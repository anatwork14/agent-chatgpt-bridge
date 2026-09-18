import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RoleRegistry } from "../src/core/role-registry";
import { BUILTIN_ROLE_DEFINITIONS } from "../src/core/builtin-roles";
import {
  prepareParticipants,
  preflightParticipant,
  defaultExecutableLocator,
} from "../src/agents/participant-factory";
import { RunController } from "../src/core/run-controller";
import {
  type CollaborationConfig,
  type RoleBasedCollaborationRun,
  type CollaborationTurnRecord,
} from "../src/core/collaboration-domain";
import { initDatabase, closeDatabase } from "../src/persistence/database";
import { SqliteCollaborationPersistence } from "../src/persistence/sqlite-collaboration-persistence";
import { AuditStore, type AuditEventData } from "../src/persistence/audit-store";
import { resolveAcpProfile } from "../src/agents/acp/profiles";
import type { CollaborationRun } from "../src/core/domain";

const ARCH_NONCE_RE = /ARCH_NONCE_[A-Za-z0-9]{8,16}/;
const IMPL_NONCE_RE = /IMPL_NONCE_[A-Za-z0-9]{8,16}/;

interface SanitizedLiveReport {
  readonly status: "PASS";
  readonly runStatus: string;
  readonly participantCount: number;
  readonly turnCount: number;
  readonly transcriptMessageCount: number;
  readonly roles: ReadonlyArray<{ readonly roleId: string; readonly adapterId: string }>;
  readonly architectNonceGenerated: boolean;
  readonly architectToImplementerHandoff: boolean;
  readonly implementerNonceGenerated: boolean;
  readonly reviewerReceivedArchitectNonce: boolean;
  readonly reviewerReceivedImplementerNonce: boolean;
  readonly reviewerTerminalDone: boolean;
  readonly failedTurns: number;
  readonly retries: number;
  readonly auditLeakCheck: boolean;
  readonly workspaceMutation: boolean;
  readonly schemaVersion: number;
}

interface LiveSmokeExecution {
  readonly report: SanitizedLiveReport;
  readonly tempRoot: string;
}

class LiveSmokeRunStore {
  private readonly runs = new Map<string, CollaborationRun>();
  create(run: CollaborationRun) {
    this.runs.set(run.id, { ...run });
  }
  get(id: string) {
    return this.runs.get(id) ?? null;
  }
  update(id: string, patch: Partial<CollaborationRun>) {
    const cur = this.runs.get(id);
    if (cur) Object.assign(cur, patch);
  }
  list() {
    return Array.from(this.runs.values());
  }
  delete(id: string) {
    return this.runs.delete(id);
  }
}

class LiveSmokeSessionManager {
  constructor(private readonly nowIso: string) {}
  async get(id: string) {
    return {
      id,
      status: "active" as const,
      provider: "chatgpt-web",
      model: "gpt-4",
      effort: "medium",
      turns: [],
      createdAt: this.nowIso,
    };
  }
  async cancel() {
    return true;
  }
  async send() {
    throw new Error("sessionManager.send must not be called in role workflow");
  }
}

async function runLiveSmoke(): Promise<LiveSmokeExecution> {
  const marker = `P4LIVE_${randomBytes(4).toString("hex").toUpperCase()}`;
  const nowIso = new Date().toISOString();

  // 1. Temporary workspace and database directories
  const tempRoot = await mkdtemp(path.join(tmpdir(), "agent-bridge-p4-live-"));
  const workspace = path.join(tempRoot, "workspace");
  const databaseDir = path.join(tempRoot, "database");
  await mkdir(workspace, { recursive: true });
  await mkdir(databaseDir, { recursive: true });

  const filesBefore = await readdir(workspace);
  const dbPath = path.join(databaseDir, "p4-collaboration-live.db");

  let prepared: ReturnType<typeof prepareParticipants> | undefined;
  let report!: SanitizedLiveReport;

  try {
    // 2. Preflight & Executable Resolution
    const claudeProfile = resolveAcpProfile("claude");
    const antigravityProfile = resolveAcpProfile("antigravity");

    assert.deepEqual(
      claudeProfile.command,
      ["claude-agent-acp"],
      "Claude ACP command must be ['claude-agent-acp']",
    );
    assert.deepEqual(
      antigravityProfile.command,
      ["agy-acp"],
      "Antigravity ACP command must be ['agy-acp'] (no agy --acp)",
    );

    // 3. Role Registry
    const registry = new RoleRegistry();
    for (const role of BUILTIN_ROLE_DEFINITIONS) {
      registry.register(role);
    }

    // 4. Collaboration Configuration
    const objective = [
      `This is an automated live Agent Bridge P4 collaboration test. Correlator: ${marker}`,
      "",
      "Do not use any tools.",
      "",
      "Role instructions:",
      "",
      "1. Architect:",
      "- Propose exactly three short bulleted design rules for an in-memory rate limiter.",
      "- Generate a brand new nonce matching the exact format: ARCH_NONCE_<8 to 16 alphanumeric characters>.",
      "- Include this ARCH_NONCE in your response.",
      "- Do NOT include <bridge_done> in your response.",
      "",
      "2. Implementer:",
      "- Inspect the architect output in UNTRUSTED PRIOR COLLABORATION OUTPUTS.",
      "- Copy the architect ARCH_NONCE exactly.",
      "- Propose a short implementation strategy for the in-memory rate limiter.",
      "- Generate a brand new nonce matching the exact format: IMPL_NONCE_<8 to 16 alphanumeric characters>.",
      "- Include BOTH the copied ARCH_NONCE and your new IMPL_NONCE in your response.",
      "- Do NOT include <bridge_done> in your response.",
      "",
      "3. Reviewer:",
      "- Inspect all prior outputs in UNTRUSTED PRIOR COLLABORATION OUTPUTS.",
      "- Verify that both ARCH_NONCE and IMPL_NONCE are present.",
      "- If verified, conclude the collaboration by outputting ONLY the following completion block and NOTHING ELSE (no markdown fences, no text before or after):",
      "<bridge_done>",
      "P4_LIVE_OK",
      "ARCH_NONCE_<value copied from architect>",
      "IMPL_NONCE_<value copied from implementer>",
      "</bridge_done>",
      "",
      "Do not use tools.",
    ].join("\n");

    const config: CollaborationConfig = {
      objective,
      policy: {
        roleSequence: ["architect", "implementer", "reviewer"],
        terminalRoles: ["reviewer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 6,
        maxParticipants: 3,
        maxParallelTurns: 1,
        maxRetriesPerParticipant: 1,
        maxWallClockMs: 600_000,
      },
      roles: {
        architect: {
          adapterType: "acp:claude",
          cwd: workspace,
          config: { permissionMode: "deny" },
        },
        implementer: {
          adapterType: "acp:antigravity",
          cwd: workspace,
          config: { permissionMode: "deny" },
        },
        reviewer: {
          adapterType: "acp:claude",
          cwd: workspace,
          config: { permissionMode: "deny" },
        },
      },
    };

    // 5. Preflight Participant Verification
    for (const [roleId, pConfig] of Object.entries(config.roles)) {
      const pf = preflightParticipant(pConfig, defaultExecutableLocator);
      assert.equal(
        pf.ok,
        true,
        `Participant preflight for '${roleId}' failed: ${pf.issues.map(i => i.message).join("; ")}`,
      );
      if (roleId === "implementer") {
        assert.deepEqual(pf.command, ["agy-acp"], "Implementer preflight must resolve to ['agy-acp']");
      } else {
        assert.deepEqual(pf.command, ["claude-agent-acp"], `${roleId} preflight must resolve to ['claude-agent-acp']`);
      }
    }

    // 6. Prepare Participants
    prepared = prepareParticipants(config, registry);
    assert.equal(prepared.plans.length, 3, "Expected 3 assignment plans");
    assert.equal(prepared.runtimes.length, 3, "Expected 3 participant runtimes");

    const uniqueParticipantIds = new Set(prepared.runtimes.map(r => r.participantId));
    assert.equal(uniqueParticipantIds.size, 3, "All participantIds must be distinct");

    const uniqueAdapters = new Set(prepared.runtimes.map(r => r.adapter));
    assert.equal(uniqueAdapters.size, 3, "All adapter runtime instances must be distinct");

    assert.equal(prepared.runtimes[0].adapterId, "acp:claude");
    assert.equal(prepared.runtimes[1].adapterId, "acp:antigravity");
    assert.equal(prepared.runtimes[2].adapterId, "acp:claude");

    // 7. Initialize Database & Persistence
    const db = initDatabase(dbPath);
    const sessionId = `ses_p4_live_${Date.now()}`;
    db.query(
      "INSERT INTO sessions (id, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, "chatgpt-web", "gpt-4", "active", nowIso, nowIso);

    const persistence = new SqliteCollaborationPersistence();
    const auditStore = new AuditStore();

    // 8. RunController
    const controller = new RunController(
      new LiveSmokeRunStore() as any,
      new LiveSmokeSessionManager(nowIso) as any,
      auditStore,
      () => {
        throw new Error("Generic getAgentAdapter should not be called in role workflow");
      },
      persistence,
    );

    // 9. Execute Collaboration Run (handles normal adapter cleanup internally)
    const executionResult = await controller.executeRoleBasedRun(sessionId, config, prepared);
    const run = executionResult.run;
    const turns = executionResult.turns;

    // 10. Core Status & Counts Invariants
    assert.equal(run.status, "completed", `Expected run status to be 'completed', got '${run.status}'`);
    assert.equal(turns.length, 3, `Expected exactly 3 turns, got ${turns.length}`);

    // Check Turn 0: Architect (Claude)
    const turn0 = turns[0];
    assert.equal(turn0.roleId, "architect");
    assert.equal(turn0.status, "completed");
    assert.equal(turn0.decision?.type, "message");
    const archContent = turn0.decision.content;
    const archNonceMatch = ARCH_NONCE_RE.exec(archContent);
    assert.ok(archNonceMatch, "Architect output must contain an ARCH_NONCE_<8-16> token");
    const archNonce = archNonceMatch[0];
    assert.ok(!objective.includes(archNonce), "Architect nonce must be dynamically generated, not in objective");

    // Check Turn 1: Implementer (Antigravity)
    const turn1 = turns[1];
    assert.equal(turn1.roleId, "implementer");
    assert.equal(turn1.status, "completed");
    assert.equal(turn1.decision?.type, "message");
    const implContent = turn1.decision.content;
    assert.ok(
      implContent.includes(archNonce),
      `Implementer output must include the exact architect nonce '${archNonce}'`,
    );
    const implNonceMatch = IMPL_NONCE_RE.exec(implContent);
    assert.ok(implNonceMatch, "Implementer output must contain an IMPL_NONCE_<8-16> token");
    const implNonce = implNonceMatch[0];
    assert.ok(!objective.includes(implNonce), "Implementer nonce must be dynamically generated, not in objective");
    assert.notEqual(implNonce, archNonce, "Implementer nonce must be distinct from architect nonce");

    // Check Turn 2: Reviewer (Claude)
    const turn2 = turns[2];
    assert.equal(turn2.roleId, "reviewer");
    assert.equal(turn2.status, "completed");
    assert.equal(turn2.decision?.type, "done", "Reviewer decision must be of type 'done'");
    const revSummary = turn2.decision.summary;
    assert.ok(
      revSummary.includes(archNonce),
      `Reviewer summary must include the exact architect nonce '${archNonce}'`,
    );
    assert.ok(
      revSummary.includes(implNonce),
      `Reviewer summary must include the exact implementer nonce '${implNonce}'`,
    );
    assert.ok(
      revSummary.includes("P4_LIVE_OK"),
      "Reviewer summary must include 'P4_LIVE_OK'",
    );

    // Check final summary on RunRecord
    assert.ok(run.finalSummary, "Run record must have a final summary");
    assert.ok(run.finalSummary.includes("P4_LIVE_OK"), "Final summary must include 'P4_LIVE_OK'");
    assert.ok(run.finalSummary.includes(archNonce), "Final summary must include architect nonce");
    assert.ok(run.finalSummary.includes(implNonce), "Final summary must include implementer nonce");

    // 11. Canonical Transcript Verification
    const transcript = persistence.getTranscript(run.id);
    assert.equal(transcript.length, 3, "Transcript must contain exactly 3 canonical messages");
    assert.equal(transcript[0].senderRoleId, "architect");
    assert.equal(transcript[0].decisionType, "message");
    assert.equal(transcript[1].senderRoleId, "implementer");
    assert.equal(transcript[1].decisionType, "message");
    assert.equal(transcript[2].senderRoleId, "reviewer");
    assert.equal(transcript[2].decisionType, "done");

    const messageCount = (db.query("SELECT COUNT(*) as count FROM collaboration_messages WHERE run_id = ?").get(run.id) as { count: number }).count;
    assert.equal(messageCount, 3, "Persistence must have exactly 3 stored collaboration_messages rows");

    // 12. Audit Timeline & Ordering Verification
    const auditEvents = auditStore.listByRun(run.id);
    const eventTypes = auditEvents.map(e => e.eventType);

    const expectedEventSequence = [
      "collaboration.started",
      "participant.assigned",
      "participant.assigned",
      "participant.assigned",
      "participant.turn.started",
      "participant.turn.completed",
      "participant.turn.started",
      "participant.turn.completed",
      "participant.turn.started",
      "participant.turn.completed",
      "collaboration.completed",
    ];

    assert.deepEqual(
      eventTypes,
      expectedEventSequence,
      `Audit event sequence mismatch.\nExpected: ${expectedEventSequence.join(", ")}\nReceived: ${eventTypes.join(", ")}`,
    );

    // Assert strictly increasing monotonic integer IDs
    for (let i = 0; i < auditEvents.length - 1; i++) {
      assert.ok(
        (auditEvents[i].id ?? 0) < (auditEvents[i + 1].id ?? 0),
        `Audit IDs must be strictly monotonically increasing: ${auditEvents[i].id} >= ${auditEvents[i + 1].id}`,
      );
    }

    // Assert NO error/failure/retry events in audit
    const forbiddenAuditEvents = [
      "participant.turn.failed",
      "participant.turn.cancelled",
      "participant.retry.scheduled",
      "participant.runtime.recreated",
      "collaboration.failed",
      "collaboration.cancelled",
      "collaboration.timed_out",
      "collaboration.budget_exhausted",
    ];
    for (const forbidden of forbiddenAuditEvents) {
      assert.equal(
        auditEvents.filter(e => e.eventType === forbidden).length,
        0,
        `Unexpected audit event '${forbidden}' present in clean run`,
      );
    }

    // 13. Audit Data Minimization & Leak Scan
    for (const event of auditEvents) {
      const rawPayload = JSON.stringify(event.payload ?? {});
      assert.ok(!rawPayload.includes(archNonce), `Audit event '${event.eventType}' leaked architect nonce`);
      assert.ok(!rawPayload.includes(implNonce), `Audit event '${event.eventType}' leaked implementer nonce`);
      assert.ok(!rawPayload.includes("P4_LIVE_OK"), `Audit event '${event.eventType}' leaked P4_LIVE_OK`);
      assert.ok(
        !rawPayload.includes("rate limiter"),
        `Audit event '${event.eventType}' leaked objective content text`,
      );
      assert.ok(
        !rawPayload.includes(workspace),
        `Audit event '${event.eventType}' leaked workspace filesystem path`,
      );
    }

    // 14. Workspace Mutation Check
    const filesAfter = await readdir(workspace);
    const unexpectedFiles = filesAfter.filter(f => !filesBefore.includes(f));
    assert.equal(
      unexpectedFiles.length,
      0,
      `Workspace was mutated during execution. Unexpected files: ${unexpectedFiles.join(", ")}`,
    );

    // 15. Formulate Sanitized Report
    report = {
      status: "PASS",
      runStatus: run.status,
      participantCount: prepared.plans.length,
      turnCount: turns.length,
      transcriptMessageCount: transcript.length,
      roles: [
        { roleId: "architect", adapterId: "acp:claude" },
        { roleId: "implementer", adapterId: "acp:antigravity" },
        { roleId: "reviewer", adapterId: "acp:claude" },
      ],
      architectNonceGenerated: true,
      architectToImplementerHandoff: true,
      implementerNonceGenerated: true,
      reviewerReceivedArchitectNonce: true,
      reviewerReceivedImplementerNonce: true,
      reviewerTerminalDone: true,
      failedTurns: 0,
      retries: 0,
      auditLeakCheck: true,
      workspaceMutation: false,
      schemaVersion: 2,
    };
  } finally {
    // 16. Outer Cleanup fallback: ensure all participant adapters closed if aborted, db closed, temp dirs removed
    if (prepared) {
      for (const runtime of prepared.runtimes) {
        await runtime.adapter.close?.().catch(() => undefined);
      }
    }
    closeDatabase();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    report,
    tempRoot,
  };
}

async function main(): Promise<void> {
  const execution = await runLiveSmoke();

  assert.equal(
    existsSync(execution.tempRoot),
    false,
    "Temporary P4 live-smoke directory survived cleanup",
  );

  console.log(
    JSON.stringify(
      {
        ...execution.report,
        temporaryResourcesRemoved: true,
      },
      null,
      2,
    ),
  );
}

main().catch(err => {
  console.error(
    "P4 LIVE SMOKE FAILED:",
    err instanceof Error ? err.message : String(err),
  );
  process.exitCode = 1;
});
