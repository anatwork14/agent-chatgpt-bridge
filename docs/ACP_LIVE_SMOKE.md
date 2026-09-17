# P3 live ACP interoperability runbook

This is the release gate for the native ACP external-agent adapter. Deterministic fake-agent coverage is necessary but not sufficient: P3 is signed off only after the bridge has exercised real installed ACP agents.

## Scope

Run the same verifier against the built-in profiles:

```text
cursor  -> agent acp
gemini  -> gemini --acp
claude  -> claude-agent-acp
```

The bridge treats these clients as **pre-authenticated local programs**. It does not import, copy, print, persist, or proxy their provider credentials.

## Prerequisites

1. Use Bun 1.4.0 and install this repository with the lockfile.
2. Install the ACP-capable client you want to test.
3. Authenticate that client using its own supported login flow before starting the bridge verifier.
4. Confirm the executable is resolvable from `PATH`.
5. Do not pass API keys through `AGENT_CHATGPT_ACP_COMMAND_JSON`. The adapter intentionally inherits only a small safe environment and expects normal client-local authentication state.

Current profile commands should be checked against upstream client documentation before each release because ACP CLIs evolve independently of this repository.

## Run

From the repository root:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run smoke:acp:live -- --profile cursor
bun run smoke:acp:live -- --profile gemini
bun run smoke:acp:live -- --profile claude
```

A custom ACP server can be tested without adding a permanent profile:

```bash
bun run smoke:acp:live -- \
  --profile custom \
  --command-json '["my-agent","--acp"]'
```

or:

```bash
AGENT_CHATGPT_ACP_PROFILE=custom \
AGENT_CHATGPT_ACP_COMMAND_JSON='["my-agent","--acp"]' \
bun run smoke:acp:live
```

## What the verifier proves

The verifier creates an isolated temporary working directory, never the repository workspace, and checks:

```text
[ ] ACP initialize succeeds
[ ] a real session is created
[ ] round 1 returns a unique marker
[ ] round 2 retains the same marker in the same ACP session
[ ] a mutation/permission probe fails closed and does not create its test file
[ ] an in-flight prompt observes bridge cancellation as client_cancelled
[ ] the same session can answer again after cancellation
[ ] adapter close completes and records agent.acp.closed
[ ] no agent.acp.failed audit event is recorded
[ ] the temporary workspace is removed
```

The JSON printed at the end is the evidence record for the run. It contains profile/status/audit event names, not provider secrets.

## Expected successful report

The exact event order may differ between agents, but all top-level gates must be true:

```json
{
  "profile": "cursor",
  "initialize": true,
  "continuity": true,
  "permissionFailClosed": true,
  "cancellation": true,
  "postCancelRecovery": true,
  "cleanClose": true,
  "failedAuditEvents": 0
}
```

## Failure interpretation

### Initialization fails

First verify the profile command and the client's own authentication state. A missing login is not a reason to add provider tokens to Agent Bridge.

### Permission probe fails

If `permission-probe.txt` is created, treat that as a P3 security blocker. The adapter is expected to reject unsafe permission requests and does not expose filesystem or terminal callbacks.

A client may reject the requested tool before sending `session/request_permission`; that is still fail-closed as long as the probe file is absent. The report includes the observed permission-request count for diagnostics.

### Cancellation fails

Treat either of these as a P3 blocker:

- the bridge cannot surface cancellation as `client_cancelled`;
- cancellation tears down the session so badly that the post-cancel recovery turn cannot complete.

The adapter may close an unresponsive child after its cancellation grace period. If that happens for a real client, capture the JSON/error and fix interoperability before sign-off rather than weakening cleanup guarantees.

### Process remains after close

Treat an orphaned ACP subprocess as a blocker. `close()` must first attempt ACP session close when supported, then close protocol streams, then terminate the owned process tree if it does not exit promptly.

## P3 sign-off record

Record the date, client version, bridge commit SHA, OS, and final JSON report for each real client:

```text
Cursor:
  date:
  client version:
  bridge SHA:
  OS:
  result:

Gemini CLI:
  date:
  client version:
  bridge SHA:
  OS:
  result:

Claude ACP:
  date:
  client version:
  bridge SHA:
  OS:
  result:
```

P3 is **deterministically complete but live-pending** until all required clients have evidence here or in the release PR/issue.
