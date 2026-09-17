## What this changes

<!-- Describe one focused behavior change and link the issue/design discussion when applicable. -->

Fixes #

## Why

<!-- What collaboration/runtime problem does this solve? Why does it belong in Agent Bridge rather than ARC, CompanyOS, codex-router, or a provider-specific client? -->

## Evidence

<!-- Give the reproduction before the change and the exact result afterward. For protocol/provider changes, include deterministic fixtures and real interoperability evidence when available. -->

## Architecture / invariants

- [ ] I read and followed `CONTRIBUTING.md` and `implementation.md`.
- [ ] `SessionManager` remains the owner of canonical bridge history.
- [ ] Provider/model/agent identity remains explicit and globally unambiguous.
- [ ] This does not silently migrate a session or perform implicit provider fallback.
- [ ] Provider/agent credentials stay with the provider/router/client that owns them.
- [ ] Model/agent output remains untrusted and gains no capability merely by requesting it.
- [ ] Cancellation reaches the exact active provider request or owned agent process.
- [ ] Autonomous behavior remains bounded by explicit budgets and terminal states.
- [ ] Persistence/audit fail-closed guarantees are not weakened.
- [ ] No ARC execution-plane or CompanyOS product-layer responsibility is duplicated inside Agent Bridge.

## Verification

- [ ] `bun install --frozen-lockfile` passes in the repository root and `launcher/` when launcher code is affected.
- [ ] `bun run verify` passes with the Bun version pinned by `package.json`.
- [ ] I added or updated focused deterministic tests for behavior changes.
- [ ] I manually exercised the affected integration when the change crosses a real provider/agent boundary.
- [ ] ACP changes were checked against `docs/ACP_LIVE_SMOKE.md` where applicable.
- [ ] codex-router changes preserve its downstream-provider-plane boundary and namespace rules.
- [ ] ChatGPT Web changes include observed/reproducible UI evidence rather than speculative selector broadening.
- [ ] Launcher changes preserve supported macOS, Windows, and Linux packaging/smoke expectations.
- [ ] I did not commit credentials, browser state, capability URLs, raw private logs, generated release artifacts, or private paths.

## Interoperability / platform evidence

<!-- List what was actually exercised: OS, Agent Bridge SHA, provider/client + version, model/profile, and result. Write "not run" for anything not verified. -->

```text
OS:
Bridge SHA:
Provider / agent:
Provider / agent version:
Profile / model:
Result:
```

## Security notes

<!-- Describe changes to permissions, environment inheritance, local binding, credential handling, process ownership, filesystem/terminal access, or audit output. Write "none" if unaffected. -->
