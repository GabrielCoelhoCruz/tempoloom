// A task made on the planner (planning-tasks.md TSK-7) while a plan runs.
// POST /api/tasks/at saves the task, then waits for the user's sync queue to
// write its locked chunk. A plan that runs first places a chunk of the new
// task under the key task:<id>:0.
//
// Ways it can fail:
// 1. The route picks the chunk key before it has the queue, so it inserts the
//    key the plan took: "UNIQUE constraint failed: managed_events.user_id,
//    managed_events.key", and the request ends with 500.
// 2. Work blocks on request (NXT-50) do the same.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { taskTimeRoutes } from "../../src/server/api/task-time.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-10-19T08:00:00Z");

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
  let n = 0;
  const pool = {
    get: () => ({
      insertEvent: async (_cal: string, e: Partial<ProviderEvent>): Promise<ProviderEvent> => ({
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
      }),
    }),
  };
  /** A plan run that has the queue first: it places one unlocked chunk of each open task with none. */
  const planFirst = () => {
    for (const t of all<{ id: string }>(
      db,
      `SELECT id FROM tasks t WHERE status = 'open'
         AND NOT EXISTS (SELECT 1 FROM managed_events m WHERE m.kind = 'task' AND m.source_id = t.id)`,
    ))
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title)
         VALUES (?, ?, 'cal', ?, ?, 'task', ?, ?, ?, 1, 'planned')`,
        `plan-${t.id}`,
        user.id,
        `plan-ev-${t.id}`,
        `task:${t.id}:0`,
        t.id,
        T0 + 2 * HOUR,
        T0 + 3 * HOUR,
      );
  };
  const sync = {
    request: () => {},
    exclusive: async (_userId: string, fn: (p: typeof pool) => Promise<unknown>) => {
      planFirst();
      return fn(pool);
    },
  } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    taskTimeRoutes(db, sync, "http://localhost", () => T0),
  );
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { db, post };
}

const locked = (db: ReturnType<typeof openDb>) =>
  all<{ key: string; locked: number; start_ms: number }>(
    db,
    "SELECT key, locked, start_ms FROM managed_events WHERE locked = 1 ORDER BY key",
  );

describe("a locked chunk written while a plan runs", () => {
  it("POST /api/tasks/at takes the next free key", async () => {
    const { db, post } = setup();
    const res = await post("/api/tasks/at", {
      title: "Drag",
      start: T0 + 24 * HOUR,
      end: T0 + 25 * HOUR,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const { task } = (await res.json()) as { task: { id: string } };
    expect(locked(db)).toEqual([{ key: `task:${task.id}:1`, locked: 1, start_ms: T0 + 24 * HOUR }]);
  });

  it("POST /api/tasks/:id/blocks takes the next free keys", async () => {
    const { db, post } = setup();
    run(
      db,
      `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
         start_after, hours_set_id, created_at, rules_changed_at)
       SELECT 't1', user_id, 'Blocks', 2, 180, 60, 60, ?, id, ?, ? FROM hours_sets WHERE kind = 'work'`,
      T0,
      T0,
      T0,
    );
    const task = { id: "t1" };
    const res = await post(`/api/tasks/${task.id}/blocks`, {
      blocks: [
        { start: T0 + 4 * HOUR, end: T0 + 5 * HOUR },
        { start: T0 + 6 * HOUR, end: T0 + 7 * HOUR },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(locked(db).map((r) => r.key)).toEqual([`task:${task.id}:1`, `task:${task.id}:2`]);
  });
});
