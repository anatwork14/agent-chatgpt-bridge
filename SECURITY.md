# Security policy

Agent Bridge coordinates multiple authenticated local systems. Treat browser sessions, provider credentials, capability URLs, local agent state, transcripts, and tool output as sensitive.

Do not open public issues containing ChatGPT cookies/browser storage, OAuth tokens, API keys, codex-router capability URLs, ACP client credentials, private prompts/tool results, raw provider logs, or unredacted local filesystem paths. Use the repository's private Security Advisory flow for credential exposure, authentication bypass, permission-boundary failures, or arbitrary tool execution.

## Trust boundaries

- The bridge and provider-control surfaces bind to loopback by default.
- ChatGPT Web authentication remains in the launcher-controlled browser profile.
- codex-router owns its provider credentials and provider-specific authentication.
- Cursor, Gemini, Claude, and custom ACP agents own their own authentication state.
- Agent Bridge must not copy provider/subscription-agent credentials into bridge persistence.
- Model and external-agent output is untrusted content.
- Filesystem, terminal, network, or tool authority must come from explicit bridge/client policy, never from model text alone.

## External-agent processes

ACP and subprocess adapters spawn owned child processes. The bridge must bound protocol output, turn time, cancellation grace, and close time; propagate cancellation; and terminate owned process trees that do not exit cleanly. An orphaned external-agent process after bridge close is a security/reliability bug.

ACP permission handling is fail-closed by default. Standard filesystem, terminal, and elicitation client callbacks are disabled unless deliberately implemented under an explicit policy. Real-client interoperability changes should be validated with `docs/ACP_LIVE_SMOKE.md`.

## Routing and persistence

- Provider/model/agent identity must remain explicit and unambiguous.
- Fallback is disabled by default and must be explicitly configured, bounded, and audited.
- A fallback turn must not silently rewrite the persistent session's provider/model identity.
- Required routing/audit persistence failures must not silently degrade into unaudited execution.
- Diagnostic/audit events must avoid credential values, capability URLs, and raw private provider state.

## ChatGPT Web and local-tool mode

Read the complete [security model](docs/security-model.md) before enabling tool-capable workflows. ChatGPT Web/browser behavior can drift independently of bridge code; selector/protocol ambiguity must fail closed rather than guessing.

If another local user can access the same OS account/application home, treat browser sessions, local agent auth state, router credentials, and bridge control material as potentially compromised and rotate/re-authenticate through the owning provider/client.

## Dependency gate

The stable MCP v1 SDK currently declares the vulnerable `@hono/node-server` 1.x range even though this project uses only its stdio transport. The lockfile explicitly resolves that unused HTTP adapter to patched 2.0.12. `bun audit`, MCP protocol tests, and compiled-binary smoke tests remain release gates; remove the override when the stable SDK itself no longer requires it.

## Reporting

Use GitHub's private Security Advisory flow for vulnerabilities. Include the affected Agent Bridge SHA/version, OS, component/provider/agent version, minimal reproduction, expected boundary, observed behavior, and privacy-safe evidence. Do not publish a proof of concept that exposes credentials or arbitrary local tool execution before a fix/mitigation is available.
