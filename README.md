# Agent ChatGPT Bridge

A local, provider-agnostic collaboration runtime that lets AI agents work with ChatGPT Web, routed model providers, and other ACP-capable agents without manual message copying.

Agent Bridge owns the collaboration semantics: persistent sessions, canonical transcripts, cancellation, bounded workflows, permissions, routing policy, persistence, and auditability. Provider-specific authentication remains with the provider or local agent client.

> **Status (2026-09-18):** P1–P3 are released, P4 role-based collaboration is merged and live-signed-off, and P5 bounded multi-participant collaboration DAG work is in progress on `feat/p5-bounded-collaboration-dag` (issue #9).

## Architecture

```text
External agents / clients
Codex / Cursor / Claude / Gemini / IDE / script
                    |
       REST / MCP / ACP / CLI / Responses
                    |
                    v
+--------------------------------------------------+
|               Agent Bridge                       |
|                                                  |
|  SessionManager       persistent sessions        |
|  canonical transcript / turn serialization       |
|  RunController        bounded collaboration      |
|  ProviderRegistry     provider/model ownership   |
|  routing policy       health/cooldown/fallback   |
|  permission boundary audit / persistence         |
+------------------------+-------------------------+
                         |
             +-----------+-----------+
             |                       |
             v                       v
 ChatGPTWebConversationProvider   CodexRouterConversationProvider
             |                       |
             v                       v
        ChatGPT Web                codex-router
                                      |
                              external providers

ExternalAgentAdapter side:

RunController
    |
    +-- JsonlSubprocessAgent
    +-- AcpAgentAdapter
            |-- Cursor: agent acp
            |-- Gemini: gemini --acp
            |-- Claude: claude-agent-acp
            `-- custom ACP agent
```

ChatGPT Web is the first direct provider, not the architecture itself. `codex-router` is a downstream `ConversationProvider`; Agent Bridge remains the higher-level collaboration plane.

## Relationship to ARC and CompanyOS

```text
CompanyOS
    |
    v
ARC ---------------- Agent Bridge
 |                       |
 |                       +-- ChatGPT Web
 |                       +-- codex-router
 |                       +-- Cursor / Claude / Gemini via ACP
 |                       `-- future providers / agents
 |
 v
tasks / experiments / recovery / evidence
```

- **ARC / adaptive-agent-runtime** is the execution plane: task DAGs, isolation, experiments, recovery, ledgers, runtime control.
- **Agent Bridge** is the intelligence/collaboration gateway: conversations, sessions, provider routing, agent-to-agent interaction, permissions, and bounded collaboration.
- **CompanyOS** is the coordination/product layer above them.

## Implemented surfaces

- Persistent bridge sessions with canonical SQLite transcripts.
- Session isolation, serialization, cancellation, interrupted-turn recovery, and restart continuity.
- `agent-chatgpt` CLI for sessions, messages, models, MCP, and bounded autonomous runs.
- Local REST API under `/bridge/v1` with SSE streaming and bearer-token protection.
- MCP tools for Agent -> ChatGPT interaction.
- Strict subprocess JSONL adapter for generic external agents.
- Native ACP external-agent adapter with persistent sessions, streaming, cancellation, permission handling, subprocess ownership/cleanup, and audit events.
- Built-in ACP profiles for Cursor, Gemini CLI, Claude ACP, plus custom commands.
- Provider-health observations: `healthy`, `unavailable`, `rate_limited`, `cooldown`, `misconfigured`.
- Explicit-only ordered fallback policy; no silent provider migration or mid-turn fallback.
- Optional `codex-router` provider plane with namespaced model discovery and canonical Agent Bridge history.
- Bounded autonomous collaboration with round, wall-clock, failure, and cancellation limits.
- Existing upstream `codex-chatgpt-web` CLI and `/v1/responses` compatibility retained.

## Safety boundaries

- Model and agent output is untrusted content; it does not directly gain shell/file permissions from Agent Bridge.
- ChatGPT Web login remains manual in the launcher-controlled browser.
- Subscription-agent/provider authentication remains with Cursor, Gemini, Claude, codex-router, or the relevant provider. Agent Bridge does not copy their OAuth/API credentials into bridge state.
- Bridge/provider-control surfaces bind to loopback by default.
- Native bridge routes require a local bearer token derived from the private runtime control secret.
- ACP filesystem and terminal callbacks are disabled by default; permission policy is fail-closed unless explicitly configured otherwise.
- Autonomous loops are bounded and cancellable.
- No silent model/provider fallback or usage-limit evasion.
- Protocol ambiguity, UI drift, and missing terminal evidence fail closed.

Read [`docs/security-model.md`](docs/security-model.md) before enabling tool-capable workflows.

## Development setup

The source runtime requires Bun 1.4.0.

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify
```

A signed-in ChatGPT browser profile is required only for live ChatGPT Web validation. ACP agents are expected to be authenticated through their own supported client login flow before Agent Bridge launches them.

## Bridge CLI

During source development, replace `agent-chatgpt` below with `bun src/cli/index.ts`.

Start the bridge daemon:

```bash
agent-chatgpt serve
```

Default endpoint:

```text
http://127.0.0.1:8765/bridge/v1
```

Create and continue a persistent session:

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember the number 8427."
agent-chatgpt ask --session demo "What number did I ask you to remember?"
```

Inspect state:

```bash
agent-chatgpt status --json
agent-chatgpt models --json
agent-chatgpt session list --json
agent-chatgpt session transcript demo --json
```

Pipe another tool's output into a session:

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

Run the Agent -> ChatGPT MCP server:

```bash
agent-chatgpt mcp
```

Available tools include:

```text
chatgpt_create_session
chatgpt_ask
chatgpt_continue
chatgpt_get_session
chatgpt_list_sessions
chatgpt_list_models
chatgpt_cancel
chatgpt_close_session
```

See [`docs/MCP.md`](docs/MCP.md).

## External agents and bounded collaboration

The original generic adapter uses a strict subprocess JSONL contract:

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

The native ACP adapter uses official ACP protocol framing rather than terminal scraping. Built-in launch profiles are:

```text
cursor       -> agent acp
gemini       -> gemini --acp
claude       -> claude-agent-acp
antigravity  -> agy-acp
```

See [`docs/agent-adapters.md`](docs/agent-adapters.md) for adapter semantics and [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md) for the real-client P3 release gate.

## Live ACP verification

After authenticating each client through its own login mechanism:

```bash
bun run smoke:acp:live -- --profile cursor
bun run smoke:acp:live -- --profile gemini
bun run smoke:acp:live -- --profile claude
bun run smoke:acp:live -- --profile antigravity
```

Each run validates initialization, same-session two-round continuity, fail-closed mutation handling, in-flight cancellation, post-cancel recovery, and owned-process cleanup in an isolated temporary workspace.

## Provider routing

ChatGPT Web remains a direct provider. `codex-router` can optionally be configured as a downstream provider plane. Public model IDs stay globally unambiguous, for example:

```text
chatgpt-web/high
codex-router/anthropic-api/...
codex-router/deepseek/...
```

Fallback is disabled by default. When enabled, candidates and trigger health states must be explicit, route decisions are persisted before execution, and a fallback turn never silently mutates the persistent session's provider/model identity.

See [`docs/CODEX_ROUTER.md`](docs/CODEX_ROUTER.md).

## Verification and release state

Deterministic checks:

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI runs the supported verification/package/smoke matrix on macOS, Linux, and Windows.

Current milestone state:

```text
P1 core + codex-router provider plane        DONE + LIVE SIGN-OFF
P2 provider health / explicit routing       DONE + CI VALIDATED
P3 native ACP external-agent adapter        DONE + LIVE SIGN-OFF
P4 role-based collaboration                 DONE + LIVE SIGN-OFF
P5 bounded multi-participant DAG            IN PROGRESS
```

See [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) for evidence and sequencing, and [`docs/P5_BOUNDED_COLLABORATION_DAG.md`](docs/P5_BOUNDED_COLLABORATION_DAG.md) for the active P5 contract.

## Architecture and implementation references

- [`implementation.md`](implementation.md) — authoritative implementation specification for existing bridge invariants
- [`GOALS.md`](GOALS.md) — provider-agnostic product direction and milestone definitions
- [`docs/architecture.md`](docs/architecture.md) — architecture background
- [`docs/API.md`](docs/API.md) — native REST contract
- [`docs/MCP.md`](docs/MCP.md) — Agent -> ChatGPT MCP surface
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — external-agent protocol and adapter model
- [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md) — P3 real-client interoperability gate
- [`docs/security-model.md`](docs/security-model.md) — trust boundaries and security
- [`docs/development.md`](docs/development.md) — contributor workflow
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — upstream synchronization notes
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — evidence-based current status

## License

MIT. Inherited upstream code remains subject to its original license notices.
