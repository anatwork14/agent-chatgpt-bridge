import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BridgeError } from "../core/errors";

export interface AgentAdapterContext {
  runId: string;
  objective: string;
  round: number;
  lastChatGptResponse?: { text: string };
}

export type AgentAdapterResult = 
  | { type: "message", content: string }
  | { type: "done", summary: string };

export class SubprocessJsonlAdapter {
  constructor(private command: string[]) {}

  async runTurn(ctx: AgentAdapterContext, abortSignal?: AbortSignal): Promise<AgentAdapterResult> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = this.command;
      const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], signal: abortSignal });

      child.on("error", (err) => {
        reject(new BridgeError("agent_failed", `Agent process failed: ${err.message}`));
      });

      const rl = createInterface({ input: child.stdout });

      let result: AgentAdapterResult | null = null;

      rl.on("line", (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "message" || parsed.type === "done") {
            result = parsed;
          }
        } catch (e) {
          // ignore non-json lines or log them
          console.error(`[Agent ${cmd}] ${line}`);
        }
      });

      child.on("close", (code) => {
        if (result) {
          resolve(result);
        } else {
          reject(new BridgeError("agent_failed", `Agent exited with code ${code} without yielding a valid JSON result.`));
        }
      });

      const payload = {
        version: 1,
        type: "turn",
        run_id: ctx.runId,
        objective: ctx.objective,
        round: ctx.round,
        last_chatgpt_response: ctx.lastChatGptResponse,
      };

      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    });
  }
}
