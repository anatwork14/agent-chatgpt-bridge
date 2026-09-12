import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { BridgeError } from "../core/errors";
import type {
  ExternalAgentAdapter,
  AgentTurnInput,
  AgentDecision,
  BridgeContentPart,
} from "../core/domain";

export interface SubprocessJsonlOptions {
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;

function safeEnvironment(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const keys = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "TMP", "TEMP",
    "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

function terminateTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

function bridgeParts(value: unknown): BridgeContentPart[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  for (const part of value) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new Error("attachment entries must be objects");
    }
    const type = (part as Record<string, unknown>).type;
    if (type !== "text" && type !== "image" && type !== "resource") {
      throw new Error(`unsupported attachment type: ${String(type)}`);
    }
  }
  return value as BridgeContentPart[];
}

function parseDecision(line: string): AgentDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("protocol response must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`unsupported subprocess protocol version: ${String(record.version)}`);
  }
  switch (record.type) {
    case "message":
      if (typeof record.content !== "string") throw new Error("message.content must be a string");
      return {
        type: "message",
        content: record.content,
        attachments: bridgeParts(record.attachments),
      };
    case "done":
      if (typeof record.summary !== "string") throw new Error("done.summary must be a string");
      return { type: "done", summary: record.summary };
    case "pause":
      if (typeof record.reason !== "string") throw new Error("pause.reason must be a string");
      return { type: "pause", reason: record.reason };
    case "error":
      if (typeof record.message !== "string" || typeof record.retryable !== "boolean") {
        throw new Error("error response requires string message and boolean retryable");
      }
      return { type: "error", message: record.message, retryable: record.retryable };
    default:
      throw new Error(`unsupported subprocess response type: ${String(record.type)}`);
  }
}

export class SubprocessJsonlAdapter implements ExternalAgentAdapter {
  public readonly id = "subprocess-jsonl";

  constructor(
    private readonly command: string[],
    private readonly options: SubprocessJsonlOptions = {},
  ) {
    if (command.length === 0 || !command[0]?.trim()) {
      throw new BridgeError("agent_protocol_invalid", "subprocess-jsonl requires a non-empty command", false);
    }
  }

  async next(input: AgentTurnInput, ctx: { signal?: AbortSignal }): Promise<AgentDecision> {
    if (ctx.signal?.aborted) {
      throw new BridgeError("client_cancelled", "External-agent turn was cancelled before start", false);
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxStdoutBytes = this.options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
    const [command, ...args] = this.command;

    return new Promise<AgentDecision>((resolve, reject) => {
      const child = spawn(command!, args, {
        cwd: this.options.cwd ?? process.cwd(),
        env: safeEnvironment(this.options.env),
        stdio: ["pipe", "pipe", "inherit"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      if (!child.stdout || !child.stdin) {
        reject(new BridgeError("agent_adapter_failed", "Failed to create subprocess stdio pipes", false));
        terminateTree(child);
        return;
      }

      let settled = false;
      let stdoutBytes = 0;
      const protocolLines: string[] = [];
      const fail = (error: BridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        terminateTree(child);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new BridgeError(
        "agent_adapter_timeout",
        `External agent exceeded ${timeoutMs} ms turn timeout`,
        false,
      )), timeoutMs);

      const onAbort = () => fail(new BridgeError(
        "client_cancelled",
        "External-agent turn was cancelled",
        false,
      ));
      ctx.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutBytes += Buffer.byteLength(chunk);
        if (stdoutBytes > maxStdoutBytes) {
          fail(new BridgeError(
            "agent_protocol_invalid",
            `External agent stdout exceeded ${maxStdoutBytes} bytes`,
            false,
          ));
        }
      });

      const readline = createInterface({ input: child.stdout });
      readline.on("line", line => {
        if (settled || !line.trim()) return;
        protocolLines.push(line);
        if (protocolLines.length > 1) {
          fail(new BridgeError(
            "agent_protocol_invalid",
            "External agent must emit exactly one JSONL response object on stdout; write logs to stderr",
            false,
          ));
        }
      });

      child.once("error", error => {
        fail(new BridgeError("agent_adapter_failed", `Agent process failed: ${error.message}`, false));
      });

      child.once("close", code => {
        if (settled) return;
        if (code !== 0) {
          fail(new BridgeError(
            "agent_adapter_failed",
            `External agent exited with code ${String(code)}`,
            false,
          ));
          return;
        }
        if (protocolLines.length !== 1) {
          fail(new BridgeError(
            "agent_protocol_invalid",
            `External agent emitted ${protocolLines.length} protocol responses; exactly one is required`,
            false,
          ));
          return;
        }
        try {
          const decision = parseDecision(protocolLines[0]!);
          settled = true;
          cleanup();
          resolve(decision);
        } catch (error) {
          fail(new BridgeError(
            "agent_protocol_invalid",
            error instanceof Error ? error.message : String(error),
            false,
          ));
        }
      });

      const cleanup = () => {
        clearTimeout(timeout);
        ctx.signal?.removeEventListener("abort", onAbort);
        readline.close();
      };

      const payload = {
        version: 1,
        type: "turn",
        run_id: input.runId,
        objective: input.objective,
        round: input.round,
        last_chatgpt_response: input.lastChatGptResponse,
        transcript: input.transcript,
        workspace: input.workspace,
      };

      child.stdin.on("error", error => {
        if (!settled) fail(new BridgeError("agent_adapter_failed", `Agent stdin failed: ${error.message}`, false));
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}
