import { expect, test } from "bun:test";
import { $ } from "bun";

test("CLI basics", async () => {
  const result = await $`export PATH="$HOME/.bun/bin:$PATH" && bun src/cli/index.ts`.quiet();
  const output = result.stdout.toString();
  expect(output).toContain("Universal Agent -> ChatGPT Web bridge.");
  expect(output).toContain("agent-chatgpt serve");
});
