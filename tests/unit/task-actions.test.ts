// Snooze, bulk edit and task defaults on the API (planning-tasks.md TSK-24,
// TSK-45, edge case 6, user task defaults).
//
// Ways it can fail:
// 1. Snooze puts the start after the due date; later edits of the task
//    (visibility, priority, done) then fail with "Due date must be after the
//    start date".
// 2. Snooze keeps a locked future chunk at its old time, so the task does
//    not move (a task made on the planner has one locked chunk, TSK-7).
// 3. Snooze unlocks a chunk that has started.
// 4. Bulk start puts the start after a due date.
// 5. A "due in 0 days" default (or a start delay as long as due-in) is saved,
//    and every new task then fails.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { settingsRoutes } from "../../src/server/api/settings.ts";
import { taskActionRoutes } from "../../src/server/api/task-actions.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const HOUR = 3_600_000;
// Monday 2026-10-19, 08:00 UTC. The user's zone is UTC; work hours start at 09:00.
const T0 = Date.parse("2026-10-19T08:00:00Z");
const NEXT_MONDAY_9 = Date.parse("2026-10-26T09:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const sync = {
    request: () => {},
    exclusive: async (_u: string, fn: (pool: unknown) => Promise<unknown>) =>
      fn({ get: () => ({ deleteEvent: async () => {} }) }),
  } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  const now = () => T0;
  app.route("/api", itemRoutes(db, sync, now));
  app.route("/api", taskActionRoutes(db, sync, now));
  app.route("/api", settingsRoutes(db, sync, now));
  const call = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = async (body: object) => {
    const res = await call("POST", "/tasks", { minutes: 60, splitUp: false, ...body });
    expect(res.status).toBe(201);
    return ((await res.json()) as { task: { id: string } }).task.id;
  };
  const task = (id: string) =>
    one<{ start_after: number; due_at: number | null; level: number; status: string }>(
      db,
      "SELECT start_after, due_at, level, status FROM tasks WHERE id = ?",
      id,
    );
  return { db, user, call, create, task };
}

describe("snooze", () => {
  it("moves the due date with the start when the new start reaches it; later edits work", async () => {
    const { call, create, task } = setup();
    // The default due date: in 3 days, before next week.
    const id = await create({ title: "Report" });
    const before = task(id);
    expect(before?.due_at).toBe(T0 + 72 * HOUR);
    expect((await call("POST", `/tasks/${id}/snooze`, { choice: "next-week" })).status).toBe(200);
    const after = task(id);
    expect(after?.start_after).toBe(NEXT_MONDAY_9);
    // The whole task moves: the time from start to due stays the same.
    expect(after?.due_at).toBe(NEXT_MONDAY_9 + 72 * HOUR);

    expect((await call("PATCH", `/tasks/${id}`, { visibility: "private" })).status).toBe(200);
    expect((await call("PATCH", `/tasks/${id}`, { level: 3 })).status).toBe(200);
    const bulk = await call("POST", "/tasks/bulk", {
      ids: [id],
      change: { action: "level", level: 1 },
    });
    expect(bulk.status).toBe(200);
    expect(task(id)?.level).toBe(1);
    expect(
      (await call("POST", "/tasks/bulk", { ids: [id], change: { action: "done" } })).status,
    ).toBe(200);
    expect(task(id)?.status).toBe("done");
  });

  it("keeps a due date that stays after the new start", async () => {
    const { call, create, task } = setup();
    const id = await create({ title: "Later", dueAt: T0 + 240 * HOUR });
    expect((await call("POST", `/tasks/${id}/snooze`, { choice: "1h" })).status).toBe(200);
    expect(task(id)).toMatchObject({ start_after: T0 + HOUR, due_at: T0 + 240 * HOUR });
  });

  it("unlocks the future chunks so the whole task moves, and keeps a started chunk", async () => {
    const { db, user, call, create } = setup();
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
       VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
      user.id,
      T0,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES ('cal', 'acc', 'cal', 'Main', 1, 1, 1)`,
    );
    const id = await create({ title: "Made on the planner", dueAt: null });
    for (const [n, start] of [
      [0, T0 - HOUR / 2],
      [1, T0 + 2 * HOUR],
    ] as const)
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
           start_ms, end_ms, busy, title, locked) VALUES (?, ?, 'cal', ?, ?, 'task', ?, ?, ?, 1, 'x', 1)`,
        `m${n}`,
        user.id,
        `e${n}`,
        `task:${id}:${n}`,
        id,
        start,
        start + HOUR,
      );
    expect((await call("POST", `/tasks/${id}/snooze`, { choice: "tomorrow" })).status).toBe(200);
    expect(all(db, "SELECT id, locked FROM managed_events ORDER BY id")).toEqual([
      { id: "m0", locked: 1 },
      { id: "m1", locked: 0 },
    ]);
  });

  it("refuses a time in the past and a done task", async () => {
    const { call, create } = setup();
    const id = await create({ title: "Old", dueAt: null });
    expect((await call("POST", `/tasks/${id}/snooze`, { until: T0 - HOUR })).status).toBe(400);
    await call("POST", `/tasks/${id}/done`);
    expect((await call("POST", `/tasks/${id}/snooze`, { choice: "1h" })).status).toBe(400);
  });
});

describe("bulk edit", () => {
  it("refuses a start after a due date and changes no task", async () => {
    const { call, create, task } = setup();
    const a = await create({ title: "A", dueAt: T0 + 24 * HOUR });
    const b = await create({ title: "B", dueAt: null });
    const res = await call("POST", "/tasks/bulk", {
      ids: [a, b],
      change: { action: "start", startAfter: T0 + 48 * HOUR },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Due date must be after the start date (A)");
    expect(task(a)?.start_after).toBe(T0);
    expect(task(b)?.start_after).toBe(T0);
  });
});

describe("task defaults", () => {
  it("refuses a due-in that is not after the start delay", async () => {
    const { call } = setup();
    for (const taskDefaults of [{ dueInDays: 0 }, { dueInDays: 1, startDelayMinutes: 24 * 60 }]) {
      const res = await call("PATCH", "/settings", { taskDefaults });
      expect(res.status, JSON.stringify(taskDefaults)).toBe(400);
    }
    expect((await call("PATCH", "/settings", { taskDefaults: { dueInDays: null } })).status).toBe(
      200,
    );
  });

  it("makes a title-only task with a stored due-in of 0 days", async () => {
    const { db, user, create, task } = setup();
    // A value saved before the check.
    run(
      db,
      "UPDATE users SET settings = ? WHERE id = ?",
      JSON.stringify({ taskDefaults: { dueInDays: 0 } }),
      user.id,
    );
    const id = await create({ title: "Quick" });
    const t = task(id);
    expect((t?.due_at ?? 0) > (t?.start_after ?? 0)).toBe(true);
  });
});
