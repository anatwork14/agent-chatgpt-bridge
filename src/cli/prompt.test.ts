import { expect, test } from "bun:test";
import { composePrompt } from "./prompt";

test("composePrompt preserves stdin content and separates a prefix", () => {
  expect(composePrompt("diff --git a/x b/x\n+change\n", "Review this diff carefully"))
    .toBe("Review this diff carefully\n\ndiff --git a/x b/x\n+change\n");
});

test("composePrompt supports prefix-only and message-only prompts", () => {
  expect(composePrompt("hello")).toBe("hello");
  expect(composePrompt("", "  summarize  ")).toBe("summarize");
});
