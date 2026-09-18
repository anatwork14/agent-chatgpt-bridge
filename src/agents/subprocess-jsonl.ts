import { createInterface } from "node:readline";
import { BridgeError } from "../core/errors";
import { spawnOwnedAgentProcess, terminateProcessTree } from "./process";
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
      const child = spawnOwnedAgentProcess([command!, ...args], {
        cwd: this.options.cwd ?? process.cwd(),
        env: this.options.env,
      });
      if (!child.stdout || !child.stdin) {
        reject(new BridgeError("agent_adapter_failed", "Failed to create subprocess stdio pipes", false));
        terminateProcessTree(child);
        return;
      }

      let settled = false;
      let stdoutBytes = 0;
      const protocolLines: string[] = [];
      const fail = (error: BridgeError) => {
        if (settled) return;
        settled = true;
        cleanup();
        terminateProcessTree(child);
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

      const payload: Record<string, unknown> = {
        version: 1,
        type: "turn",
        run_id: input.runId,
        objective: input.objective,
        round: input.round,
        last_chatgpt_response: input.lastChatGptResponse,
        transcript: input.transcript,
        workspace: input.workspace,
      };

      if (input.collaboration) {
        payload.collaboration = {
          participant_id: input.collaboration.participantId,
          role_id: input.collaboration.roleId,
          role_name: input.collaboration.roleName,
          system_instructions: input.collaboration.systemInstructions,
          sequence_index: input.collaboration.sequenceIndex,
          prior_turns: input.collaboration.priorTurns.map(t => ({
            participant_id: t.participantId,
            role_id: t.roleId,
            decision_type: t.decisionType,
            text: t.text,
          })),
          ...(input.collaboration.dag
            ? {
                dag: {
                  node_id: input.collaboration.dag.nodeId,
                  instruction: input.collaboration.dag.instruction,
                  dependency_node_ids: input.collaboration.dag.dependencyNodeIds,
                  predecessor_message_ids: input.collaboration.dag.predecessorMessageIds,
                  attempt: input.collaboration.dag.attempt,
                },
              }
            : {}),
        };
      }

      child.stdin.on("error", error => {
        if (!settled) fail(new BridgeError("agent_adapter_failed", `Agent stdin failed: ${error.message}`, false));
      });
      child.stdin.end(`${JSON.stringify(payload)}\n`);
    });
  }
}
