# Codex Router integration

Agent ChatGPT Bridge can use [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router) as a downstream provider plane while keeping bridge sessions, transcripts, autonomous runs, cancellation, and agent orchestration in this repository.

## Architecture

```text
external agent / CLI
        |
        v
Agent ChatGPT Bridge
  SessionManager
  RunController
  model-router
        |
        +----------------------+----------------------+
        |                                             |
        v                                             v
ChatGPTWebConversationProvider            CodexRouterConversationProvider
        |                                             |
        v                                             v
   ChatGPT Web                                  codex-router
                                              /    |    \
                                         Claude DeepSeek Kimi ...
```

The integration is intentionally protocol-level. This repository does not import codex-router source code, copy provider credentials, or read its private state files.

## Security boundary

Codex Router protects its local Responses API with a random caller capability embedded in the URL path. Treat the complete URL like a password:

- never commit it;
- never paste it into an issue, log, or support bundle;
- keep the bridge and codex-router bound to loopback;
- do not point `AGENT_CHATGPT_CODEX_ROUTER_BASE_URL` at a public HTTP endpoint.

The bridge rejects non-loopback codex-router URLs by default. Optional bearer authentication can be layered on top with `AGENT_CHATGPT_CODEX_ROUTER_API_KEY`.

## Configure

Install and configure codex-router first, then verify its doctor/health checks according to that project's documentation.

When the packaged `codex-router` command is available, obtain its intentionally printable panel capability without reading the private caller-key file:

```sh
PANEL_URL="$(codex-router panel --print)"
export AGENT_CHATGPT_CODEX_ROUTER_BASE_URL="${PANEL_URL%panel/}v1"
unset PANEL_URL
```

`panel --print` is deliberately sensitive output. Do not echo the resulting environment variable.

If an additional local proxy requires bearer authentication:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_API_KEY='local-only-token'
```

Start the bridge normally:

```sh
agent-chatgpt serve
```

Without `AGENT_CHATGPT_CODEX_ROUTER_BASE_URL`, codex-router integration is completely disabled and existing ChatGPT Web behavior is unchanged.

## Discover routed models

```sh
agent-chatgpt models --json
```

ChatGPT Web models keep their existing names, for example:

```text
chatgpt-web/high
chatgpt-web/luna
```

Codex Router models are namespaced by the bridge:

```text
codex-router/deepseek/deepseek-v4-pro
codex-router/anthropic-api/claude-opus-4.8
codex-router/kimi-oauth/kimi-for-coding
```

The extra `codex-router/` prefix belongs to Agent ChatGPT Bridge. The provider removes only that prefix before sending the request to codex-router.

## Use a routed model

Because the bridge's internal `model-router` resolves namespaced model ownership, normal protocol clients only need to choose the model.

```sh
agent-chatgpt session create \
  --name deepseek-review \
  --model codex-router/deepseek/deepseek-v4-pro

agent-chatgpt ask \
  --session deepseek-review \
  "Review this architecture and identify the three largest risks."
```

The same model IDs are available through:

- `GET /bridge/v1/models`;
- `POST /bridge/v1/sessions`;
- MCP `chatgpt_list_models` / `chatgpt_create_session`;
- `GET /v1/models`;
- `POST /v1/responses`.

Existing callers that omit a model continue to use the primary ChatGPT Web default model.

## Current capability contract

The first integration intentionally enables only capabilities that can be normalized safely across routed providers:

- text input/history;
- text streaming;
- reasoning effort forwarding;
- JSON-schema output forwarding;
- usage accounting;
- cancellation;
- HTTP/auth/rate-limit/error mapping.

Images and bridge-managed tool translation are **disabled** for the codex-router provider until exact per-model capability metadata is wired. The provider fails closed rather than pretending all OpenAI-compatible models support those features.

## Failure semantics

The bridge does not silently switch providers.

```text
codex-router unavailable -> provider_unavailable
codex-router 401/403     -> provider_authentication_failed
codex-router 429         -> provider_rate_limited
malformed SSE/JSON       -> provider_protocol_invalid
missing terminal event   -> provider_terminal_missing
client cancellation      -> client_cancelled
```

A configured codex-router endpoint participates in model discovery. Misconfiguration is therefore visible immediately instead of silently falling back to ChatGPT Web.

## Do not create a routing cycle

The supported topology is:

```text
Agent ChatGPT Bridge -> codex-router -> external model/provider
```

Do **not** simultaneously configure codex-router to route the same model namespace back into this bridge. Reciprocal routing can create catalog recursion or request loops. A future release may support explicitly tagged reciprocal edges, but the initial integration deliberately has one routing direction.

## Validation checklist

After configuration:

```text
[ ] codex-router doctor/health passes
[ ] agent-chatgpt serve starts
[ ] agent-chatgpt models shows codex-router/* models
[ ] routed session can complete a text turn
[ ] second turn preserves bridge session history
[ ] cancelling a routed turn reaches the downstream request
[ ] a 429 remains a visible rate-limit failure and does not fall back
[ ] ChatGPT Web sessions still work independently
[ ] autonomous run can target a session backed by codex-router
```

## Next extensions

The architectural boundary intentionally leaves room for:

1. per-model image/tool/search capabilities;
2. provider health and cooldown state;
3. explicit policy-controlled failover;
4. ACP agent adapters for Claude Code, Cursor Agent, and Gemini CLI;
5. role-based collaboration policies such as `architect -> ChatGPT`, `critic -> Claude`, `cheap reviewer -> DeepSeek`;
6. multi-agent DAG execution above the provider registry.

Those features belong in Agent ChatGPT Bridge. Provider-specific credential and transport quirks remain codex-router's responsibility.
