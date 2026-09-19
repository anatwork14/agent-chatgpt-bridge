# P6 ARC / CompanyOS Integration Sign-Off

**Phase:** P6  
**Status:** RELEASE CANDIDATE — merge only after exact-head Bridge CI passes  
**Tracking:** issue #11 / PR #12  
**Baseline:** P5 merge `c3338cdeabb1a7fe95ea97231bed97be9be223a6`

## 1. Authority boundary

P6 preserves three independent authorities:

- **Agent Bridge** owns collaboration/session/provider identity and lifecycle.
- **ARC** owns project/task DAGs, workers/worktrees, candidates, Git integration, and IntegrationGate acceptance.
- **CompanyOS** owns workflow/policy/budget/evidence/outcome state.

Cross-system IDs are bounded opaque correlation metadata only.

## 2. Agent Bridge evidence

Functional P6 head before this release-evidence commit:

`397199746912125322850645298f0de43ea0c962`

CI run:

`35413007099` — PASS

Covered on Ubuntu, macOS, and Windows plus actionlint and real codex-router integration.

P6 deterministic coverage includes:

- versioned capability discovery;
- bearer-authenticated safe read/cancel boundary;
- exact Bridge-owned run cancellation with fixed Bridge-owned reason;
- SQLite v4 correlation persistence;
- correlation close/reopen durability;
- correlation binding through RunController;
- minimized run projection leak tests;
- minimized/replayable SSE lifecycle events;
- SSE cursor replay and consumer-disconnect isolation;
- idempotent external DAG submission;
- built-in role/profile-only external submission;
- rejection of credential, arbitrary command/cwd, and ACP delegate surfaces;
- recovery event field minimization, including external `runStatus` instead of ambiguous `outcomeStatus`.

## 3. ARC P6.5 evidence

Repository: `anatwork14/adaptive-agent-runtime`

PR #29 exact smoke head:

`9c37f8492f0069bdb9dfc4c5d533c9f1e5ad9831`

CI:

`35412712345` — PASS on Python 3.11 and 3.12

Released merge:

`3adc4bfce924d213ad1f676726f3373ef44e1399`

The ARC smoke proves:

- consumption through versioned HTTP/SSE only;
- no Bridge internal imports;
- ARC project/task/session correlation survives round trip;
- idempotent submission;
- replay cursor parsing;
- exact Bridge cancellation;
- a Bridge `completed` collaboration remains observational;
- the correlated ARC task stays READY;
- no `gate.accepted` or `task.completed` is emitted;
- runtime bearer token, objective, and node instructions do not enter ARC events.

## 4. CompanyOS P6.6 evidence

Repository: `anatwork14/CompanyOS`

Contract PR #13 exact head:

`52f60a6ec198e9784e876a6d11f903525d7f00ba`

Contract merge:

`d3b1f4579bcd8f9aadfaf54a46d25ec7cdbf6da0`

Behavioral smoke PR #14 exact head:

`f3e84c41c8840bdf4a88f9c6c7c653824c21040d`

Gateway-smoke Git blob:

`7f71b459e27407b62e4dd7e1e6694df3e6bfda29`

Behavioral merge:

`790974b2cb8ecc956da5c64505d8e711e7751de4`

Exact-byte gateway smoke result: PASS.

The CompanyOS smoke proves:

- versioned capability discovery;
- bearer-authenticated protocol-only client behavior;
- same-key/same-request idempotent replay without duplicate run creation;
- same-key/different-request conflict;
- workflow/step/run correlation preservation;
- SSE replay cursor handling;
- exact Bridge run cancellation;
- Bridge `completed` does not mutate CompanyOS workflow, policy, budget, or outcome state;
- bearer token and protected content do not enter observed payloads.

CompanyOS is currently a private architecture/bootstrap repository whose GitHub-hosted Actions jobs fail before step execution. No CompanyOS CI success is claimed. The schemas were validated on exact head and the behavioral harness was executed byte-for-byte before merge.

## 5. Restart / recovery / cancellation evidence

P6 reuses the released P5 recovery/cancellation semantics and adds integration-specific durability:

- correlation metadata survives SQLite close/reopen;
- interrupted DAG recovery/resume remains covered by the P5 verifier suite run under Bridge CI;
- recovery events are replayable minimized projections;
- exact integration cancellation targets only the Bridge run ID;
- ARC cancellation propagation targets the exact Bridge run;
- CompanyOS gateway smoke targets the exact Bridge run;
- consumer SSE disconnect does not cancel Bridge execution;
- duplicate submission retry cannot create a second Bridge run.

## 6. Security / data minimization audit

Integration projections/events intentionally exclude:

- objective text;
- prompts/static node instructions;
- raw model output/transcript content;
- transcript/output message IDs;
- final summaries;
- provider error message details;
- commands and cwd;
- environment values;
- provider credentials/tokens;
- unrestricted arbitrary JSON;
- CompanyOS workflow/policy/budget/outcome authority fields.

Allowed external control is bounded to versioned discovery, idempotent static-DAG submission, minimized read/events, and exact cancellation.

## 7. Final gate

This release-candidate commit intentionally records all P6.0–P6.7 evidence before the final CI run.

**Do not merge PR #12 unless:**

1. PR #12 head remains unchanged;
2. the CI run attached to that exact head passes actionlint, codex-router integration, Ubuntu, macOS, and Windows;
3. branch divergence remains 0 behind main;
4. no review/thread blocker appears;
5. GitHub reports the PR mergeable.

The final PR conversation comment records the exact release head, CI run, and merge action.
