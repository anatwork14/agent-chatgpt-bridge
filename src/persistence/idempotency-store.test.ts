import { afterEach, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "./database";
import { IdempotencyStore } from "./idempotency-store";

const dbPath = join(tmpdir(), `agent-chatgpt-idempotency-${process.pid}.db`);

afterEach(() => {
  closeDatabase();
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${dbPath}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
});

test("idempotency reservation replays completed result", () => {
  initDatabase(dbPath);
  const store = new IdempotencyStore();

  const first = store.reserve("scope:key", "hash-a");
  expect(first.status).toBe("reserved");
  store.complete("scope:key", "hash-a", { value: 42 });

  const second = store.reserve("scope:key", "hash-a");
  expect(second.status).toBe("existing");
  if (second.status === "existing") {
    expect(JSON.parse(second.record.resultJson!)).toEqual({ value: 42 });
  }
});

test("idempotency reservation exposes body-hash conflict", () => {
  initDatabase(dbPath);
  const store = new IdempotencyStore();
  store.reserve("scope:key", "hash-a");

  const existing = store.reserve("scope:key", "hash-b");
  expect(existing.status).toBe("existing");
  expect(existing.record.bodyHash).toBe("hash-a");
});

test("failed operation can release an incomplete reservation", () => {
  initDatabase(dbPath);
  const store = new IdempotencyStore();
  expect(store.reserve("scope:key", "hash-a").status).toBe("reserved");
  store.release("scope:key", "hash-a");
  expect(store.reserve("scope:key", "hash-a").status).toBe("reserved");
});
