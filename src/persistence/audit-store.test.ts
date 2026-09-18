import { expect, test, afterEach } from "bun:test";
import { initDatabase, closeDatabase, getDatabase } from "./database";
import { AuditStore } from "./audit-store";
import { BridgeError } from "../core/errors";

afterEach(() => {
  closeDatabase();
});

test("AuditStore log and listByRun retrieves causal timeline ordered by id ASC", () => {
  initDatabase(":memory:");
  const store = new AuditStore();

  store.log({
    eventType: "collaboration.started",
    runId: "run_test_1",
    sessionId: "ses_1",
    payload: { schemaVersion: 1, participantCount: 2 },
    createdAt: "2026-09-18T00:00:00.000Z",
  });

  store.log({
    eventType: "participant.assigned",
    runId: "run_test_1",
    sessionId: "ses_1",
    payload: { schemaVersion: 1, participantId: "p1", roleId: "architect" },
    createdAt: "2026-09-18T00:00:01.000Z",
  });

  store.log({
    eventType: "participant.assigned",
    runId: "run_test_1",
    sessionId: "ses_1",
    payload: { schemaVersion: 1, participantId: "p2", roleId: "implementer" },
    createdAt: "2026-09-18T00:00:02.000Z",
  });

  // Event for a different run
  store.log({
    eventType: "collaboration.started",
    runId: "run_test_2",
    sessionId: "ses_2",
    payload: { schemaVersion: 1, participantCount: 1 },
    createdAt: "2026-09-18T00:00:03.000Z",
  });

  const run1Events = store.listByRun("run_test_1");
  expect(run1Events).toHaveLength(3);
  expect(run1Events[0]!.eventType).toBe("collaboration.started");
  expect(run1Events[1]!.eventType).toBe("participant.assigned");
  expect((run1Events[1]!.payload as any).participantId).toBe("p1");
  expect(run1Events[2]!.eventType).toBe("participant.assigned");
  expect((run1Events[2]!.payload as any).participantId).toBe("p2");

  // Verify IDs are monotonic increasing
  expect(run1Events[0]!.id).toBeLessThan(run1Events[1]!.id!);
  expect(run1Events[1]!.id).toBeLessThan(run1Events[2]!.id!);
});

test("AuditStore same-timestamp deterministic ordering authority by id ASC (Section 53)", () => {
  initDatabase(":memory:");
  const store = new AuditStore();
  const identicalTimestamp = "2026-09-18T12:00:00.000Z";

  // Insert multiple events with the EXACT same timestamp
  for (let i = 0; i < 5; i++) {
    store.log({
      eventType: `event.step.${i}`,
      runId: "run_same_ts",
      payload: { step: i },
      createdAt: identicalTimestamp,
    });
  }

  const events = store.listByRun("run_same_ts");
  expect(events).toHaveLength(5);
  for (let i = 0; i < 5; i++) {
    expect(events[i]!.eventType).toBe(`event.step.${i}`);
    expect((events[i]!.payload as any).step).toBe(i);
    expect(events[i]!.createdAt).toBe(identicalTimestamp);
    if (i > 0) {
      expect(events[i]!.id!).toBeGreaterThan(events[i - 1]!.id!);
    }
  }
});

test("AuditStore list filters by eventTypes and limit", () => {
  initDatabase(":memory:");
  const store = new AuditStore();

  store.log({ eventType: "type.A", runId: "run_filter", createdAt: "2026-09-18T00:00:00Z" });
  store.log({ eventType: "type.B", runId: "run_filter", createdAt: "2026-09-18T00:00:01Z" });
  store.log({ eventType: "type.A", runId: "run_filter", createdAt: "2026-09-18T00:00:02Z" });
  store.log({ eventType: "type.C", runId: "run_filter", createdAt: "2026-09-18T00:00:03Z" });

  const onlyA = store.list({ runId: "run_filter", eventTypes: ["type.A"] });
  expect(onlyA).toHaveLength(2);
  expect(onlyA.every(e => e.eventType === "type.A")).toBe(true);

  const limited = store.list({ runId: "run_filter", limit: 2 });
  expect(limited).toHaveLength(2);
  expect(limited[0]!.eventType).toBe("type.A");
  expect(limited[1]!.eventType).toBe("type.B");
});

test("AuditStore throws audit_record_corrupt when payload_json is invalid (Section 18)", () => {
  initDatabase(":memory:");
  const store = new AuditStore();
  const db = getDatabase();

  // Directly insert corrupt JSON
  db.prepare(`
    INSERT INTO audit_events (event_type, session_id, turn_id, run_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("corrupt.event", null, null, "run_bad", "{not-valid-json", "2026-09-18T00:00:00Z");

  expect(() => store.listByRun("run_bad")).toThrow(BridgeError);
  try {
    store.listByRun("run_bad");
  } catch (err) {
    expect((err as BridgeError).code).toBe("audit_record_corrupt");
  }
});

test("AuditStore handles legacy events and null payloads gracefully (Section 66)", () => {
  initDatabase(":memory:");
  const store = new AuditStore();

  store.log({
    eventType: "run.start",
    sessionId: "ses_legacy",
    runId: "run_legacy",
    payload: { objective: "legacy test", agentAdapterId: "chatgpt-web" },
    createdAt: "2026-09-18T00:00:00Z",
  });

  store.log({
    eventType: "run.completed",
    sessionId: "ses_legacy",
    runId: "run_legacy",
    payload: null,
    createdAt: "2026-09-18T00:00:01Z",
  });

  const list = store.listByRun("run_legacy");
  expect(list).toHaveLength(2);
  expect(list[0]!.eventType).toBe("run.start");
  expect((list[0]!.payload as any).objective).toBe("legacy test");
  expect(list[1]!.eventType).toBe("run.completed");
  expect(list[1]!.payload).toBeUndefined();
});
