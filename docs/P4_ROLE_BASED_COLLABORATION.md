# P4: Role-Based Multi-Agent Collaboration Specification

**Document Version:** 1.0.0  
**Status:** DRAFT / APPROVED FOR IMPLEMENTATION  
**Target Milestone:** P4 (`feat/p4-role-based-collaboration`)  
**Parent PR / Baseline:** PR #5 (`main` @ `aeca1a34b4bca2b4e16b5376f74c7d1f23478802`)  
**Tracking Issues:** Issue #7 (Codex External-Agent Adapter Candidate)

---

## 1. Executive Summary & Motivation

### 1.1 Problem Statement
Phases P1 through P3 established a deterministic, hardened bridge foundation capable of:
1. Orchestrating single-agent external processes via subprocess JSONL and ACP v1 (`acp:claude`, `acp:antigravity`).
2. Driving persistent ChatGPT sessions across authenticated web and loopback relays.
3. Enforcing fail-closed capability security, credential isolation, and strict turn budgeting.

However, the existing collaboration loop (`CollaborationRun` in `src/core/run-controller.ts`) is strictly dyadic: exactly one external agent adapter (`agentAdapterId`) exchanges alternating rounds with one ChatGPT session (`sessionId`).

In real-world software engineering workflows, a single agent attempting to perform architecture, implementation, critique, and verification within one monolithic prompt context encounters severe failure modes:
- **Context Bloat & Cognitive Confusion:** Shifting operational modes (e.g. from high-level architectural trade-offs to low-level syntax fixes) within a single prompt degrades reasoning quality and increases hallucinations.
- **Confirmation Bias & Sycophancy:** An agent reviewing its own generated diff frequently overlooks logical bugs, edge cases, and security vulnerabilities.
- **Provider Lock-in at the Task Level:** Different foundation models excel at distinct tasks—for example, Claude 3.7 Sonnet for complex architectural reasoning and code review, Google Antigravity for codebase navigation and synthesis, and OpenAI models for targeted verification. Coupling a workflow to a single provider prevents combining best-of-breed capabilities.

### 1.2 The P4 Solution: Role-Based Collaboration
Phase P4 introduces **Role-Based Collaboration** to the Agent ChatGPT Bridge. Instead of binding a run to a single monolithic agent, a `CollaborationRun` orchestrates a team of specialized **Participants**, each assigned a distinct **Role** (e.g., `architect`, `implementer`, `reviewer`, `verifier`).

Crucially, **roles are logical responsibilities, completely independent of external providers or model vendors**. An `architect` role may be fulfilled by Claude today, Antigravity tomorrow, or Codex in the future. The bridge provides the authoritative hub-and-spoke orchestration, canonical transcript management, capability enforcement, and bounded execution invariants necessary to make multi-agent collaboration safe, deterministic, and auditable.

```text
                                  User Objective
                                        │
                                        ▼
                                ┌───────────────┐
                                │ RunController │ (Authoritative Hub)
                                └───────┬───────┘
                                        │
             ┌──────────────────────────┼──────────────────────────┐
             ▼                          ▼                          ▼
      ┌──────────────┐           ┌──────────────┐           ┌──────────────┐
      │  Architect   │           │ Implementer  │           │   Reviewer   │
      │ (Role: arch) │           │ (Role: impl) │           │ (Role: rev)  │
      │ Adapter: ACP │           │ Adapter: ACP │           │ Adapter:     │
      │  [Claude]    │           │[Antigravity] │           │   [Codex]    │
      └──────────────┘           └──────────────┘           └──────────────┘
```

---

## 2. Canonical Terminology

To eliminate architectural ambiguity across the codebase, documentation, and APIs, P4 strictly defines the following nine domain terms:

| Term | Definition | Concrete Example |
| :--- | :--- | :--- |
| **`role`** | An abstract functional specification of persona, mandate, system instructions, expected inputs, and expected outputs. Contains no provider or runtime state. | `architect`, `implementer`, `reviewer` |
| **`participant`** | A runtime instantiation of a role within an active `CollaborationRun`, binding the role to a concrete external agent adapter, isolated process/session, and lifecycle state. | Participant `part_01` (assigned role `architect`, running `acp:claude`) |
| **`agent`** | The external software entity or process implementing `ExternalAgentAdapter` that executes turns and returns decisions. | Claude Agent via ACP, Antigravity CLI via ACP, Subprocess JSONL binary |
| **`provider`** | The underlying model host, runtime engine, or communication protocol backing an agent or bridge session. | Anthropic Claude, Google Antigravity, OpenAI ChatGPT Web, Loopback Relay |
| **`session`** | The persistent conversational continuity context managed by `SessionManager` in SQLite, tracking message history, model parameters, and epochs. | `BridgeSession` (`ses_...`) in `bridge.db` |
| **`run`** | An end-to-end bounded multi-participant collaboration instance executing towards a user-defined objective under strict budget controls. | `CollaborationRun` (`run_...`) |
| **`turn`** | A single discrete execution cycle where one participant evaluates provided input and produces an `AgentDecision` (or where the bridge relay produces a response). | `CollaborationTurn` (`cturn_...`) |
| **`task`** | A bounded sub-goal or prompt slice assigned to a participant for a specific turn or stage within the run. | "Draft architecture plan for auth token refresh" |
| **`artifact`** | A structured, verifiable data payload produced by a participant during a turn (e.g. diff, specification document, review verdict, test report). | Markdown plan, unified git patch, JSON review rubric |

---

## 3. Architecture & Data Model

### 3.1 Domain Types (`src/core/collaboration-domain.ts`)

The core domain model builds cleanly upon existing P1–P3 abstractions without breaking single-agent backward compatibility.

```typescript
// ============================================================
// 1. Role Definitions
// ============================================================

export type BuiltinRoleId =
  | "primary"
  | "architect"
  | "researcher"
  | "implementer"
  | "critic"
  | "reviewer"
  | "verifier";

export type RoleId = BuiltinRoleId | (string & {});

export interface RoleDefinition {
  /** Unique logical role identifier (e.g. 'architect', 'implementer') */
  readonly id: RoleId;
  /** Human-readable display name */
  readonly name: string;
  /** Detailed functional mandate and operational boundaries */
  readonly description: string;
  /** System instructions injected into the participant's turn prompt */
  readonly systemInstructions: string;
  /** Contractual input expectations */
  readonly expectedInputSummary?: string;
  /** Contractual output format expectation (e.g. markdown diff, structured verdict) */
  readonly outputContract?: BridgeOutputContract;
}

// ============================================================
// 2. Participant & Assignment Models
// ============================================================

export type ParticipantStatus =
  | "pending"
  | "ready"
  | "active"
  | "idle"
  | "failed"
  | "cancelled";

export interface ParticipantConfig {
  /** Adapter identifier (e.g. 'acp:claude', 'acp:gemini', 'acp', 'subprocess-jsonl') */
  readonly adapterType: string;
  /** Custom launch command array (required for custom 'acp' or 'subprocess-jsonl') */
  readonly command?: string[];
  /** Process environment and permission configuration */
  readonly config?: ExternalAgentAdapterConfig;
  /** Optional role-specific working directory override */
  readonly cwd?: string;
}

export interface ParticipantRecord {
  readonly id: string;
  readonly roleId: RoleId;
  readonly adapterId: string;
  readonly status: ParticipantStatus;
  readonly turnsExecuted: number;
  readonly consecutiveFailures: number;
  readonly createdAt: string;
  readonly lastActiveAt?: string;
}

/**
 * Runtime-only participant execution state.
 * Kept strictly in memory by RunController during active turns; NEVER persisted or serialized.
 */
export interface ParticipantRuntime {
  readonly participantId: string;
  readonly adapter: ExternalAgentAdapter;
  readonly abortController?: AbortController;
}

export interface RoleAssignment {
  readonly roleId: RoleId;
  readonly participantConfig: ParticipantConfig;
}

// ============================================================
// 3. Collaboration Run & Turn Execution Models
// ============================================================

export type CollaborationRunStatus =
  | "created"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "timed_out";

export interface RoleBasedRunBudget {
  /** Maximum total turns across ALL participants in the run */
  readonly maxTurns: number;
  /** Maximum participants allowed to be instantiated in this run */
  readonly maxParticipants: number;
  /** Strictly 1 for P4 (enforces sequential turns; parallel execution is P5) */
  readonly maxParallelTurns: 1;
  /** Maximum consecutive retries allowed per participant before failure escalation */
  readonly maxRetriesPerParticipant: number;
  /** Hard total wall-clock limit in milliseconds */
  readonly maxWallClockMs: number;
  /** Extensible token/cost thresholds (optional) */
  readonly tokenBudget?: {
    readonly maxInputTokens?: number;
    readonly maxOutputTokens?: number;
    readonly maxTotalTokens?: number;
  };
}

export interface CollaborationTurnRecord {
  readonly id: string;
  readonly runId: string;
  readonly round: number;
  readonly turnIndex: number;
  readonly participantId: string;
  readonly roleId: RoleId;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly inputSummary: string;
  readonly decision?: AgentDecision;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
}

export interface RoleBasedCollaborationRun {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly status: CollaborationRunStatus;
  readonly round: number;
  readonly budget: RoleBasedRunBudget;
  readonly policy: RunPolicy;
  /** Explicit deterministic participant ordering */
  readonly participantIds: string[];
  /** O(1) indexed lookup of participant records */
  readonly participantsById: Record<string, ParticipantRecord>;
  readonly activeParticipantId?: string;
  readonly turnHistory: string[]; // List of CollaborationTurnRecord IDs
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly finalSummary?: string;
}

// ============================================================
// 4. Orchestration Policy
// ============================================================

export interface RunPolicy {
  /** Execution sequence of roles for sequential orchestration */
  readonly roleSequence: RoleId[];
  /** Policy on loop completion: 'stop' after sequence, or 'repeat_until_done' up to maxTurns */
  readonly loopMode: "once" | "repeat_until_done";
  /** Designated roles permitted to emit authoritative 'done' decision */
  readonly terminalRoles: RoleId[];
}
```

---

## 4. Built-in Role Model & Provider Independence

### 4.1 Strict Provider Decoupling
A fundamental architectural invariant of P4 is that **role definitions must never encode model names, vendor names, or transport protocols**.

- **Incorrect (Coupled):**
  ```yaml
  role: claude_architect
  model: claude-3-7-sonnet
  ```
- **Correct (Decoupled):**
  ```yaml
  role: architect
  # In configuration, map the role to a concrete adapter:
  participant:
    adapterType: acp:claude
  ```

### 4.2 Built-in Role Definitions
The bridge includes seven standard built-in roles in its core registry (`RoleRegistry`):

| Role ID | Title | Mandate & Purpose | Permitted Actions |
| :--- | :--- | :--- | :--- |
| `primary` | Primary Collaborator | General-purpose collaboration partner (preserves 100% backward compatibility with P1–P3 single-agent runs). | General dialogue, planning, execution |
| `architect` | System Architect | Decomposes high-level objectives, evaluates technical trade-offs, specifies file interfaces and architectural invariants. | Read-only analysis, specification generation, interface design |
| `researcher` | Codebase & Docs Researcher | Explores repository structure, investigates symbols, traces call graphs, and extracts relevant context. | Read-only search, file inspection, documentation review |
| `implementer` | Software Engineer | Implements code changes conforming to architectural specifications, edits files, and creates deterministic test cases. | Targeted code authoring, diff generation, file modifications |
| `critic` | Adversarial Critic | Stress-tests proposed plans and implementations, actively seeks edge cases, security vulnerabilities, and failure modes. | Read-only critique, vulnerability analysis, assumption challenging |
| `reviewer` | Quality & Maintainability Reviewer | Verifies implementation against requirements, inspects diffs for clarity, style, typing, and architectural compliance. | Read-only review, commentary, approval / rejection recommendations |
| `verifier` | Deterministic Verifier | Executes build verification, linter checks, test suites, and regression benchmarks; assesses deterministic PASS/FAIL evidence. | Test execution, diagnostic evaluation, sign-off validation |

---

## 5. Explicit Assignment Strategy

### 5.1 Configuration-First Initialization
In P4, role assignment is **explicit and deterministic**. Dynamic or emergent role assignment is explicitly out of scope for P4 to ensure strict predictability and auditability.

Participants are declared statically via configuration file or REST API payload:

```yaml
# config/collaboration.yaml (or embedded in POST /runs)
objective: "Implement resilient JWT refresh token rotation with SQLite revocation blacklist"

policy:
  roleSequence:
    - architect
    - implementer
    - reviewer
    - verifier
  loopMode: "repeat_until_done"
  terminalRoles:
    - reviewer
    - verifier

roles:
  architect:
    adapterType: "acp:claude"
    config:
      permissionMode: "allow_readonly"

  implementer:
    # Uses repository first-class Antigravity profile (agy-acp adapter bridging to agy CLI)
    adapterType: "acp:antigravity"
    config:
      permissionMode: "deny"

  reviewer:
    adapterType: "acp:claude"
    config:
      permissionMode: "allow_readonly"

  verifier:
    adapterType: "subprocess-jsonl"
    command: ["./tools/verify-runner.sh"]
```

### 5.2 Assignment Validation Rules
Before any subprocess or session is spawned, pure validation rules enforce:
1. **Role Existence:** Every role referenced in `policy.roleSequence` exists in the `RoleRegistry`.
2. **Assignment Completeness:** Every role in `policy.roleSequence` has an associated `ParticipantConfig`.
3. **Budget Compliance:** The total count of configured participants does not exceed `budget.maxParticipants`.
4. **Structural Validity:** The specified adapter configuration possesses required fields (and valid launch commands if custom). Runtime binary discovery, PATH probing, and executable pre-flight checks occur during participant instantiation, keeping pure validation decoupled from the host filesystem.
5. **Terminal Role Coverage:** At least one role in `policy.terminalRoles` is present in `policy.roleSequence`.

---

## 6. Communication Model: Authoritative Hub-and-Spoke

### 6.1 Topology Invariant
Communication in P4 is strictly **hub-and-spoke through the RunController**. Direct participant-to-participant communication (peer-to-peer mesh) is strictly forbidden.

```text
    ┌─────────────────────────────────────────────────────────────┐
    │                        RunController                        │
    │  - Manages SQLite transcript and audit log                  │
    │  - Enforces budgets, turn boundaries, and timeouts          │
    │  - Sanitizes and validates all message payloads             │
    │  - Evaluates terminal states and stopping criteria          │
    └───────▲──────────────▲──────────────▲──────────────▲────────┘
            │              │              │              │
    TurnIn  │ TurnOut  Turn│ TurnOut  Turn│ TurnOut  Turn│ TurnOut
            ▼              ▼              ▼              ▼
     ┌─────────────┐┌─────────────┐┌─────────────┐┌─────────────┐
     │  Architect  ││ Implementer ││  Reviewer   ││  Verifier   │
     └─────────────┘└─────────────┘└─────────────┘└─────────────┘
```

### 6.2 Why Hub-and-Spoke is Mandatory
1. **Total Auditability:** Every piece of information exchanged between agents passes through the controller, where it is logged with cryptographic hashes and timestamps to SQLite.
2. **Prompt Injection & Collusion Defense:** External agents cannot secretly exchange out-of-band signals, bypass permission policies, or convince each other to execute unauthorized actions.
3. **Deterministic Turn Scheduling:** The controller decides who speaks next, when their turn begins, and when their turn is forcefully terminated.
4. **Context Window Hygiene:** The controller curates the exact context sent to each participant. An `implementer` does not need 50 turns of conversational overhead if the controller provides a synthesized specification from the `architect`.

---

## 7. Canonical Transcript & History Invariants

### 7.1 Canonical Persistence
All collaboration messages are stored in SQLite (`bridge.db`) in the dedicated `collaboration_messages` table (strictly segregated from ChatGPT session messages in `messages`).

Every persisted message in a collaboration run satisfies the following invariants:
- **Immutable Provenance:** Every message records `sender_participant_id`, `sender_role_id`, `turn_id`, `created_at`, `sequence_index`, and `content_hash`.
- **Deterministic Ordering:** Canonical transcript ordering uses `sequence_index ASC`, guaranteeing consistency across concurrent reads and independent of timestamp precision.
- **SHA-256 Integrity:** Every message contains a cryptographic SHA-256 hash over `(runId, turnId, participantId, roleId, decisionType, normalizedContent)`. Tampering with stored content fails closed upon read (`collaboration_transcript_integrity_failed`).
- **No External Mutation:** External agents have **zero access** to modify, overwrite, delete, or re-order entries in the bridge transcript. The store is append-only.
- **Content Policy Verification:** Before any participant output is appended to the canonical transcript or relayed to subsequent participants, it is evaluated for maximum byte limits (`MAX_COLLABORATION_MESSAGE_BYTES`), Unicode NFC normalization, and CRLF line ending normalization.

### 7.2 Transcript Transformation for Participant Turns
When preparing the `AgentTurnInput` for a participant's turn:
1. The participant receives the overarching `objective`.
2. The participant receives their role's specific `systemInstructions`.
3. The participant receives the curated transcript of preceding turns:
   ```json
   [
     { "speaker": "architect", "role": "architect", "text": "Spec approved: Use SHA-256 for token hashing." },
     { "speaker": "implementer", "role": "implementer", "text": "Implemented hash token verification in src/auth/token.ts." }
   ]
   ```
4. Untrusted model responses are cleanly labeled with their specific producing role.

---

## 8. Capability & Permission Model (`Role != Capability`)

### 8.1 The Capability Invariant
> **CRITICAL SECURITY INVARIANT:** Role identity alone grants **NO** filesystem, terminal, network, or MCP capabilities.

Being assigned the role `architect` or `implementer` does not endow an agent with write permissions. Capabilities are strictly bounded properties of the underlying `ExternalAgentAdapterConfig` and host sandbox.

### 8.2 Fail-Closed Permission Matrix

| Capability Category | Default Policy | How to Grant | Enforcement Mechanism |
| :--- | :--- | :--- | :--- |
| **Filesystem Read** | Denied | `permissionMode: "allow_readonly"` | ACP protocol permission response filter |
| **Filesystem Write** | Denied | Explicit adapter approval resolver | Subprocess sandbox / ACP tool denial |
| **Terminal Execution** | Denied | Explicit adapter approval resolver | ACP tool rejection (`deny`) |
| **Network Egress** | Denied | Loopback only | Host firewall / proxy configuration |
| **Credential Access** | Prohibited | Never granted | Bridge never reads or imports agent tokens |

ACP tool requests originating from external agents are subject to the same strict handling established in P3:
- If an agent requests an unadvertised tool or unauthorized command, the bridge responds with an immediate, deterministic error frame.
- Unhandled permission requests fail closed (`deny`).

---

## 9. Cancellation Propagation & Teardown

### 9.1 Multi-Level Cancellation Hierarchy

```text
                  cancelRoleBasedRun(runId) (Run-Level)
                                  │
                                  ▼
                     Abort Root AbortController
                                  │
                                  ▼
                   Abort Active Turn AbortSignal
                                  │
                                  ▼
             Close Active & Initialized Participant Adapters
                                  │
                                  ▼
    Atomically Update SQLite Run & Active Participant Status to 'cancelled'
        (Pending participants remain 'pending' without modification)
```

### 9.2 Addressable Participant Cancellation
P4 supports granular participant-level cancellation:
- **API:** `cancelRoleParticipant(runId, participantId)`
- Validates run ownership (rejects attempts to cancel foreign participants from another run).
- If the participant is actively executing a turn, aborts the active turn controller and fails the run atomically in SQLite (`turn.status = 'cancelled'`, `participant.status = 'cancelled'`, `run.status = 'failed'`).
- If another participant is cancelled while a peer is executing, the interrupted peer is safely transitioned to `idle` (not cancelled or active) while the cancelled target is marked `cancelled` and the run marked `failed`.
- If the participant is idle or pending, marks the participant cancelled and fails the run (fail-closed requirement for sequential workflow dependencies).
- Strictly does not touch `SessionManager.cancel()` as role runs coordinate via hub-and-spoke without ChatGPT web turns.
- Marks participant status as `cancelled` and run status as `failed` (no retries).

### 9.3 Same-Participant Bounded Retries & Failure Propagation
- Retries are governed strictly by `budget.maxRetriesPerParticipant` (counting retries after the initial attempt).
- Retries strictly reuse the same participant (`participantId`, `roleId`, `adapterId`, and configuration) with ZERO provider fallback or rotation.
- Every retry attempt consumes 1 turn from `budget.maxTurns` and receives a unique monotonic `turnIndex` and `turnId` in SQLite (`UNIQUE(run_id, turn_index)` constraint).
- Explicit error decisions (`decision.type === 'error'`) emit canonical messages and retry with the same adapter instance.
- Thrown operational errors emit no message, close the crashed adapter, recreate a fresh adapter instance via `recreateAdapter()`, and retry.
- On success, `consecutiveFailures` resets to 0.
- If `maxTurns` or `maxWallClockMs` is reached during retries, global budget limits take precedence and transition the run to `budget_exhausted` or `timed_out`.

---

## 10. Fault Handling & Failure Policy

Every possible failure mode is explicitly classified with deterministic remediation steps:

| Failure Mode | Trigger Condition | RunController Response | Status Outcome |
| :--- | :--- | :--- | :--- |
| **Participant Process Crash** | Non-zero exit, SIGSEGV, SIGBUS, or thrown error | Close crashed adapter; recreate same participant adapter instance via factory without provider rotation; retry if retries remain; else escalate to run failure. | `participant.failed` → `run.failed` |
| **Turn Timeout** | Turn duration exceeds per-turn deadline | Abort turn `AbortController`; record timeout in audit log; evaluate retry. | `participant.turn.failed` (timed out) |
| **Wall-Clock Exhaustion** | Run duration exceeds `budget.maxWallClockMs` | Abort active participant turn; do not touch bridge session; finalize run. | `run.timed_out` (terminal) |
| **Turn Limit Exhaustion** | Run turns reach `budget.maxTurns` | Cease scheduling; finalize run with summary of incomplete progress. | `run.budget_exhausted` (terminal) |
| **Malformed Decision Frame** | JSON parsing failure, missing fields | Count as failure; retry up to `maxRetriesPerParticipant`; fail closed. | `participant.turn.failed` |
| **Explicit Rejection** | Agent emits decision `{ type: "error", retryable: false }` | No retry; advance or terminate based on role importance. | `run.failed` or handoff |
| **Permission Denial** | Agent attempts disallowed tool execution | Bridge returns error response to agent; agent may continue or fail. | Turn continues or errors |
| **Provider / Network Error** | Upstream API 502/503/429 | Exponential backoff for retryable errors; fail-fast for fatal auth errors. | Retry or `run.failed` |

---

## 11. Execution Budgets & Terminal States

### 11.1 Budget Parameters

```typescript
export interface CollaborationRunBudget {
  /** Maximum total turns across all participants (Default: 30, Hard Max: 100) */
  maxTurns: number;
  /** Maximum participants in a single run (Default: 5, Hard Max: 10) */
  maxParticipants: number;
  /** Strictly 1 in P4 (sequential turn guarantee) */
  maxParallelTurns: 1;
  /** Maximum consecutive retries per participant (Default: 2, Hard Max: 5) */
  maxRetriesPerParticipant: number;
  /** Maximum total run wall-clock duration (Default: 3,600,000 ms [1 hr], Hard Max: 14,400,000 ms [4 hr]) */
  maxWallClockMs: number;
}
```

### 11.2 Terminal State Taxonomy
A `CollaborationRun` terminates exclusively in one of these five explicit terminal states:

1. **`completed`**:
   - The user objective has been fully achieved.
   - A participant possessing a recognized `terminalRole` (e.g., `reviewer` or `verifier`) emitted an authoritative `{ type: "done", summary: "..." }` decision.
   - The final summary and artifacts are persisted to SQLite.
2. **`failed`**:
   - An unrecoverable operational fault occurred (e.g. fatal provider error, invalid configuration).
   - A participant exhausted its `maxRetriesPerParticipant`.
3. **`cancelled`**:
   - The user or external caller invoked `POST /runs/{id}/cancel`.
   - All participant processes were cleanly terminated and resources released.
4. **`budget_exhausted`**:
   - `maxTurns` or token budget was reached prior to receiving a valid `done` decision.
   - Prevents runaway billing or infinite loops.
5. **`timed_out`**:
   - `maxWallClockMs` elapsed while turns were still executing.

---

## 12. Audit Events Taxonomy & Observability (P4.7)

Every lifecycle transition emits a structured, strongly-typed audit record stored in the SQLite `audit_events` table with `schemaVersion: 1`.

### 12.1 Strict Data Minimization & Privacy Invariants
Audit records are derivative operational logs designed for tracing, metrics, and incident diagnosis.
To prevent credential and intellectual property leakage:
1. **Zero Raw Content:** Audit payloads NEVER store model prompts, system instructions, user objectives, agent outputs, message content, error messages, done summaries, or cancellation reasons.
2. **Safe Metadata Only:** Indicators are recorded as booleans (`reasonPresent`, `summaryPresent`), structural metrics (`objectiveLength`, `totalTurns`, `durationMs`), or standardized error codes (`errorCode`, `failureCategory`, `causeCode`).
3. **Payload Bounds:** Payloads must be strictly JSON-serializable and bounded by a 16 KiB ceiling.
4. **Idempotent Ordering Authority:** The SQLite auto-incrementing integer `id ASC` serves as the deterministic causal ordering authority. All timeline queries use `ORDER BY id ASC`.
5. **Fail-Closed Persistence Commit:** Canonical database updates must COMMIT before derivative audit events are emitted. If audit emission fails, canonical history is preserved.

### 12.2 Collaboration Audit Taxonomy

The core P4 collaboration audit taxonomy defines the standard event types for bounded sequential workflows. Note: The optional `collaboration.pause.requested` event is omitted because pause transitions in P4 are initiated solely by participant decisions rather than a controller-side API.

| Audit Event Name | Emitted When | Critical Payload Attributes (`schemaVersion: 1`) |
| :--- | :--- | :--- |
| `collaboration.started` | Run validated and started | `roleSequence`, `terminalRoles`, `loopMode`, `maxTurns`, `maxWallClockMs`, `participantCount`, `objectiveLength` |
| `participant.assigned` | Role bound to participant | `participantId`, `roleId`, `adapterId`, `sequenceIndex` |
| `participant.turn.started` | Participant invoked for turn | `participantId`, `roleId`, `round`, `turnIndex`, `attemptOrdinal` |
| `participant.turn.completed` | Participant produced valid decision | `participantId`, `roleId`, `round`, `turnIndex`, `decisionType`, `durationMs` |
| `participant.turn.failed` | Turn failed (decision or operational) | `participantId`, `roleId`, `round`, `turnIndex`, `errorCode`, `retryable`, `durationMs` |
| `participant.turn.cancelled` | Turn aborted due to cancellation | `participantId`, `roleId`, `round`, `turnIndex`, `cancellationScope` (`run` \| `participant` \| `workflow`) |
| `participant.retry.scheduled` | Retry scheduled for failed participant | `participantId`, `roleId`, `retryOrdinal`, `maxRetries`, `nextTurnIndex`, `recreateRuntime` |
| `participant.runtime.recreated` | Adapter runtime closed and recreated | `participantId`, `roleId`, `adapterId`, `causeCode` |
| `collaboration.paused` | Run paused by participant decision | `round`, `turnIndex`, `participantId`, `roleId`, `reasonPresent` |
| `collaboration.cancel.requested` | Entire collaboration cancel initiated | `activeParticipantId`, `reasonPresent` |
| `participant.cancel.requested` | Single participant cancel initiated | `participantId`, `roleId`, `wasActive`, `reasonPresent` |
| `collaboration.recovered` | Daemon startup recovery completed | `recoveryKind` (`safe_boundary` \| `interrupted_turn`), `outcomeStatus`, `participantId`, `turnIndex`, `syntheticTurn` |
| `collaboration.replay.acknowledged` | Interrupted turn replay acknowledged | `participantId`, `roleId`, `interruptedTurnIndex` |
| `collaboration.resumed` | Paused run resumed | `round`, `sequenceIndex`, `nextTurnIndex`, `participantId`, `roleId`, `replayAcknowledged` |
| `collaboration.completed` | Workflow finished successfully | `round`, `totalTurns` |
| `collaboration.failed` | Run failed fatally or retry exhausted | `round`, `totalTurns`, `errorCode`, `failureCategory`, `participantId`, `roleId` |
| `collaboration.cancelled` | Run cancelled by operator or signal | `round`, `totalTurns` |
| `collaboration.timed_out` | Wall-clock deadline exceeded | `totalTurns`, `maxWallClockMs` |
| `collaboration.budget_exhausted` | Turn budget exceeded | `totalTurns`, `maxTurns` |

---

## 13. Persistence & Resumption

### 13.1 SQLite Schema Evolution (Migration v2)
To persist multi-participant runs, granular turn history, and canonical messages without modifying legacy P1–P3 single-agent `runs` and `messages`, database migration version 2 introduces four dedicated tables:

```sql
-- Migration 2: Multi-Participant Role-Based Collaboration Schema

CREATE TABLE role_based_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  budget_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  active_participant_id TEXT,
  final_summary TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE TABLE collaboration_participants (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  role_snapshot_json TEXT NOT NULL,
  config_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL,
  turns_executed INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  sequence_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_active_at TEXT,
  FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
  UNIQUE(run_id, sequence_index)
);

CREATE TABLE collaboration_turns (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  turn_index INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  decision_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(participant_id) REFERENCES collaboration_participants(id),
  UNIQUE(run_id, turn_index)
);

CREATE TABLE collaboration_messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  sequence_index INTEGER NOT NULL,
  sender_participant_id TEXT NOT NULL,
  sender_role_id TEXT NOT NULL,
  decision_type TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id) REFERENCES role_based_runs(id) ON DELETE CASCADE,
  FOREIGN KEY(turn_id) REFERENCES collaboration_turns(id) ON DELETE CASCADE,
  FOREIGN KEY(sender_participant_id) REFERENCES collaboration_participants(id),
  UNIQUE(run_id, sequence_index)
);

CREATE INDEX idx_role_based_runs_session ON role_based_runs(session_id);
CREATE INDEX idx_role_based_runs_status ON role_based_runs(status);
CREATE INDEX idx_collaboration_participants_run ON collaboration_participants(run_id);
CREATE INDEX idx_collaboration_participants_role ON collaboration_participants(run_id, role_id);
CREATE INDEX idx_collaboration_turns_run ON collaboration_turns(run_id, turn_index);
CREATE INDEX idx_collaboration_turns_participant ON collaboration_turns(participant_id, turn_index);
CREATE INDEX idx_collaboration_messages_run ON collaboration_messages(run_id, sequence_index);
CREATE INDEX idx_collaboration_messages_turn ON collaboration_messages(turn_id);
```

### 13.2 Role and Configuration Snapshots
- **Per-Participant Role Snapshots:** System instructions and role definitions are persisted per-participant in `role_snapshot_json`, ensuring historical runs are immune to daemon-level role definition changes.
- **Sanitized Config Snapshots:** `config_snapshot_json` defensively strips any credentials, tokens, or passwords, retaining only execution parameters (`adapterType`, `command`, `cwd`, profile, permissionMode).

### 13.3 Safe Resumption Protocol
If the bridge daemon restarts or crashes while a role-based run is in status `running`:

1. **Startup Discovery & Reconciliation:**
   - Upon daemon boot, before accepting new traffic, `RunController.recoverRoleBasedRuns()` queries SQLite for all runs where `status = 'running'`.
   - Recovery is strictly non-spawning: zero external adapter processes, zero network calls, zero token consumption.
   - Recovery is fail-closed: if any orphaned run fails reconciliation, daemon startup aborts and cleans up SQLite and runtime state.
   - There is **no automatic resume** on daemon startup.

2. **Interruption Case A: Safe Turn Boundary (`activeParticipantId == null`):**
   - If the crash occurred between turns, the run is evaluated against remaining budgets:
     - If wall-clock elapsed (`now - run.startedAt`) exceeds `budget.maxWallClockMs`, the run transitions to `timed_out`.
     - If canonical turn count already reached `budget.maxTurns`, the run transitions to `budget_exhausted`.
     - Otherwise, the run transitions to `paused` with `activeParticipantId = null`. No synthetic turn is recorded.

3. **Interruption Case B: Active Turn Crash (`activeParticipantId != null`):**
   - Because child processes and ephemeral network sessions do not survive daemon crashes, the active turn was abruptly interrupted.
   - A synthetic turn is recorded with `status = 'failed'`, error code `daemon_restarted`, and retryable flag `true`.
   - The synthetic `daemon_restarted` turn consumes a turn slot (`turnsBeforeSynthetic + 1`), counts against `maxTurns`, and increments the participant's `consecutiveFailures`.
   - Synthetic turns never emit canonical messages (`collaboration_messages` row count remains 0 for synthetic failures).
   - If budgets are exhausted (wall-clock expired, `maxTurns` reached, or retry limit exceeded), the run transitions to `timed_out`, `budget_exhausted`, or `failed`.
   - Otherwise, the run transitions to `paused` with `activeParticipantId = null`.

4. **Explicit Resumption (`RunController.resumeRoleBasedRun(runId, options)`):**
   - P4 provides an internal controller API only (there is no REST resume route in P4).
   - **Replay Protection:** A participant may have executed filesystem writes or external side-effects before the daemon crashed. If the latest attempt for the current resumable role was interrupted (`error.code === 'daemon_restarted'`), resumption fails closed unless the caller explicitly passes `allowReplayInterruptedTurn: true`.
   - **Wall-Clock Budget Integrity:** The wall-clock origin remains the original persisted `startedAt`. Daemon downtime and pause duration count against `budget.maxWallClockMs`.
   - **Historical Snapshot Authority:** Resumption reconstructs participant adapters exclusively from persisted `role_snapshot_json` and `config_snapshot_json`. It never consults the current `RoleRegistry` or ambient environment. Profiles and providers (e.g. `acp:antigravity` -> `agy-acp`) are preserved exactly without fallback.
   - **Deterministic Cursor & Hash Verification:** The controller re-reads canonical history from SQLite, verifies SHA-256 message content hashes, validates round/turn provenance, and derives the next sequence index before dispatching turns.
   - **Terminal Budget Enforcement:** If wall-clock or turn limits are already exhausted at resume time, the run is durably persisted as `timed_out` or `budget_exhausted` without instantiating adapters.


---

## 14. Core Security Invariants

All implementations of P4 must verify and uphold these seven non-negotiable security invariants:

1. **Untrusted Model Output:** All text, diffs, code snippets, and structured outputs received from agents or relay sessions are strictly treated as untrusted data. They must pass schema and content validation before ingestion.
2. **`Role != Capability`:** Assigning a role grants zero ambient authority. Filesystem, terminal, and process execution capabilities are independently granted per adapter config and default to `deny`.
3. **No Implicit Provider Fallback:** The bridge must never silently re-route a participant assigned to `Claude` over to `ChatGPT` or `Antigravity` upon failure. Any provider substitution must be explicit in configuration.
4. **No Credential Import / Leaking:** The bridge never reads, persists, or proxies external agent credentials or OAuth tokens. Child processes inherit only an explicit allowlist of environment variables.
5. **Fail-Closed Permission Handling:** Any ambiguous or unhandled permission query received over ACP or MCP fails closed with an immediate rejection.
6. **Bounded Autonomy:** Every run enforces strict, non-bypassable caps on turns, wall-clock time, retries, and concurrent operations. Infinite agent loops are mathematically prevented.
7. **Explicit Identity & Provenance:** Every persisted action, message, and artifact in history is attributed to an exact, authenticated `participantId` and `roleId`.

---

## 15. The P4 Minimum Viable Product (MVP)

### 15.1 Scope of the P4 MVP
The P4 MVP focuses on delivering a rock-solid, deterministic sequential collaboration workflow between 2 to 3 participants.

**MVP Characteristics:**
- **Single RunController:** Central authoritative coordinator.
- **2–3 Explicit Participants:** (e.g. Architect, Implementer, Reviewer).
- **Strictly Sequential:** `maxParallelTurns = 1`. No concurrent branches.
- **Hub-and-Spoke Routing:** Controller mediates every turn.
- **Standard Termination:** Run completes when the Reviewer emits `{ type: "done" }` or when budget runs out.

### 15.2 MVP Workflow Walkthrough

```text
                                [Start Run]
                       User Objective: Add CSRF Protection
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │ Round 0: Architect (Claude)   │
                     │ Inputs: Objective             │
                     │ Outputs: CSRF Token Plan      │
                     └───────────────┬───────────────┘
                                     │ (Controller verifies & logs)
                                     ▼
                     ┌───────────────────────────────┐
                     │ Round 1: Implementer (AGY)    │
                     │ Inputs: Plan + Code Context   │
                     │ Outputs: Patch + Unit Tests   │
                     └───────────────┬───────────────┘
                                     │ (Controller verifies & logs)
                                     ▼
                     ┌───────────────────────────────┐
                     │ Round 2: Reviewer (Claude)    │
                     │ Inputs: Spec + Patch + Diff   │
                     │ Outputs: { type: "done" }     │
                     └───────────────┬───────────────┘
                                     │
                                     ▼
                            [Run Completed]
```

---

## 16. Strict Boundary: P4 vs. P5

To prevent feature creep and maintain deterministic reliability, the boundary between P4 and P5 is strictly defined:

| Capability / Architecture | In Scope for P4 | Deferred to P5 |
| :--- | :---: | :---: |
| **Role-based specialization** | **YES** | YES |
| **Sequential collaboration workflow** | **YES** | YES |
| **Explicit static role assignment** | **YES** | YES |
| **Hub-and-spoke message routing** | **YES** | YES |
| **Canonical SQLite transcript with roles** | **YES** | YES |
| **Per-participant cancellation & timeouts** | **YES** | YES |
| **Bounded Multi-Participant DAG Scheduling** | ❌ NO | **YES** |
| **Parallel / Concurrent Agent Turns** (`maxParallelTurns > 1`) | ❌ NO | **YES** |
| **Dynamic Fan-out / Fan-in (Map-Reduce)** | ❌ NO | **YES** |
| **Dependency-driven Turn Triggering** | ❌ NO | **YES** |
| **Autonomous Dynamic Role Spawning** | ❌ NO | **YES** |

---

## 17. Future Codex External-Agent Adapter (#7) Accommodation

### 17.1 Universal Adapter Abstraction
Tracking Issue #7 outlines the future implementation of `CodexAgentAdapter`. The P4 architecture guarantees that `CodexAgentAdapter` will slot into the participant framework seamlessly without requiring any modifications to the role layer or orchestration engine.

Because all participants implement the generic `ExternalAgentAdapter` interface:
```typescript
export interface ExternalAgentAdapter {
  readonly id: string;
  initialize?(context: { runId: string; objective: string; cwd?: string }): Promise<void>;
  next(input: AgentTurnInput, ctx: { signal?: AbortSignal }): Promise<AgentDecision>;
  close?(): Promise<void>;
}
```

Any external engine—whether:
- Claude ACP (`acp:claude`)
- Antigravity ACP (`acp:antigravity` using `agy-acp`)
- Future Codex Adapter (`codex` or `acp:codex`)
- Custom Subprocess JSONL (`subprocess-jsonl`)

can be assigned to **any** role (`architect`, `implementer`, `reviewer`, `verifier`). The role layer remains 100% agnostic to whether an adapter uses ACP, stdio JSONL, or a native SDK.

---

## 18. Comparison with Existing Repository Abstractions

A comparison of proposed P4 abstractions against existing implementations in `src/core/domain.ts` and `src/core/run-controller.ts`:

| Existing (P3) Abstraction | P4 Evolution | Backward Compatibility Strategy |
| :--- | :--- | :--- |
| `CollaborationRun.agentAdapterId: string` | Extended to `participants: Record<string, Participant>` | If a legacy request specifies `agentAdapterId`, the controller automatically creates a default participant assigned to the `primary` role. |
| `CollaborationRun.round: number` | Retained as outer round counter; supplemented with `turnHistory: string[]` | Existing REST `/runs/{id}` consumers continue reading `round` without breaking. |
| `AgentTurnInput.transcript` | Enriched with `speakerRole?: RoleId` and `participantId?: string` | Adapters that only inspect `speaker: "agent" \| "chatgpt"` continue functioning unmodified. |
| `AgentDecision` (`message`, `done`, `pause`, `error`) | Retained unmodified | All existing external agents emit compatible decisions. |
| `RunStore` SQLite persistence | Extended via Migration v2 with `participants` and `collaboration_turns` tables | Existing `runs` table columns preserved; migrations run idempotently. |

---

## 19. Incremental Implementation Plan (Slices P4.0 to P4.8)

Each slice represents an independently testable, atomic unit of work:

- **Slice P4.0: Core Types, Domain Interfaces & Invariants**
  - Define `RoleId`, `RoleDefinition`, `ParticipantRecord`, `RoleBasedRunBudget`, and `CollaborationTurnRecord` in `src/core/collaboration-domain.ts`.
  - Add type assertions and validation helpers.
  - Implement deterministic unit tests verifying budget invariants and constraint validators.

- **Slice P4.1: Role Registry & Built-in Role Definitions**
  - Implement `RoleRegistry` class in `src/core/role-registry.ts`.
  - Register built-in role definitions (`primary`, `architect`, `researcher`, `implementer`, `critic`, `reviewer`, `verifier`).
  - Unit tests verifying registration, retrieval, immutability, and duplicate detection.

- **Slice P4.2: Explicit Participant Assignment & Configuration Parser**
  - Implement parser and validator for `RoleAssignment` configuration.
  - Add factory methods to instantiate and bind `ExternalAgentAdapter` instances into memory-only `ParticipantRuntime` bindings (keeping persisted `ParticipantRecord` structs strictly runtime-free).
  - Unit tests for valid configurations, missing adapters, and invalid command specs.

- **Slice P4.3: Sequential Orchestration Engine in RunController**
  - Update `RunController` to execute sequential multi-participant turns based on `RunPolicy.roleSequence`.
  - Implement turn handoff logic and `AgentTurnInput` contextual assembly.
  - Unit tests using mock adapters validating sequential execution order (Architect → Implementer → Reviewer).

- **Slice P4.4: Canonical Transcript & SQLite Migration v2**
  - Implement migration v2 in `src/persistence/database.ts` adding `participants` and `collaboration_turns`.
  - Implement `TurnStore` and update `RunStore` to record multi-participant states.
  - Tests verifying schema migration, relational integrity, and transcript queries.

- **Slice P4.5: Fault Handling, Error Escalation & Cancellation Propagation**
  - Implement per-participant retry counters and error classification in `RunController`.
  - Implement participant-level and run-level cancellation propagation with clean process tree teardown.
  - Unit tests covering simulated process crash, SIGTERM timeout, and unparseable decision payloads.

- **Slice P4.6: Persistence, State Recovery & Run Resumption**
  - Implement `RunController.recoverRuns()` and `resumeRun()`.
  - Tests verifying state recovery after simulated abrupt process termination.

- **Slice P4.7: Audit Events & Observability**
  - Integrate P4 audit event taxonomy into `AuditStore`.
  - Verify deterministic event ordering in SQLite `audit_events`.

- **Slice P4.8: Live Multi-Agent Integration Smoke Test**
  - Execute live end-to-end smoke test with real Claude ACP and Antigravity ACP adapters collaborating on a synthetic coding objective.
  - Validated release topology: Claude architect (`acp:claude`) → Antigravity implementer (`acp:antigravity`) → Claude reviewer (`acp:claude`).
  - Document evidence and metrics in `docs/P4_COLLABORATION_SMOKE.md`.

---

## 20. Comprehensive Test & Verification Plan

The P4 implementation suite will enforce the following deterministic test cases:

### 20.1 Role Registry & Assignment Tests
- `test_role_registry_builtins`: Verify all 7 built-in roles are registered with valid descriptions and instructions.
- `test_role_registry_duplicate_rejection`: Attempting to register an existing role ID throws `duplicate_role`.
- `test_role_registry_unknown_lookup`: Looking up an unregistered role ID returns `null` or throws `role_not_found`.
- `test_assignment_missing_role`: Reject run configuration referencing a role not in the registry.
- `test_assignment_adapter_unavailable`: Reject run configuration specifying an unresolvable adapter binary.

### 20.2 Orchestration & Turn Sequencing Tests
- `test_sequential_workflow_execution`: Mock 3 participants (`architect`, `implementer`, `reviewer`); verify turns execute in exact sequence 1 → 2 → 3.
- `test_max_turns_exhaustion`: Run halts with status `budget_exhausted` when total turns reach `maxTurns`.
- `test_max_participants_cap`: Reject run attempting to register participants beyond `budget.maxParticipants`.
- `test_single_parallel_turn_enforcement`: Invariant test proving no two participant turns execute concurrently in P4.

### 20.3 Cancellation & Timeout Tests
- `test_run_cancellation_propagates_to_active_participant`: Aborting run aborts current turn `AbortSignal` and terminates process.
- `test_individual_participant_cancellation`: Cancelling one participant does not corrupt run state.
- `test_turn_wall_clock_timeout`: Participant exceeding per-turn deadline is forcefully terminated and logged as timed out.
- `test_run_wall_clock_deadline`: Run exceeding `budget.maxWallClockMs` transitions to `timed_out` immediately.

### 20.4 Fault Tolerance & Recovery Tests
- `test_participant_process_crash_retry`: Participant crashing with exit code 1 is retried up to `maxRetriesPerParticipant`.
- `test_participant_retry_exhaustion`: Run transitions to `failed` when a participant exceeds max retries.
- `test_malformed_json_handling`: Agent emitting unparseable JSON on stdout triggers retryable error handling.
- `test_permission_denial_fail_closed`: Unauthorized tool call request receives deterministic rejection frame.

### 20.5 Transcript & Audit Integrity Tests
- `test_canonical_transcript_provenance`: Every message in history contains valid `participantId` and `roleId`.
- `test_no_external_transcript_mutation`: Verify external agents cannot alter prior transcript entries.
- `test_audit_event_ordering`: Audit events for a 3-stage run appear in exact causal order (`collaboration.started` → `participant.assigned` → `participant.turn.started` → ... → `collaboration.completed`).
- `test_session_isolation`: Turns executed by participant A cannot leak private context to participant B without passing through `RunController`.

---

## 21. Implementation Status Checklist

### P4.0 — Types + Invariants
- [x] Domain records (`ParticipantRecord`, `RoleBasedCollaborationRun`, `CollaborationTurnRecord`, etc.)
- [x] Pure validators (`src/core/collaboration-validation.ts`)
- [x] Deterministic test suite (`src/core/collaboration-validation.test.ts`)
- [x] Backward compatibility with single-agent `CollaborationRun` preserved

### P4.1 — Role Registry
- [x] `RoleRegistry` class
- [x] Built-in role definitions registered
- [x] Unit tests for role lookup and immutability

### P4.2 — Explicit Participant Assignment
- [x] Configuration normalization
- [x] Participant planning/records
- [x] Adapter factory
- [x] Non-spawning preflight
- [x] Deterministic tests

### P4.3 — Sequential Role Workflow
- [x] sequential multi-participant execution
- [x] hub-and-spoke role handoff
- [x] role-aware AgentTurnInput
- [x] terminal-role authority
- [x] bounded turns / wall-clock behavior
- [x] deterministic adapter cleanup
- [x] deterministic orchestration tests

### P4.4 — Canonical Transcript Integration
- [x] SQLite migration v2 (`role_based_runs`, `collaboration_participants`, `collaboration_turns`, `collaboration_messages`)
- [x] Canonical provenance logging with role IDs and SHA-256 integrity verification
- [x] Transcript query and projection tests
- [x] Fail-closed persistence and crash durability tests

### P4.5 — Cancellation & Failure Propagation
- [x] Participant-level cancellation propagation
- [x] Run-level cancellation teardown
- [x] Error escalation and retry budgets

### P4.6 — Persistence / Resume
- [x] Run recovery on daemon startup
- [x] Idempotent run resumption
- [x] Interrupted turn reconciliation

### P4.7 — Audit / Observability
- [x] Structured multi-participant audit event logging
- [x] Audit event sequence tests

### P4.8 — Claude + Antigravity Live Collaboration
- [x] Live ACP multi-agent smoke test (Claude architect → Antigravity implementer → Claude reviewer)
- [x] Evidence capture in `docs/P4_COLLABORATION_SMOKE.md`
