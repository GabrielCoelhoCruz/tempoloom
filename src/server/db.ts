import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `Database schema version ${current} is newer than this build (${MIGRATIONS.length})`,
    );
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v] as string;
    // A migration that rebuilds a table runs with foreign keys off, so that
    // dropping the old table does not cascade (SQLite's ALTER TABLE procedure).
    const rebuild = sql.includes("-- rebuilds tables");
    if (rebuild) db.exec("PRAGMA foreign_keys = OFF");
    try {
      tx(db, () => {
        db.exec(sql);
        if (rebuild && db.prepare("PRAGMA foreign_key_check").all().length > 0)
          throw new Error(`Migration ${v + 1} breaks a foreign key`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    } finally {
      if (rebuild) db.exec("PRAGMA foreign_keys = ON");
    }
  }
}

const broken = new WeakSet<Db>();
let brokenHandler: ((err: AggregateError) => void) | undefined;

/** Sets the action for a connection that tx() closed after a failed ROLLBACK. */
export function onConnectionBroken(fn: (err: AggregateError) => void): void {
  brokenHandler = fn;
}

/** Runs fn in a write transaction. Nested calls join the outer transaction. */
export function tx<T>(db: Db, fn: () => T): T {
  if (broken.has(db))
    throw new Error("Database connection closed: an earlier ROLLBACK failed; restart the server");
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    // SQLite ends the transaction itself on some errors (SQLITE_FULL,
    // SQLITE_IOERR, ...); a ROLLBACK then would throw and hide err.
    if (!db.isTransaction) throw err;
    try {
      db.exec("ROLLBACK");
    } catch (rollbackErr) {
      const both = new AggregateError(
        [err, rollbackErr],
        "ROLLBACK failed after a failed transaction",
      );
      // A connection left in the transaction would make every later tx() join
      // it and never commit. Closing discards the transaction, and every later
      // call on the connection throws instead of losing its write.
      broken.add(db);
      try {
        db.close();
      } catch (closeErr) {
        both.errors.push(closeErr);
      }
      console.error("ROLLBACK failed: connection closed", both);
      brokenHandler?.(both);
      throw both;
    }
    throw err;
  }
}

export function all<T>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, ...params: SQLInputValue[]): void {
  db.prepare(sql).run(...params);
}
