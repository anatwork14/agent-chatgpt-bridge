import { expect, test } from "bun:test";
import { SubprocessJsonlAdapter } from "./subprocess-jsonl";

test("Subprocess JSONL adapter", async () => {
  const script = `
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin }, {});
    rl.on("line", (line) => {
      const parsed = JSON.parse(line);
      console.log(JSON.stringify({ type: "message", content: "Got objective: " + parsed.objective }));
    }, {});
  `;

  const adapter = new SubprocessJsonlAdapter(["bun", "-e", script]);
  
  const res = await adapter.next({
    runId: "run_1",
    objective: "Test objective",
    round: 1
  }, {});

  expect(res.type).toBe("message");
  if (res.type === "message") {
    expect(res.content).toBe("Got objective: Test objective");
  }
}, {});
