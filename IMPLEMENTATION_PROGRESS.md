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
- Optional `codex-router` downstream provider plane through the OpenAI Responses boundary.
- Namespaced `codex-router/<model-id>` model discovery with no silent fallback.
- Loopback-only codex-router endpoint policy by default plus recursive bridge-route prevention.
- Codex-router cancellation, explicit rate-limit/error mapping, and capability-URL redaction.
- Canonical bridge history preserved across multi-turn codex-router sessions.
- Real child-process bridge integration test covering CLI/server/auth/model discovery/two routed turns/history/shutdown.
- Three-OS CI fully green on the child-process integration head (`b905273`).
- Native launcher packaging and packaged-app smoke green on macOS, Ubuntu, and Windows.

## Deterministic validation status

The latest CI matrix validates all deterministic gates on macOS, Ubuntu, and Windows:

```text
[x] typecheck
[x] bridge/unit/integration tests
[x] launcher tests
[x] dependency/security verification gate
[x] native launcher packaging
[x] packaged-app smoke
[x] child-process codex-router bridge integration
```

The codex-router deterministic integration uses a real `agent-chatgpt serve` child process and a local deterministic HTTP/SSE router peer. It verifies:

- authenticated bridge startup;
- combined `chatgpt-web/...` + `codex-router/...` model discovery;
- explicit routed session creation;
- two routed CLI turns;
- canonical persisted history replay on the second turn;
- no provider/model migration;
- authenticated bridge shutdown and process cleanup.

## Live validation still required

These cannot be honestly proven by fake-provider or deterministic CI alone:

### ChatGPT Web

- real authenticated ChatGPT Web persistent session milestone (`8427` test)
- real two-session browser isolation
- live cancellation cleanup
- MCP ask/continue against a signed-in account
- multi-round autonomous relay against ChatGPT Web
- restart/continuity behavior with the real retained browser conversation

### codex-router

- direct live routed-model smoke against a local codex-router installation
- bridge model discovery against the real router capability URL
- real routed text turn and same-session continuation
- coexistence with an independent ChatGPT Web session
- downstream cancellation against a genuinely long-running routed request
- real 429/provider-error propagation when safely reproducible
- confirmation that caller-capability URL material never appears in logs/errors

See `docs/release-validation-agent-bridge.md` and `docs/CODEX_ROUTER_SMOKE.md`.

## Remaining hardening

- Harden the codex-router SSE parser for a CRLF delimiter split exactly across transport chunks, with a regression test.
- Run the complete three-OS matrix again after that parser-only change.
- Perform the live validation checklist above before calling the release fully proven.

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
[x] optional codex-router provider plane
[x] codex-router model namespace/discovery
[x] codex-router two-turn canonical-history integration
[x] child-process bridge/router integration test
[x] latest three-OS CI fully green
[x] package/smoke stages green on latest validated head
[ ] codex-router CRLF split-boundary parser regression fixed
[ ] live authenticated persistent-session test
[ ] live MCP test
[ ] live autonomous two-round test
[ ] live codex-router smoke checklist
```
