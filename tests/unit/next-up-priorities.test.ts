// The next-up queue endpoint (planning-next-up.md NXT-2, NXT-9 to NXT-11) and
// the priorities endpoint (planning-priorities.md PRI-51, PRI-53).
//
// Ways it can fail:
// 1. A move leaves gaps or two equal ranks in the queue.
// 2. A task taken out of the queue keeps a rank, or a done task stays queued.
// 3. A level change of an automation keeps its old rank, so it jumps ahead in
//    the new level; focus time leaves P4.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { priorityRoutes } from "../../src/server/api/priorities.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const sync = { request: () => {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    itemRoutes(db, sync, () => T0),
  );
  app.route(
    "/api",
    priorityRoutes(db, sync, () => T0),
  );
  const post = async (url: string, body: unknown) => {
    const res = await app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { db, post };
}

const ranks = (db: ReturnType<typeof openDb>) =>
  Object.fromEntries(
    all<{ title: string; next_up_rank: number | null }>(
      db,
      "SELECT title, next_up_rank FROM tasks ORDER BY title",
    ).map((t) => [t.title, t.next_up_rank]),
  );

describe("POST /api/tasks/:id/queue", () => {
  it("adds last, moves to a position, and takes out, keeping ranks 0..n-1", async () => {
    const { db, post } = setup();
    const ids: Record<string, string> = {};
    for (const title of ["A", "B", "C", "D"]) {
      const r = await post("/api/tasks", { title, dueAt: null });
      ids[title] = (r.body.task as { id: string }).id;
    }
    for (const t of ["A", "B", "C"]) await post(`/api/tasks/${ids[t]}/queue`, {});
    expect(ranks(db)).toEqual({ A: 0, B: 1, C: 2, D: null });
    await post(`/api/tasks/${ids.C}/queue`, { position: 0 });
    expect(ranks(db)).toEqual({ A: 1, B: 2, C: 0, D: null });
    await post(`/api/tasks/${ids.D}/queue`, { position: 1 });
    expect(ranks(db)).toEqual({ A: 2, B: 3, C: 0, D: 1 });
    await post(`/api/tasks/${ids.A}/queue`, { position: null });
    expect(ranks(db)).toEqual({ A: null, B: 2, C: 0, D: 1 });
    await post(`/api/tasks/${ids.D}/done`, {});
    expect(ranks(db)).toMatchObject({ D: null });
    await post(`/api/tasks/${ids.A}/queue`, {});
    // The done task is out; the new entry goes last.
    expect(ranks(db)).toEqual({ A: 2, B: 1, C: 0, D: null });
  });
});

describe("POST /api/priorities", () => {
  it("moves a habit to the end of its new level and keeps focus time at P4", async () => {
    const { db, post } = setup();
    const habit = async (title: string, level: number) =>
      (
        (
          await post("/api/habits", {
            title,
            idealTime: "10:00",
            minMinutes: 30,
            maxMinutes: 30,
            level,
          })
        ).body.habit as { id: string }
      ).id;
    await habit("One", 1);
    const two = await habit("Two", 3);
    expect((await post("/api/priorities", { kind: "habit", id: two, level: 1 })).status).toBe(200);
    expect(one(db, "SELECT level, rank FROM habits WHERE id = ?", two)).toEqual({
      level: 1,
      rank: 1,
    });
    const focus = await post("/api/priorities", { kind: "focus_time", id: "any", level: 1 });
    expect(focus.status).toBe(400);
  });
});
