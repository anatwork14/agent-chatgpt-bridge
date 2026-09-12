import { expect, test } from "bun:test";
import { SubprocessJsonlAdapter } from "./subprocess-jsonl";
import { BridgeError } from "../core/errors";

function bunScript(source: string, options = {}) {
  return new SubprocessJsonlAdapter([process.execPath, "-e", source], options);
}

const input = {
  runId: "run_1",
  objective: "Test objective",
  round: 1,
};

test("Subprocess JSONL adapter exchanges one versioned protocol frame", async () => {
  const adapter = bunScript(`
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", line => {
      const parsed = JSON.parse(line);
      console.error("human-readable diagnostic");
      console.log(JSON.stringify({ version: 1, type: "message", content: "Got objective: " + parsed.objective }));
    });
  `);

  const result = await adapter.next(input, {});
  expect(result.type).toBe("message");
  if (result.type === "message") {
    expect(result.content).toBe("Got objective: Test objective");
  }
});

test("Subprocess JSONL rejects multiple stdout protocol frames", async () => {
  const adapter = bunScript(`
    process.stdin.resume();
    process.stdin.on("end", () => {
      console.log(JSON.stringify({ version: 1, type: "done", summary: "first" }));
      console.log(JSON.stringify({ version: 1, type: "done", summary: "second" }));
    });
  `);

  expect(adapter.next(input, {})).rejects.toMatchObject({ code: "agent_protocol_invalid" });
});

test("Subprocess JSONL rejects malformed stdout instead of treating it as a log", async () => {
  const adapter = bunScript(`
    process.stdin.resume();
    process.stdin.on("end", () => console.log("not-json"));
  `);

  try {
    await adapter.next(input, {});
    throw new Error("expected adapter to reject");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe("agent_protocol_invalid");
  }
});

test("Subprocess JSONL validates protocol version", async () => {
  const adapter = bunScript(`
    process.stdin.resume();
    process.stdin.on("end", () => console.log(JSON.stringify({ version: 2, type: "done", summary: "wrong version" })));
  `);
  expect(adapter.next(input, {})).rejects.toMatchObject({ code: "agent_protocol_invalid" });
});

test("Subprocess JSONL enforces turn timeout", async () => {
  const adapter = bunScript(`setInterval(() => {}, 1000);`, { timeoutMs: 25 });
  expect(adapter.next(input, {})).rejects.toMatchObject({ code: "agent_adapter_timeout" });
});
