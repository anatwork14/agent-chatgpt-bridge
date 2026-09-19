# Implementation Progress

Last updated: 2026-09-18

This file is evidence-based. A milestone is not marked live-complete only because unit tests or CI pass.

## Current release state

```text
P0 universal bridge/session foundation        DONE
P1 codex-router provider plane                DONE + LIVE SIGN-OFF
P2 provider health / explicit routing policy DONE + CI VALIDATED
P3 native ACP external-agent adapter          IMPLEMENTED + CI GREEN + LIVE SIGN-OFF COMPLETE
P3 real ACP interoperability                  DONE + LIVE SIGN-OFF
P4 role-based collaboration                   DONE + LIVE SIGN-OFF
P5 bounded collaboration DAG                  DONE + LIVE SIGN-OFF
P6 ARC / CompanyOS integration contract       IN PROGRESS
```

The active consolidation branch is `release/p3-hardening`. It connects the previously orphaned feature-stack history to `main` with a two-parent integration commit while preserving the complete P1 -> P2 -> P3 ancestry. The older stacked PRs remain available as implementation history until the consolidation PR is accepted.

## Completed foundation

- Upstream baseline imported and pinned.
- Generic bridge domain types and `ConversationProvider` abstraction.
- Real ChatGPT Web provider facade around the upstream adapter.
- Account-aware model discovery.
- Persistent `SessionManager` and canonical SQLite transcript.
- Terminal turn persistence and interrupted-turn recovery.
- Session isolation and serialization.
- Cancellation propagation and browser-owner retirement for explicit bridge cancellation.
- Local content/attachment policy.
- Turn scheduling and bounded concurrency primitives.
- REST `/bridge/v1` API with SSE and bearer-token protection.
- Idempotency for supported non-streaming mutations.
- Agent -> ChatGPT MCP tools with stdio lifetime ownership.
- Strict subprocess JSONL external-agent adapter.
- Bounded autonomous collaboration controller.
- Runtime-home SQLite integration.
- Cross-platform CI verification/package/smoke coverage.
- Upstream Codex compatibility retained.

## P1 — codex-router provider plane

Final signed-off head:

```text
c8ee167ab15a5dd537a13d3c714e142acc59ce3f
```

Implemented:

- optional downstream `codex-router` provider through the OpenAI Responses boundary;
- namespaced `codex-router/<model-id>` discovery with no silent fallback;
- loopback-only endpoint policy by default and recursive bridge-route prevention;
- cancellation and explicit rate-limit/error propagation;
- capability-URL redaction;
- canonical bridge history across multi-turn routed sessions;
- real child-process integration and pinned real codex-router process coverage;
- SSE CRLF split-boundary hardening;
- packaged-app smoke on macOS, Ubuntu, and Windows.

P1 CI run #185 / `34747263537` passed the full matrix.

Live validation completed:

```text
[x] production ChatGPT Web authenticated
[x] independent ChatGPT turn
[x] persistent-session marker recovery
[x] direct real codex-router smoke
[x] ChatGPT Web and codex-router namespaces
[x] routed turn and same-session semantic continuity
[x] routed transcript persistence
[x] provider/model pinning
[x] capability/secret leak inspection
[x] routed downstream cancellation
[x] ChatGPT/router coexistence
[x] two-session isolation
[x] ChatGPT cancellation cleanup + same-session reuse
[x] MCP create / ask / continue
[x] autonomous relay >= 2 rounds + bounded termination
[x] restart reconstruction / continuity
```

A genuine provider-side 429 was intentionally not manufactured because paid-account exhaustion is not a safe validation technique.

**P1 LIVE SIGN-OFF: YES**

## P2 — provider health and explicit routing policy

Final stacked P2 head before P3:

```text
77c1de144dfd8509be8aee885903af688591d8a2
```

Implemented:

- bridge-level provider health states: `healthy`, `unavailable`, `rate_limited`, `cooldown`, `misconfigured`;
- secret-safe health observations for discovery, validation, turns, and explicit policy state;
- authenticated read-only `/bridge/v1/providers/health` endpoint;
- fallback disabled by default;
- explicitly ordered fallback with explicit trigger states only;
- no opportunistic retry/mid-turn migration;
- optional rate-limit cooldown with deterministic expiry semantics;
- shared health enforcement for direct-provider and model-router traffic;
- route decisions persisted before provider execution, with audit failure fail-closed;
- no persistent session provider/model migration on fallback;
- explicit fallback-model validation before execution;
- structured `BridgeError` preservation in terminal turn persistence;
- startup policy validation before bridge-owned SQLite is opened;
- concrete-provider cancellation preserved through routing wrappers.

The combined P1+P2 stack passed the full macOS/Linux/Windows CI/package/smoke matrix.

**P2 DETERMINISTIC SIGN-OFF: YES**

## P3 — native ACP external-agent adapter

Current P3 implementation head before release hardening:

```text
ec4c7f3ea888ff8a904d98847f8da33b4e1fe959
```

CI run #191 / `34767691106` completed successfully on that head.

Implemented:

- generic ACP v1 adapter using `@agentclientprotocol/sdk` 1.4.0;
- built-in profiles for Cursor (`agent acp`), Gemini CLI (`gemini --acp`), and Claude ACP (`claude-agent-acp`);
- custom ACP command profile;
- persistent owned subprocess and ACP session across collaboration rounds;
- streaming agent-message collection;
- cancellation via ACP `session/cancel` plus bounded process cleanup;
- prompt timeout and protocol-output bounds;
- default-deny permission handling with optional read-only/delegated policy;
- filesystem, terminal, and elicitation client callbacks disabled by default;
- safe environment inheritance rather than wholesale parent-process credential inheritance;
- structured ACP audit events;
- deterministic fake ACP coverage for initialize/session/prompt/cancel/permission/close behavior;
- prompt process-exit detection and orphan cleanup hardening.

Release hardening added on `release/p3-hardening`:

- repository/package metadata corrected to identify Agent Bridge rather than upstream `codex-chatgpt-web`;
- README/product architecture synchronized through P3;
- repeatable `bun run smoke:acp:live` verifier;
- isolated temporary workspace for mutation/permission probes;
- two-round marker continuity check;
- in-flight cancellation and post-cancel recovery check;
- clean-close/audit evidence output;
- `docs/ACP_LIVE_SMOKE.md` runbook and sign-off record.

### P3 live gates and sign-off

The live verifier exercises real authenticated clients:

```bash
bun run smoke:acp:live -- --profile cursor
bun run smoke:acp:live -- --profile gemini
bun run smoke:acp:live -- --profile claude
bun run smoke:acp:live -- --profile antigravity
```

Required evidence per client:

```text
[x] initialize and session/new succeed
[x] round 1 -> round 2 semantic/marker continuity
[x] permission/mutation probe remains fail-closed
[x] in-flight cancellation surfaces client_cancelled
[x] same-session post-cancel recovery succeeds
[x] close leaves no owned orphan process
[x] no agent.acp.failed audit event
[x] no provider credential material is emitted by the bridge
```

Live status by client:
- **Claude ACP (`claude-agent-acp`)**: `PASS` (full 8-gate lifecycle validated on macOS).
- **Google Antigravity CLI (`agy` via `agy-acp`)**: `PASS` (full 8-gate lifecycle validated on macOS; native Antigravity CLI integration through ACP adapter).
- **Cursor (`agent acp`)**: Documented release exception (unsupported without proprietary account).
- **Gemini CLI (`gemini --acp`)**: Legacy live path superseded by Google Antigravity CLI via ACP adapter.
- **Codex**: Validated through separate non-ACP provider paths; P4 external adapter tracked under issue #7.

**P3 DETERMINISTIC SIGN-OFF: YES**

**P3 LIVE SIGN-OFF: YES (Claude ACP + Antigravity ACP complete; Cursor release exception documented)**

## Integration topology

The original repository `main` history did not share an ancestor with the feature stack. The release-hardening branch fixes that without force-pushing or rewriting either history:

```text
main (initial repository history) -----------+
                                             \
                                              merge -> release/p3-hardening
                                             /
P0 -> P1 -> P2 -> P3 -----------------------+
```

The integration commit reuses the exact P3 tree as its content and records both `main` and the P3 head as parents. Subsequent hardening commits are normal descendants. This makes a single reviewable PR to `main` possible while preserving implementation provenance.

## Merge/release sequencing

1. Keep the consolidation PR in draft while the hardening CI matrix runs.
2. Resolve any deterministic regression on `release/p3-hardening`.
3. Run the three real-client ACP smoke commands and attach evidence.
4. Mark P3 live-signed-off only when all required gates pass or an explicit documented exception is accepted.
5. Merge the consolidation PR to `main`.
6. Close/supersede the old stacked PRs only after the consolidated merge is complete.
7. Begin P4 from the merged release baseline; do not develop role policy on the old stack branches.

## Definition-of-done tracking

```text
[x] generic session creation
[x] canonical persisted transcript
[x] multi-session isolation
[x] REST + SSE
[x] cancellation primitives
[x] SQLite persistence
[x] CLI
[x] MCP + real stdio lifetime regression
[x] strict subprocess JSONL adapter
[x] bounded autonomous relay
[x] local bearer-token boundary
[x] fail-closed provider terminal handling
[x] upstream Codex compatibility
[x] codex-router provider plane and namespace
[x] real codex-router child-process integration
[x] P1 deterministic cross-platform CI
[x] P1 live sign-off
[x] P2 provider-health state machine
[x] P2 explicit-only fallback/cooldown/auditable routing
[x] P2 combined cross-platform CI
[x] P3 ACP adapter implementation
[x] P3 deterministic ACP tests
[x] P3 cross-platform CI #191
[x] P3 live verifier/runbook
[x] P3 live Cursor interoperability (documented release exception)
[x] P3 live Antigravity ACP interoperability
[x] P3 live Claude ACP interoperability
[x] P3 live sign-off
[x] P4 role-based collaboration
[x] P5 bounded multi-participant DAG
```


## P4 — role-based collaboration

P4 was merged to `main` via PR #8 on 2026-09-18.

Release evidence:

```text
feature head: 15efb03f02c0aa2a46c8e3ef6c9805045db01c8b
merge commit: ac3cd2a56b7335b098251f0377f7d0620f0b9186
CI run: 35346019961
actionlint: PASS
codex-router-integration: PASS
ubuntu: PASS
macOS: PASS
windows: PASS
Claude -> Antigravity -> Claude live collaboration smoke: PASS
```

Implemented through P4.8:

- provider-independent role definitions;
- explicit participant assignment;
- sequential role workflow through RunController;
- canonical transcript integration with SHA-256 payload integrity;
- cancellation and deterministic failure propagation;
- SQLite persistence and restart recovery;
- structured audit/observability;
- real Claude + Antigravity multi-participant live sign-off.

**P4 RELEASE SIGN-OFF: YES**

## P5 — bounded multi-participant collaboration DAG

P5 started from the released P4 baseline on 2026-09-18.

Tracking:

- issue #9;
- branch `feat/p5-bounded-collaboration-dag`;
- specification `docs/P5_BOUNDED_COLLABORATION_DAG.md`.

P5 keeps graph topology static, bounded, and validated before execution. It adds safe fan-out/fan-in collaboration without turning Agent Bridge into a general execution engine.

Current slices:

```text
[x] P5.0 DAG domain model + invariants
[x] P5.1 graph validation + deterministic planning
[x] P5.2 bounded ready-set scheduler / fan-out
[x] P5.3 fan-in provenance + canonical node outputs
[x] P5.4 SQLite persistence / migration
[x] P5.5 cancellation + failure propagation
[x] P5.6 recovery / idempotent resume
[x] P5.7 audit / observability
[x] P5.8 real Claude + Antigravity fan-out/fan-in live smoke
```


### P5 deterministic implementation status

P5.0 through P5.7 are implemented. Current deterministic evidence includes:

- static DAG domain model, hard limits, and pure validation;
- deterministic Kahn planning and malformed-graph rejection;
- bounded fan-out with global parallelism and participant-local serialization;
- deterministic fan-in provenance and canonical transcript hashing;
- SQLite schema v3 plus atomic node completion and disk durability tests;
- fail-fast and skip-dependent failure semantics;
- exact DAG cancellation without coupling to `SessionManager.cancel()`;
- restart recovery and explicit replay acknowledgement for interrupted nodes;
- completed-node no-replay and persisted-state corruption checks;
- recovery/resume audit events with data minimization;
- provider-independent trusted DAG node instructions now reaching both ACP prompts and subprocess JSONL payloads.

A dedicated real-client P5.8 verifier is available as:

```bash
bun run smoke:p5:live
```

P5.8 real-client sign-off is complete.

Release evidence:

```text
implementation/live-smoke head: a25ae80d3fcf898e0071544d05adcf0a1009d0c4
live command: bun run smoke:p5:live
platform: Darwin arm64 (macOS)
status: PASS
runStatus: completed
participantCount: 4
nodeCount: 4
maxParallelTurns: 2
branchOverlapProved: true
observedMaxConcurrency: 2
deterministicFanInOrder: true
reviewerReceivedCriticNonce: true
reviewerReceivedImplementerNonce: true
reviewerTerminalDone: true
cancellationRunStatus: cancelled
simultaneousCancellationTargets: 2
cancelledNodeCount: 2
auditLeakCheck: true
workspaceMutation: false
temporaryResourcesRemoved: true
schemaVersion: 3
CI run on same implementation head: 35404281425 PASS
```

**P5 DETERMINISTIC SIGN-OFF: YES**

**P5 LIVE SIGN-OFF: YES**


## P6 — ARC / CompanyOS integration contract

P6 started from the released P5 merge commit `c3338cdeabb1a7fe95ea97231bed97be9be223a6`.

Tracking:

- issue #11;
- branch `feat/p6-arc-companyos-integration`;
- specification `docs/P6_ARC_COMPANYOS_INTEGRATION.md`.

Current slices:

```text
[x] P6.0 versioned integration domain + capability discovery
[x] P6.1 safe DAG run projection + exact cancellation REST surface
[x] P6.2 correlation metadata
[x] P6.3 minimized integration event stream
[x] P6.4 idempotent external collaboration submission
[x] P6.5 ARC integration smoke
[x] P6.6 CompanyOS integration smoke
[x] P6.7 release sign-off
```

Initial implementation intentionally exposes only safe lifecycle/control metadata. It does not expose objectives, prompts, node instructions, model output, provider error messages, commands, cwd, credentials, or environment values.

The P6 authority boundary is:

```text
ARC task / candidate authority         -> ARC
Bridge collaboration/session authority -> Agent Bridge
Company workflow/outcome authority     -> CompanyOS
cross-system linkage                   -> bounded opaque correlation IDs
```


### P6 release-candidate evidence

Cross-repository P6 integration evidence:

```text
Agent Bridge functional head: 397199746912125322850645298f0de43ea0c962
Agent Bridge CI: 35413007099 PASS

ARC P6.5 PR: #29
ARC exact smoke head: 9c37f8492f0069bdb9dfc4c5d533c9f1e5ad9831
ARC CI: 35412712345 PASS (Python 3.11 / 3.12)
ARC merge commit: 3adc4bfce924d213ad1f676726f3373ef44e1399

CompanyOS P6.6 contract PR: #13
CompanyOS contract head: 52f60a6ec198e9784e876a6d11f903525d7f00ba
CompanyOS contract merge: d3b1f4579bcd8f9aadfaf54a46d25ec7cdbf6da0

CompanyOS P6.6 behavior PR: #14
CompanyOS gateway-smoke head: f3e84c41c8840bdf4a88f9c6c7c653824c21040d
CompanyOS gateway-smoke merge: 790974b2cb8ecc956da5c64505d8e711e7751de4
CompanyOS exact smoke blob: 7f71b459e27407b62e4dd7e1e6694df3e6bfda29
CompanyOS gateway smoke: PASS
```

CompanyOS private-repository GitHub-hosted Actions were unavailable before workflow-step execution. Contract and behavioral smoke evidence is therefore exact-head / exact-byte deterministic evidence; no claim of CompanyOS CI success is made.
