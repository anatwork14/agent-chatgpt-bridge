import * as acp from "@agentclientprotocol/sdk";
import { Readable, Transform, Writable, type TransformCallback } from "node:stream";
import { BridgeError } from "../../core/errors";
import type {
  AgentDecision,
  AgentTurnInput,
  ExternalAgentAdapter,
} from "../../core/domain";
import {
  spawnOwnedAgentProcess,
  terminateProcessTreeAndWait,
  waitForProcessExit,
} from "../process";
import type { OwnedAgentProcess } from "../process";
import { AcpProcessError, acpError, mapAcpError } from "./errors";
import type {
  AcpAgentAdapterOptions,
  AcpAgentProfile,
  AcpPermissionMode,
} from "./types";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CANCEL_GRACE_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;

class BoundedOutput extends Transform {
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += Buffer.byteLength(chunk, encoding);
    if (this.bytes > this.maxBytes) {
      callback(new Error("ACP protocol output exceeded the configured limit"));
      return;
    }
    callback(null, chunk);
  }
}

function positiveOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new BridgeError("agent_protocol_invalid", `${name} must be a positive finite number`, false);
  }
  return resolved;
}

function textPrompt(input: AgentTurnInput, firstPrompt: boolean): string {
  if (firstPrompt) {
    return [
      "OBJECTIVE",
      input.objective,
      "",
      "You are the primary external agent in a bounded collaboration.",
      "Respond with the next useful action/message for ChatGPT.",
      "When the objective is complete, finish with <bridge_done>SUMMARY...</bridge_done>.",
    ].join("\n");
  }
  return [
    "CHATGPT RESPONSE",
    input.lastChatGptResponse?.text ?? "",
    "",
    "Continue working toward:",
    input.objective,
    "",
    "When the objective is complete, finish with <bridge_done>SUMMARY...</bridge_done>.",
  ].join("\n");
}

function decisionFromText(text: string): AgentDecision {
  const done = /<bridge_done>([\s\S]*?)<\/bridge_done>/.exec(text);
  if (done) {
    const summary = done[1]?.trim();
    if (!summary) throw acpError("agent_protocol_invalid", "ACP completion summary is empty");
    const withoutMarker = text.replace(done[0], "").trim();
    if (withoutMarker) return { type: "message", content: withoutMarker };
    return { type: "done", summary };
  }
  if (!text.trim()) throw acpError("agent_protocol_invalid", "ACP agent returned no textual response");
  return { type: "message", content: text };
}

function readonlyKind(kind: string | null | undefined): boolean {
  return kind === "read" || kind === "search" || kind === "fetch";
}

function selectedPermission(
  request: acp.RequestPermissionRequest,
  mode: AcpPermissionMode,
): acp.RequestPermissionResponse {
  const reject = request.options.find(option => option.kind === "reject_once" || option.kind === "reject_always");
  const allow = request.options.find(option => option.kind === "allow_once" || option.kind === "allow_always");
  if (mode === "allow_readonly" && readonlyKind(request.toolCall.kind) && allow) {
    return { outcome: { outcome: "selected", optionId: allow.optionId } };
  }
  if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
  throw new Error("ACP permission request has no safe rejection option");
}

function promptResponseText(update: acp.ActiveSessionMessage): string {
  if (update.kind !== "session_update") return "";
  if (update.update.sessionUpdate !== "agent_message_chunk") return "";
  return update.update.content.type === "text" ? update.update.content.text : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, ms)));
}

export class AcpAgentAdapter implements ExternalAgentAdapter {
  public readonly id = "acp";

  private child?: OwnedAgentProcess;
  private connection?: acp.ClientConnection;
  private session?: acp.ActiveSession;
  private agentCapabilities?: acp.AgentCapabilities;
  private protocolVersion?: number;
  private agentInfo?: acp.Implementation | null;
  private runId?: string;
  private firstPrompt = true;
  private turnInFlight = false;
  private closing = false;
  private failed = false;
  private closePromise?: Promise<void>;
  private readonly options: AcpAgentAdapterOptions;

  constructor(
    private readonly profile: AcpAgentProfile,
    options: AcpAgentAdapterOptions = {},
  ) {
    this.options = {
      ...profile.options,
      ...options,
      env: { ...profile.options?.env, ...options.env },
    };
    if (profile.command.length === 0 || !profile.command[0]?.trim()) {
      throw new BridgeError("agent_protocol_invalid", "ACP requires a non-empty command", false);
    }
  }

  async initialize(context: { runId: string; objective: string; cwd?: string }): Promise<void> {
    if (this.session && this.connection) return;
    if (this.closing) throw acpError("agent_adapter_failed", "ACP adapter is closed");
    this.runId = context.runId;
    const cwd = context.cwd ?? this.options.cwd ?? process.cwd();
    const maxProtocolBytes = positiveOption(
      "maxProtocolBytes",
      this.options.maxProtocolBytes,
      DEFAULT_MAX_PROTOCOL_BYTES,
    );
    try {
      this.child = spawnOwnedAgentProcess(this.profile.command, {
        cwd,
        env: this.options.env,
      });
      this.audit("agent.acp.started", { profile: this.profile.id });

      const boundedOutput = new BoundedOutput(maxProtocolBytes);
      let protocolOutputSeen = false;
      this.child.stdout.once("data", () => {
        protocolOutputSeen = true;
      });
      this.child.stdout.pipe(boundedOutput);
      const child = this.child;
      child.once("error", () => {
        this.auditFailure(new AcpProcessError("ACP process failed"));
        this.connection?.close(new AcpProcessError("ACP process failed"));
      });
      child.once("close", () => {
        if (this.closing) return;
        const processError = this.protocolVersion === undefined && protocolOutputSeen
          ? acpError("agent_protocol_invalid", "The ACP agent protocol stream ended during initialization")
          : new AcpProcessError("ACP process exited unexpectedly");
        this.auditFailure(processError);
        this.connection?.close(processError);
      });
      boundedOutput.once("error", error => {
        this.connection?.close(error);
        void terminateProcessTreeAndWait(child, DEFAULT_CLOSE_TIMEOUT_MS);
      });

      const app = acp
        .client({ name: "agent-chatgpt-bridge" })
        .onRequest(acp.methods.client.session.requestPermission, ctx => this.handlePermission(ctx.params))
        .onRequest(acp.methods.client.fs.readTextFile, () => {
          throw new Error("ACP filesystem access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.fs.writeTextFile, () => {
          throw new Error("ACP filesystem access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.terminal.create, () => {
          throw new Error("ACP terminal access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.terminal.output, () => {
          throw new Error("ACP terminal access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.terminal.release, () => {
          throw new Error("ACP terminal access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.terminal.waitForExit, () => {
          throw new Error("ACP terminal access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.terminal.kill, () => {
          throw new Error("ACP terminal access is not supported by the bridge");
        })
        .onRequest(acp.methods.client.elicitation.create, () => {
          throw new Error("ACP elicitation is not supported by the bridge");
        });
      this.connection = app.connect(acp.ndJsonStream(
        Writable.toWeb(child.stdin),
        Readable.toWeb(boundedOutput) as unknown as ReadableStream<Uint8Array>,
      ));

      const initialized = await this.connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "agent-chatgpt-bridge", version: "5.0.6" },
        clientCapabilities: {},
      });
      if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
        throw acpError("agent_protocol_invalid", "ACP agent negotiated an unsupported protocol version");
      }
      this.protocolVersion = initialized.protocolVersion;
      this.agentCapabilities = initialized.agentCapabilities;
      this.agentInfo = initialized.agentInfo;
      this.audit("agent.acp.initialized", {
        protocolVersion: initialized.protocolVersion,
        agent: initialized.agentInfo?.name,
        agentVersion: initialized.agentInfo?.version,
      });

      const session = await this.connection.agent.buildSession({ cwd, mcpServers: [] }).start();
      this.session = session;
      this.audit("agent.acp.session.created", {
        protocolVersion: initialized.protocolVersion,
        sessionId: session.sessionId,
      });
    } catch (error) {
      this.auditFailure(error);
      await this.close().catch(() => undefined);
      if (error instanceof BridgeError && error.code === "agent_protocol_invalid") throw error;
      throw mapAcpError(error, "initialize");
    }
  }

  async next(input: AgentTurnInput, ctx: { signal?: AbortSignal }): Promise<AgentDecision> {
    if (ctx.signal?.aborted) throw acpError("client_cancelled", "External-agent turn was cancelled before start");
    if (!this.session || !this.connection) throw acpError("agent_adapter_failed", "ACP adapter is not initialized");
    if (this.turnInFlight) throw acpError("agent_adapter_failed", "ACP adapter does not support concurrent turns");
    this.turnInFlight = true;
    const timeoutMs = positiveOption("timeoutMs", this.options.timeoutMs, DEFAULT_TIMEOUT_MS);
    const cancelGraceMs = positiveOption("cancelGraceMs", this.options.cancelGraceMs, DEFAULT_CANCEL_GRACE_MS);
    const internal = new AbortController();
    let stopReason: "cancelled" | "timeout" | undefined;
    const onOuterAbort = () => {
      if (stopReason) return;
      stopReason = "cancelled";
      internal.abort(ctx.signal?.reason);
    };
    const onInternalAbort = () => {
      if (!this.session) return;
      this.audit("agent.acp.cancelled", { round: input.round, reason: stopReason });
      void this.connection?.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: this.session.sessionId,
      }).catch(() => undefined);
    };
    ctx.signal?.addEventListener("abort", onOuterAbort, { once: true });
    internal.signal.addEventListener("abort", onInternalAbort, { once: true });
    const timeout = setTimeout(() => {
      if (stopReason) return;
      stopReason = "timeout";
      internal.abort(new DOMException("ACP prompt timeout", "TimeoutError"));
    }, timeoutMs);
    this.audit("agent.acp.prompt.started", { round: input.round });

    let promptPromise: Promise<acp.PromptResponse> | undefined;
    try {
      promptPromise = this.session.prompt(textPrompt(input, this.firstPrompt), {
        cancellationSignal: internal.signal,
      });
      void promptPromise.catch(() => undefined);
      let text = "";
      while (true) {
        const update = await Promise.race([
          this.session.nextUpdate(),
          this.connection.closed.then(() => {
            throw new AcpProcessError("ACP connection closed");
          }),
          new Promise<never>((_, reject) => {
            internal.signal.addEventListener("abort", () => reject(internal.signal.reason), { once: true });
          }),
        ]);
        if (update.kind === "stop") {
          await promptPromise;
          if (stopReason) throw stopReason === "timeout"
            ? acpError("agent_adapter_timeout", `External ACP agent exceeded ${timeoutMs} ms turn timeout`)
            : acpError("client_cancelled", "External-agent turn was cancelled");
          this.firstPrompt = false;
          this.audit("agent.acp.prompt.completed", { round: input.round, stopReason: update.stopReason });
          return decisionFromText(text);
        }
        text += promptResponseText(update);
      }
    } catch (error) {
      if (stopReason) {
        if (promptPromise) {
          const promptSettled = await this.waitForPromptCleanup(promptPromise, cancelGraceMs);
          if (!promptSettled) await this.close().catch(() => undefined);
        }
        if (stopReason === "timeout") {
          throw acpError("agent_adapter_timeout", `External ACP agent exceeded ${timeoutMs} ms turn timeout`);
        }
        throw acpError("client_cancelled", "External-agent turn was cancelled");
      }
      throw mapAcpError(error, "prompt");
    } finally {
      clearTimeout(timeout);
      ctx.signal?.removeEventListener("abort", onOuterAbort);
      internal.signal.removeEventListener("abort", onInternalAbort);
      this.turnInFlight = false;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closing = true;
    const closeTimeoutMs = positiveOption("closeTimeoutMs", this.options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    const child = this.child;
    const connection = this.connection;
    const session = this.session;
    try {
      if (connection && session && this.agentCapabilities?.sessionCapabilities?.close) {
        await Promise.race([
          connection.agent.request(acp.methods.agent.session.close, { sessionId: session.sessionId }),
          sleep(closeTimeoutMs),
        ]).catch(() => undefined);
      }
      session?.dispose();
      connection?.close();
      try { child?.stdin.end(); } catch { /* already closed */ }
      if (child) {
        const exited = await waitForProcessExit(child, closeTimeoutMs);
        if (!exited) await terminateProcessTreeAndWait(child, closeTimeoutMs);
      }
      this.audit("agent.acp.closed", { protocolVersion: this.protocolVersion });
    } catch (error) {
      this.auditFailure(error);
      throw mapAcpError(error, "close");
    } finally {
      this.session = undefined;
      this.connection = undefined;
      this.child = undefined;
    }
  }

  private async waitForPromptCleanup(prompt: Promise<acp.PromptResponse>, graceMs: number): Promise<boolean> {
    let settled = false;
    const promptSettled = prompt.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.race([promptSettled, sleep(graceMs)]);
    return settled;
  }

  private async handlePermission(request: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    this.audit("agent.acp.permission.requested", {
      toolKind: request.toolCall.kind,
      optionCount: request.options.length,
    });
    const mode = this.options.permissionMode ?? "deny";
    let response: acp.RequestPermissionResponse;
    if (mode === "delegate") {
      if (!this.options.permissionResolver) {
        throw new Error("ACP permission delegation is not configured");
      }
      response = await this.options.permissionResolver(request);
    } else {
      response = selectedPermission(request, mode);
    }
    this.audit("agent.acp.permission.resolved", {
      outcome: response.outcome.outcome,
      selectedOption: response.outcome.outcome === "selected" ? response.outcome.optionId : undefined,
    });
    return response;
  }

  private audit(eventType: Parameters<NonNullable<AcpAgentAdapterOptions["audit"]>>[0]["eventType"], payload?: Record<string, unknown>): void {
    this.options.audit?.({ eventType, runId: this.runId, payload });
  }

  private auditFailure(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.audit("agent.acp.failed", { error: error instanceof BridgeError ? error.code : "protocol_or_process_failure" });
  }
}

export type { AcpAgentAdapterOptions, AcpAgentProfile, AcpPermissionMode } from "./types";
