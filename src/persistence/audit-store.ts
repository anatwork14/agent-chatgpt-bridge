import { getDatabase } from "./database";
import { BridgeError } from "../core/errors";

export interface AuditEventData {
  id?: number;
  eventType: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  payload?: unknown;
  createdAt: string;
}

export interface AuditListOptions {
  runId?: string;
  sessionId?: string;
  eventTypes?: readonly string[];
  limit?: number;
}

export class AuditStore {
  log(event: AuditEventData): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO audit_events (event_type, session_id, turn_id, run_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventType,
      event.sessionId || null,
      event.turnId || null,
      event.runId || null,
      event.payload !== undefined && event.payload !== null ? JSON.stringify(event.payload) : null,
      event.createdAt || new Date().toISOString()
    );
  }

  list(options?: AuditListOptions): AuditEventData[] {
    const db = getDatabase();
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options?.runId) {
      conditions.push("run_id = ?");
      params.push(options.runId);
    }
    if (options?.sessionId) {
      conditions.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options?.eventTypes && options.eventTypes.length > 0) {
      const placeholders = options.eventTypes.map(() => "?").join(", ");
      conditions.push(`event_type IN (${placeholders})`);
      params.push(...options.eventTypes);
    }

    let query = "SELECT id, event_type, session_id, turn_id, run_id, payload_json, created_at FROM audit_events";
    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    query += " ORDER BY id ASC";

    if (options?.limit !== undefined && options.limit > 0) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = db.prepare(query).all(...params) as Array<{
      id: number;
      event_type: string;
      session_id: string | null;
      turn_id: string | null;
      run_id: string | null;
      payload_json: string | null;
      created_at: string;
    }>;

    return rows.map((row) => {
      let payload: unknown = undefined;
      if (row.payload_json !== null) {
        try {
          payload = JSON.parse(row.payload_json);
        } catch (err) {
          throw new BridgeError(
            "audit_record_corrupt",
            `Failed to parse audit payload for event id ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
            false,
          );
        }
      }
      return {
        id: row.id,
        eventType: row.event_type,
        sessionId: row.session_id ?? undefined,
        turnId: row.turn_id ?? undefined,
        runId: row.run_id ?? undefined,
        payload,
        createdAt: row.created_at,
      };
    });
  }

  listByRun(runId: string): AuditEventData[] {
    return this.list({ runId });
  }
}

