# Contributing

Agent Bridge is a provider-agnostic collaboration runtime. Contributions are welcome when they preserve the separation between bridge orchestration, provider/router ownership, and the execution/product layers above it.

Before opening a bug report, reproduce on the current revision when possible, use the structured issue form, and share only privacy-safe evidence. Never upload cookies, OAuth tokens, API keys, browser storage, capability URLs, raw private prompts, provider logs containing secrets, or unredacted local paths.

For architectural changes, open an issue/design discussion before a large implementation. Focused pull requests with explicit invariants and verification are much easier to review than broad rewrites.

## Architecture boundaries

- **Agent Bridge** owns persistent collaboration sessions, canonical transcripts, routing policy, bounded workflows, external-agent adapters, permissions, persistence, and auditability.
- **ChatGPT Web provider** owns browser/UI interaction and its authenticated launcher profile.
- **codex-router** owns downstream provider credentials and provider-specific connectivity/normalization.
- **ACP agent clients** own their installation and provider authentication state.
- **ARC** remains the execution plane for task DAGs, isolation, experiments, recovery, and ledgers.
- **CompanyOS** remains the coordination/product layer.

Prefer protocol composition and explicit adapters over merging provider/client implementations into the bridge.

## Core invariants

- `SessionManager` remains the canonical bridge-history owner.
- Provider/model/agent identity is explicit and globally unambiguous.
- Fallback is disabled unless explicitly configured and audited; never silently mutate persistent session identity.
- Model/agent output is untrusted and cannot grant itself tools, filesystem, terminal, network, or credential access.
- Credentials stay with the system that owns them. Do not persist provider/API/subscription-agent credentials in bridge state.
- Cancellation must reach the exact active provider request or owned external-agent process.
- External-agent processes must be owned and cleaned up; do not leave detached/orphaned workers.
- Autonomous workflows are bounded by rounds, wall-clock/failure budgets, explicit terminal states, and cancellation.
- Preserve fail-closed behavior for protocol drift, unsupported callbacks, ambiguous routing, and required audit/persistence failures.
- Never commit browser state, cookies, API keys, OAuth tokens, capability URLs, generated private logs, or absolute user-specific paths.

## Before opening a pull request

1. Run `bun install --frozen-lockfile` in the repository root.
2. If launcher code is affected, run `bun install --frozen-lockfile` in `launcher/` too.
3. Run `bun run verify`.
4. Add focused deterministic regression coverage for behavior changes.
5. Manually test any changed real provider/agent boundary; deterministic mocks are not live interoperability evidence.
6. For ACP changes, follow `docs/ACP_LIVE_SMOKE.md` and record the client version, OS, bridge SHA, and privacy-safe JSON result.
7. For ChatGPT Web UI changes, include observed/reproducible DOM evidence rather than speculative selector broadening.
8. For codex-router changes, preserve the downstream-provider-plane boundary and namespaced model identity.
9. For launcher changes, preserve macOS, Windows, and Linux packaging/smoke expectations.
10. Keep Terms/trademark/security claims factual and do not present the bridge as a way to bypass authentication, permissions, or provider limits.

## Evidence expectations

A useful pull request names what was actually tested:

```text
OS:
Bridge SHA:
Provider / agent:
Provider / agent version:
Profile / model:
Deterministic tests:
Live test:
Result:
```

Write `not run` rather than implying a live path was exercised when only CI/mocks were used.

## Relevant docs

- `implementation.md` — authoritative existing implementation invariants
- `GOALS.md` — provider-agnostic product direction and roadmap
- `IMPLEMENTATION_PROGRESS.md` — evidence-based milestone status
- `docs/security-model.md` — trust and permission boundaries
- `docs/agent-adapters.md` — external-agent adapter semantics
- `docs/ACP_LIVE_SMOKE.md` — P3 real-client ACP release gate
- `docs/CODEX_ROUTER.md` — downstream router integration
- `docs/development.md` — contributor workflow
