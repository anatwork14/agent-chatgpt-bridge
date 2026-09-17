# Validation Audit

This document records an independent validation of `feat/universal-agent-bridge` against `implementation.md`.

## Status

The branch is currently an **incomplete prototype**, not a release candidate.

## Confirmed critical findings

1. **New tests are not executed by the package test script.** `package.json` runs `bun test ./tests`, while bridge tests live under `src/**/*.test.ts`.
2. **The ChatGPT provider facade does not match the upstream `AdapterEvent` contract.** It checks nonexistent `turn_started` / `completed` event types and reads `event.delta` instead of `text_delta.text`.
3. **The provider facade can fabricate success.** If the adapter returns without a terminal event, it converts `incomplete` to `completed`; the project requires fail-closed behavior.
4. **Model discovery is hard-coded and stale.** The facade/REST routes advertise `gpt-4o` / `gpt-4` instead of using the existing account-aware ChatGPT Web route catalog.
5. **The Codex compatibility shim is type-incompatible.** It emits `inputSchema` where `CodexTool` expects `parameters`, and its JSON-schema output omits required fields.
6. **Session persistence types disagree with the session manager.** `SessionData.status` only permits `active | closed`, while `SessionManager` writes `created`, `busy`, and `ready`.
7. **Turn records are created but never transitioned to terminal state.** `TurnStore` has no update path and `SessionManager` leaves turns at `started`.
8. **The new CLI is not wired to the real provider.** `agent-chatgpt serve` instantiates `FakeConversationProvider`.
9. **REST route prefixes disagree.** `createBridgeApi()` registers `/sessions` etc., while the CLI requests `/bridge/v1/...`.
10. **Native REST authentication is a no-op.** The middleware calls `next()` without checking a token.
11. **Autonomous cancellation/timeouts do not cover active ChatGPT turns.** The abort signal is applied to the external subprocess step but not the `SessionManager.send()` browser turn.
12. **The required run-cancel route is missing.**
13. **The subprocess JSONL adapter does not enforce exactly one protocol response.** Malformed stdout is logged and multiple valid lines are accepted with the last one winning.
14. **MCP is missing `chatgpt_list_models` and uses hard-coded `auto` models rather than session/account-aware model selection.**
15. **Release-validation documentation currently describes commands/features not implemented by the CLI.**

## Validation method

A review branch and draft PR are used so the repository's existing macOS/Linux/Windows CI can provide executable evidence. Fixes should be made on the review branch and merged only when CI plus architectural acceptance checks pass.
