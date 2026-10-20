// Failure modes of tx():
// 1. A body that throws must rethrow its own error and leave no open transaction.
// 2. When the body's error already ended the transaction (SQLite does this on
//    SQLITE_FULL, SQLITE_IOERR and similar), the ROLLBACK must not hide the
//    body's error with "cannot rollback - no transaction is active".
// 3. When the ROLLBACK itself fails, both errors must surface and the failure
//    must be logged.
// 4. After a failed ROLLBACK no later write may report success while it is
//    lost in the stuck transaction: the connection is closed, later calls
//    throw "restart the server", and the connection's onBroken runs once.
// 5. A tx() inside a tx body joins the outer transaction, which commits once.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { all, exitOnBroken, one, openDb, run, tx } from "../../src/server/db.ts";

function memDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER)");
  return db;
}

/** Runs a failing tx() whose ROLLBACK also fails; returns what tx() threw. */
function breakRollback(db: DatabaseSync): unknown {
  const exec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
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
  log.mockRestore();
  spy.mockRestore();
  return thrown;
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
    breakRollback(db);
    expect(() => tx(db, () => db.exec("INSERT INTO t VALUES (2)"))).toThrow(/restart the server/);
    expect(() => run(db, "INSERT INTO t VALUES (3)")).toThrow(/restart the server/);
    expect(() => one(db, "SELECT 1")).toThrow(/restart the server/);
    expect(() => all(db, "SELECT 1")).toThrow(/restart the server/);
  });

  it("calls the connection's onBroken once with the AggregateError", () => {
    const onBroken = vi.fn();
    const db = openDb(":memory:", { onBroken });
    db.exec("CREATE TABLE t (x INTEGER)");
    const other = openDb(":memory:", { onBroken: vi.fn() });
    const thrown = breakRollback(db);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith(thrown);
    expect(() => tx(db, () => {})).toThrow(/restart the server/);
    expect(onBroken).toHaveBeenCalledTimes(1);
    // The handler belongs to its connection: another connection still works.
    expect(one(other, "SELECT 1 AS n")).toEqual({ n: 1 });
  });

  it("exitOnBroken stops the server and exits with code 1 at once", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);
    const stop = vi.fn();
    const onBroken = exitOnBroken(stop);
    onBroken(new AggregateError([], "x"));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockClear();
    // A failing server.close() must not skip the exit.
    expect(() =>
      exitOnBroken(() => {
        throw new Error("close failed");
      })(new AggregateError([], "x")),
    ).toThrow("close failed");
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
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
