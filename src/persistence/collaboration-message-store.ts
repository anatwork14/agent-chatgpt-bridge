import { getDatabase } from "./database";
import type { CollaborationMessageRecord } from "../core/collaboration-transcript";
import { assertCollaborationMessageIntegrity } from "../core/collaboration-transcript";

function mapMessageRow(row: any): CollaborationMessageRecord {
  const record: CollaborationMessageRecord = {
    id: row.id,
    runId: row.run_id,
    turnId: row.turn_id,
    sequenceIndex: row.sequence_index,
    senderParticipantId: row.sender_participant_id,
    senderRoleId: row.sender_role_id,
    decisionType: row.decision_type,
    content: row.content_text,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
  assertCollaborationMessageIntegrity(record);
  return record;
}

export class CollaborationMessageStore {
  create(message: CollaborationMessageRecord): void {
    assertCollaborationMessageIntegrity(message);
    const db = getDatabase();
    db.prepare(`
      INSERT INTO collaboration_messages (
        id, run_id, turn_id, sequence_index, sender_participant_id,
        sender_role_id, decision_type, content_text, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.runId,
      message.turnId,
      message.sequenceIndex,
      message.senderParticipantId,
      message.senderRoleId,
      message.decisionType,
      message.content,
      message.contentHash,
      message.createdAt,
    );
  }

  get(id: string): CollaborationMessageRecord | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM collaboration_messages WHERE id = ?").get(id) as any;
    return row ? mapMessageRow(row) : null;
  }

  listByRun(runId: string): CollaborationMessageRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        "SELECT * FROM collaboration_messages WHERE run_id = ? ORDER BY sequence_index ASC",
      )
      .all(runId) as any[];
    return rows.map(mapMessageRow);
  }

  listByTurn(turnId: string): CollaborationMessageRecord[] {
    const db = getDatabase();
    const rows = db
      .query(
        "SELECT * FROM collaboration_messages WHERE turn_id = ? ORDER BY sequence_index ASC",
      )
      .all(turnId) as any[];
    return rows.map(mapMessageRow);
  }
}
