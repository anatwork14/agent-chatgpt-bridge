# Agent ChatGPT Bridge REST API

The native bridge API is local-first and versioned under `/bridge/v1`.

Default endpoint:

```text
http://127.0.0.1:8765/bridge/v1
```

Production composition supplies a bearer token derived from the private runtime control secret. The `agent-chatgpt` CLI reads the same local configuration and authenticates automatically. Third-party clients must send:

```http
Authorization: Bearer <bridge-token>
```

The bridge is not intended to be exposed directly to an untrusted network.

## Sessions

### `POST /sessions`

Create an isolated bridge session.

Example body:

```json
{
  "name": "research",
  "model": "chatgpt-web/high",
  "effort": "high"
}
```

`model` may be omitted when the daemon has an explicit account-derived default.

### `GET /sessions`

List persisted sessions.

### `GET /sessions/{id}`

Get one session by ID or supported alias.

### `GET /sessions/{id}/messages`

Return the canonical persisted transcript.

### `POST /sessions/{id}/messages`

Send one user message.

```json
{
  "content": [
    { "type": "text", "text": "Review this result." }
  ],
  "stream": false
}
```

The session owns provider/model selection. A caller cannot silently move an existing session onto another provider/model by changing a turn payload.

When `stream=true`, the response is Server-Sent Events. Bridge events include `turn.started`, `text.delta`, reasoning summaries when available, tool-call notifications, and a terminal completion/failure event.

### `POST /sessions/{id}/cancel`

Cancel the active turn for the session.

### `DELETE /sessions/{id}`

Close the session and release provider conversation ownership.

## Models

### `GET /models`

Returns ChatGPT Web routes available to the authenticated account according to the upstream account-capability model routing.

No silent model downgrade is performed.

## Collaboration runs

### `POST /runs`

Start a bounded external-agent ↔ ChatGPT collaboration run.

Example:

```json
{
  "objective": "Find and fix the parser race",
  "agent_adapter": {
    "type": "subprocess-jsonl",
    "command": ["./my-agent-wrapper"]
  },
  "chatgpt": {
    "session_id": "ses_..."
  },
  "budget": {
    "max_rounds": 20,
    "max_wall_clock_ms": 3600000,
    "max_consecutive_failures": 3
  }
}
```

For a persistent ACP v1 agent, select a built-in profile or provide a custom ACP command:

```json
{
  "objective": "Review the parser race",
  "agent_adapter": {
    "type": "acp:cursor",
    "permission_mode": "deny"
  },
  "chatgpt": { "session_id": "ses_..." }
}
```

The built-in ACP profile types are `acp:cursor`, `acp:gemini`, and `acp:claude`. A custom profile uses `"type": "acp"` and a non-empty `command` array. The optional permission modes are `deny` and `allow_readonly` on the REST surface. `delegate` is reserved for embedded callers that provide a resolver; it cannot be represented as a REST function. ACP runs retain one ACP session across rounds, advertise no filesystem/terminal/MCP callbacks, and do not import agent-client credentials.

Hard maximum rounds: 100.

### `GET /runs/{id}`

Read current run state.

### `POST /runs/{id}/cancel`

Cancel the run. Cancellation propagates to the active external-agent invocation and active ChatGPT turn.

## Idempotency

Non-streaming mutation routes support `Idempotency-Key` where implemented. Reusing a key with the same request body returns the recorded result; reusing the key with a different body fails with `idempotency_conflict`.

SSE turns do not accept replay keys because replaying an already-consumed event stream is ambiguous.

## Error envelope

Bridge errors use a stable shape:

```json
{
  "error": {
    "code": "session_not_found",
    "message": "Session ... not found",
    "retryable": false,
    "requestId": "..."
  }
}
```

Representative codes include `invalid_request`, `session_not_found`, `session_closed`, `session_busy`, `model_unavailable`, `authentication_required`, `browser_not_ready`, `browser_ui_drift`, `browser_turn_timeout`, `client_cancelled`, `run_budget_exhausted`, `agent_adapter_failed`, `agent_adapter_timeout`, `agent_protocol_invalid`, and `agent_permission_denied`.

The public API does not intentionally expose raw internal stack traces.
