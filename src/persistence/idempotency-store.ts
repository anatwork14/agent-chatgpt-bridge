import { getDatabase } from "./database";

export interface IdempotencyRecord {
  key: string;
  bodyHash: string;
  resultJson?: string;
  createdAt: string;
  expiresAt: string;
}

export type IdempotencyReservation =
  | { status: "reserved"; record: IdempotencyRecord }
  | { status: "existing"; record: IdempotencyRecord };

export class IdempotencyStore {
  reserve(key: string, bodyHash: string, ttlMs = 24 * 60 * 60_000): IdempotencyReservation {
    const db = getDatabase();
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    db.prepare("DELETE FROM idempotency WHERE expires_at <= ?").run(createdAt);
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO idempotency (key, body_hash, result_json, created_at, expires_at)
      VALUES (?, ?, NULL, ?, ?)
    `).run(key, bodyHash, createdAt, expiresAt);

    if (Number(inserted.changes) === 1) {
      return {
        status: "reserved",
        record: { key, bodyHash, createdAt, expiresAt },
      };
    }

    const existing = this.get(key);
    if (!existing) {
      throw new Error(`Idempotency reservation disappeared unexpectedly: ${key}`);
    }
    return { status: "existing", record: existing };
  }

  get(key: string): IdempotencyRecord | null {
    const db = getDatabase();
    const row = db.query("SELECT * FROM idempotency WHERE key = ?").get(key) as any;
    if (!row) return null;
    return {
      key: row.key,
      bodyHash: row.body_hash,
      resultJson: row.result_json ?? undefined,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  complete(key: string, bodyHash: string, result: unknown): void {
    const db = getDatabase();
    const update = db.prepare(`
      UPDATE idempotency SET result_json = ?
      WHERE key = ? AND body_hash = ?
    `).run(JSON.stringify(result), key, bodyHash);
    if (Number(update.changes) !== 1) {
      throw new Error(`Idempotency reservation could not be completed: ${key}`);
    }
  }

  release(key: string, bodyHash: string): void {
    getDatabase().prepare(`
      DELETE FROM idempotency
      WHERE key = ? AND body_hash = ? AND result_json IS NULL
    `).run(key, bodyHash);
  }
}
