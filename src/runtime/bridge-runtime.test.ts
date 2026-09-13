import { expect, test } from "bun:test";
import { assertCodexRouterDoesNotTargetBridge } from "./bridge-runtime";

test("codex-router provider refuses recursive routes to the bridge listener", () => {
  for (const baseUrl of [
    "http://127.0.0.1:8765/v1",
    "http://localhost:8765/_codex-router/example/v1",
    "http://[::1]:8765/v1",
  ]) {
    expect(() => assertCodexRouterDoesNotTargetBridge(baseUrl, 8765))
      .toThrow("refusing a recursive provider route");
  }
});

test("codex-router provider accepts a distinct local router port", () => {
  expect(() => assertCodexRouterDoesNotTargetBridge(
    "http://127.0.0.1:4202/_codex-router/example/v1",
    8765,
  )).not.toThrow();
});
