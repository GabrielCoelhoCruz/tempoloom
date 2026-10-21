// The next-up queue endpoint (planning-next-up.md NXT-2, NXT-9 to NXT-11) and
// the priorities endpoint (planning-priorities.md PRI-51, PRI-53).
//
// Ways it can fail:
// 1. A move leaves gaps or two equal ranks in the queue.
// 2. A task taken out of the queue keeps a rank, or a done task stays queued.
// 3. A level change of an automation keeps its old rank, so it jumps ahead in
//    the new level; focus time leaves P4.
// 4. Two controls for the same order change give two different plans: the
//    queue routes, the priorities board and the edit form must mark the same
//    tasks for a new placement, and the board must move a habit like the
//    automation list does (PRI-54).
// 5. An up move un-sticks every other task (SCH-88 lost); a down move keeps
//    the others sticky, so the moved task takes its old early slot again
//    (NXT-10, acceptance test 4).
// 6. "Mark done" from the timer keeps the queue rank (NXT-11).
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { automationRoutes } from "../../src/server/api/automations.ts";
import { habitRoutes } from "../../src/server/api/habits.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { priorityRoutes } from "../../src/server/api/priorities.ts";
import { taskTimeRoutes } from "../../src/server/api/task-time.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const clock = { t: T0 };
  const now = () => clock.t;
  // The timer writes its log event through the provider; this one accepts every write.
  const pool = {
    get: () => ({
      insertEvent: async (_cal: string, e: Partial<ProviderEvent>): Promise<ProviderEvent> => ({
        id: `ev-${Math.random()}`,
        cancelled: false,
        etag: null,
        summary: "",
        description: "",
        location: "",
        start: 0,
        end: 0,
        allDay: false,
        busy: true,
        eventType: "default",
        selfResponse: null,
        attendeeCount: 0,
        attendees: [],
        organizerSelf: true,
        recurringId: null,
        colorId: null,
        updated: null,
        privateProps: {},
        visibility: "default",
        ...e,
      }),
    }),
  };
  const sync = {
    request: () => {},
    exclusive: async (_userId: string, fn: (p: typeof pool) => Promise<unknown>) => fn(pool),
  } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api", itemRoutes(db, sync, now));
  app.route("/api", habitRoutes(db, sync, now));
  app.route("/api", priorityRoutes(db, sync, now));
  app.route("/api", automationRoutes(db, sync, now));
  app.route("/api", taskTimeRoutes(db, sync, "http://localhost", now));
  const send = async (method: string, url: string, body: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const post = (url: string, body: unknown) => send("POST", url, body);
  const patch = (url: string, body: unknown) => send("PATCH", url, body);
  return { db, post, patch, clock, user };
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

/** Creates open tasks A, B, C at T0, in the given levels. */
async function tasks(s: ReturnType<typeof setup>, levels: Record<string, number>) {
  const ids: Record<string, string> = {};
  for (const [title, level] of Object.entries(levels)) {
    const r = await s.post("/api/tasks", { title, level, dueAt: null });
    ids[title] = (r.body.task as { id: string }).id;
  }
  return ids;
}

/** The tasks that the next plan run places again: rules changed after `since`. */
const marked = (s: ReturnType<typeof setup>, since: number) =>
  all<{ title: string }>(
    s.db,
    "SELECT title FROM tasks WHERE rules_changed_at > ? ORDER BY title",
    since,
  ).map((t) => t.title);

/** Runs `act` one minute later than the last step and returns the tasks it marked. */
async function marks(s: ReturnType<typeof setup>, act: () => Promise<{ status: number }>) {
  const since = s.clock.t;
  s.clock.t += 60_000;
  expect((await act()).status).toBe(200);
  return marked(s, since);
}

describe("an order change marks the same tasks from every control (SCH-88, NXT-10)", () => {
  it("queue: an add or an up move marks only the moved task; a down move or a removal marks every open task", async () => {
    const s = setup();
    const ids = await tasks(s, { A: 2, B: 2, C: 2 });
    const q = (t: string, body: unknown) => () => s.post(`/api/tasks/${ids[t]}/queue`, body);
    expect(await marks(s, q("A", {}))).toEqual(["A"]);
    expect(await marks(s, q("B", {}))).toEqual(["B"]);
    // B goes before A: an up move.
    expect(await marks(s, q("B", { position: 0 }))).toEqual(["B"]);
    // B goes after A again: a down move.
    expect(await marks(s, q("B", { position: 1 }))).toEqual(["A", "B", "C"]);
    expect(await marks(s, q("A", { position: null }))).toEqual(["A", "B", "C"]);
    // The same place: nothing goes down.
    expect(await marks(s, q("B", { position: 0 }))).toEqual(["B"]);
  });

  it("level: the priorities board and the edit form mark the same tasks", async () => {
    const s = setup();
    const ids = await tasks(s, { A: 2, B: 3, C: 4 });
    const board = (t: string, level: number) => () =>
      s.post("/api/priorities", { kind: "task", id: ids[t], level });
    const form = (t: string, level: number) => () => s.patch(`/api/tasks/${ids[t]}`, { level });
    // Up: only the moved task.
    expect(await marks(s, board("C", 1))).toEqual(["C"]);
    expect(await marks(s, form("B", 1))).toEqual(["B"]);
    // Down: every open task.
    expect(await marks(s, board("C", 4))).toEqual(["A", "B", "C"]);
    expect(await marks(s, form("B", 4))).toEqual(["A", "B", "C"]);
    // An edit without a level change marks only the edited task.
    expect(await marks(s, () => s.patch(`/api/tasks/${ids.A}`, { title: "A" }))).toEqual(["A"]);
  });

  it("habit: the priorities board moves a habit like the automation list does (PRI-54)", async () => {
    const s = setup();
    const habit = async (title: string, level: number) =>
      (
        (
          await s.post("/api/habits", {
            title,
            idealTime: "10:00",
            minMinutes: 30,
            maxMinutes: 30,
            level,
          })
        ).body.habit as { id: string }
      ).id;
    const one1 = await habit("One", 1);
    const two = await habit("Two", 3);
    const state = () =>
      all(s.db, "SELECT title, level, rank, rules_changed_at FROM habits ORDER BY title");
    s.clock.t += 60_000;
    await s.post("/api/automations/order", {
      level: 1,
      items: [
        { type: "habit", id: one1 },
        { type: "habit", id: two },
      ],
    });
    const byList = state();
    run(s.db, "UPDATE habits SET level = 3, rank = 0 WHERE id = ?", two);
    s.clock.t += 60_000;
    expect((await s.post("/api/priorities", { kind: "habit", id: two, level: 1 })).status).toBe(
      200,
    );
    expect(state()).toEqual(byList);
  });
});

describe("POST /api/timer/log with markDone (NXT-11)", () => {
  it("takes the task out of the next-up queue, so add time does not bring it back queued", async () => {
    const s = setup();
    run(
      s.db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
       VALUES ('acc', ?, 'caldav', 'owner', 'owner@example.com', '', ?)`,
      s.user.id,
      T0,
    );
    run(
      s.db,
      "INSERT INTO calendars (id, account_id, provider_id, name, is_primary, writable) VALUES ('cal', 'acc', 'cal', 'Work', 1, 1)",
    );
    const ids = await tasks(s, { A: 2, B: 2 });
    await s.post(`/api/tasks/${ids.A}/queue`, {});
    await s.post(`/api/tasks/${ids.B}/queue`, {});
    expect((await s.post("/api/timer", { kind: "task", itemId: ids.A })).status).toBe(201);
    s.clock.t += 30 * 60_000;
    const log = await s.post("/api/timer/log", { minutes: 30, calendarId: "cal", markDone: true });
    expect(log.status).toBe(200);
    expect(ranks(s.db)).toEqual({ A: null, B: 1 });
    await s.post(`/api/tasks/${ids.A}/add-time`, { minutes: 30 });
    expect(one(s.db, "SELECT status, next_up_rank FROM tasks WHERE id = ?", ids.A ?? "")).toEqual({
      status: "open",
      next_up_rank: null,
    });
  });
});
