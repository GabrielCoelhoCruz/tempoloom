// PUT /api/hours/:id with parts of a set (planning-hours.md HRS-6, HRS-7, HRS-12).
// The calendar menu sends only a name or a task calendar; the range editor
// sends only the ranges. Two such saves can overlap.
//
// Ways it can fail:
// 1. A save without ranges writes back ranges it read before its body came,
//    and so loses ranges saved in between.
// 2. A save without ranges marks the items of the set for a new placement.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { settingsRoutes } from "../../src/server/api/settings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { one, openDb, run } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(
    db,
    "INSERT INTO hours_sets (id, user_id, kind, name, weekly, created_at) VALUES ('h1', ?, 'custom', 'Old', ?, ?)",
    user.id,
    JSON.stringify({ "1": [[540, 1020]] }),
    T0,
  );
  const sync = { request: () => {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    settingsRoutes(db, sync, () => T0 + 1000),
  );
  return { db, user, app };
}

/** A PUT whose body arrives only when `send` is called. */
function slowPut(app: Hono<AppEnv>, body: unknown) {
  let send = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      send = () => {
        ctrl.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        ctrl.close();
      };
    },
  });
  const res = app.request("/api/hours/h1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: stream,
    // @ts-expect-error Node needs duplex for a stream body.
    duplex: "half",
  });
  return { res, send: () => send() };
}

const put = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/api/hours/h1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PUT /api/hours/:id", () => {
  it("keeps ranges saved while a name-only save waits for its body", async () => {
    const { db, app } = setup();
    const slow = slowPut(app, { name: "New" });
    await new Promise((r) => setTimeout(r, 10));
    expect((await put(app, { weekly: { "2": [[600, 660]] } })).status).toBe(200);
    slow.send();
    expect((await slow.res).status).toBe(200);
    const set = one<{ name: string; weekly: string }>(
      db,
      "SELECT name, weekly FROM hours_sets WHERE id = 'h1'",
    );
    expect(set?.name).toBe("New");
    expect(JSON.parse(set?.weekly ?? "{}")).toEqual({ "2": [[600, 660]] });
  });

  it("re-places items only when the ranges change", async () => {
    const { db, user, app } = setup();
    run(
      db,
      `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes,
         max_chunk_minutes, start_after, hours_set_id, created_at, rules_changed_at)
       VALUES ('t1', ?, 'T', 3, 60, 30, 60, ?, 'h1', ?, ?)`,
      user.id,
      T0,
      T0,
      T0,
    );
    const changed = () =>
      one<{ r: number }>(db, "SELECT rules_changed_at AS r FROM tasks WHERE id = 't1'")?.r;
    const before = changed();
    expect((await put(app, { name: "Renamed" })).status).toBe(200);
    expect((await put(app, { weekly: { "1": [[540, 1020]] } })).status).toBe(200);
    expect(changed()).toBe(before);
    expect((await put(app, { weekly: { "1": [[600, 1020]] } })).status).toBe(200);
    expect(changed()).toBe(T0 + 1000);
  });
});
