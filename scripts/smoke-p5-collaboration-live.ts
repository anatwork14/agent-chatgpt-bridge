import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
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
import type { CollaborationConfig } from "../src/core/collaboration-domain";
import type { CollaborationDagDefinition } from "../src/core/collaboration-dag";
import { initDatabase, closeDatabase } from "../src/persistence/database";
import { SqliteCollaborationDagPersistence } from "../src/persistence/sqlite-collaboration-dag-persistence";
import { AuditStore } from "../src/persistence/audit-store";
import { resolveAcpProfile } from "../src/agents/acp/profiles";
import type { CollaborationRun } from "../src/core/domain";

const ARCH_NONCE_RE = /ARCH_NONCE_[A-Za-z0-9]{8,16}/;
const CRIT_NONCE_RE = /CRIT_NONCE_[A-Za-z0-9]{8,16}/;
const IMPL_NONCE_RE = /IMPL_NONCE_[A-Za-z0-9]{8,16}/;

interface SanitizedP5LiveReport {
  readonly status: "PASS";
  readonly runStatus: string;
  readonly participantCount: number;
  readonly nodeCount: number;
  readonly transcriptMessageCount: number;
  readonly maxParallelTurns: number;
  readonly branchOverlapProved: boolean;
  readonly observedMaxConcurrency: number;
  readonly deterministicFanInOrder: boolean;
  readonly reviewerReceivedCriticNonce: boolean;
  readonly reviewerReceivedImplementerNonce: boolean;
  readonly reviewerTerminalDone: boolean;
  readonly cancellationRunStatus: string;
  readonly simultaneousCancellationTargets: number;
  readonly cancelledNodeCount: number;
  readonly auditLeakCheck: boolean;
  readonly workspaceMutation: boolean;
  readonly temporaryResourcesRemoved: boolean;
  readonly schemaVersion: number;
}

class LiveSmokeRunStore {
  private readonly runs = new Map<string, CollaborationRun>();
  create(run: CollaborationRun) { this.runs.set(run.id, { ...run }); }
  get(id: string) { return this.runs.get(id) ?? null; }
  update(id: string, patch: Partial<CollaborationRun>) {
    const current = this.runs.get(id);
    if (current) Object.assign(current, patch);
  }
  list() { return [...this.runs.values()]; }
  delete(id: string) { return this.runs.delete(id); }
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
    throw new Error("SessionManager.cancel must not be used by P5 DAG cancellation");
  }
  async send() {
    throw new Error("SessionManager.send must not be called in P5 collaboration DAG");
  }
}

function maxIntervalConcurrency(
  nodes: readonly { startedAt?: string; completedAt?: string }[],
): number {
  const events: Array<{ at: number; delta: number }> = [];
  for (const node of nodes) {
    if (!node.startedAt || !node.completedAt) continue;
    events.push({ at: Date.parse(node.startedAt), delta: 1 });
    events.push({ at: Date.parse(node.completedAt), delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let active = 0;
  let max = 0;
  for (const event of events) {
    active += event.delta;
    max = Math.max(max, active);
  }
  return max;
}

function assertAuditDataMinimized(
  events: readonly any[],
  forbiddenValues: readonly string[],
): void {
  const forbiddenKey = /^(token|secret|password|authorization|cookie|api[_-]?key|oauth|credential|refresh[_-]?token|access[_-]?token|objective|prompt|transcript|content|message|summary|cwd|command|env|environment|system[_-]?instructions?|model[_-]?output)$/i;

  const walk = (value: unknown, pathText: string): void => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${pathText}[${index}]`));
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        assert.equal(
          forbiddenKey.test(key),
          false,
          `Audit payload leaked forbidden key '${key}' at ${pathText}`,
        );
        walk(child, `${pathText}.${key}`);
      }
      return;
    }
  };

  for (const event of events) {
    const raw = JSON.stringify(event.payload ?? {});
    for (const forbidden of forbiddenValues) {
      assert.equal(
        raw.includes(forbidden),
        false,
        `Audit event '${event.eventType}' leaked protected live-smoke data`,
      );
    }
    walk(event.payload, `audit.${event.eventType}`);
  }
}

async function waitForRunningNodes(
  persistence: SqliteCollaborationDagPersistence,
  runId: string,
  count: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = persistence.getNodes(runId).filter(node => node.status === "running").length;
    if (running >= count) return running;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return persistence.getNodes(runId).filter(node => node.status === "running").length;
}

async function main(): Promise<void> {
  const marker = `P5LIVE_${randomBytes(4).toString("hex").toUpperCase()}`;
  const nowIso = new Date().toISOString();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "agent-bridge-p5-live-"));
  const workspace = path.join(tempRoot, "workspace");
  const databaseDir = path.join(tempRoot, "database");
  await mkdir(workspace, { recursive: true });
  await mkdir(databaseDir, { recursive: true });
  const filesBefore = await readdir(workspace);
  const dbPath = path.join(databaseDir, "p5-collaboration-live.db");

  let mainPrepared: ReturnType<typeof prepareParticipants> | undefined;
  let cancellationPrepared: ReturnType<typeof prepareParticipants> | undefined;
  let report: Omit<SanitizedP5LiveReport, "temporaryResourcesRemoved"> | undefined;

  try {
    const claudeProfile = resolveAcpProfile("claude");
    const antigravityProfile = resolveAcpProfile("antigravity");
    assert.deepEqual(claudeProfile.command, ["claude-agent-acp"]);
    assert.deepEqual(antigravityProfile.command, ["agy-acp"]);

    const registry = new RoleRegistry();
    for (const role of BUILTIN_ROLE_DEFINITIONS) registry.register(role);

    const objective = [
      `Automated live Agent Bridge P5 DAG test. Correlator: ${marker}.`,
      "Design and independently evaluate a minimal in-memory rate limiter.",
      "Do not use tools or mutate the workspace.",
      "Follow only your trusted role instructions and trusted DAG node instruction.",
    ].join("\n");

    const claudeParticipantConfig = {
      adapterType: "acp:claude" as const,
      cwd: workspace,
      config: { permissionMode: "deny" },
    };
    const antigravityParticipantConfig = {
      adapterType: "acp:antigravity" as const,
      cwd: workspace,
      config: { permissionMode: "deny" },
    };

    const config: CollaborationConfig = {
      objective,
      policy: {
        roleSequence: ["architect", "critic", "implementer", "reviewer"],
        terminalRoles: ["reviewer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 8,
        maxParticipants: 4,
        maxParallelTurns: 1,
        maxRetriesPerParticipant: 1,
        maxWallClockMs: 600_000,
      },
      roles: {
        architect: claudeParticipantConfig,
        critic: claudeParticipantConfig,
        implementer: antigravityParticipantConfig,
        reviewer: claudeParticipantConfig,
      },
    };

    for (const [roleId, participantConfig] of Object.entries(config.roles)) {
      const result = preflightParticipant(participantConfig, defaultExecutableLocator);
      assert.equal(
        result.ok,
        true,
        `Participant preflight failed for '${roleId}': ${result.issues.map(issue => issue.message).join("; ")}`,
      );
      assert.deepEqual(
        result.command,
        roleId === "implementer" ? ["agy-acp"] : ["claude-agent-acp"],
      );
    }

    mainPrepared = prepareParticipants(config, registry);
    assert.equal(mainPrepared.plans.length, 4);
    assert.equal(new Set(mainPrepared.runtimes.map(runtime => runtime.adapter)).size, 4);

    const byRole = Object.fromEntries(
      mainPrepared.plans.map(plan => [plan.roleId, plan.participantId]),
    ) as Record<string, string>;

    const graph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "architecture",
          participantId: byRole.architect!,
          dependsOn: [],
          instruction: [
            "Produce exactly three short design rules.",
            "Generate a fresh nonce matching ARCH_NONCE_<8 to 16 alphanumeric characters>.",
            "Include the nonce in your response.",
            "Do not emit <bridge_done>.",
          ].join("\n"),
        },
        {
          id: "critique",
          participantId: byRole.critic!,
          dependsOn: ["architecture"],
          instruction: [
            "Read only the architect predecessor output supplied by the DAG.",
            "Copy its ARCH_NONCE exactly.",
            "Give two concise adversarial failure modes.",
            "Generate CRIT_NONCE_<8 to 16 alphanumeric characters>.",
            "Include both nonces and do not emit <bridge_done>.",
          ].join("\n"),
        },
        {
          id: "implementation",
          participantId: byRole.implementer!,
          dependsOn: ["architecture"],
          instruction: [
            "Read only the architect predecessor output supplied by the DAG.",
            "Copy its ARCH_NONCE exactly.",
            "Give a concise implementation strategy.",
            "Generate IMPL_NONCE_<8 to 16 alphanumeric characters>.",
            "Include both nonces and do not emit <bridge_done>.",
          ].join("\n"),
        },
        {
          id: "review",
          participantId: byRole.reviewer!,
          dependsOn: ["critique", "implementation"],
          terminal: true,
          instruction: [
            "Read the fan-in predecessor outputs in their supplied deterministic order.",
            "Verify that both CRIT_NONCE and IMPL_NONCE are present.",
            "Conclude by outputting ONLY the following completion block and NOTHING ELSE (no conversational text, no preamble, no markdown formatting, no text before or after):",
            "<bridge_done>",
            "P5_LIVE_OK",
            "CRIT_NONCE_<value copied from critic>",
            "IMPL_NONCE_<value copied from implementer>",
            "</bridge_done>",
          ].join("\n"),
        },
      ],
    };

    const db = initDatabase(dbPath);
    const sessionId = `ses_p5_live_${Date.now()}`;
    db.query(
      "INSERT INTO sessions (id, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(sessionId, "chatgpt-web", "gpt-4", "active", nowIso, nowIso);

    const persistence = new SqliteCollaborationDagPersistence();
    const auditStore = new AuditStore();
    const controller = new RunController(
      new LiveSmokeRunStore() as any,
      new LiveSmokeSessionManager(nowIso) as any,
      auditStore,
      () => {
        throw new Error("Generic getAgentAdapter must not be called by P5 DAG execution");
      },
      undefined,
      undefined,
      persistence,
    );

    const result = await controller.executeDagRun(
      sessionId,
      config,
      mainPrepared,
      graph,
      {
        budget: {
          maxTurns: 8,
          maxParticipants: 4,
          maxParallelTurns: 2,
          maxRetriesPerParticipant: 1,
          maxWallClockMs: 600_000,
        },
      },
    );

    assert.equal(result.run.status, "completed");
    assert.equal(result.nodes.length, 4);
    assert.ok(result.nodes.every(node => node.status === "completed"));

    const messages = persistence.getMessagesByNode(result.run.id);
    const archContent = messages.architecture?.content ?? "";
    const criticContent = messages.critique?.content ?? "";
    const implContent = messages.implementation?.content ?? "";
    const reviewContent = messages.review?.content ?? "";

    const archNonce = ARCH_NONCE_RE.exec(archContent)?.[0];
    const criticNonce = CRIT_NONCE_RE.exec(criticContent)?.[0];
    const implNonce = IMPL_NONCE_RE.exec(implContent)?.[0];
    assert.ok(archNonce, "Architect output must generate ARCH_NONCE");
    assert.ok(criticNonce, "Critic output must generate CRIT_NONCE");
    assert.ok(implNonce, "Implementer output must generate IMPL_NONCE");
    assert.ok(criticContent.includes(archNonce));
    assert.ok(implContent.includes(archNonce));
    assert.ok(reviewContent.includes("P5_LIVE_OK"));
    assert.ok(reviewContent.includes(criticNonce));
    assert.ok(reviewContent.includes(implNonce));

    const criticNode = result.nodes.find(node => node.id === "critique")!;
    const implementerNode = result.nodes.find(node => node.id === "implementation")!;
    assert.ok(criticNode.startedAt && criticNode.completedAt);
    assert.ok(implementerNode.startedAt && implementerNode.completedAt);

    const branchOverlap =
      Date.parse(criticNode.startedAt) < Date.parse(implementerNode.completedAt) &&
      Date.parse(implementerNode.startedAt) < Date.parse(criticNode.completedAt);
    assert.equal(branchOverlap, true, "Critic and implementer must overlap in wall-clock execution");

    const observedMaxConcurrency = maxIntervalConcurrency(result.nodes);
    assert.equal(observedMaxConcurrency, 2, "Live DAG must observe exactly two concurrent node turns");
    assert.ok(observedMaxConcurrency <= 2, "Live DAG exceeded maxParallelTurns=2");

    const transcript = persistence.getTranscript(result.run.id);
    assert.deepEqual(
      transcript.map(message => message.senderRoleId),
      ["architect", "critic", "implementer", "reviewer"],
      "Canonical transcript order must follow declaration order, not completion timing",
    );

    const reviewerInputs = persistence.getInputs(result.run.id, "review");
    assert.equal(reviewerInputs.length, 1);
    assert.deepEqual(reviewerInputs[0]!.predecessorNodeIds, ["critique", "implementation"]);
    assert.deepEqual(reviewerInputs[0]!.predecessorMessageIds, [
      messages.critique!.id,
      messages.implementation!.id,
    ]);

    const auditEvents = auditStore.listByRun(result.run.id);
    for (let index = 0; index < auditEvents.length - 1; index++) {
      assert.ok(
        (auditEvents[index]!.id ?? 0) < (auditEvents[index + 1]!.id ?? 0),
        "Audit event IDs must be strictly monotonic",
      );
    }
    assertAuditDataMinimized(auditEvents, [
      marker,
      archNonce,
      criticNonce,
      implNonce,
      "P5_LIVE_OK",
      workspace,
    ]);

    // Cancellation phase: force two independent roots active, then cancel the exact DAG run.
    const cancellationConfig: CollaborationConfig = {
      objective: `P5 cancellation live test. Correlator: ${marker}. Do not use tools.`,
      policy: {
        roleSequence: ["critic", "implementer"],
        terminalRoles: ["critic", "implementer"],
        loopMode: "once",
      },
      budget: {
        maxTurns: 4,
        maxParticipants: 2,
        maxParallelTurns: 1,
        maxRetriesPerParticipant: 0,
        maxWallClockMs: 600_000,
      },
      roles: {
        critic: claudeParticipantConfig,
        implementer: antigravityParticipantConfig,
      },
    };
    cancellationPrepared = prepareParticipants(cancellationConfig, registry);
    const cancelByRole = Object.fromEntries(
      cancellationPrepared.plans.map(plan => [plan.roleId, plan.participantId]),
    ) as Record<string, string>;
    const cancellationGraph: CollaborationDagDefinition = {
      version: 1,
      nodes: [
        {
          id: "critic_cancel",
          participantId: cancelByRole.critic!,
          dependsOn: [],
          terminal: true,
          instruction: "Produce a long, careful adversarial analysis with at least 100 distinct numbered observations. Do not use tools.",
        },
        {
          id: "implementation_cancel",
          participantId: cancelByRole.implementer!,
          dependsOn: [],
          terminal: true,
          instruction: "Produce a long, careful implementation analysis with at least 100 distinct numbered observations. Do not use tools.",
        },
      ],
    };

    const cancellationRun = await controller.startDagRun(
      sessionId,
      cancellationConfig,
      cancellationPrepared,
      cancellationGraph,
      { budget: { maxParallelTurns: 2, maxRetriesPerParticipant: 0 } },
    );

    const simultaneouslyRunning = await waitForRunningNodes(
      persistence,
      cancellationRun.id,
      2,
      30_000,
    );
    assert.equal(
      simultaneouslyRunning,
      2,
      "Cancellation smoke must observe both root nodes running before cancellation",
    );

    assert.equal(
      await controller.cancelDagRun(cancellationRun.id, "P5 live cancellation verification"),
      true,
    );
    const cancellationResult = await controller.waitForDagRun(cancellationRun.id);
    assert.equal(cancellationResult.run.status, "cancelled");
    const cancelledNodeCount = cancellationResult.nodes.filter(
      node => node.status === "cancelled",
    ).length;
    assert.equal(cancelledNodeCount, 2, "Both active live DAG nodes must settle cancelled");

    const cancelAuditEvents = auditStore.listByRun(cancellationRun.id);
    assertAuditDataMinimized(cancelAuditEvents, [marker, workspace]);

    const filesAfter = await readdir(workspace);
    const unexpectedFiles = filesAfter.filter(file => !filesBefore.includes(file));
    assert.deepEqual(unexpectedFiles, [], "P5 live smoke workspace was mutated");

    report = {
      status: "PASS",
      runStatus: result.run.status,
      participantCount: mainPrepared.plans.length,
      nodeCount: result.nodes.length,
      transcriptMessageCount: transcript.length,
      maxParallelTurns: 2,
      branchOverlapProved: true,
      observedMaxConcurrency,
      deterministicFanInOrder: true,
      reviewerReceivedCriticNonce: true,
      reviewerReceivedImplementerNonce: true,
      reviewerTerminalDone: true,
      cancellationRunStatus: cancellationResult.run.status,
      simultaneousCancellationTargets: simultaneouslyRunning,
      cancelledNodeCount,
      auditLeakCheck: true,
      workspaceMutation: false,
      schemaVersion: 3,
    };

  } finally {
    for (const prepared of [mainPrepared, cancellationPrepared]) {
      if (!prepared) continue;
      for (const runtime of prepared.runtimes) {
        await runtime.adapter.close?.().catch(() => undefined);
      }
    }
    closeDatabase();
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  assert.equal(
    existsSync(tempRoot),
    false,
    "Temporary P5 live-smoke directory survived cleanup",
  );
  assert.ok(report, "P5 live-smoke report was not produced");

  const finalReport: SanitizedP5LiveReport = {
    ...report,
    temporaryResourcesRemoved: true,
  };
  console.log(JSON.stringify(finalReport, null, 2));
}

main().catch(error => {
  console.error(
    "P5 LIVE SMOKE FAILED:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
