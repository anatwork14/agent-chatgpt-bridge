# External Agent Adapters

The bridge core talks to external agents through `ExternalAgentAdapter`. The available transports are the per-turn `subprocess-jsonl` adapter and the persistent stable ACP v1 adapter.

## ACP v1

ACP support uses the official `@agentclientprotocol/sdk` stable root entry point. The bridge is the ACP client; the configured coding agent is the ACP agent. One ACP process and session are retained for the lifetime of a collaboration run, so relay rounds preserve agent-side conversational context.

Built-in launch profiles are configuration data:

| Adapter type | Launch command |
| --- | --- |
| `acp:cursor` | `agent acp` |
| `acp:gemini` | `gemini --acp` |
| `acp:claude` | `claude-agent-acp` |

Use `acp` with a non-empty `command` array for a custom ACP agent. The bridge advertises no filesystem, terminal, or MCP capability by default and rejects unsupported client callbacks. ACP permission handling defaults to `deny`; `allow_readonly` only selects an explicitly offered allow option for read/search/fetch tool kinds. Embedded callers may use `delegate` with a permission resolver.

ACP agents inherit only the allowlisted process environment plus explicitly configured extra variables. The bridge never reads, parses, persists, or returns agent-client OAuth/API credentials. Protocol output is bounded, stderr is kept separate from stdout, and cancellation/close terminate the owned process tree after a bounded grace period.

The ACP adapter asks an agent to use the bridge-owned completion convention `<bridge_done>SUMMARY...</bridge_done>`. A completed ACP prompt without that marker is still only a collaboration message; prompt completion is not treated as objective completion.

## JSONL protocol

For each collaboration round the bridge launches the configured process and writes exactly one JSON line to stdin:

```json
{
  "version": 1,
  "type": "turn",
  "run_id": "run_...",
  "objective": "Find and fix the parser race",
  "round": 2,
  "last_chatgpt_response": {
    "text": "The likely race is..."
  }
}
```

The agent must emit exactly one valid decision frame on stdout. Human-readable logs belong on stderr.

### Continue

```json
{"version":1,"type":"message","content":"I applied the fix. Review these results..."}
```

### Complete

```json
{"version":1,"type":"done","summary":"The race is fixed and the test suite passes."}
```

### Pause

```json
{"version":1,"type":"pause","reason":"Human approval is required."}
```

### Error

```json
{"version":1,"type":"error","message":"Dependency unavailable","retryable":true}
```

## Strictness

The adapter deliberately fails on malformed JSON, unknown versions/types, multiple protocol frames, non-zero process exit, oversized output, timeout, or cancellation failures. It does not scrape interactive terminal UIs.

## Autonomy budgets

Default collaboration limits:

- maximum rounds: 20
- wall clock: 1 hour
- consecutive failures: 3
- hard maximum rounds: 100

A run also stops on structured `done`, structured `pause`, user cancellation, provider failure, or session closure. Natural-language phrases such as “we are done” are not treated as authoritative termination.

## Writing another adapter

Implement the `ExternalAgentAdapter` contract and return structured `AgentDecision` values. Keep execution/capability authority in the external agent; the bridge should remain orchestration and transport, not become a second planner.
