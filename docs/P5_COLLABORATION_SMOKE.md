# P5 Live Collaboration DAG Sign-Off

**Status:** PASS — REAL LIVE SIGN-OFF COMPLETE  
**Command:** `bun run smoke:p5:live`  
**Harness:** `scripts/smoke-p5-collaboration-live.ts`

## Purpose

This is the final P5.8 release gate for the bounded multi-participant collaboration DAG.

The harness uses real authenticated ACP clients and exercises:

```text
                     +-> critic (Claude) --------+
architect (Claude) --+                            +-> reviewer (Claude)
                     +-> implementer (Antigravity)+
```

with `maxParallelTurns = 2`.

A second live run starts two independent root nodes (Claude + Antigravity), waits until both are simultaneously persisted as `running`, then cancels the exact DAG run.

## Required environment

The same live prerequisites as the accepted P4 sign-off apply:

- `claude-agent-acp` available and authenticated;
- `agy-acp` available and authenticated;
- Bun dependencies installed;
- no credentials passed through bridge configuration;
- permission mode remains `deny`.

Preflight must resolve:

```text
Claude       -> claude-agent-acp
Antigravity  -> agy-acp
```

## Run

```bash
bun run smoke:p5:live
```

The verifier uses an isolated temporary workspace/database and removes both after completion.

## Required evidence

The sanitized JSON result must report `status: "PASS"` and establish all of the following:

- [x] four real participants are created with distinct adapter runtime instances;
- [x] architect completes before both branch nodes become eligible;
- [x] critic (Claude) and implementer (Antigravity) actually overlap in wall-clock execution;
- [x] observed maximum concurrency is exactly 2 and never exceeds `maxParallelTurns = 2`;
- [x] both branches receive the architect canonical output;
- [x] reviewer fan-in provenance is exactly `[critique, implementation]`;
- [x] canonical transcript order is deterministic regardless of branch completion order;
- [x] reviewer receives both dynamically generated branch nonces and returns `P5_LIVE_OK`;
- [x] SQLite v3 stores all node states, canonical messages, and input provenance;
- [x] audit IDs are monotonic and payloads contain no objective/prompt/output/nonce/workspace/credential data;
- [x] no direct agent-to-agent transport exists; all handoffs are canonical persisted RunController inputs;
- [x] second run observes two nodes simultaneously `running` before cancellation;
- [x] exact DAG cancellation settles both active nodes as `cancelled`;
- [x] cancellation does not call `SessionManager.cancel()`;
- [x] no workspace mutation occurs;
- [x] temporary resources are removed and adapters are closed.

## Sign-off record

Exact-head real-client sign-off:

```text
date: 2026-09-18 23:14:50 UTC
platform: Darwin arm64 (macOS)
branch: feat/p5-bounded-collaboration-dag
head SHA: a25ae80d3fcf898e0071544d05adcf0a1009d0c4
working tree clean: YES
command: bun run smoke:p5:live

status: PASS
runStatus: completed
participantCount: 4
nodeCount: 4
transcriptMessageCount: 4
maxParallelTurns: 2
branchOverlapProved: true
observedMaxConcurrency: 2
deterministicFanInOrder: true
reviewerReceivedCriticNonce: true
reviewerReceivedImplementerNonce: true
reviewerTerminalDone: true
cancellationRunStatus: cancelled
simultaneousCancellationTargets: 2
cancelledNodeCount: 2
auditLeakCheck: true
workspaceMutation: false
temporaryResourcesRemoved: true
schemaVersion: 3

credentials exposed: NO
workspace modified: NO
temporary resources remaining: NO
PR merged during smoke: NO
PR marked ready during smoke: NO
```

Deterministic CI on the same implementation head:

```text
CI run: 35404281425
conclusion: PASS
branch divergence at gate: 0 behind / 72 ahead
GitHub mergeability: MERGEABLE
reviews: 0
review threads: 0
```

The release-record commits after this sign-off are documentation/status-only; the implementation and live-smoke harness exercised above remain those from `a25ae80d3fcf898e0071544d05adcf0a1009d0c4`.

## Release rule

P5.8 is complete. Merge remains gated on final CI for the documentation/status-only release-record head and the exact-head merge guard.
