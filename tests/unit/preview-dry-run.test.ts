// Failure modes of the preview dry run (dryRun):
// 1. When the replayed call already ended the dry-run transaction and then
//    failed, the ROLLBACK in finally must not replace the call's error with
//    "cannot rollback - no transaction is active".
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb } from "../../src/server/db.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

describe("dryRun", () => {
  it("surfaces the call's error when the call ended the transaction", async () => {
    const db = openDb(":memory:");
    const user = ensureUser(db, "owner@example.com", "Owner", T0);
    const dryApp = new Hono<AppEnv>();
    dryApp.post("/api/habits", () => {
      db.exec("ROLLBACK");
      throw new Error("disk full");
    });
    dryApp.onError((err) => {
      throw err;
    });
    const preview = createPreview({
      db,
      now: () => T0,
      dry: () => ({ app: dryApp, db }),
    } as unknown as PreviewDeps);
    await expect(
      preview.dryRun(user.id, { method: "POST", path: "/api/habits", body: "{}" }),
    ).rejects.toThrow("disk full");
    expect(db.isTransaction).toBe(false);
  });
});
