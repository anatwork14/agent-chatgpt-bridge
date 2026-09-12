# Upstream Patch Policy

Upstream baseline: see `UPSTREAM_BASELINE`.

The project reuses the upstream browser/login/model/launcher runtime and adds the generic bridge mainly in new modules such as:

```text
src/core/
src/persistence/
src/providers/
src/protocols/
src/agents/
src/runtime/
src/compatibility/
src/cli/
```

## Rules

1. Avoid formatting or renaming large upstream files without functional need.
2. Wrap the ChatGPT Web adapter before modifying browser internals.
3. Keep upstream Codex behavior covered by inherited tests.
4. Record unavoidable upstream-runtime edits here when they materially complicate future synchronization.
5. Prefer small, reviewable compatibility patches over forks of browser logic.

## Current notable compatibility work

- A generic provider facade wraps the upstream ChatGPT Web adapter.
- Generic bridge sessions synthesize stable native-style thread/turn identity to reuse retained conversation machinery.
- Codex request conversion remains isolated under compatibility code rather than leaking `CodexParsedRequest` through the generic core.
- Existing `/v1/responses`, launcher, browser worker, compaction, and Codex integration remain compatibility paths.

No release should replace browser fail-closed checks with permissive selectors or silent fallback merely to make generic-agent tests pass.
