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
- Cancellation propagation with terminal ChatGPT Web browser-owner retirement for explicit bridge cancellation.
- Local content/attachment policy.
- Turn scheduling and bounded concurrency primitives.
- REST `/bridge/v1` API with SSE and bearer-token protection.
- Idempotency for supported non-streaming mutations.
- Agent → ChatGPT MCP tools with correct stdio lifetime ownership.
- Strict subprocess JSONL external-agent adapter.
- Bounded autonomous collaboration controller.
- Real `agent-chatgpt` CLI/runtime composition using the authenticated upstream provider.
- Runtime-home SQLite integration.
- Hono security upgrade to 4.13.7.
- Cross-platform CI test coverage expanded to bridge tests.
- PR CI concurrency added so superseded runs cancel automatically.
- Upstream Codex compatibility retained.
- Optional `codex-router` downstream provider plane through the OpenAI Responses boundary.
- Namespaced `codex-router/<model-id>` discovery with no silent fallback.
- Loopback-only codex-router endpoint policy by default plus recursive bridge-route prevention.
- Codex-router cancellation, explicit rate-limit/error mapping, and capability-URL redaction.
- Canonical bridge history preserved across multi-turn codex-router sessions.
- Real child-process bridge integration and pinned real codex-router process integration in CI.
- Codex-router SSE parser hardened for CRLF frame delimiters split across transport chunks.
- Native launcher packaging and packaged-app smoke green on macOS, Ubuntu, and Windows.
- Live bridge verifier for routed continuity, transcript persistence, model pinning, capability leak detection, downstream cancellation, and ChatGPT Web coexistence.
- Live-verifier path hardening so public `/v1` is not mistaken for secret capability material.
- P2 provider-health state machine: `healthy`, `unavailable`, `rate_limited`, `cooldown`, `misconfigured`.
- Secret-safe health observations for discovery, validation, turns, and explicit policy state.
- Authenticated read-only `/bridge/v1/providers/health` endpoint.
- Explicit provider routing policy with fallback disabled by default.
- Ordered fallback only for explicitly configured trigger states; no mid-turn or implicit retry/fallback.
- Explicit rate-limit cooldown policy with local enforcement and deterministic expiry semantics.
- Direct-provider and model-router traffic share the same health enforcement boundary.
- Bridge-owned `provider.route` decisions are persisted before provider execution; audit failure is fail-closed.
- Fallback turns do not migrate persistent session provider/model identity.
- Explicit fallback models are validated before route execution.
- Structured `BridgeError` codes are preserved in terminal turn persistence.
- Startup provider/policy validation runs before bridge-owned SQLite is opened.
- Model-router cancellation delegates to the exact selected concrete provider and remains compatible with P2 health/policy wrappers.
- P2 ancestry synchronized to fully signed-off P1 through a real two-parent merge with no force rewrite or duplicated P1 history.

## P1 — codex-router provider plane

### Final signed-off head

`c8ee167ab15a5dd537a13d3c714e142acc59ce3f`

Final P1 fixes after the previous deterministic checkpoint:

- `8d092306f366c65eef72bae4bb7a59a8294b4d2f` — keep MCP stdio runtime alive until disconnect.
- `3b917750f4d7540dcf8ab28d0e559c96591f3d5e` — retire ChatGPT Web bridge turns on explicit cancellation.
- `c8ee167ab15a5dd537a13d3c714e142acc59ce3f` — route cancellation through model-router to the concrete active provider.

CI run #185 / `34747263537` passed completely:

```text
[x] actionlint
[x] pinned real codex-router process integration
[x] macOS 15 verify + package + packaged-app smoke
[x] Ubuntu verify + package + AppImage ABI + packaged-app smoke
[x] Windows PowerShell launcher validation + verify + package + packaged-app smoke
```

Local verification on the signed-off head reported 1073 passing tests, 2 skipped, 0 failed; focused P1 tests 65 passing; typecheck, audits, builds, and relocatable smoke passed.

### Live release validation

```text
[x] production ChatGPT Web authenticated
[x] independent ChatGPT turn
[x] persistent-session 8427 marker recovery
[x] direct real codex-router smoke
[x] chatgpt-web and codex-router namespaces
[x] real routed turn
[x] routed same-session semantic continuity
[x] routed transcript persistence
[x] provider/model pinning
[x] capability/secret leak inspection — NONE
[x] routed downstream cancellation
[x] ChatGPT/router coexistence
[x] two-session semantic isolation — no cross-marker contamination
[x] ChatGPT cancellation cleanup
[x] same-session post-cancel reuse
[x] MCP chatgpt_create_session
[x] MCP chatgpt_ask
[x] MCP chatgpt_continue
[x] autonomous relay >= 2 rounds
[x] autonomous bounded termination
[x] restart reconstruction/continuity
```

A genuine provider-side 429 was intentionally not manufactured because no safe reproduction mechanism was available. Paid-account exhaustion is not an acceptable validation mechanism and this gate remains conditional rather than blocking.

**P1 LIVE SIGN-OFF: YES**

PR #2 is Ready for review and remains intentionally unmerged until an explicit merge decision.

## P2 — provider health and explicit routing policy

P2 core implementation checkpoint: `7edb493` — CI #178 fully green.

Prior combined checkpoint: `1024b3301ced497fdddc5fca88e0259ede3d7b19` — CI #183 fully green.

Current synchronized P2 head before this documentation update: `356ded7ba910d857a12476d20c2a371b6ae8096f`.

That head is a two-parent merge of previous P2 and signed-off P1 `c8ee167...`. Compare from P1 reports `behind_by=0` and merge base exactly the signed-off P1 head.

CI run #186 / `34748073113` passed completely on the combined P1+P2 stack:

```text
[x] actionlint
[x] pinned real codex-router process integration
[x] macOS 15 verify + package + packaged-app smoke
[x] Ubuntu verify + package + AppImage ABI + packaged-app smoke
[x] Windows PowerShell launcher validation + verify + package + packaged-app smoke
```

P2 deterministic coverage includes:

```text
[x] five bridge-level provider health states
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
[x] cooldown expiry does not manufacture healthy state
[x] direct concrete-provider sessions obey health/cooldown enforcement
[x] route decision persisted before provider execution
[x] audit persistence failure prevents provider execution
[x] fallback does not mutate persistent session identity
[x] structured provider error codes preserved in turn persistence
[x] invalid health policy fails before bridge SQLite opens
[x] signed-off P1 MCP lifecycle fix inherited
[x] signed-off P1 ChatGPT cancellation retirement inherited
[x] model-router cancellation delegation preserved through P2 routing
[x] full three-OS combined stack CI green
```

P2 has no remaining blocker inherited from P1. PR #3 may move to Ready for review after the documentation checkpoint remains green.

## Sequencing

Current dependency state:

```text
P1 deterministic      DONE
P1 live sign-off      DONE
P2 deterministic      DONE
P2 + signed-off P1    DONE
P3 ACP adapters       NOT STARTED
P4/P5 roles + DAG     NOT STARTED
```

Do not merge PR #2 or PR #3 automatically. Merge sequencing requires an explicit decision. Because PR #3 is stacked on PR #2, the clean order is P1 first, then P2. Only after that sequencing is settled should P3 ACP implementation begin from the correct base.

## Known design notes

The generic `agent-chatgpt serve` composition owns its local bridge listener while preserving the original upstream Codex daemon separately. Both reuse the same upstream browser/provider implementation. A future single-listener composition may be possible, but it is not part of P1/P2.

The P2 routing policy is intentionally an injected bridge policy rather than a role-level collaboration-policy DSL. Role routing and richer collaboration policy belong to later milestones.

## Definition-of-done tracking

```text
[x] generic session creation
[x] canonical persisted transcript
[x] multi-session isolation
[x] REST API
[x] SSE
[x] cancellation primitives
[x] terminal same-session ChatGPT cancellation cleanup
[x] SQLite persistence
[x] CLI
[x] MCP
[x] MCP real stdio lifetime regression
[x] strict subprocess JSONL
[x] bounded autonomous relay
[x] local bearer-token boundary
[x] fail-closed provider terminal handling
[x] Codex compatibility retained in code/tests
[x] optional codex-router provider plane
[x] codex-router namespace/discovery
[x] codex-router two-turn canonical-history integration
[x] child-process bridge/router integration
[x] pinned real codex-router process integration
[x] codex-router CRLF split-boundary regression
[x] public-/v1 capability-path verifier hardening
[x] P1 deterministic three-OS CI green
[x] P1 live authenticated persistent session
[x] P1 live MCP create/ask/continue
[x] P1 live autonomous two-round relay
[x] P1 live codex-router smoke checklist
[x] P1 live cancellation + same-session reuse
[x] P1 live restart continuity
[x] P1 live sign-off
[x] P2 provider-health state machine
[x] P2 authenticated provider-health API
[x] P2 explicit-only fallback policy
[x] P2 enforced optional cooldown
[x] P2 auditable route decisions
[x] P2 no persistent session migration on fallback
[x] P2 deterministic three-OS CI green
[x] P2 branch includes signed-off P1 ancestry
[x] P2 combined P1+P2 CI green
[ ] P3 ACP agent adapters
```
