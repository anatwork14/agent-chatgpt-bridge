# P5 Live Collaboration DAG Sign-Off

**Status:** PENDING REAL LIVE EXECUTION  
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

- [ ] four real participants are created with distinct adapter runtime instances;
- [ ] architect completes before both branch nodes become eligible;
- [ ] critic (Claude) and implementer (Antigravity) actually overlap in wall-clock execution;
- [ ] observed maximum concurrency is exactly 2 and never exceeds `maxParallelTurns = 2`;
- [ ] both branches receive the architect canonical output;
- [ ] reviewer fan-in provenance is exactly `[critique, implementation]`;
- [ ] canonical transcript order is deterministic regardless of branch completion order;
- [ ] reviewer receives both dynamically generated branch nonces and returns `P5_LIVE_OK`;
- [ ] SQLite v3 stores all node states, canonical messages, and input provenance;
- [ ] audit IDs are monotonic and payloads contain no objective/prompt/output/nonce/workspace/credential data;
- [ ] no direct agent-to-agent transport exists; all handoffs are canonical persisted RunController inputs;
- [ ] second run observes two nodes simultaneously `running` before cancellation;
- [ ] exact DAG cancellation settles both active nodes as `cancelled`;
- [ ] cancellation does not call `SessionManager.cancel()`;
- [ ] no workspace mutation occurs;
- [ ] temporary resources are removed and adapters are closed.

## Sign-off record

Populate only after a real successful run:

```text
date:
platform:
branch:
head SHA:
command: bun run smoke:p5:live

status:
runStatus:
participantCount:
nodeCount:
transcriptMessageCount:
maxParallelTurns:
branchOverlapProved:
observedMaxConcurrency:
deterministicFanInOrder:
reviewerReceivedCriticNonce:
reviewerReceivedImplementerNonce:
reviewerTerminalDone:
cancellationRunStatus:
simultaneousCancellationTargets:
cancelledNodeCount:
auditLeakCheck:
workspaceMutation:
temporaryResourcesRemoved:
```

## Release rule

Do not mark P5.8 complete and do not merge PR #10 until this document contains a real PASS record from the current release candidate head.
