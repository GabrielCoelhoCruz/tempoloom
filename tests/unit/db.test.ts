// Failure modes of tx():
// 1. A body that throws must rethrow its own error and leave no open transaction.
// 2. When the body's error already ended the transaction (SQLite does this on
//    SQLITE_FULL, SQLITE_IOERR and similar), the ROLLBACK must not hide the
//    body's error with "cannot rollback - no transaction is active".
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { tx } from "../../src/server/db.ts";

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  return db;
}

describe("tx", () => {
  it("rethrows the body's error and rolls back", () => {
    const db = memDb();
    expect(() =>
      tx(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        throw new Error("body failed");
      }),
    ).toThrow("body failed");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
  });

  it("rethrows the body's error when SQLite already ended the transaction", () => {
    const db = memDb();
    expect(() =>
      tx(db, () => {
        db.exec("INSERT INTO t VALUES (1)");
        db.exec("ROLLBACK");
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(db.isTransaction).toBe(false);
  });

  it("commits when the body returns", () => {
    const db = memDb();
    const result = tx(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
  });
});
