import { getDatabase } from "./database";
import type { SessionStatus } from "../core/domain";

export interface SessionData {
  id: string;
  name?: string;
  provider: string;
  model: string;
  effort?: string;
  status: SessionStatus;
  conversationEpoch: number;
  continuityMode?: string;
  createdAt: string;
  updatedAt: string;
  lastTurnAt?: string;
  metadata?: Record<string, unknown>;
}

function mapSessionRow(row: any): SessionData {
  return {
    id: row.id,
    name: row.name ?? undefined,
    provider: row.provider,
    model: row.model,
    effort: row.effort ?? undefined,
    status: row.status,
    conversationEpoch: row.conversation_epoch,
    continuityMode: row.continuity_mode ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTurnAt: row.last_turn_at ?? undefined,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  };
}

export class SessionStore {
  create(session: SessionData): void {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO sessions (id, name, provider, model, effort, status, conversation_epoch, continuity_mode, created_at, updated_at, last_turn_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.name || null,
      session.provider,
      session.model,
      session.effort || null,
      session.status,
      session.conversationEpoch,
      session.continuityMode || null,
      session.createdAt,
      session.updatedAt,
      session.lastTurnAt || null,
      session.metadata ? JSON.stringify(session.metadata) : null
    );
  }

  get(id: string): SessionData | null {
    const row = getDatabase().query("SELECT * FROM sessions WHERE id = ?").get(id) as any;
    return row ? mapSessionRow(row) : null;
  }

  getByName(name: string): SessionData | null {
    const row = getDatabase().query("SELECT * FROM sessions WHERE name = ?").get(name) as any;
    return row ? mapSessionRow(row) : null;
  }

  list(): SessionData[] {
    const rows = getDatabase().query("SELECT * FROM sessions ORDER BY updated_at DESC").all() as any[];
    return rows.map(mapSessionRow);
  }

  update(id: string, updates: Partial<SessionData>): void {
    const db = getDatabase();
    const current = this.get(id);
    if (!current) throw new Error("Session not found");
    const merged = { ...current, ...updates, updatedAt: new Date().toISOString() };

    db.prepare(`
      UPDATE sessions SET
        name = ?, provider = ?, model = ?, effort = ?, status = ?, conversation_epoch = ?, continuity_mode = ?, updated_at = ?, last_turn_at = ?, metadata_json = ?
      WHERE id = ?
    `).run(
      merged.name || null,
      merged.provider,
      merged.model,
      merged.effort || null,
      merged.status,
      merged.conversationEpoch,
      merged.continuityMode || null,
      merged.updatedAt,
      merged.lastTurnAt || null,
      merged.metadata ? JSON.stringify(merged.metadata) : null,
      id
    );
  }
}
