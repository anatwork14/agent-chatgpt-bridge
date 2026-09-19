# P6: ARC / CompanyOS Integration Contract

**Document Version:** 1.0.0  
**Status:** P6.0–P6.1 IMPLEMENTED / VALIDATION IN PROGRESS  
**Branch:** `feat/p6-arc-companyos-integration`  
**Tracking Issue:** #11  
**Baseline:** P5 merge commit `c3338cdeabb1a7fe95ea97231bed97be9be223a6`

---

## 1. Purpose

P6 turns the released Agent Bridge P5 collaboration runtime into an explicit service boundary that can be consumed by:

- **ARC / adaptive-agent-runtime** — authoritative execution plane;
- **CompanyOS** — coordination/product plane.

The integration strategy is **protocol composition, not codebase merging**.

Agent Bridge continues to own collaboration semantics, provider/agent interaction, collaboration persistence, cancellation, permission boundaries, and collaboration audit state.

ARC continues to own project/task execution authority, isolated worktrees, task DAGs, leases, exact Git candidates, and IntegrationGate acceptance.

CompanyOS continues to own goals, SOPs, workflows, business policy, budgets, coordination, and outcome/evidence semantics.

P6 must not make any of those systems authoritative for another system's internal state.

---

## 2. Authority Matrix

| Domain | Authoritative owner | Other systems may hold |
| --- | --- | --- |
| Bridge session / collaboration run | Agent Bridge | opaque ID + projection |
| Bridge DAG node lifecycle | Agent Bridge | minimized projection |
| ARC task DAG | ARC | correlation ID only |
| ARC worker / worktree / candidate | ARC | correlation ID only |
| CompanyOS workflow / step | CompanyOS | correlation ID only |
| Provider credentials | provider/vendor client | never copied |
| Bridge provider/model routing | Agent Bridge | outcome/projection only |
| Git candidate acceptance | ARC IntegrationGate | external evidence only |
| Company outcome / budget / policy | CompanyOS | external correlation only |

No integration endpoint may redefine these boundaries.

---

## 3. P6 Security Invariants

P6 MUST preserve all P0–P5 security invariants and additionally enforce:

1. integration routes remain under the existing local bearer-token boundary;
2. no integration projection contains objective text;
3. no integration projection contains static node instructions;
4. no integration projection contains raw model output or canonical message content;
5. no integration projection contains provider error messages;
6. no integration projection contains credential material;
7. no integration projection contains cwd, unrestricted command strings, or environment values;
8. external IDs are correlation metadata, never Bridge primary keys;
9. arbitrary external cancellation text is not persisted as a Bridge cancellation reason;
10. no integration client may mutate graph topology after execution begins;
11. no integration client may raise Bridge parallelism/retry budgets after start;
12. no silent provider/model fallback is introduced by integration logic.

---

## 4. Versioned Contract

P6 integration payloads use an explicit schema version.

Current version:

```text
schemaVersion = 1
```

The TypeScript contract lives in:

```text
src/core/integration-contract.ts
```

Backward-incompatible payload changes require a new schema version or route version. Additive optional fields may be introduced without invalidating schema version 1 only when older consumers can safely ignore them.

---

## 5. Capability Discovery

Endpoint:

```http
GET /bridge/v1/integrations/capabilities
Authorization: Bearer <local bridge token>
```

Initial response:

```json
{
  "schemaVersion": 1,
  "service": "agent-chatgpt-bridge",
  "authority": {
    "collaboration": "bridge",
    "execution": "external",
    "coordination": "external"
  },
  "capabilities": {
    "dagRunProjection": true,
    "dagRunCancellation": true,
    "integrationEvents": false,
    "dagRunSubmission": false
  }
}
```

Capability discovery is truthful: future surfaces remain `false` until implemented and tested.

---

## 6. Safe DAG Projection

Endpoint:

```http
GET /bridge/v1/integrations/dag-runs/:id
Authorization: Bearer <local bridge token>
```

The projection includes only:

- Bridge run ID;
- Bridge session ID;
- run lifecycle status;
- failure policy;
- max parallel turns;
- participant count;
- node count;
- timestamps;
- per-node:
  - node ID;
  - participant ID;
  - role ID;
  - lifecycle status;
  - declaration index;
  - attempt/retry count;
  - lifecycle timestamps;
  - bounded error code + retryability.

The projection intentionally excludes:

- objective;
- policy instructions;
- node instructions;
- transcript/turn IDs;
- canonical output message IDs/content;
- final summary;
- provider error text;
- commands;
- cwd;
- credentials/environment values.

Node ordering is declaration-index deterministic.

---

## 7. Exact Cancellation

Endpoint:

```http
POST /bridge/v1/integrations/dag-runs/:id/cancel
Authorization: Bearer <local bridge token>
```

P6.1 deliberately does **not** accept arbitrary external cancellation text.

The Bridge uses the fixed internal reason:

```text
Cancelled by local integration client
```

This avoids turning a control-plane endpoint into an arbitrary-text persistence channel.

Cancellation targets the exact Bridge DAG run ID and continues to use the P5 cancellation path.

---

## 8. Correlation Metadata — P6.2

Planned correlation fields:

```ts
interface BridgeIntegrationCorrelation {
  arcProjectId?: string;
  arcTaskId?: string;
  arcSessionId?: string;
  companyWorkflowId?: string;
  companyStepId?: string;
  companyRunId?: string;
  externalTraceId?: string;
}
```

Rules:

- values are bounded opaque identifiers;
- values are never interpreted as authorization;
- values never replace Bridge IDs;
- values are persisted only in dedicated minimized metadata;
- values must not contain secrets, paths, prompts, or arbitrary JSON;
- correlation updates after run creation require an explicit reviewed contract.

---

## 9. Integration Events — P6.3

Planned events are lifecycle projections derived from Bridge authoritative state, for example:

```text
bridge.integration.dag_run.created
bridge.integration.dag_run.status_changed
bridge.integration.node.status_changed
bridge.integration.dag_run.cancelled
bridge.integration.dag_run.completed
```

Events MUST be reconstructable from authoritative Bridge persistence and MUST NOT become a second source of truth.

Payloads follow the same minimization rules as the REST projection.

A consumer disconnect must not affect Bridge execution.

---

## 10. External Submission — P6.4

Future submission is additive and idempotent.

A submission request may declare:

- Bridge collaboration configuration;
- static DAG;
- explicit participant adapter/profile selections;
- bounded budgets;
- correlation IDs.

It may not:

- submit credentials;
- mutate ARC task DAGs;
- execute ARC IntegrationGate;
- submit CompanyOS authoritative workflow state;
- dynamically add DAG nodes after start;
- request unbounded retries/parallelism;
- enable silent provider substitution.

Submission must use an idempotency key so an ARC/CompanyOS retry cannot create duplicate Bridge runs.

---

## 11. ARC Integration — P6.5

ARC consumes Agent Bridge as a collaboration/intelligence service.

Expected conceptual flow:

```text
ARC authoritative task
        |
        | correlation metadata
        v
Agent Bridge collaboration DAG
        |
        | minimized lifecycle/result evidence
        v
ARC worker/task context
        |
        v
isolated Git candidate
        |
        v
ARC IntegrationGate
```

Bridge completion does not imply ARC task acceptance.

ARC remains responsible for:

- worktree mutation;
- candidate generation;
- verification;
- Git integration;
- authoritative task completion.

---

## 12. CompanyOS Integration — P6.6

CompanyOS consumes Agent Bridge through its Intelligence Gateway boundary.

Conceptual flow:

```text
CompanyOS workflow step
        |
        | bounded intelligence request
        v
Agent Bridge
        |
        | collaboration lifecycle/evidence
        v
CompanyOS workflow
        |
        v
evaluation / evidence / outcome
```

Bridge does not become CompanyOS's workflow engine, budget ledger, knowledge graph, or business outcome authority.

---

## 13. Failure and Recovery

Integration consumers must tolerate:

- Bridge daemon restart;
- paused/recovered P5 DAG runs;
- provider unavailability;
- cancellation;
- terminal failure;
- duplicate HTTP retries;
- consumer disconnect.

Bridge remains authoritative for the collaboration run lifecycle.

Future integration events are observational and replayable from Bridge state; they must never require the consumer to reconstruct a missing Bridge transition.

---

## 14. Implementation Slices

### P6.0 — versioned integration domain + discovery

- [x] integration schema version;
- [x] authority declaration;
- [x] truthful capability discovery;
- [x] minimized DAG projection builder;
- [x] leak-prevention unit tests.

### P6.1 — safe REST read/cancel boundary

- [x] bearer-authenticated capability endpoint;
- [x] DAG projection endpoint;
- [x] exact DAG cancellation endpoint;
- [x] fixed cancellation reason;
- [x] unknown-run handling;
- [x] REST leak/auth tests.

### P6.2 — correlation metadata

- [ ] bounded correlation schema;
- [ ] persistence;
- [ ] validation;
- [ ] projection support;
- [ ] restart durability tests.

### P6.3 — integration event stream

- [ ] event envelope;
- [ ] minimized lifecycle events;
- [ ] replay cursor;
- [ ] SSE consumer disconnect isolation;
- [ ] restart/replay tests.

### P6.4 — external collaboration submission

- [ ] versioned request;
- [ ] idempotency;
- [ ] participant/profile validation;
- [ ] P5 static DAG validation reuse;
- [ ] no credential-bearing fields;
- [ ] exact run identity response.

### P6.5 — ARC integration smoke

- [ ] ARC client/adapter uses only HTTP/event contract;
- [ ] correlation preserved;
- [ ] Bridge completion does not bypass IntegrationGate;
- [ ] cancellation propagation demonstrated;
- [ ] no cross-repo internal imports.

### P6.6 — CompanyOS integration smoke

- [ ] Intelligence Gateway client uses only versioned contract;
- [ ] workflow-step correlation preserved;
- [ ] Bridge state remains non-authoritative for CompanyOS workflow;
- [ ] cancellation/retry behavior demonstrated.

### P6.7 — release sign-off

- [ ] cross-platform Agent Bridge CI;
- [ ] ARC contract smoke;
- [ ] CompanyOS contract smoke;
- [ ] restart/recovery/cancellation evidence;
- [ ] security/data-minimization audit;
- [ ] exact-head release gate.

---

## 15. Definition of Done

P6 is complete only when:

- P6.0–P6.7 are checked;
- Agent Bridge integration surfaces are versioned and bearer-protected;
- ARC and CompanyOS use protocol composition only;
- no authority boundary is duplicated or silently transferred;
- no protected content leaks through projections/events;
- retries are idempotent;
- cancellation targets exact Bridge ownership;
- recovery works across daemon restart;
- cross-repository integration smokes pass;
- final exact-head CI and release gate pass.
