import { getDatabase } from "./database";

export interface AuditEventData {
  id?: number;
  eventType: string;
  sessionId?: string;
  turnId?: string;
  runId?: string;
  payload?: any;
  createdAt: string;
}

export class AuditStore {
  log(event: AuditEventData) {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO audit_events (event_type, session_id, turn_id, run_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      event.eventType,
      event.sessionId || null,
      event.turnId || null,
      event.runId || null,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt || new Date().toISOString()
    );
  }
}
