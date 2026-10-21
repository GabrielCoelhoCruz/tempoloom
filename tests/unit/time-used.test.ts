// The time-used action (planning-task-progress.md PRG-40 to PRG-44).
//
// Ways it can fail:
// 1. The action runs before the wait days end, or on a task with work ahead.
// 2. "re-add" adds the current total, so a second re-add doubles the work.
// 3. "re-add" leaves less than the first total when the done work was more
//    than the total (a lengthened past chunk), so it re-adds on every run.
// 4. Manual start mode or "nothing" still changes a task.
// 5. A total the user sets is not the one that comes again.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { one, openDb, run } from "../../src/server/db.ts";
import { applyTimeUsed } from "../../src/server/planner/time-used.ts";
import { getSettings, updateSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup(patch: object) {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  updateSettings(db, user.id, patch);
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
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    itemRoutes(db, { request: () => {} } as unknown as SyncService, () => T0),
  );
  const call = (method: string, path: string, body: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  let n = 0;
  const chunk = (taskId: string, start: number, minutes: number) =>
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
         start_ms, end_ms, busy, title) VALUES (?, ?, 'cal', ?, ?, 'task', ?, ?, ?, 1, 'x')`,
      `m${n}`,
      user.id,
      `e${n}`,
      `task:${taskId}:${n++}`,
      taskId,
      start,
      start + minutes * MIN,
    );
  const create = async (minutes: number) => {
    const res = await call("POST", "/tasks", { title: "t", minutes, splitUp: false, dueAt: null });
    return ((await res.json()) as { task: { id: string } }).task.id;
  };
  const task = (id: string) =>
    one<{ status: string; total_minutes: number }>(
      db,
      "SELECT status, total_minutes FROM tasks WHERE id = ?",
      id,
    );
  const apply = (t: number) => applyTimeUsed(db, user.id, t, getSettings(db, user.id));
  return { db, call, chunk, create, task, apply };
}

describe("time-used action", () => {
  it("marks done only after the wait days, and not with work ahead", async () => {
    const { chunk, create, task, apply } = setup({
      timeUsedAction: "mark-done",
      timeUsedWaitDays: 2,
    });
    const used = await create(60);
    chunk(used, T0, 60);
    const ahead = await create(60);
    chunk(ahead, T0, 60);
    chunk(ahead, T0 + 3 * DAY, 30);
    const end = T0 + 60 * MIN;
    expect(apply(end + 2 * DAY - MIN)).toBe(0);
    expect(task(used)?.status).toBe("open");
    expect(apply(end + 2 * DAY)).toBe(1);
    expect(task(used)?.status).toBe("done");
    expect(task(ahead)?.status).toBe("open");
  });

  it("re-adds the first total each time, and at least that much is left", async () => {
    const { chunk, create, task, apply, call } = setup({
      timeUsedAction: "re-add",
      timeUsedWaitDays: 1,
    });
    const id = await create(60);
    chunk(id, T0, 60);
    expect(apply(T0 + 60 * MIN + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(120);
    // The new hour was done, and its chunk ran 30 minutes long.
    chunk(id, T0 + 2 * DAY, 90);
    expect(apply(T0 + 2 * DAY + 90 * MIN + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(210);
    expect(apply(T0 + 2 * DAY + 90 * MIN + DAY)).toBe(0);
    // A total the user sets is the one that comes again.
    expect((await call("PATCH", `/tasks/${id}`, { minutes: 150 })).status).toBe(200);
    chunk(id, T0 + 4 * DAY, 60);
    expect(apply(T0 + 4 * DAY + 60 * MIN + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(360);
  });

  it("does nothing with Nothing or in manual start mode", async () => {
    for (const patch of [
      { timeUsedAction: "nothing" },
      { timeUsedAction: "mark-done", startMode: "manual" },
    ]) {
      const { chunk, create, task, apply, db } = setup({ timeUsedWaitDays: 1, ...patch });
      const id = await create(60);
      chunk(id, T0, 60);
      run(db, "UPDATE managed_events SET started = 1");
      expect(apply(T0 + 10 * DAY)).toBe(0);
      expect(task(id)).toEqual({ status: "open", total_minutes: 60 });
    }
  });
});
