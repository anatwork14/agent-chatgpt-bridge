# Live codex-router smoke

Use this only after the deterministic test suite passes. The smoke intentionally consumes one real routed-model turn and must be run against a local codex-router installation.

## 1. Export the caller-capability URL safely

Obtain the URL through codex-router's deliberate printable interface rather than reading private credential files:

```sh
PANEL_URL="$(codex-router panel --print)"
export AGENT_CHATGPT_CODEX_ROUTER_BASE_URL="${PANEL_URL%panel/}v1"
unset PANEL_URL
```

Treat `AGENT_CHATGPT_CODEX_ROUTER_BASE_URL` like a password. Do not echo it, commit it, paste it into an issue, or include it in diagnostics.

If the router has an additional local bearer layer:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_API_KEY='local-only-token'
```

## 2. Direct provider smoke

From the repository root:

```sh
bun run scripts/smoke-codex-router.ts
```

The script:

1. discovers `/models` through the configured local capability URL;
2. selects the first routed model unless an explicit smoke model is set;
3. sends one text-only Responses turn;
4. requires a completed non-empty assistant response;
5. prints only the public model ID and non-sensitive response/usage counts.

Expected success form:

```text
CODEX_ROUTER_SMOKE_OK model=codex-router/... chars=... input=... output=...
```

To choose a specific public model ID:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_MODEL='codex-router/<provider>/<model>'
bun run scripts/smoke-codex-router.ts
```

The model must be one of the namespaced IDs returned by bridge-side discovery.

## 3. Full bridge smoke

Start the normal bridge with the same environment:

```sh
agent-chatgpt serve
```

In another terminal using the same bridge home:

```sh
agent-chatgpt models --json
```

Confirm that both `chatgpt-web/...` and `codex-router/...` routes are present. Then execute a routed turn:

```sh
agent-chatgpt ask \
  --model 'codex-router/<provider>/<model>' \
  --quiet-session \
  'Reply with a short acknowledgement for a bridge routing smoke test.'
```

Create a persistent routed session and prove continuation:

```sh
agent-chatgpt session create \
  --name router-smoke \
  --model 'codex-router/<provider>/<model>' \
  --json
```

Use the returned session ID for two `agent-chatgpt ask --session ...` turns. The second turn must remain in the same bridge session; no provider/model migration is allowed.

## 4. Coexistence check

While the routed provider is configured, also run one normal ChatGPT Web session. Success requires both providers to work independently:

```text
ChatGPT Web session      -> chatgpt-web/... only
codex-router session     -> codex-router/... only
no silent fallback
no shared conversation state
no routing cycle
```

A codex-router outage may make routed models unavailable, but it must not prevent creation of an unrelated ChatGPT Web session.

## 5. Cancellation and rate-limit checks

For the final P1 release gate, verify with a real long-running routed request that cancellation terminates the downstream request. If the selected provider can safely produce a 429 in a test environment, verify that it surfaces as `provider_rate_limited` and does not fall back to another model.

## Pass criteria

P1 live validation passes only when all of the following are observed:

```text
[ ] direct provider smoke succeeds
[ ] bridge model discovery shows namespaced routed models
[ ] routed text turn succeeds
[ ] routed second turn preserves bridge history
[ ] ChatGPT Web still works independently
[ ] cancellation propagates to the routed request
[ ] rate-limit/provider failures remain explicit
[ ] no capability URL appears in logs or errors
[ ] no model/provider fallback occurs
```
