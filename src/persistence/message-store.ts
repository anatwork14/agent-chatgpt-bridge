import { getDatabase } from "./database";

export interface MessageData {
  id: string;
  sessionId: string;
  role: string;
  contentJson: string;
  createdAt: string;
  metadataJson?: string;
}

export class MessageStore {
  create(msg: MessageData) {
    const db = getDatabase();
    db.prepare(`
      INSERT OR IGNORE INTO messages (id, session_id, role, content_json, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      msg.id,
      msg.sessionId,
      msg.role,
      msg.contentJson,
      msg.createdAt,
      msg.metadataJson || null
    );
  }

  listBySession(sessionId: string): MessageData[] {
    const db = getDatabase();
    const rows = db.query("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as any[];
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      contentJson: row.content_json,
      createdAt: row.created_at,
      metadataJson: row.metadata_json,
    }));
  }
}
