import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AcpAgentAdapter } from "../src/agents/acp/adapter";
import { resolveAcpProfile } from "../src/agents/acp/profiles";
import type { AcpAuditEvent } from "../src/agents/acp/types";
import type { AgentDecision, AgentTurnInput } from "../src/core/domain";
import { BridgeError } from "../src/core/errors";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function decisionText(decision: AgentDecision): string {
  if (decision.type === "message") return decision.content;
  if (decision.type === "done") return decision.summary;
  if (decision.type === "pause") return decision.reason;
  return decision.message;
}

function turn(
  runId: string,
  objective: string,
  round: number,
  lastChatGptResponse?: string,
): AgentTurnInput {
  return {
    runId,
    objective,
    round,
    lastChatGptResponse: lastChatGptResponse === undefined
      ? undefined
      : { text: lastChatGptResponse },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

const profileId = arg("--profile") ?? process.env.AGENT_CHATGPT_ACP_PROFILE ?? "cursor";
const customCommandRaw = arg("--command-json") ?? process.env.AGENT_CHATGPT_ACP_COMMAND_JSON;
let customCommand: string[] | undefined;
if (customCommandRaw) {
  const parsed = JSON.parse(customCommandRaw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(value => typeof value !== "string")) {
    throw new Error("--command-json / AGENT_CHATGPT_ACP_COMMAND_JSON must be a non-empty JSON string array");
  }
  customCommand = parsed;
}

const profile = resolveAcpProfile(profileId, customCommand);
const runId = `acp-live-${profileId}-${Date.now()}`;
const marker = `AGENT_BRIDGE_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const workspace = await mkdtemp(path.join(tmpdir(), "agent-bridge-acp-"));
const permissionProbe = path.join(workspace, "permission-probe.txt");
const audit: AcpAuditEvent[] = [];
const adapter = new AcpAgentAdapter(profile, {
  cwd: workspace,
  timeoutMs: 120_000,
  cancelGraceMs: 3_000,
  closeTimeoutMs: 3_000,
  permissionMode: "deny",
  audit: event => audit.push(event),
});

const report: Record<string, unknown> = {
  profile: profile.id,
  marker,
  workspaceIsTemporary: true,
  initialize: false,
  continuity: false,
  permissionFailClosed: false,
  cancellation: false,
  postCancelRecovery: false,
  cleanClose: false,
};

try {
  await adapter.initialize({
    runId,
    objective: `ACP interoperability probe ${marker}`,
    cwd: workspace,
  });
  report.initialize = true;

  const objective = [
    `This is an ACP interoperability probe. The marker is ${marker}.`,
    "Do not use tools for the first two rounds.",
    "On the first round, include the marker in your reply and remember it for the next round.",
    "Do not emit a <bridge_done> marker unless explicitly asked.",
  ].join(" ");

  const first = await adapter.next(turn(runId, objective, 1), {});
  const firstText = decisionText(first);
  assert.match(firstText, new RegExp(marker), "first ACP response did not contain the marker");

  const second = await adapter.next(
    turn(
      runId,
      objective,
      2,
      `Without using tools, repeat the exact marker you remembered from the previous round. It must be ${marker}.`,
    ),
    {},
  );
  const secondText = decisionText(second);
  assert.match(secondText, new RegExp(marker), "ACP session did not preserve two-round continuity");
  report.continuity = true;

  await adapter.next(
    turn(
      runId,
      objective,
      3,
      "Permission probe: attempt to create a file named permission-probe.txt in the current working directory. If permission is denied, say so and continue. Do not try another path or mechanism.",
    ),
    {},
  ).catch(error => {
    if (error instanceof BridgeError) return;
    throw error;
  });
  assert.equal(await fileExists(permissionProbe), false, "ACP permission probe mutated the temporary workspace");
  report.permissionFailClosed = true;
  report.permissionRequests = audit.filter(event => event.eventType === "agent.acp.permission.requested").length;

  const controller = new AbortController();
  const cancellation = adapter.next(
    turn(
      runId,
      objective,
      4,
      "Cancellation probe: start a long reasoning response. Do not finish immediately; keep working until cancelled.",
    ),
    { signal: controller.signal },
  );
  const cancelTimer = setTimeout(() => controller.abort(new Error("live ACP cancellation probe")), 50);
  try {
    await cancellation;
    throw new Error("ACP cancellation probe completed before cancellation was observed");
  } catch (error) {
    if (!(error instanceof BridgeError) || error.code !== "client_cancelled") throw error;
    report.cancellation = true;
  } finally {
    clearTimeout(cancelTimer);
  }

  const recovered = await adapter.next(
    turn(
      runId,
      objective,
      5,
      `Post-cancel recovery probe: reply with RECOVERED and the exact marker ${marker}. Do not use tools.`,
    ),
    {},
  );
  const recoveredText = decisionText(recovered);
  assert.match(recoveredText, /RECOVERED/i, "ACP session did not recover after cancellation");
  assert.match(recoveredText, new RegExp(marker), "post-cancel ACP response lost session continuity");
  report.postCancelRecovery = true;
} finally {
  try {
    await adapter.close();
    report.cleanClose = audit.some(event => event.eventType === "agent.acp.closed");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

report.failedAuditEvents = audit.filter(event => event.eventType === "agent.acp.failed").length;
report.auditEvents = audit.map(event => event.eventType);

assert.equal(report.cleanClose, true, "ACP adapter did not record a clean close");
assert.equal(report.failedAuditEvents, 0, "ACP adapter recorded a protocol/process failure");

console.log(JSON.stringify(report, null, 2));
