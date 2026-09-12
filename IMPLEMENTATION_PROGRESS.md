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
- Codex-router SSE parser hardened for CRLF frame delimiters split across transport chunks, with regression coverage.
- Pinned real codex-router process integration added to CI.
- CI run #141 fully green on macOS 15, Ubuntu latest, and Windows latest at `367844d`.
- Native launcher packaging and packaged-app smoke green on macOS, Ubuntu, and Windows.
- Live bridge-level codex-router verifier added for real routed continuity, transcript persistence, model pinning, capability leak detection, optional cancellation, and optional ChatGPT Web coexistence.

## Deterministic validation status

CI run #141 validated the P1 deterministic gates on macOS, Ubuntu, and Windows:

```text
[x] typecheck
[x] bridge/unit/integration tests
[x] launcher tests
[x] dependency/security verification gate
[x] native launcher packaging
[x] packaged-app smoke
[x] child-process codex-router bridge integration
[x] pinned real codex-router process integration
[x] CRLF split-boundary SSE regression
```

The deterministic codex-router coverage now includes two complementary paths:

1. a real `agent-chatgpt serve` child process with a deterministic local HTTP/SSE router peer, verifying public bridge surfaces and canonical history ownership;
2. a pinned real codex-router process with a deterministic fake upstream, verifying the actual router transport boundary without requiring external provider credentials.

Together they verify:

- authenticated bridge startup;
- combined `chatgpt-web/...` + `codex-router/...` model discovery;
- explicit routed session creation;
- two routed CLI turns;
- canonical persisted history replay on the second turn;
- no provider/model migration;
- Responses streaming translation;
- split CRLF framing across transport chunks;
- real codex-router model discovery and routed request transport;
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
- confirmation that caller-capability URL material never appears in live bridge responses/errors

The live codex-router work is now substantially automated by:

```sh
bun run smoke:codex-router
bun run smoke:codex-router:bridge
```

Optional real cancellation and ChatGPT Web coexistence checks are enabled with:

```sh
AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL=1
AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT=1
```

See `docs/release-validation-agent-bridge.md` and `docs/CODEX_ROUTER_SMOKE.md`.

## Remaining hardening

- Run the current branch CI after the new live-verifier tooling changes.
- Perform the live validation checklist above before calling P1 fully proven.
- Keep real provider-side 429 validation conditional on a safe test mechanism; deterministic mapping/no-fallback coverage already exists and paid-account exhaustion must not be used as a test strategy.

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
[x] pinned real codex-router process integration
[x] codex-router CRLF split-boundary parser regression fixed
[x] latest validated three-OS CI fully green
[x] package/smoke stages green on latest validated runtime head
[ ] live authenticated persistent-session test
[ ] live MCP test
[ ] live autonomous two-round test
[ ] live codex-router smoke checklist
```
