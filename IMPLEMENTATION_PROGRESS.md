# Implementation Progress

Last updated: 2026-09-12

## Completed

- Upstream baseline imported and pinned.
- Generic bridge domain types and provider interface.
- Real ChatGPT Web provider facade around the upstream adapter.
- Account-aware model discovery.
- Persistent session manager and canonical SQLite transcript.
- Terminal turn persistence and interrupted-turn recovery.
- Session isolation and serialization.
- Cancellation propagation.
- Local content/attachment policy.
- Turn scheduling and bounded concurrency primitives.
- REST `/bridge/v1` API with SSE and bearer-token protection.
- Idempotency for supported non-streaming mutations.
- Agent → ChatGPT MCP tools.
- Strict subprocess JSONL external-agent adapter.
- Bounded autonomous collaboration controller.
- Real `agent-chatgpt` CLI/runtime composition using the authenticated upstream provider.
- Runtime-home SQLite integration.
- Hono security upgrade to 4.13.7.
- Cross-platform CI test coverage expanded to bridge tests.
- PR CI concurrency added so superseded runs cancel automatically.
- Upstream Codex compatibility retained.

## In validation

- Full macOS/Linux/Windows verification after the latest cancellation and test-isolation fixes.
- Launcher packaging and smoke stages after the full test suite becomes green.
- Dependency audit after tests/typecheck.

## Live validation still required

These cannot be honestly proven by fake-provider CI:

- real authenticated ChatGPT Web persistent session milestone (`8427` test)
- real two-session browser isolation
- live cancellation cleanup
- MCP ask/continue against a signed-in account
- multi-round autonomous relay against ChatGPT Web
- restart/continuity behavior with the real retained browser conversation

See `docs/release-validation-agent-bridge.md`.

## Known design note

The generic `agent-chatgpt serve` composition currently owns its local bridge listener while preserving the original upstream Codex daemon separately. Both reuse the same upstream browser/provider implementation. A future single-listener composition is possible, but should only be attempted as a small lifecycle injection after release gates are green; it is not worth destabilizing the inherited `/v1` server or browser worker during core validation.

## Definition-of-done tracking

```text
[x] generic session creation
[x] canonical persisted transcript
[x] multi-session isolation in fake-provider tests
[x] REST API
[x] SSE
[x] cancellation primitives
[x] SQLite persistence
[x] CLI
[x] MCP
[x] strict subprocess JSONL
[x] bounded autonomous relay
[x] local bearer-token boundary
[x] fail-closed provider terminal handling
[x] Codex compatibility retained in code/tests
[ ] latest three-OS CI fully green
[ ] package/smoke stages green on latest head
[ ] live authenticated persistent-session test
[ ] live MCP test
[ ] live autonomous two-round test
```
