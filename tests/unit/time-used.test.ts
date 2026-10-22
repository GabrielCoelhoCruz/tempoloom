// The time-used action (planning-task-progress.md PRG-40 to PRG-46). The
// first apply() after a task becomes time-used starts its wait, as the first
// plan run does.
//
// Ways it can fail:
// 1. The action runs before the wait days end, or on a task with work ahead.
// 2. "re-add" adds the current total, so a second re-add doubles the work.
// 3. "re-add" leaves less than the first total when the done work was more
//    than the total (a lengthened past chunk), so it re-adds on every run.
// 4. Manual start mode or "nothing" still changes a task.
// 5. "Add 30 min", or a minutes edit after a re-add, changes what re-add adds.
// 6. A total lowered below the done work, or work logged with an old date,
//    acts at once, with no wait.
// 7. The automatic action leaves no change-log entry.
// 8. "Nothing" does not start the wait, so a later change to another action
//    waits again (PRG-43).
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import { applyTimeUsed } from "../../src/server/planner/time-used.ts";
import { getSettings, updateSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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
  const clock = { t: T0 };
  app.route(
    "/api",
    itemRoutes(db, { request: () => {} } as unknown as SyncService, () => clock.t),
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
  const since = (id: string) =>
    one<{ s: number | null }>(db, "SELECT time_used_since AS s FROM tasks WHERE id = ?", id)?.s;
  const apply = (t: number) => applyTimeUsed(db, user.id, t, getSettings(db, user.id));
  const log = (id: string) =>
    all<{ action: string; reason: string }>(
      db,
      "SELECT action, reason FROM item_changes WHERE item_id = ? ORDER BY id",
      id,
    );
  return { db, call, chunk, create, task, apply, clock, log, since };
}

describe("time-used action", () => {
  it("marks done only after the wait days from the first run that finds it time-used, and not with work ahead", async () => {
    const { chunk, create, task, apply, since } = setup({
      timeUsedAction: "mark-done",
      timeUsedWaitDays: 2,
    });
    const used = await create(60);
    chunk(used, T0, 60);
    const ahead = await create(60);
    chunk(ahead, T0, 60);
    chunk(ahead, T0 + 3 * DAY, 30);
    const seen = T0 + 2 * HOUR;
    expect(apply(seen)).toBe(0);
    expect(since(used)).toBe(seen);
    expect(since(ahead)).toBeNull();
    expect(apply(seen + 2 * DAY - MIN)).toBe(0);
    expect(task(used)?.status).toBe("open");
    expect(apply(seen + 2 * DAY)).toBe(1);
    expect(task(used)?.status).toBe("done");
    expect(task(ahead)?.status).toBe("open");
  });

  it("re-adds the first total each time, and exactly that much is left", async () => {
    const { chunk, create, task, apply, log, since } = setup({
      timeUsedAction: "re-add",
      timeUsedWaitDays: 1,
    });
    const id = await create(60);
    chunk(id, T0, 60);
    const e1 = T0 + 60 * MIN;
    expect(apply(e1)).toBe(0);
    expect(apply(e1 + DAY - MIN)).toBe(0);
    expect(apply(e1 + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(120);
    expect(since(id)).toBeNull();
    // The new hour was done, and its chunk ran 30 minutes long.
    chunk(id, T0 + 2 * DAY, 90);
    const e2 = T0 + 2 * DAY + 90 * MIN;
    expect(apply(e2)).toBe(0);
    expect(apply(e2 + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(210);
    expect(apply(e2 + DAY)).toBe(0);
    // A third time: 60 again, not the 210 of the full total.
    chunk(id, T0 + 4 * DAY, 60);
    const e3 = T0 + 4 * DAY + 60 * MIN;
    expect(apply(e3)).toBe(0);
    expect(apply(e3 + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(270);
    expect(log(id)).toEqual(Array(3).fill({ action: "status", reason: "time-used-readd" }));
  });

  it("Add 30 min does not change what re-add adds, and ends the time-used wait", async () => {
    const { chunk, create, task, apply, call, since } = setup({
      timeUsedAction: "re-add",
      timeUsedWaitDays: 1,
    });
    const id = await create(60);
    chunk(id, T0, 60);
    expect(apply(T0 + HOUR)).toBe(0);
    expect(since(id)).toBe(T0 + HOUR);
    expect((await call("POST", `/tasks/${id}/add-time`, { minutes: 30 })).status).toBe(200);
    expect(apply(T0 + HOUR + MIN)).toBe(0);
    expect(since(id)).toBeNull();
    chunk(id, T0 + 2 * HOUR, 30);
    const end = T0 + 2 * HOUR + 30 * MIN;
    expect(apply(end)).toBe(0);
    expect(apply(end + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(150);
  });

  it("a minutes edit before the first re-add moves the first total by the same amount; one after it does not", async () => {
    const { chunk, create, task, apply, call, clock } = setup({
      timeUsedAction: "re-add",
      timeUsedWaitDays: 1,
    });
    const id = await create(60);
    expect((await call("PATCH", `/tasks/${id}`, { minutes: 45 })).status).toBe(200);
    chunk(id, T0 + HOUR, 45);
    const e1 = T0 + HOUR + 45 * MIN;
    expect(apply(e1)).toBe(0);
    expect(apply(e1 + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(90);
    // After the re-add the user sets 105 to add 15 minutes: re-add still adds 45.
    clock.t = T0 + 2 * DAY;
    expect((await call("PATCH", `/tasks/${id}`, { minutes: 105 })).status).toBe(200);
    chunk(id, T0 + 3 * DAY, 60);
    const e2 = T0 + 3 * DAY + 60 * MIN;
    expect(apply(e2)).toBe(0);
    expect(apply(e2 + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(150);
  });

  it("a minutes edit after Add 30 min keeps the added minutes out of the first total", async () => {
    const { chunk, create, task, apply, call } = setup({
      timeUsedAction: "re-add",
      timeUsedWaitDays: 1,
    });
    const id = await create(60);
    expect((await call("POST", `/tasks/${id}/add-time`, { minutes: 30 })).status).toBe(200);
    // 90 to 105: the first total goes from 60 to 75.
    expect((await call("PATCH", `/tasks/${id}`, { minutes: 105 })).status).toBe(200);
    chunk(id, T0, 105);
    const end = T0 + 105 * MIN;
    expect(apply(end)).toBe(0);
    expect(apply(end + DAY)).toBe(1);
    expect(task(id)?.total_minutes).toBe(180);
  });

  it("a total lowered below the done work waits the full days from the edit", async () => {
    const { chunk, create, task, apply, call, clock, log } = setup({
      timeUsedAction: "mark-done",
      timeUsedWaitDays: 3,
    });
    const id = await create(120);
    chunk(id, T0, 90);
    expect(apply(T0 + 2 * HOUR)).toBe(0);
    // 5 days later the user lowers the total to 60: the task is time-used from now.
    clock.t = T0 + 5 * DAY;
    expect((await call("PATCH", `/tasks/${id}`, { minutes: 60 })).status).toBe(200);
    expect(apply(clock.t)).toBe(0);
    expect(apply(clock.t + 3 * DAY - MIN)).toBe(0);
    expect(task(id)?.status).toBe("open");
    expect(apply(clock.t + 3 * DAY)).toBe(1);
    expect(task(id)?.status).toBe("done");
    expect(log(id)).toEqual([{ action: "status", reason: "time-used-done" }]);
  });

  it("work logged on day 5 with a day-0 date waits the full days from day 5", async () => {
    const { chunk, create, task, apply } = setup({
      timeUsedAction: "mark-done",
      timeUsedWaitDays: 3,
    });
    const id = await create(90);
    chunk(id, T0, 60);
    expect(apply(T0 + 2 * HOUR)).toBe(0);
    // Day 5: the user logs the other 30 minutes, dated day 0.
    chunk(id, T0 + 2 * HOUR, 30);
    expect(apply(T0 + 5 * DAY)).toBe(0);
    expect(apply(T0 + 8 * DAY - MIN)).toBe(0);
    expect(task(id)?.status).toBe("open");
    expect(apply(T0 + 8 * DAY)).toBe(1);
    expect(task(id)?.status).toBe("done");
  });

  it("does nothing with Nothing or in manual start mode; Nothing still starts the wait (PRG-43)", async () => {
    for (const patch of [
      { timeUsedAction: "nothing" },
      { timeUsedAction: "mark-done", startMode: "manual" },
    ]) {
      const { chunk, create, task, apply, db } = setup({ timeUsedWaitDays: 1, ...patch });
      const id = await create(60);
      chunk(id, T0, 60);
      run(db, "UPDATE managed_events SET started = 1");
      expect(apply(T0 + HOUR)).toBe(0);
      expect(apply(T0 + 10 * DAY)).toBe(0);
      expect(task(id)).toEqual({ status: "open", total_minutes: 60 });
      if (patch.timeUsedAction !== "nothing") continue;
      const user = one<{ id: string }>(db, "SELECT id FROM users")?.id ?? "";
      updateSettings(db, user, { timeUsedAction: "mark-done" });
      expect(applyTimeUsed(db, user, T0 + 10 * DAY, getSettings(db, user))).toBe(1);
      expect(task(id)?.status).toBe("done");
    }
  });
});
