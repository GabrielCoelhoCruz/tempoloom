// A managed event that is missing from the event cache only because it lies
// outside the read window is not a deleted event (planning-calendar-edits.md
// CED-20 applies to events the user deleted). The cache keeps 84 days of the
// past; a full read drops older events, and their managed rows must stay, so
// that done work and logged work of past chunks still count.
//
// Ways it can fail:
// 1. A full read drops a chunk older than the window, the row is deleted, and
//    the task's done minutes go down, so the scheduler places the work again.
// 2. The fix keeps every missing row, so a real delete inside the window is lost.
// 3. The fix ignores a cancellation that the provider reports for an old event.
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import type {
  CalendarProvider,
  EventChanges,
  ProviderEvent,
} from "../../src/server/providers/types.ts";
import { applyCalendarEdits } from "../../src/server/sync/edits.ts";
import { pullEvents } from "../../src/server/sync/pull.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function event(id: string, start: number, end: number): ProviderEvent {
  return {
    id,
    cancelled: false,
    etag: `"${id}"`,
    summary: "Report",
    description: "",
    location: "",
    start,
    end,
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
    privateProps: { tl: "1" },
    visibility: "default",
  };
}

/** A calendar that answers a full read with the events that overlap the window. */
function fakeProvider(store: ProviderEvent[], delta?: ProviderEvent[]): CalendarProvider {
  return {
    listEvents: async (
      _id: string,
      o: { syncToken: string | null; timeMin: number; timeMax: number },
    ): Promise<EventChanges> =>
      o.syncToken && delta
        ? { events: delta, nextSyncToken: "t2", full: false }
        : {
            events: store.filter((e) => e.end > o.timeMin && e.start < o.timeMax),
            nextSyncToken: "t1",
            full: true,
          },
  } as unknown as CalendarProvider;
}

function setup(windowEnd: number) {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0 - 200 * DAY);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
    user.id,
    T0,
  );
  // The window of the last full read, 30 days ago.
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable,
       sync_token, window_start, window_end)
     VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1, 't0', ?, ?)`,
    T0 - 114 * DAY,
    windowEnd,
  );
  const hours = one<{ id: string }>(
    db,
    "SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'work'",
    user.id,
  )?.id;
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, hours_set_id, created_at, rules_changed_at)
     VALUES ('t', ?, 'Report', 2, 600, 60, 120, ?, ?, ?, ?)`,
    user.id,
    T0 - 200 * DAY,
    hours as string,
    T0 - 200 * DAY,
    T0 - 200 * DAY,
  );
  const chunks: [string, number][] = [
    ["old", T0 - 100 * DAY], // ended before the new window: aged out
    ["log-old", T0 - 95 * DAY], // logged work, also aged out
    ["recent", T0 - 10 * DAY], // inside the window
    ["next", T0 + 2 * DAY], // a future chunk
  ];
  const store: ProviderEvent[] = [];
  for (const [key, start] of chunks) {
    const e = event(`ev-${key}`, start, start + HOUR);
    store.push(e);
    run(
      db,
      `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
         start_ms, end_ms, busy, title, etag) VALUES (?, ?, 'cal', ?, ?, 'task', 't', ?, ?, 1, 'Report', ?)`,
      `m-${key}`,
      user.id,
      e.id,
      `t:${key}`,
      e.start,
      e.end,
      e.etag,
    );
    run(
      db,
      `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, etag, private_props)
       VALUES ('cal', ?, 'Report', ?, ?, 1, ?, '{"tl":"1"}')`,
      e.id,
      e.start,
      e.end,
      e.etag,
    );
  }
  const done = () =>
    all<{ start_ms: number; end_ms: number }>(
      db,
      "SELECT start_ms, end_ms FROM managed_events WHERE kind = 'task' AND source_id = 't' AND end_ms <= ?",
      T0,
    ).reduce((a, r) => a + (r.end_ms - r.start_ms) / 60_000, 0);
  const keys = () =>
    all<{ key: string }>(db, "SELECT key FROM managed_events ORDER BY key").map((r) => r.key);
  const sync = async (provider: CalendarProvider) => {
    await pullEvents(db, provider, "cal", T0);
    return applyCalendarEdits(db, user.id, ["cal"], "UTC", T0);
  };
  return { db, user, store, done, keys, sync };
}

describe("a full read that moves the event window", () => {
  it("keeps the managed rows and done minutes of chunks older than the window", async () => {
    // The window is stale (less than 90 days ahead), so the next read is full.
    const { done, keys, store, sync } = setup(T0 + 60 * DAY);
    expect(done()).toBe(180);
    const summary = await sync(fakeProvider(store));
    expect(summary.deleted).toBe(0);
    expect(keys()).toEqual(["t:log-old", "t:next", "t:old", "t:recent"]);
    expect(done()).toBe(180);
  });

  it("still deletes a chunk that the user deleted inside the window", async () => {
    const { db, done, keys, store, sync } = setup(T0 + 60 * DAY);
    const kept = store.filter((e) => e.id !== "ev-recent" && e.id !== "ev-next");
    const summary = await sync(fakeProvider(kept));
    expect(summary.deleted).toBe(2);
    expect(keys()).toEqual(["t:log-old", "t:old"]);
    expect(done()).toBe(120);
    // The deleted future chunk still leaves its exclusion (CED-20).
    expect(all(db, "SELECT kind, item_id FROM item_exclusions")).toEqual([
      { kind: "task", item_id: "t" },
    ]);
  });

  it("deletes an old chunk when the provider reports it cancelled", async () => {
    // A fresh window: the read is incremental, and the delta cancels the old chunk.
    const { done, keys, store, sync } = setup(T0 + 120 * DAY);
    const old = store.find((e) => e.id === "ev-old") as ProviderEvent;
    const summary = await sync(fakeProvider(store, [{ ...old, cancelled: true }]));
    expect(summary.deleted).toBe(1);
    expect(keys()).toEqual(["t:log-old", "t:next", "t:recent"]);
    expect(done()).toBe(120);
  });
});
