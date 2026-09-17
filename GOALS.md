# Agent ChatGPT Bridge — Project Goals

`implementation.md` remains authoritative for existing bridge invariants, persistence, security, and ChatGPT Web behavior. This file is authoritative for the provider-agnostic product direction and later collaboration milestones.

## Mission

Build a **local, provider-agnostic AI collaboration runtime** that lets an external AI agent remain the primary worker while consulting and coordinating with ChatGPT Web, routed API models, subscription-agent CLIs, and future agent backends through persistent, bounded, auditable workflows.

Agent Bridge is not a generic credential proxy and is not a replacement for provider-specific routers. It owns collaboration semantics.

## Responsibility split

### Agent Bridge owns

- persistent collaboration sessions;
- canonical transcript/history;
- turn serialization and cancellation;
- bounded autonomous runs;
- external-agent adapters;
- permission boundaries;
- provider selection policy;
- collaboration roles and future DAG execution;
- REST, MCP, Responses, CLI, and agent-facing surfaces;
- auditability and orchestration state.

### codex-router owns

- provider credentials and OAuth/API-key boundaries;
- provider-specific request/response normalization;
- provider namespaces and model connectivity;
- provider quirks and transport compatibility;
- external API/local-model connectivity.

Agent Bridge may observe coarse provider health for its own collaboration policy, but should not duplicate provider-specific router internals.

### ChatGPT Web provider owns

- launcher-controlled ChatGPT authentication/profile;
- browser lifecycle and UI interaction;
- account-aware ChatGPT Web model routes;
- browser/UI drift detection;
- ChatGPT Web turn extraction.

### ACP agent clients own

- their own installation and authentication state;
- provider-specific login/OAuth/API-key handling;
- their ACP server implementation;
- client-specific tools and capabilities.

Agent Bridge owns the ACP client/session lifecycle and the permission boundary exposed to those agents. It must not copy subscription-agent credentials into bridge persistence.

## Target architecture

```text
Codex / Claude / Gemini / Cursor / IDE / custom agents
                 |
      MCP / ACP / JSONL / REST / Responses
                 |
                 v
+--------------------------------------------------+
|                 Agent Bridge                     |
|                                                  |
|  SessionManager        canonical history         |
|  RunController         bounded autonomy          |
|  ProviderRegistry      model ownership           |
|  CollaborationPolicy  role/model selection      |
|  PermissionEngine      capability boundaries     |
|  Audit / Persistence   inspectable state         |
+-------------------------+------------------------+
             |                         |
             v                         v
 ChatGPTWebConversationProvider   CodexRouterConversationProvider
             |                         |
             v                         v
        ChatGPT Web                  codex-router
                                      / | \
                              Claude  APIs local models

RunController external-agent side
             |
             +-- JSONL subprocess adapter
             +-- ACP adapter
                    +-- Cursor
                    +-- Gemini CLI
                    +-- Claude ACP
                    +-- Antigravity
                    `-- custom ACP agent
```

## Core architectural rules

1. **Agent Bridge is the top-level collaboration plane.** `codex-router` is a downstream provider plane.
2. No protocol surface may bypass `SessionManager` to invoke a provider directly.
3. Public provider/model identity must remain globally unambiguous.
4. Provider or agent credentials stay in the system that owns them.
5. Collaboration is bounded: no uncontrolled recursive agent spawning or implicit infinite retries.
6. Fallback is explicit, auditable, and never silently mutates persistent session identity.
7. Agent/model output is untrusted input to the bridge and must not acquire capabilities merely by asking for them.

## Model identity

Examples:

```text
chatgpt-web/high
chatgpt-web/luna
codex-router/deepseek/...
codex-router/anthropic-api/...
codex-router/kimi-oauth/...
```

A public model ID must resolve to exactly one provider. Ambiguity is a hard error.

## Provider abstraction

All inference backends implement the bridge provider contract conceptually as:

```ts
interface ConversationProvider {
  readonly name: string;
  capabilities(): Promise<ProviderCapabilities>;
  runTurn(request, context): Promise<BridgeTurnResult>;
  cancelTurn?(sessionId, turnId): Promise<void>;
  closeSession?(sessionId): Promise<void>;
}
```

The collaboration layer owns history even when the downstream provider also has native conversation/session concepts.

## External-agent abstraction

External workers implement the bridge adapter contract through protocol adapters such as:

```text
JsonlSubprocessAgent
AcpAgentAdapter
future MCP-native agent adapter
```

The preferred strategy is official protocol composition, not terminal scraping.

## Milestone status

### P0 — universal bridge/session foundation

**Status: DONE**

Core session ownership, SQLite persistence, REST/SSE, MCP, CLI, cancellation, strict JSONL external-agent protocol, and bounded two-party collaboration are implemented.

### P1 — codex-router provider plane

**Status: DONE + LIVE SIGN-OFF**

Completed capabilities include:

```text
[x] opt-in codex-router endpoint configuration
[x] loopback-only by default
[x] model discovery
[x] globally namespaced routed model IDs
[x] Responses streaming translated into bridge events
[x] usage/error/cancellation propagation
[x] SessionManager remains canonical history owner
[x] REST/MCP/autonomous routes can use routed models
[x] ChatGPT Web remains available independently
[x] no silent provider fallback
[x] cross-platform CI/release checks
[x] live ChatGPT Web + real codex-router coexistence validation
```

### P2 — provider health and explicit policy

**Status: DONE + DETERMINISTIC SIGN-OFF**

Bridge-level policy states:

```text
healthy
unavailable
rate_limited
cooldown
misconfigured
```

Fallback remains disabled by default and is allowed only through explicit ordered candidates and trigger states. Route decisions are persisted before execution and never silently rewrite the persistent session's provider/model identity.

### P3 — ACP agent adapters

**Status: IMPLEMENTED + CI GREEN; LIVE SIGN-OFF PENDING**

Implemented:

```text
[x] generic native ACP adapter
[x] persistent owned ACP subprocess/session
[x] streaming response collection
[x] cancellation propagation
[x] bounded cleanup / subprocess-tree ownership
[x] default-deny permissions
[x] filesystem/terminal/elicitation callbacks disabled by default
[x] structured audit events
[x] Cursor profile: agent acp
[x] Gemini profile: gemini --acp
[x] Claude profile: claude-agent-acp
[x] custom ACP profile
[x] deterministic fake-agent interoperability coverage
[x] cross-platform CI #191
[x] live smoke verifier and runbook
[ ] real Cursor live sign-off
[ ] real Gemini CLI live sign-off
[ ] real Claude ACP live sign-off
```

The live gate is documented in `docs/ACP_LIVE_SMOKE.md` and verifies initialize/session, two-round continuity, fail-closed mutation handling, cancellation, post-cancel recovery, and clean process teardown.

### P4 — role-based collaboration

**Status: NOT STARTED**

Introduce explicit collaboration roles such as:

```text
primary
architect
researcher
critic
reviewer
verifier
```

A policy maps role + runtime state to an agent/provider/model. Example:

```text
primary       -> external Codex/ACP agent
architect     -> ChatGPT Web
critic        -> codex-router/anthropic-api/...
cheap-review  -> codex-router/deepseek/...
verifier      -> ChatGPT Web
```

Requirements:

- inspectable policy;
- deterministic behavior when statically configured;
- explicit provider/model identity;
- budget enforcement;
- permission policy per role;
- persisted routing/role decisions;
- no implicit privilege escalation.

### P5 — bounded multi-participant collaboration DAG

**Status: NOT STARTED**

Generalize the current two-party relay into a bounded graph:

```text
objective
   |
   +---- architecture ------> ChatGPT
   +---- independent critique -> Claude
   +---- alternative --------> Gemini / routed model
   |
   v
synthesis -> primary agent -> execution/tests
   |
   +---- diagnosis ----------> ChatGPT
   +---- verification -------> independent agent
   |
  DONE
```

Every node must have:

- explicit actor/provider/model;
- bounded retries and wall-clock budget;
- input provenance;
- persisted output;
- cancellation propagation;
- terminal state;
- audit events;
- explicit capabilities/permissions.

No uncontrolled recursive agent spawning.

## Security invariants

1. Bind bridge/provider-control surfaces to loopback by default.
2. Treat all model and agent output as untrusted content.
3. Do not automate passwords, CAPTCHA, or usage-limit bypass.
4. Do not copy codex-router provider credentials into bridge state.
5. Do not copy subscription-agent OAuth/API credentials into bridge state.
6. Do not expose caller capability URLs or credentials in diagnostics/audit.
7. Do not silently change provider/model.
8. Fail closed on protocol drift or ambiguous routing.
9. Propagate cancellation to the exact active provider request or owned agent process.
10. Keep reverse local tools/filesystem/terminal access disabled unless explicitly granted.
11. Bound protocol output, wall-clock time, retries, rounds, and cleanup waits.
12. A failed audit/persistence requirement must not silently degrade into unaudited execution where the invariant says fail-closed.

## Engineering strategy

Prefer:

```text
protocol composition > codebase merging
provider adapters     > provider-specific SessionManager logic
explicit namespaces   > heuristic model ownership
bounded policies      > uncontrolled automatic fallback
official ACP/MCP       > terminal scraping
owned subprocesses    > detached/untracked CLI processes
wrappers               > large upstream browser refactors
```

## Current implementation sequence

1. Finish P3 real-client Cursor/Gemini/Claude interoperability sign-off.
2. Merge the consolidated `release/p3-hardening` baseline to `main` after CI + live evidence.
3. Retire/supersede the old stacked PRs only after the consolidated merge.
4. Design P4 role-policy schema on the merged baseline.
5. Implement role-aware provider/agent selection with persisted decisions and permission boundaries.
6. Generalize `RunController` into the P5 bounded collaboration DAG.
7. Integrate upward with ARC/CompanyOS through explicit APIs/events rather than merging execution-plane responsibilities into Agent Bridge.

Do not begin a later milestone by weakening an earlier milestone's correctness, security, cancellation, persistence, or audit guarantees.
