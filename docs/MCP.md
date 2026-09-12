# Agent → ChatGPT MCP

`agent-chatgpt mcp` exposes a stdio MCP server that lets an MCP-capable external agent use ChatGPT Web as a collaborating peer while remaining the primary agent.

This direction is intentionally separate from the upstream ChatGPT → Codex tool bridge. Calling these tools does **not** grant ChatGPT local shell or filesystem authority.

## Tools

### `chatgpt_create_session`

Create an isolated bridge session.

Inputs: optional `name`, `model`, `effort`.

### `chatgpt_ask`

Send a message. `session_id` is optional; without it, a new session is created using an explicit/default model.

### `chatgpt_continue`

Continue an existing session. Inputs: `session_id`, `message`.

### `chatgpt_get_session`

Read session metadata.

### `chatgpt_list_sessions`

List bridge sessions.

### `chatgpt_list_models`

Return ChatGPT Web model routes available to the authenticated account.

### `chatgpt_cancel`

Cancel the current turn in a session.

### `chatgpt_close_session`

Close the session and release provider ownership.

## Recommended agent workflow

```text
external agent identifies a question
        ↓
chatgpt_ask / chatgpt_continue
        ↓
ChatGPT Web response
        ↓
external agent evaluates it, runs tools/tests itself
        ↓
continue or finish
```

ChatGPT prose is untrusted peer output. The external agent should validate claims and must use its own explicit capability path for local side effects.

## Session isolation

Every logical bridge session has its own stable identity. Do not reuse one session for unrelated tasks when conversational state must remain isolated.
