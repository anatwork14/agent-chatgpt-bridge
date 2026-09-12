# Agent ChatGPT Bridge Release Validation

This document separates deterministic CI evidence from account-bound live validation.

## Automated gate

Required before a release candidate is accepted:

```text
[ ] frozen dependency install succeeds
[ ] version sync succeeds
[ ] TypeScript typecheck succeeds
[ ] inherited upstream tests succeed
[ ] generic bridge tests succeed
[ ] dependency audit succeeds
[ ] launcher tests/build succeed
[ ] package build succeeds
[ ] release smoke succeeds
[ ] macOS CI succeeds
[ ] Linux CI succeeds
[ ] Windows CI succeeds
```

## Live authenticated gate

Use a real launcher-owned ChatGPT login. Do not automate password entry or CAPTCHA.

### Persistent conversation

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember the number 8427."
agent-chatgpt ask --session demo "What number did I ask you to remember?"
```

Pass: final response contains `8427` without manual message copying.

### Session isolation

Create two sessions with unique markers and verify neither response leaks the other marker.

### Model discovery

`agent-chatgpt models --json` must reflect account-supported ChatGPT Web routes and unavailable routes must fail explicitly.

### Cancellation

Start a long turn, cancel it, and verify the bridge reaches a terminal cancelled state without leaving browser ownership stuck.

### MCP

Connect an MCP-capable external agent, call `chatgpt_ask`, receive the response, and continue external-agent reasoning.

### Autonomous relay

Complete at least two Agent → ChatGPT → Agent exchanges and terminate through structured `done`. Verify persisted run objective, rounds, transcript, timestamps, and termination reason.

### Restart reconstruction

Create a session, complete turns, restart the bridge, inspect the persisted transcript, and continue the session according to the supported continuity contract.

## Failure handling

UI drift, missing completion evidence, authentication loss, unsupported models, invalid JSONL, and cross-session ambiguity must fail closed. Do not waive these failures by adding silent fallbacks.

## Evidence policy

Do not mark the live gate complete from fake-provider tests or CI alone. Record date, platform, account capability tier, model route, and pass/fail evidence when the live gate is executed.
