# P5: Bounded Multi-Participant Collaboration DAG Specification

**Document Version:** 1.0.0  
**Status:** DRAFT / APPROVED FOR IMPLEMENTATION  
**Target Milestone:** P5 (`feat/p5-bounded-collaboration-dag`)  
**Baseline:** P4 merged to `main` at `ac3cd2a56b7335b098251f0377f7d0620f0b9186`  
**Tracking Issue:** #9  
**Predecessor:** `docs/P4_ROLE_BASED_COLLABORATION.md`

---

## 1. Executive Summary

P4 introduced explicit roles, participant assignment, canonical transcript persistence, cancellation, recovery, audit events, and a strictly sequential multi-participant workflow.

P5 generalizes that released P4 workflow into a **bounded static collaboration DAG**. Independent collaboration nodes may execute concurrently when their dependencies are satisfied, while fan-in nodes consume deterministic persisted outputs from their declared predecessors.

P5 remains a collaboration feature inside Agent Bridge. It is **not** a general-purpose workflow engine and must not absorb ARC's execution-plane responsibilities.

The P5 scheduler is therefore intentionally constrained:

- graph topology is declared before execution;
- graph validation completes before any participant process starts;
- nodes may not create new nodes or edges;
- every node binds to an already configured participant;
- global parallelism is bounded;
- the same participant cannot execute two nodes concurrently;
- all inter-node handoff data travels through RunController and canonical persistence;
- completed node output is immutable;
- retries occur on the same node/participant only;
- cancellation, failure, restart recovery, and audit behavior are deterministic.

---

## 2. Goals

P5 MUST provide:

1. static DAG definitions for role-based collaboration;
2. deterministic graph validation and topological planning;
3. bounded fan-out execution;
4. deterministic fan-in input assembly;
5. per-node lifecycle state;
6. canonical node output provenance;
7. persistence sufficient for crash recovery and idempotent resume;
8. exact node/run cancellation propagation;
9. fail-closed failure semantics;
10. graph/node audit events;
11. backward compatibility with P4 sequential runs;
12. real multi-agent fan-out/fan-in release evidence.

---

## 3. Non-Goals

P5 does NOT implement:

- recursive or model-generated graph expansion;
- arbitrary distributed task scheduling;
- a queue cluster or worker fleet;
- shell/process orchestration unrelated to collaboration adapters;
- provider credential brokerage;
- implicit participant/provider/model substitution;
- speculative duplicate execution of the same node;
- unbounded parallelism;
- direct peer-to-peer agent communication;
- arbitrary cyclic state machines.

ARC remains the execution plane for broader task DAGs, experiments, sandboxes, recovery ledgers, and runtime control.

---

## 4. Architectural Invariants

### 4.1 Static graph invariant

The entire graph definition MUST be known and validated before the first node starts.

No agent output may add, remove, or rewrite graph nodes or edges during a P5 run.

### 4.2 DAG invariant

The graph MUST be acyclic.

Validation MUST reject:

- self edges;
- missing node references;
- duplicate node IDs;
- duplicate edges;
- cycles;
- orphan participant references;
- graphs exceeding hard node/edge caps.

### 4.3 Explicit actor invariant

Each executable node MUST bind to exactly one participant ID.

That participant MUST already exist in the P4 role-based participant assignment set.

Roles remain responsibility labels. Capabilities remain adapter configuration and are never inferred from role names.

### 4.4 Hub-and-spoke invariant

Participants never send prompts directly to peers.

All node inputs are assembled by RunController from:

- the run objective;
- declared predecessor outputs;
- optional static node instructions;
- role instructions;
- canonical provenance metadata.

### 4.5 Bounded parallelism invariant

P5 permits `maxParallelTurns > 1`, but the value is bounded by a hard safety cap.

The scheduler MUST enforce both:

- global active node count <= `maxParallelTurns`;
- active node count per participant <= 1.

A participant therefore retains serial conversational/process semantics even when independent participants run concurrently.

### 4.6 Immutable output invariant

Once a node reaches `completed`, its canonical output and provenance are immutable.

Crash recovery MUST NOT re-execute a completed node.

### 4.7 Deterministic fan-in invariant

A fan-in node receives predecessor outputs in deterministic order independent of completion timing.

Default ordering is graph declaration order after validation normalization.

### 4.8 Fail-closed persistence invariant

A node MUST NOT be considered successfully completed until its terminal node state and canonical output are persisted atomically.

If required persistence or audit operations fail, execution MUST fail closed.

---

## 5. Canonical Domain Model

### 5.1 Identifiers

```ts
export type CollaborationDagNodeId = string;
export type CollaborationDagEdgeId = string;
```

IDs are opaque bridge-owned identifiers or validated user-supplied logical IDs after normalization.

### 5.2 Node definition

```ts
export interface CollaborationDagNodeDefinition {
  readonly id: CollaborationDagNodeId;
  readonly participantId: string;
  readonly instruction: string;
  readonly dependsOn: CollaborationDagNodeId[];
  readonly terminal?: boolean;
  readonly retryLimit?: number;
  readonly timeoutMs?: number;
}
```

Rules:

- `participantId` MUST exist in the run participant set.
- `instruction` is static user/controller input, not generated scheduling code.
- `dependsOn` is explicit and complete.
- root nodes use `dependsOn: []`.
- `retryLimit` cannot exceed the run-level retry cap.
- `timeoutMs` cannot exceed remaining run wall-clock budget.
- a terminal node may complete the graph only when its dependencies are satisfied and it emits an authorized terminal decision.

### 5.3 Graph definition

```ts
export interface CollaborationDagDefinition {
  readonly version: 1;
  readonly nodes: CollaborationDagNodeDefinition[];
}
```

Edges are derived from `dependsOn` for the P5 public contract. Persistence may materialize explicit edge rows for efficient dependency queries.

### 5.4 Node status

```ts
export type CollaborationDagNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled";
```

State progression:

```text
pending -> ready -> running -> completed
                         |-> failed
                         |-> cancelled

pending/ready -> skipped
pending/ready -> cancelled
```

Terminal node statuses are immutable.

### 5.5 Runtime node record

```ts
export interface CollaborationDagNodeRecord {
  readonly id: CollaborationDagNodeId;
  readonly runId: string;
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly status: CollaborationDagNodeStatus;
  readonly declarationIndex: number;
  readonly attempt: number;
  readonly retryLimit: number;
  readonly timeoutMs?: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly outputMessageId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}
```

### 5.6 Provenance

Every node output MUST persist explicit input provenance.

```ts
export interface CollaborationDagInputProvenance {
  readonly nodeId: CollaborationDagNodeId;
  readonly objectiveIncluded: boolean;
  readonly predecessorMessageIds: string[];
  readonly predecessorNodeIds: CollaborationDagNodeId[];
  readonly assembledAt: string;
}
```

The predecessor arrays MUST be deterministic and aligned by index.

### 5.7 P5 budget

P4's `maxParallelTurns: 1` becomes a bounded positive integer for DAG runs.

Recommended defaults:

```ts
export const P5_LIMITS = {
  maxNodes: 64,
  maxEdges: 256,
  maxParallelTurns: 4,
} as const;

export const P5_DEFAULT_MAX_PARALLEL_TURNS = 2;
```

The existing P4 sequential configuration continues to normalize to `maxParallelTurns: 1`.

---

## 6. Validation

Graph validation is pure and MUST run before participant adapter creation.

### 6.1 Structural checks

Reject when:

- graph version is unsupported;
- graph contains zero nodes;
- node count exceeds the hard cap;
- node ID is empty or duplicated;
- dependency references are missing;
- node depends on itself;
- the same dependency is listed twice;
- edge count exceeds the hard cap;
- participant is unknown;
- node retry budget is invalid;
- node timeout is invalid.

### 6.2 Cycle detection

Use deterministic Kahn topological sorting.

Validation returns a normalized plan containing:

- declaration index;
- indegree;
- ordered dependent list;
- topological order;
- root node IDs;
- sink node IDs.

If processed node count differs from graph node count, reject with `collaboration_dag_cycle`.

### 6.3 Determinism

For multiple ready nodes, scheduling priority is:

1. topological level;
2. declaration index;
3. node ID as stable tie-breaker.

Actual completion order may differ under parallel execution, but persisted input assembly and downstream ready ordering must remain deterministic.

---

## 7. Scheduler

### 7.1 Ready-set scheduler

RunController maintains:

- a bounded global ready queue;
- active node controls by node ID;
- active participant locks by participant ID;
- terminal node state map;
- remaining run wall-clock budget.

A node becomes `ready` only when all dependencies are `completed`.

### 7.2 Dispatch

Dispatch may start a ready node when:

- global active count is below `maxParallelTurns`;
- its participant is not already active;
- run cancellation has not been requested;
- run budget remains;
- required predecessor outputs pass integrity verification.

### 7.3 Same-participant serialization

Two ready nodes targeting the same participant MUST execute serially.

The lower deterministic scheduling priority executes first.

### 7.4 Node input construction

Each node turn input includes:

1. run objective;
2. node instruction;
3. role instructions;
4. ordered predecessor outputs;
5. provenance metadata;
6. relevant bounded prior participant continuity required by the adapter contract.

It MUST NOT include unrelated hidden outputs from sibling branches unless explicitly connected by dependencies.

### 7.5 Fan-out

Independent ready nodes assigned to different participants may execute concurrently up to the configured cap.

### 7.6 Fan-in

A fan-in node is not ready until every predecessor has completed successfully.

Predecessor content is ordered by normalized dependency order, not finish time.

---

## 8. Failure Semantics

P5 uses an explicit graph failure policy:

```ts
export type CollaborationDagFailurePolicy =
  | "fail_fast"
  | "skip_dependents";
```

### 8.1 fail_fast

On unrecoverable node failure:

- cancel active sibling node turns;
- mark not-yet-started nodes cancelled;
- fail the run.

This is the default.

### 8.2 skip_dependents

On unrecoverable node failure:

- mark transitive dependents `skipped`;
- independent branches may continue;
- the run may complete only if an authorized terminal node remains reachable and completes.

P5 does not support arbitrary model-controlled conditional edges.

### 8.3 Retry

Retries:

- stay on the same node;
- stay on the same participant;
- do not rotate provider/model;
- increment persisted attempt count;
- cannot exceed node or run retry limits.

---

## 9. Cancellation

### 9.1 Run cancellation

Run cancellation MUST:

1. set the authoritative run abort reason;
2. abort every active node;
3. propagate cancellation to each active participant adapter;
4. wait only within bounded cleanup time;
5. mark pending/ready nodes cancelled;
6. persist final run state;
7. emit exactly one run terminal audit event.

### 9.2 Node cancellation

P5 internal APIs may cancel an exact active node for scheduler/failure propagation.

Public arbitrary user cancellation of one node is out of scope unless introduced through a separately reviewed API because it changes graph semantics.

---

## 10. Persistence

P5 introduces SQLite migration v3.

Recommended tables:

### 10.1 `collaboration_dag_nodes`

Persist:

- node ID;
- run ID;
- participant ID;
- role ID;
- declaration index;
- instruction snapshot;
- status;
- attempt;
- retry limit;
- timeout;
- output message ID;
- error fields;
- timestamps.

### 10.2 `collaboration_dag_edges`

Persist:

- run ID;
- predecessor node ID;
- successor node ID;
- dependency order.

Composite uniqueness prevents duplicate edges.

### 10.3 `collaboration_dag_inputs`

Persist canonical provenance for each started attempt or final successful attempt.

At minimum:

- run ID;
- node ID;
- predecessor node IDs JSON;
- predecessor message IDs JSON;
- objective-included flag;
- assembled timestamp.

### 10.4 Atomic node completion

Successful node completion transaction MUST atomically:

1. insert/update turn record;
2. insert canonical output message;
3. persist provenance;
4. mark node completed with output message ID;
5. update participant state;
6. update run scheduling state if required.

A process crash after the transaction MUST recover as completed without replay.

---

## 11. Recovery / Resume

Startup recovery converts active `running` nodes to an interrupted recoverable state before resume planning.

Resume MUST:

- verify graph definition/persistence integrity;
- preserve completed nodes;
- reconcile interrupted running nodes deterministically;
- recompute ready set from persisted terminal states;
- never duplicate completed canonical output;
- restore participants through the existing P4 restorer;
- respect remaining wall-clock semantics.

Recovery is idempotent.

---

## 12. Audit Events

Extend the P4 audit taxonomy with events such as:

```text
collaboration.dag.validated
collaboration.node.ready
collaboration.node.started
collaboration.node.retrying
collaboration.node.completed
collaboration.node.failed
collaboration.node.skipped
collaboration.node.cancelled
collaboration.fanout.started
collaboration.fanin.ready
```

Audit payloads contain identifiers and bounded metadata only.

They MUST NOT contain:

- objective text;
- prompts;
- raw model output;
- credentials;
- OAuth tokens;
- capability URLs;
- unrestricted workspace paths.

---

## 13. Backward Compatibility

P4 behavior remains supported.

A sequential P4 role workflow is semantically equivalent to a linear P5 DAG:

```text
architect -> implementer -> reviewer
```

P5 implementation MUST NOT require existing P4 callers to provide graph definitions.

The existing P4 execution path may remain separate initially, then be internally lowered to a linear DAG only after deterministic equivalence tests exist.

---

## 14. API Strategy

P5 should introduce additive graph-aware methods rather than mutate existing P4 call contracts in place.

Conceptually:

```ts
RunController.startDagRun(...)
RunController.executeDagRun(...)
RunController.resumeDagRun(...)
RunController.cancelDagRun(...)
```

Public REST/MCP/CLI surfaces are added only after the core scheduler, persistence, cancellation, and recovery behavior is proven.

---

## 15. Security Model

P5 inherits every P4 security invariant.

Additional P5 requirements:

- sibling branch output isolation unless connected by an edge;
- no graph data may grant capabilities;
- no node may change its own participant assignment;
- no node may raise global parallelism;
- no node may alter another node's retry budget;
- no dynamic graph mutation from model output;
- canonical predecessor hashes are revalidated before fan-in;
- graph validation failure occurs before agent process startup.

---

## 16. Implementation Slices

### P5.0 — DAG domain model + invariants

- [ ] DAG types
- [ ] node statuses / terminal helpers
- [ ] hard bounds
- [ ] backward-compatible P4 budget widening
- [ ] pure invariant tests

### P5.1 — Graph validation + deterministic planning

- [ ] structural validator
- [ ] cycle detection
- [ ] deterministic topological planner
- [ ] roots/sinks/dependents plan
- [ ] malformed graph tests

### P5.2 — Bounded ready-set scheduler

- [ ] ready queue
- [ ] global parallel cap
- [ ] per-participant serialization
- [ ] fan-out execution
- [ ] deterministic dispatch tests

### P5.3 — Fan-in provenance + canonical outputs

- [ ] deterministic input assembly
- [ ] predecessor hash verification
- [ ] provenance persistence contract
- [ ] sibling output isolation tests

### P5.4 — SQLite persistence

- [ ] migration v3
- [ ] node store
- [ ] edge store
- [ ] provenance store
- [ ] atomic completion transaction
- [ ] disk durability tests

### P5.5 — Cancellation + failure propagation

- [ ] fail-fast cancellation
- [ ] skip-dependent propagation
- [ ] active sibling teardown
- [ ] bounded retries
- [ ] exact terminal state tests

### P5.6 — Recovery / resume

- [ ] interrupted-node reconciliation
- [ ] ready-set reconstruction
- [ ] completed-node no-replay guarantee
- [ ] idempotent resume tests

### P5.7 — Audit / observability

- [ ] DAG/node audit events
- [ ] deterministic event relationships
- [ ] data-minimization tests

### P5.8 — Live multi-agent DAG smoke

Validated topology:

```text
                     +-> critic (Claude) ------+
objective -> architect                         +-> synthesizer/reviewer (Claude)
                     +-> implementer (Antigravity) -+
```

The release smoke MUST prove:

- two independent branches actually overlap in wall-clock execution when assigned to different participants;
- `maxParallelTurns` is never exceeded;
- fan-in receives both persisted branch outputs;
- output order is deterministic regardless of completion order;
- no direct agent-to-agent prompt chaining occurs;
- cancellation cleans all active adapter processes;
- persistence and audit integrity pass;
- no credentials or raw prompt/output leak into audit records.

---

## 17. Definition of Done

P5 is complete only when:

- all P5.0–P5.8 slices are checked;
- deterministic unit/integration suite passes;
- macOS, Linux, and Windows CI passes on the exact release head;
- migration/recovery tests pass;
- live Claude + Antigravity fan-out/fan-in smoke passes;
- exact-head release gate reports no blockers;
- PR is merged to `main`.

