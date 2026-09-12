# External Agent Adapters

The bridge core talks to external agents through `ExternalAgentAdapter`. The first universal adapter is `subprocess-jsonl`.

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
