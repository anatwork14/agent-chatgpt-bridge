# Implementation Progress

Last updated: 2026-09-13

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
- Native launcher packaging and packaged-app smoke green on macOS, Ubuntu, and Windows.
- Live bridge-level codex-router verifier added for real routed continuity, transcript persistence, model pinning, capability leak detection, optional cancellation, and optional ChatGPT Web coexistence.
- P2 provider-health state machine: `healthy`, `unavailable`, `rate_limited`, `cooldown`, `misconfigured`.
- Secret-safe health observations for discovery, validation, turns, and explicit policy state.
- Authenticated read-only `/bridge/v1/providers/health` endpoint.
- Explicit provider routing policy with fallback disabled by default.
- Ordered fallback only for explicitly configured trigger states; no mid-turn or implicit retry/fallback.
- Explicit rate-limit cooldown policy with local enforcement and deterministic expiry semantics.
- Direct-provider and model-router traffic share the same health enforcement boundary.
- Bridge-owned `provider.route` decisions are persisted before provider execution; audit failure is fail-closed.
- Fallback turns do not migrate the persistent session provider/model identity.
- Explicit fallback models are validated before route execution; nonexistent or invalid routes fail closed.
- Structured `BridgeError` codes are preserved in terminal turn persistence.
- Startup provider/policy validation runs before bridge-owned SQLite is opened.

## Deterministic validation status

### P1 — codex-router provider plane

P1 validated head: `74d7826`.

CI run #149 passed completely on macOS 15, Ubuntu latest, and Windows latest, including:

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
[x] live-verifier deterministic subprocess coverage
```

The deterministic codex-router coverage includes two complementary paths:

1. a real `agent-chatgpt serve` child process with a deterministic local HTTP/SSE router peer, verifying public bridge surfaces and canonical history ownership;
2. a pinned real codex-router process with a deterministic fake upstream, verifying the actual router transport boundary without requiring external provider credentials.

Together they verify authenticated bridge startup, combined model discovery, explicit routed session creation, two-turn canonical history, no provider/model migration, Responses streaming translation, split CRLF framing, real codex-router transport, cancellation plumbing, and authenticated process cleanup.

### P2 — provider health and explicit policy

P2 validated implementation head: `7edb493`.

CI run #178 passed completely on macOS 15, Ubuntu latest, and Windows latest. The dedicated pinned real codex-router process job and actionlint also passed.

The P2 deterministic checkpoint verifies:

```text
[x] five bridge-level health states
[x] raw provider diagnostics excluded from health observations
[x] cancellation/caller errors remain health-neutral
[x] authenticated provider-health REST surface
[x] fallback disabled by default
[x] explicit ordered fallback with explicit trigger states
[x] no opportunistic mid-turn fallback
[x] retryable fallback-candidate resolution may continue through explicit order
[x] non-retryable ambiguity/configuration failures stop immediately
[x] explicit fallback model validation before execution
[x] optional explicit rate-limit cooldown
[x] cooldown blocks concrete-provider calls locally
[x] cooldown expiry does not manufacture a healthy observation
[x] direct concrete-provider sessions obey health/cooldown enforcement
[x] route decision persisted before provider execution
[x] audit persistence failure prevents provider execution
[x] fallback does not mutate persistent session identity
[x] structured provider error codes preserved in turn persistence
[x] invalid health policy fails before bridge SQLite is opened
[x] package/smoke stages green on all three CI platforms
```

P2 remains stacked on P1. This deterministic checkpoint does not convert P1's live-only validation gates into CI evidence and does not make either draft PR release-ready by itself.

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

The live codex-router work is substantially automated by:

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

## Remaining hardening / sequencing

- Perform the live validation checklist above before calling P1 fully proven.
- Keep real provider-side 429 validation conditional on a safe test mechanism; paid-account exhaustion must not be used to manufacture the condition.
- Keep PR #2 and stacked PR #3 draft while P1 live sign-off is outstanding.
- Do not start P3 ACP/agent-adapter work as if P1/P2 release sign-off were complete. P2 deterministic implementation is validated, but milestone sequencing remains explicit.

## Known design note

The generic `agent-chatgpt serve` composition currently owns its local bridge listener while preserving the original upstream Codex daemon separately. Both reuse the same upstream browser/provider implementation. A future single-listener composition is possible, but should only be attempted as a small lifecycle injection after release gates are green; it is not worth destabilizing the inherited `/v1` server or browser worker during core validation.

The P2 routing policy is intentionally an injected bridge policy rather than a new role-level collaboration-policy DSL. Role routing and richer collaboration policy belong to later milestones and were not pulled forward into P2.

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
[x] P1 deterministic three-OS CI fully green
[x] P2 provider-health state machine
[x] P2 authenticated provider-health API
[x] P2 explicit-only fallback policy
[x] P2 enforced optional cooldown
[x] P2 auditable route decisions
[x] P2 no persistent session migration on fallback
[x] P2 deterministic three-OS CI fully green
[ ] live authenticated persistent-session test
[ ] live MCP test
[ ] live autonomous two-round test
[ ] live codex-router smoke checklist
[ ] P3 ACP agent adapters
```
