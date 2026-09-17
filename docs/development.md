# Development Guide

## Baseline

The project intentionally keeps `miuuyy/codex-chatgpt-web` recognizable so upstream browser fixes remain mergeable. See `UPSTREAM_BASELINE` and `docs/upstream-patches.md`.

High-risk upstream components such as `browser-worker.ts` should receive targeted changes only. Prefer wrappers/facades around stable browser code.

## Required local checks

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify
```

Launcher changes additionally require launcher typecheck/test/build and release smoke paths.

## Test strategy

- Core/session/run/protocol unit tests use fake providers and, where persistence durability is irrelevant, in-memory SQLite.
- Dedicated persistence/crash tests remain file-backed.
- Browser contract tests protect the inherited ChatGPT runtime.
- CI validates macOS, Linux, and Windows.
- Authenticated browser behavior is validated separately because CI does not own a real user ChatGPT session.

## Engineering rules

- Generic core types must not depend on `CodexParsedRequest`.
- Codex is a compatibility ingress, not the universal internal domain model.
- Fail closed on ambiguous provider/browser state.
- Keep loopback-only networking by default.
- Never log browser cookies or secrets.
- Keep stdout machine-readable for JSONL adapters; logs go to stderr.
- Preserve session isolation and one-active-turn-per-session serialization.
- Do not infer autonomous completion from prose.

## CI

The workflow uses PR-scoped concurrency with `cancel-in-progress` so obsolete commits do not consume runners after a newer head exists.
