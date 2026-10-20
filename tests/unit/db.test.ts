// Failure modes of tx():
// 1. A body that throws must rethrow its own error and leave no open transaction.
// 2. When the body's error already ended the transaction (SQLite does this on
//    SQLITE_FULL, SQLITE_IOERR and similar), the ROLLBACK must not hide the
//    body's error with "cannot rollback - no transaction is active".
// 3. When the ROLLBACK itself fails, both errors must surface and the failure
//    must be logged: the connection may be left in a transaction.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
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

  it("surfaces both errors and logs when the ROLLBACK fails", () => {
    const db = memDb();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("disk I/O error");
      exec(sql);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let thrown: unknown;
    try {
      tx(db, () => {
        throw new Error("body failed");
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    const messages = (thrown as AggregateError).errors.map((e: Error) => e.message);
    expect(messages).toEqual(["body failed", "disk I/O error"]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/left in a transaction/), thrown);
    log.mockRestore();
    vi.mocked(db.exec).mockRestore();
    exec("ROLLBACK");
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
