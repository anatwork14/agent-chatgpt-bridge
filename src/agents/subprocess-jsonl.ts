import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BridgeError } from "../core/errors";
import type { ExternalAgentAdapter, AgentTurnInput, AgentDecision } from "../core/domain";

export class SubprocessJsonlAdapter implements ExternalAgentAdapter {
  public readonly id = "subprocess-jsonl";

  constructor(private command: string[]) {}

  async next(input: AgentTurnInput, ctx: { signal?: AbortSignal }): Promise<AgentDecision> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = this.command;
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], signal: ctx.signal });

      child.on("error", (err) => {
        reject(new BridgeError("agent_failed", `Agent process failed: ${err.message}`));
      });

      const rl = createInterface({ input: child.stdout });

      let result: AgentDecision | null = null;

      rl.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          if (["message", "done", "pause", "error"].includes(parsed.type)) {
            result = parsed;
          }
        } catch (e) {
          console.error(`[Agent ${cmd}] ${line}`);
        }
      });

      child.on("close", (code) => {
        if (result) {
          resolve(result);
        } else {
          resolve({
            type: "error",
            message: `Agent exited with code ${code} without yielding a valid JSON result.`,
            retryable: false
          });
        }
      });

      const payload = {
        version: 1,
        type: "turn",
        run_id: input.runId,
        objective: input.objective,
        round: input.round,
        last_chatgpt_response: input.lastChatGptResponse,
      };

      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    });
  }
}
