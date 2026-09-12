import { expect, test } from "bun:test";
import { $ } from "bun";

test("CLI basics", async () => {
  const result = await $`export PATH="$HOME/.bun/bin:$PATH" && bun src/cli/index.ts`.quiet();
  expect(result.stdout.toString()).toContain("Usage: agent-chatgpt");
});
