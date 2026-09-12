import { expect, test } from "bun:test";
import { $ } from "bun";

test("CLI basics", async () => {
  const result = await $`export PATH="$HOME/.bun/bin:$PATH" && bun src/cli/index.ts`.quiet();
  const output = result.stdout.toString();
  expect(output).toContain("Universal Agent -> ChatGPT Web bridge.");
  expect(output).toContain("agent-chatgpt app");
  expect(output).toContain("agent-chatgpt serve");
  expect(output).toContain("agent-chatgpt stop");
  expect(output).toContain("agent-chatgpt login");
  expect(output).toContain("agent-chatgpt doctor [--json]");
  expect(output).toContain("agent-chatgpt browser-smoke");
  expect(output).toContain("agent-chatgpt session cancel SESSION");
  expect(output).toContain("agent-chatgpt run list");
  expect(output).toContain("--prompt-prefix TEXT");
});