# Agent ChatGPT Bridge — Project Goals

This file extends `implementation.md` with the project's next architectural goal. Where this file changes the product direction, it is authoritative for new provider/orchestration work; the original implementation specification remains authoritative for existing bridge invariants, security, persistence, and ChatGPT Web behavior.

## Mission

Build a **local, provider-agnostic AI collaboration runtime** that lets an external AI agent remain the primary worker while consulting and coordinating with ChatGPT Web, routed API models, subscription-agent CLIs, and future agent backends through persistent, bounded, auditable workflows.

The product is not a generic credential proxy and is not a replacement for provider-specific routers. It owns collaboration semantics.

## Responsibility split

### Agent ChatGPT Bridge owns

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
- model routing and provider namespaces;
- provider quirks and transport compatibility;
- provider-specific health/failover evidence;
- external API/local-model connectivity.

### ChatGPT Web provider owns

- launcher-controlled ChatGPT authentication/profile;
- browser lifecycle and UI interaction;
- account-aware ChatGPT Web model routes;
- browser/UI drift detection;
- ChatGPT Web turn extraction.

## Target architecture

```text
Codex / Claude Code / Gemini CLI / Cursor / custom agents
                 |
      MCP / ACP / JSONL / REST / Responses
                 |
                 v
+--------------------------------------------------+
|          Agent ChatGPT Bridge                    |
|                                                  |
|  SessionManager        canonical history         |
|  RunController         bounded autonomy          |
|  ProviderRegistry      model ownership           |
|  CollaborationPolicy  role/model selection      |
|  PermissionEngine      capability boundaries     |
|  Audit / Persistence   inspectable state         |
+-------------------------+------------------------+
                          |
              +-----------+-----------+
              |                       |
              v                       v
  ChatGPTWebConversationProvider   CodexRouterConversationProvider
              |                       |
              v                       v
         ChatGPT Web                codex-router
                                    /   |   \
                                Claude  DS  Kimi ...
```

## Core architectural rule

**Agent ChatGPT Bridge is the top-level collaboration plane. codex-router is a downstream provider plane.**

The supported initial direction is:

```text
Agent ChatGPT Bridge -> codex-router -> provider/model
```

Do not create an untagged reciprocal path that routes codex-router back into the bridge and then into codex-router again.

## Model identity

Public model IDs must remain globally unambiguous.

Examples:

```text
chatgpt-web/high
chatgpt-web/luna
codex-router/deepseek/deepseek-v4-pro
codex-router/anthropic-api/claude-opus-4.8
codex-router/kimi-oauth/kimi-for-coding
```

The session layer must never infer two providers for the same public model ID. Ambiguity is a hard error.

## Provider abstraction

All inference backends implement the existing provider contract:

```ts
interface ConversationProvider {
  readonly name: string;
  capabilities(): Promise<ProviderCapabilities>;
  runTurn(request, context): Promise<BridgeTurnResult>;
  cancelTurn?(sessionId, turnId): Promise<void>;
  closeSession?(sessionId): Promise<void>;
}
```

No protocol surface may bypass `SessionManager` to call codex-router directly.

## Milestone P1 — codex-router provider plane

Definition of done:

```text
[ ] opt-in codex-router endpoint configuration
[ ] loopback-only by default
[ ] model discovery through /v1/models
[ ] globally namespaced routed model IDs
[ ] Responses streaming translated into BridgeEvent
[ ] usage/error/cancellation propagation
[ ] SessionManager remains canonical history owner
[ ] REST can create a routed session
[ ] MCP can create/use a routed session
[ ] generic /v1/responses can choose a routed model
[ ] autonomous runs can target a routed session
[ ] ChatGPT Web remains the default when no routed model is selected
[ ] no silent provider fallback
[ ] cross-platform CI/release checks pass
[ ] live integration test against a local codex-router installation passes
```

## Milestone P2 — provider health and explicit policy

Add bridge-level observations that do not duplicate provider internals:

```text
healthy
unavailable
rate_limited
cooldown
misconfigured
```

Any fallback must be explicitly configured by a collaboration policy. A session must never silently migrate from ChatGPT Web to another provider or vice versa.

## Milestone P3 — ACP agent adapters

Extend `ExternalAgentAdapter` with a native ACP implementation so installed agent clients can participate without terminal scraping.

Target adapters:

```text
JsonlSubprocessAgent
McpAgent
AcpAgent
```

Initial ACP targets:

- Claude Code;
- Cursor Agent;
- Gemini CLI.

Reuse official client protocols. Never copy OAuth tokens from those clients.

## Milestone P4 — role-based collaboration

Introduce explicit collaboration roles such as:

```text
primary
architect
researcher
critic
reviewer
verifier
```

A policy maps a role and runtime state to a provider/model.

Example:

```text
primary       -> external Codex agent
architect     -> ChatGPT Web
critic        -> codex-router/anthropic-api/...
cheap-review  -> codex-router/deepseek/...
verifier      -> ChatGPT Web
```

Policies must be inspectable, deterministic when configured as static, bounded by run budgets, and auditable.

## Milestone P5 — multi-participant collaboration DAG

Generalize the current two-party relay into a bounded graph:

```text
objective
   |
   +---- architecture -> ChatGPT
   |
   +---- independent critique -> Claude
   |
   +---- alternative -> DeepSeek
   |
   v
synthesis -> primary agent -> execution/tests
   |
   +---- diagnosis -> ChatGPT
   +---- verification -> Claude
   |
  DONE
```

Every node must have:

- explicit actor/provider/model;
- bounded retries;
- input provenance;
- persisted output;
- cancellation propagation;
- terminal state;
- audit events.

No uncontrolled recursive agent spawning.

## Security invariants

1. Bind bridge/provider-control surfaces to loopback by default.
2. Treat all model/agent output as untrusted content.
3. Do not automate passwords, CAPTCHA, or usage-limit bypass.
4. Do not copy codex-router provider credentials into bridge state.
5. Do not copy subscription-agent OAuth credentials into bridge state.
6. Do not expose caller capability URLs in diagnostics.
7. Do not silently change provider/model.
8. Fail closed on protocol drift or ambiguous routing.
9. Propagate cancellation to the active downstream request/process.
10. Keep reverse local tools disabled unless explicitly granted.

## Engineering strategy

Prefer:

```text
protocol composition > codebase merging
provider adapters     > provider-specific logic in SessionManager
explicit namespaces   > heuristic model ownership
bounded policies      > automatic uncontrolled fallback
official ACP/MCP       > terminal scraping
wrappers               > large upstream browser refactors
```

## Current implementation sequence

1. Finish P1 codex-router provider plane.
2. Run deterministic CI across macOS/Linux/Windows.
3. Run live ChatGPT Web + codex-router coexistence validation.
4. Add provider health/cooldown observations.
5. Implement ACP adapter.
6. Add role policy.
7. Generalize RunController into a bounded collaboration graph.

Do not begin a later milestone by weakening an earlier milestone's correctness, security, or test evidence.
