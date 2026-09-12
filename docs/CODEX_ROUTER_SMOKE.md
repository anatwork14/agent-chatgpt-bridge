# Live codex-router smoke

Use this only after the deterministic test suite passes. The smoke consumes real model turns and must be run against a local codex-router installation.

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
bun run smoke:codex-router
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
bun run smoke:codex-router
```

The model must be one of the namespaced IDs returned by bridge-side discovery.

## 3. Full bridge smoke

Start the normal bridge with the same environment:

```sh
agent-chatgpt serve
```

In another terminal using the same bridge home, run the automated bridge-level verifier:

```sh
bun run smoke:codex-router:bridge
```

The verifier intentionally does not print the codex-router capability URL. It:

1. authenticates to the running local Agent ChatGPT Bridge using the bridge token derived from the existing profile;
2. verifies that `chatgpt-web/...` and `codex-router/...` model namespaces coexist;
3. creates a persistent routed session;
4. sends two context-dependent routed turns using a random continuity marker;
5. requires the second turn to recover the marker from the previous turn;
6. verifies persisted transcript order `user -> assistant -> user -> assistant`;
7. verifies the routed session's provider/model identity did not change;
8. fails immediately if any bridge response exposes the configured codex-router capability URL/path;
9. closes the temporary smoke session.

Expected success form:

```text
LIVE_BRIDGE_CODEX_ROUTER_SMOKE_OK model=codex-router/... continuity=passed capability_leak=none cancellation=not-requested coexistence=model-discovery-only
```

The verifier uses `AGENT_CHATGPT_BRIDGE_PORT` when set and otherwise connects to the default bridge port. A custom request timeout can be supplied in milliseconds:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_TIMEOUT_MS=180000
```

## 4. Real cancellation validation

Cancellation is opt-in because it deliberately starts a long-running real model request.

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL=1
bun run smoke:codex-router:bridge
```

The verifier starts a separate routed session, begins a deliberately long response, issues the authenticated bridge session-cancel operation, and requires both:

```text
cancelled == true
turn status == cancelled
```

If the provider finishes before cancellation arrives, use a slower/longer prompt or shorten the delay:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL_DELAY_MS=250
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL_PROMPT='Produce a very long response suitable for a cancellation transport test.'
```

## 5. Real ChatGPT Web coexistence validation

The default bridge smoke proves namespace coexistence without consuming a ChatGPT Web turn. To prove both providers can execute independently in the same running bridge, opt in explicitly:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT=1
bun run smoke:codex-router:bridge
```

Optionally choose the ChatGPT Web route:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT_MODEL='chatgpt-web/high'
```

Success requires the ChatGPT Web turn to complete and its temporary session to retain the original `chatgpt-web/...` model while the routed session remains pinned to `codex-router/...`.

To run the strongest automated live P1 smoke in one pass:

```sh
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CANCEL=1
export AGENT_CHATGPT_CODEX_ROUTER_SMOKE_CHATGPT=1
bun run smoke:codex-router:bridge
```

Expected success then includes:

```text
cancellation=passed coexistence=passed
```

## 6. Rate-limit/provider-error validation

A genuine 429 should only be forced when the selected provider offers a safe test mechanism. If safely reproducible, verify that it surfaces as `provider_rate_limited` and that the bridge does not migrate to another model/provider.

Do not intentionally exhaust a paid account merely to manufacture a release check. Deterministic tests already cover bridge-side 429 mapping and no-silent-fallback behavior; this live check exists only to validate the real provider path when it can be done safely.

## Pass criteria

P1 live validation passes only when all of the following are observed:

```text
[ ] direct provider smoke succeeds
[ ] bridge model discovery shows namespaced routed models
[ ] routed text turn succeeds
[ ] routed second turn preserves bridge history
[ ] ChatGPT Web still works independently
[ ] cancellation propagates to the routed request
[ ] rate-limit/provider failures remain explicit when safely reproducible
[ ] no capability URL appears in bridge responses/errors
[ ] no model/provider fallback occurs
```

The automated scripts cover every item above except a genuine provider-side 429, which remains conditional on a safe provider test path.