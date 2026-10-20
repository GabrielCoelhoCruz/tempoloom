// Logged work is started work (planning-task-progress.md PRG-3, PRG-20, PRG-22).
// In manual start mode only a started event counts as done work; an ended,
// unstarted event goes back to the plan and the push step can move it.
//
// Ways it can fail:
// 1. A route that records past work (an AI tool's work session, the timer)
//    writes started = 0: the minutes do not count and the planner may move the
//    past record to a future slot.
// 2. Planned future work (blocks) counts as started.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { taskTimeRoutes } from "../../src/server/api/task-time.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { endedUnstarted, taskDoneMinutes } from "../../src/server/planner/progress.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { getSettings, updateSettings } from "../../src/server/settings.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse("2026-10-19T08:00:00Z");
const NOW = T0 + 6 * HOUR;

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
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
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, hours_set_id, created_at, rules_changed_at)
     SELECT 't1', user_id, 'Report', 2, 300, 60, 60, ?, id, ?, ? FROM hours_sets WHERE kind = 'work'`,
    T0,
    T0,
    T0,
  );
  // Manual start mode from before the logged work.
  updateSettings(db, user.id, { startMode: "manual", manualSince: T0 });
  let n = 0;
  const pool = {
    get: () => ({
      insertEvent: async (_cal: string, e: Partial<ProviderEvent>): Promise<ProviderEvent> =>
        ({
          id: `ev-${n++}`,
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
        }) as ProviderEvent,
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
  let clock = T0;
  app.route(
    "/api",
    taskTimeRoutes(db, sync, "http://localhost", () => clock),
  );
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const rows = () =>
    all<{
      kind: string;
      source_id: string;
      key: string;
      start_ms: number;
      end_ms: number;
      event_id: string | null;
      started: number;
    }>(db, "SELECT kind, source_id, key, start_ms, end_ms, event_id, started FROM managed_events");
  return { db, user, post, rows, setClock: (t: number) => (clock = t) };
}

describe("logged work in manual start mode", () => {
  it("an AI tool's work session (POST /tasks/:id/sessions) is started and counts as done work", async () => {
    const { db, user, post, rows, setClock } = setup();
    setClock(NOW);
    const res = await post("/api/tasks/t1/sessions", { start: NOW - 2 * HOUR, minutes: 90 });
    expect(res.status, await res.clone().text()).toBe(201);
    const [row] = rows();
    expect(row?.started).toBe(1);
    expect(endedUnstarted(row as never, NOW, getSettings(db, user.id))).toBe(false);
    expect(taskDoneMinutes(db, user.id, NOW).get("t1")).toBe(90);
  });

  it("a timer log is started and counts as done work", async () => {
    const { db, user, post, rows, setClock } = setup();
    setClock(NOW - HOUR);
    expect((await post("/api/timer", { kind: "task", itemId: "t1" })).status).toBe(201);
    setClock(NOW);
    const res = await post("/api/timer/log", { minutes: 45, calendarId: "cal" });
    expect(res.ok, await res.clone().text()).toBe(true);
    expect(rows()[0]?.started).toBe(1);
    expect(taskDoneMinutes(db, user.id, NOW + MIN).get("t1")).toBe(45);
  });

  it("work blocks are planned work, not started", async () => {
    const { post, rows, setClock } = setup();
    setClock(NOW);
    const res = await post("/api/tasks/t1/blocks", {
      blocks: [{ start: NOW + HOUR, end: NOW + 2 * HOUR }],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(rows()[0]?.started).toBe(0);
  });
});
