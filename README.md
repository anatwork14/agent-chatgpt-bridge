# Agent ChatGPT Bridge

A local bridge that lets an external AI agent remain the primary agent while collaborating programmatically with a user-authenticated ChatGPT Web session.

The project is built on top of [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web). It preserves the upstream Codex integration while adding protocol-independent sessions, REST, MCP, a dedicated CLI, persistence, and bounded autonomous Agent ↔ ChatGPT relay.

> **Status:** pre-1.0 validation. Core behavior is covered by the repository test suite and cross-platform CI. Account-bound browser behavior must still be validated with a real signed-in ChatGPT session before a release is called complete.

## What this project enables

```text
Codex / Claude Code / Gemini CLI / OpenCode / Aider / custom agent
                              │
                    REST / MCP / CLI / JSONL
                              │
                              ▼
                  Agent ChatGPT Bridge
                  ├─ Session Manager
                  ├─ Turn Manager
                  ├─ SQLite persistence
                  ├─ Run Controller
                  ├─ Security / permissions
                  └─ protocol adapters
                              │
                              ▼
              ChatGPTWebConversationProvider
                              │
                              ▼
         upstream codex-chatgpt-web browser runtime
                              │
                              ▼
                         ChatGPT Web
```

The external agent remains responsible for reasoning, coding, experiments, and deciding when work is complete. ChatGPT Web is a collaborating peer, reviewer, researcher, critic, or sub-agent—not a silent replacement for the external agent.

## Implemented surfaces

- Persistent bridge sessions with isolated ChatGPT conversation identity.
- `agent-chatgpt` CLI for sessions, messages, models, MCP, and autonomous runs.
- Local REST API under `/bridge/v1` with SSE streaming and bearer-token protection.
- MCP tools for Agent → ChatGPT interaction.
- Strict subprocess JSONL adapter for generic external agents.
- SQLite persistence for sessions, messages, turns, runs, idempotency, and audit records.
- Bounded autonomous collaboration with round, wall-clock, failure, and cancellation limits.
- Account-aware ChatGPT Web model discovery through the upstream routing implementation.
- Fail-closed provider behavior on UI drift, missing terminal evidence, invalid protocol frames, and unavailable models.
- Existing `codex-chatgpt-web` CLI and `/v1/responses` compatibility path retained.

## Safety boundaries

- ChatGPT output is untrusted text. It does not directly execute shell commands or mutate files.
- Login remains manual in the launcher-controlled browser. The bridge does not automate passwords, CAPTCHA, or cookie import.
- The bridge listens on loopback only by default.
- Native bridge routes require a local bearer token derived from the existing private runtime control secret.
- Autonomous loops are bounded and cancellable.
- No silent model fallback or usage-limit evasion.

Read [`docs/security-model.md`](docs/security-model.md) before enabling tool-capable/full-harness workflows.

## Development setup

The source runtime requires Bun 1.4.0.

Requirements:

- Bun 1.4.0
- the existing ChatGPT Web launcher/browser setup from the upstream project
- a user-authenticated ChatGPT session for live browser validation

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
```

The upstream launcher remains the owner of browser authentication. From source, use the existing launcher/setup flow to sign in and verify the browser surface before trying live bridge turns.

## Bridge CLI

During source development, replace `agent-chatgpt` below with `bun src/cli/index.ts`.

Start the generic bridge daemon:

```bash
agent-chatgpt serve
```

The default bridge endpoint is:

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

Pipe content from another command:

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

Run the Agent → ChatGPT MCP server:

```bash
agent-chatgpt mcp
```

Available tools:

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

## Autonomous relay

A generic external agent can participate through the strict subprocess JSONL protocol:

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

Each external-agent invocation receives one versioned JSON line on stdin and must return exactly one valid decision frame on stdout. Human-readable logs belong on stderr.

See [`docs/agent-adapters.md`](docs/agent-adapters.md).

## REST API

The native API is versioned under `/bridge/v1` and includes sessions, transcripts, models, cancellation, and collaboration runs. Streaming turns use SSE.

See [`docs/API.md`](docs/API.md).

## Codex compatibility

This repository intentionally preserves the upstream product path:

```text
Codex → /v1/responses → codex-chatgpt-web → ChatGPT Web
```

The original `codex-chatgpt-web` CLI, browser worker, launcher, model routing, compaction machinery, and Codex harness remain compatibility infrastructure. The generic bridge wraps that runtime instead of rewriting it.

## Verification

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI runs verification on macOS, Linux, and Windows. Live browser validation is intentionally separate because it requires a real authenticated ChatGPT account.

The required live milestone is:

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember 8427."
agent-chatgpt ask --session demo "What value did I ask you to remember?"
```

The final reply must contain `8427` without human message copying. Then validate two-session isolation, cancellation, MCP ask/continue, and a two-round autonomous relay.

See [`docs/release-validation-agent-bridge.md`](docs/release-validation-agent-bridge.md).

## Architecture and implementation

- [`implementation.md`](implementation.md) — authoritative implementation specification
- [`docs/architecture.md`](docs/architecture.md) — architecture background
- [`docs/API.md`](docs/API.md) — native REST contract
- [`docs/MCP.md`](docs/MCP.md) — Agent → ChatGPT MCP surface
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — external-agent protocol
- [`docs/security-model.md`](docs/security-model.md) — trust boundaries and security
- [`docs/development.md`](docs/development.md) — contributor workflow
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — upstream synchronization notes
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — evidence-based current status

## License

MIT. The inherited upstream code remains subject to its original license notices.
