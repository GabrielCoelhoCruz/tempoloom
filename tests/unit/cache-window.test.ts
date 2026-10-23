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
// 3. The fix ignores a cancellation that the provider reports for an old event
//    that is still inside the window.
// 4. Known limit, pinned so that a change is a visible decision: a cancel for
//    an event that ended before the window start is not applied (its row stays).
// 5. The edit pass and the pull use different window rules, so an event at a
//    window edge that the read skipped counts as deleted, or the reverse.
// 6. The one-query edit pass finds other edits than the per-row pass did for
//    rows inside, at and outside the window.
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

  it("deletes an old chunk inside the window when the provider reports it cancelled", async () => {
    // A fresh window: the read is incremental, and the delta cancels the old chunk.
    const { done, keys, store, sync } = setup(T0 + 120 * DAY);
    const old = store.find((e) => e.id === "ev-old") as ProviderEvent;
    const summary = await sync(fakeProvider(store, [{ ...old, cancelled: true }]));
    expect(summary.deleted).toBe(1);
    expect(keys()).toEqual(["t:log-old", "t:next", "t:recent"]);
    expect(done()).toBe(120);
  });
  it("keeps a chunk older than the window when the provider reports it cancelled (known limit)", async () => {
    const { db, done, keys, store, sync } = setup(T0 + 120 * DAY);
    // The window start moves past the old chunk: it ended before window_start.
    run(db, "UPDATE calendars SET window_start = ?", T0 - 99 * DAY);
    const old = store.find((e) => e.id === "ev-old") as ProviderEvent;
    const summary = await sync(fakeProvider(store, [{ ...old, cancelled: true }]));
    expect(summary.deleted).toBe(0);
    expect(keys()).toEqual(["t:log-old", "t:next", "t:old", "t:recent"]);
    expect(done()).toBe(180);
  });
});

/** Calls listEvents through a full read; records the window the pull asked for. */
function recordingProvider(store: ProviderEvent[]) {
  const asked: { timeMin: number; timeMax: number }[] = [];
  const provider = {
    listEvents: async (
      _id: string,
      o: { syncToken: string | null; timeMin: number; timeMax: number },
    ): Promise<EventChanges> => {
      asked.push({ timeMin: o.timeMin, timeMax: o.timeMax });
      // CalDAV time-range and Google timeMin/timeMax: an event that overlaps the range.
      return {
        events: store.filter((e) => e.end > o.timeMin && e.start < o.timeMax),
        nextSyncToken: "t1",
        full: true,
      };
    },
  } as unknown as CalendarProvider;
  return { provider, asked };
}

describe("the read window of the pull and of the edit pass", () => {
  const MIN = 60_000;

  function calendarWith(window: [number, number] | null) {
    const db = openDb(":memory:");
    const user = ensureUser(db, "owner@example.com", "Owner", T0 - 400 * DAY);
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
       VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 1)`,
      user.id,
      T0,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable,
         sync_token, window_start, window_end)
       VALUES ('cal', 'acc', 'cal', 'Work', 1, 1, 1, NULL, ?, ?)`,
      window?.[0] ?? null,
      window?.[1] ?? null,
    );
    const row = (
      key: string,
      kind: string,
      start: number,
      end: number,
      cached?: [number, number],
    ) => {
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id,
           start_ms, end_ms, busy, title, etag) VALUES (?, ?, 'cal', ?, ?, ?, ?, ?, ?, 1, ?, '"e"')`,
        `m-${key}`,
        user.id,
        `ev-${key}`,
        key,
        kind,
        `src-${key}`,
        start,
        end,
        key,
      );
      if (cached)
        run(
          db,
          `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, etag)
           VALUES ('cal', ?, ?, ?, ?, 1, '"e2"')`,
          `ev-${key}`,
          key,
          cached[0],
          cached[1],
        );
    };
    const state = () =>
      all<{ key: string; locked: number; start_ms: number }>(
        db,
        "SELECT key, locked, start_ms FROM managed_events ORDER BY key",
      );
    return { db, userId: user.id, row, state };
  }

  it("finds the same edits for rows inside, at and outside the window", () => {
    const ws = T0 - 84 * DAY;
    const we = T0 + 120 * DAY;
    const { db, userId, row, state } = calendarWith([ws, we]);
    // Missing from the cache:
    row("gone-in", "focus", T0 + DAY, T0 + DAY + HOUR); // deleted
    row("gone-past-in", "task", T0 - 10 * DAY, T0 - 10 * DAY + HOUR); // deleted
    row("gone-ends-at-start", "task", ws - HOUR, ws); // not read: kept
    row("gone-ends-after-start", "task", ws - HOUR, ws + MIN); // deleted
    row("gone-starts-at-start", "task", ws, ws + HOUR); // deleted
    row("gone-before", "task", ws - 10 * DAY, ws - 10 * DAY + HOUR); // kept
    row("gone-starts-before-end", "focus", we - MIN, we + HOUR); // deleted
    row("gone-starts-at-end", "focus", we, we + HOUR); // not read: kept
    row("gone-after", "focus", we + DAY, we + DAY + HOUR); // kept
    row("gone-mirror-in", "mirror", T0 + DAY, T0 + DAY + HOUR); // deleted
    row("gone-mirror-before", "mirror", ws - DAY, ws - DAY + HOUR); // kept
    // In the cache, moved by the user: the cache wins wherever the row is.
    const moved = (s: number): [number, number] => [s + HOUR, s + 2 * HOUR];
    row("moved-in", "focus", T0 + DAY, T0 + DAY + HOUR, moved(T0 + DAY));
    row("moved-at-start", "focus", ws - HOUR, ws, moved(ws - HOUR));
    row("moved-before", "focus", ws - DAY, ws - DAY + HOUR, moved(ws - DAY));
    row("moved-after", "focus", we, we + HOUR, moved(we));
    row("same-in", "focus", T0 + 3 * DAY, T0 + 3 * DAY + HOUR, [T0 + 3 * DAY, T0 + 3 * DAY + HOUR]);
    const summary = applyCalendarEdits(db, userId, ["cal"], "UTC", T0);
    expect(summary).toEqual({ moved: 4, deleted: 5, locked: 4 }); // a mirror row is not counted
    expect(state()).toEqual([
      { key: "gone-after", locked: 0, start_ms: we + DAY },
      { key: "gone-before", locked: 0, start_ms: ws - 10 * DAY },
      { key: "gone-ends-at-start", locked: 0, start_ms: ws - HOUR },
      { key: "gone-mirror-before", locked: 0, start_ms: ws - DAY },
      { key: "gone-starts-at-end", locked: 0, start_ms: we },
      { key: "moved-after", locked: 1, start_ms: we + HOUR },
      { key: "moved-at-start", locked: 1, start_ms: ws },
      { key: "moved-before", locked: 1, start_ms: ws - DAY + HOUR },
      { key: "moved-in", locked: 1, start_ms: T0 + DAY + HOUR },
      { key: "same-in", locked: 0, start_ms: T0 + 3 * DAY },
    ]);
  });

  it("reads a calendar without a window (never pulled) as all read", () => {
    const { db, userId, row, state } = calendarWith(null);
    row("gone-old", "focus", T0 - 400 * DAY, T0 - 400 * DAY + HOUR);
    const summary = applyCalendarEdits(db, userId, ["cal"], "UTC", T0);
    expect(summary.deleted).toBe(1);
    expect(state()).toEqual([]);
  });

  it("counts as deleted exactly the missing events that the pull's read covered", async () => {
    // The pull sets the window; the edit pass must use the same edges, with the
    // overlap rule of the providers' time range.
    const { db, userId, row } = calendarWith(null);
    const probe = recordingProvider([]);
    await pullEvents(db, probe.provider, "cal", T0);
    const { timeMin: ws, timeMax: we } = probe.asked[0] as { timeMin: number; timeMax: number };
    const spans: [string, number, number][] = [
      ["a-ends-at-start", ws - HOUR, ws],
      ["b-ends-after-start", ws - HOUR, ws + 1],
      ["c-starts-at-start", ws, ws + HOUR],
      ["d-ends-at-end", we - HOUR, we],
      ["e-crosses-end", we - 1, we + HOUR],
      ["f-starts-at-end", we, we + HOUR],
      ["g-before", ws - DAY, ws - DAY + HOUR],
      ["h-after", we + DAY, we + DAY + HOUR],
    ];
    for (const [key, s, e] of spans) row(key, "focus", s, e);
    // The user deleted every event: the read finds none of them.
    const { provider, asked } = recordingProvider([]);
    run(db, "UPDATE calendars SET window_end = 0");
    await pullEvents(db, provider, "cal", T0);
    expect(asked).toEqual(probe.asked);
    applyCalendarEdits(db, userId, ["cal"], "UTC", T0);
    const kept = all<{ key: string }>(db, "SELECT key FROM managed_events ORDER BY key").map(
      (r) => r.key,
    );
    const read = spans.filter(([, s, e]) => e > ws && s < we).map(([k]) => k);
    expect(read).toEqual([
      "b-ends-after-start",
      "c-starts-at-start",
      "d-ends-at-end",
      "e-crosses-end",
    ]);
    expect(kept).toEqual(spans.map(([k]) => k).filter((k) => !read.includes(k)));
  });
});
