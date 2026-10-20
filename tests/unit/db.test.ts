// Failure modes of tx():
// 1. A body that throws must rethrow its own error and leave no open transaction.
// 2. When the body's error already ended the transaction (SQLite does this on
//    SQLITE_FULL, SQLITE_IOERR and similar), the ROLLBACK must not hide the
//    body's error with "cannot rollback - no transaction is active".
// 3. When the ROLLBACK itself fails, both errors must surface and the failure
//    must be logged.
// 4. After a failed ROLLBACK no later write may report success while it is
//    lost in the stuck transaction: the connection is closed and later calls
//    throw.
// 5. A tx() inside a tx body joins the outer transaction, which commits once.
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
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/ROLLBACK failed/), thrown);
    log.mockRestore();
  });

  it("never loses a later write after a failed ROLLBACK", () => {
    const db = memDb();
    const exec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === "ROLLBACK") throw new Error("disk I/O error");
      exec(sql);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      tx(db, () => {
        throw new Error("body failed");
      }),
    ).toThrow(AggregateError);
    log.mockRestore();
    vi.mocked(db.exec).mockRestore();

    let committed = false;
    try {
      tx(db, () => db.exec("INSERT INTO t VALUES (2)"));
      committed = true;
    } catch (err) {
      expect(String(err)).toMatch(/ROLLBACK failed/);
    }
    if (committed) {
      expect(db.isTransaction).toBe(false);
      expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
    }
    expect(() => db.prepare("INSERT INTO t VALUES (3)").run()).toThrow();
  });

  it("joins a nested tx() and commits once", () => {
    const db = memDb();
    const exec = vi.spyOn(db, "exec");
    tx(db, () => {
      db.exec("INSERT INTO t VALUES (1)");
      tx(db, () => db.exec("INSERT INTO t VALUES (2)"));
      expect(db.isTransaction).toBe(true);
    });
    expect(exec.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 2 });
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
