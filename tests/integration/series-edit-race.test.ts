// The organizer's "all events" edit of a meeting series while a sync job
// runs, on a real Radicale server (meetings-flexible-rescheduling.md rule 22).
// Run as caldav.test.ts.
//
// Ways it can fail:
// 1. A job that read the calendar before the edit plans and writes after it,
//    and its writes undo the edit.
// 2. The organizer edits the series while Tempoloom's first write of it runs
//    (the new series is on the calendar, its rows are not yet saved): the
//    write reads the edited instances back and moves them to the old plan,
//    and keeps the old master as the baseline, so the edit is never read.
// Each time, the next jobs must read the edit and keep it.
import { randomUUID } from "node:crypto";
import { DAVClient } from "tsdav";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { all, one, openDb, run } from "../../src/server/db.ts";
import { observeMeetings } from "../../src/server/planner/meeting-log.ts";
import { replanUser } from "../../src/server/planner/replan.ts";
import { readSeriesEdits } from "../../src/server/planner/series-edits.ts";
import { CalDavProvider } from "../../src/server/providers/caldav.ts";
import type { CalendarProvider } from "../../src/server/providers/types.ts";
import { applyCalendarEdits } from "../../src/server/sync/edits.ts";
import { pullEvents } from "../../src/server/sync/pull.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../src/shared/time.ts";

const url = process.env.CALDAV_URL;
const username = process.env.CALDAV_USERNAME ?? "e2e";
const password = process.env.CALDAV_PASSWORD ?? "";
if (!url) throw new Error("CALDAV_URL is not set; start scripts/caldav-server.sh first");
const ZONE = "Europe/Berlin";
const EMAIL = "e2e@tempoloom.test";
const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

let raw: DAVClient;
beforeAll(async () => {
  raw = new DAVClient({
    serverUrl: url,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await raw.login();
});

/** A new calendar for each test: series of other tests never share it. */
async function newCalendar(): Promise<string> {
  const home = raw.account?.homeUrl;
  if (!home) throw new Error("no calendar home");
  const calendarUrl = new URL(`it-${randomUUID()}/`, home).toString();
  await raw.makeCalendar({ url: calendarUrl, props: { displayname: "Series race" } });
  return calendarUrl;
}

const local = (t: number) => {
  const l = utcToLocal(ZONE, t);
  return `${l.date} ${String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0")}:${String(l.minuteOfDay % 60).padStart(2, "0")}`;
};

/** The first Monday at least 2 days ahead, as the E2E test week. */
function testWeek(now: number): string {
  let d = addDays(utcToLocal(ZONE, now).date, 2);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

async function setup(now: () => number) {
  const calendarUrl = await newCalendar();
  const db = openDb(":memory:");
  const user = ensureUser(db, EMAIL, "Owner", now());
  run(
    db,
    "UPDATE users SET time_zone = ?, first_sign_in_at = ? WHERE id = ?",
    ZONE,
    now(),
    user.id,
  );
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', ?, '', 'ok', ?, 1)`,
    user.id,
    EMAIL,
    now(),
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', ?, 'Work', 1, 1, 1)`,
    calendarUrl,
  );
  const title = `Review ${randomUUID().slice(0, 6)}`;
  run(
    db,
    `INSERT INTO meetings (id, user_id, title, level, rank, frequency, ideal_minute, duration_minutes,
       shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at,
       rules_changed_at, series_owned, lead_minutes)
     VALUES ('m1', ?, ?, 2, 0, ?, 600, 30, 30, 'organizer',
       (SELECT id FROM hours_sets WHERE user_id = ? AND kind = 'meeting' LIMIT 1), 'busy',
       'keep_as_conflict', ?, ?, 1, 0)`,
    user.id,
    title,
    JSON.stringify({ period: "weekly", everyWeeks: 1, idealDays: [2] }),
    user.id,
    now(),
    now(),
  );
  run(
    db,
    "INSERT INTO meeting_attendees (meeting_id, email, required) VALUES ('m1', 'dana@example.com', 1)",
  );
  const dav = new CalDavProvider(
    { serverUrl: url as string, username, password, email: EMAIL },
    ZONE,
  );
  /** Runs once, right after the next series is written and before it is read back. */
  const hook: {
    afterInsert?: ((seriesId: string) => Promise<void>) | undefined;
    /** Runs once, after the first read of a series' instances. */
    afterRead?: ((seriesId: string) => Promise<void>) | undefined;
  } = {};
  const p: CalendarProvider = new Proxy(dav, {
    get(target, name, receiver) {
      const v = Reflect.get(target, name, receiver);
      if (typeof v !== "function") return v;
      if (name === "insertEvent")
        return async (...args: Parameters<CalendarProvider["insertEvent"]>) => {
          const ev = await target.insertEvent(...args);
          const run = hook.afterInsert;
          if (run && args[1].recurrence) {
            hook.afterInsert = undefined;
            await run(ev.recurringId ?? ev.id);
          }
          return ev;
        };
      if (name === "seriesInstances")
        return async (...args: Parameters<NonNullable<CalendarProvider["seriesInstances"]>>) => {
          const list = await target.seriesInstances(...args);
          const run = hook.afterRead;
          if (run) {
            hook.afterRead = undefined;
            await run(args[1]);
          }
          return list;
        };
      return v.bind(target);
    },
  });
  const read = () => pullEvents(db, p, "cal", now());
  const rest = async () => {
    readSeriesEdits(db, user.id, ["cal"], now());
    observeMeetings(db, user.id, ["cal"], now());
    applyCalendarEdits(db, user.id, ["cal"], ZONE, now());
    await replanUser({ db, provider: () => p, now: now(), baseUrl: "http://localhost" }, user.id);
  };
  /** One sync job: pull, then the series edits, the edits, and the plan run with its push. */
  const job = async (between?: () => Promise<void>) => {
    await read();
    if (between) await between();
    await rest();
  };
  const series = () =>
    one<{ id: string }>(db, "SELECT series_event_id AS id FROM meetings WHERE id = 'm1'")?.id ?? "";
  const occurrences = async (from: number, to: number) =>
    (await p.listEvents(calendarUrl, { syncToken: null, timeMin: from, timeMax: to })).events
      .filter((e) => e.summary.includes(title))
      .map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)
      .sort();
  return { db, userId: user.id, title, job, series, occurrences, hook };
}

/** The organizer's "all events" edit in another app: Thursday 14:00 from `thursday` on, and a new title. */
async function moveSeries(id: string, thursday: string) {
  const res = await fetch(id, { headers: { authorization: auth } });
  const etag = res.headers.get("etag");
  const text = (await res.text()).replace(/\r?\n[ \t]/g, "");
  const date = thursday.replace(/-/g, "");
  let inMaster = false;
  const lines = text.split(/\r?\n/).map((l) => {
    if (l === "BEGIN:VEVENT") inMaster = true;
    if (l.startsWith("RECURRENCE-ID")) inMaster = false;
    if (l === "END:VEVENT") inMaster = false;
    return l;
  });
  // The master is the VEVENT without a RECURRENCE-ID.
  const blocks = text.split(/(?=BEGIN:VEVENT)/);
  const out = blocks
    .map((b) => {
      if (!b.startsWith("BEGIN:VEVENT") || /^RECURRENCE-ID/m.test(b)) return b;
      return b
        .replace(/^(DTSTART[^:\r\n]*):\d{8}T\d{6}/m, `$1:${date}T140000`)
        .replace(/^(DTEND[^:\r\n]*):\d{8}T\d{6}/m, `$1:${date}T143000`)
        .replace(/BYDAY=TU/, "BYDAY=TH")
        .replace(/^(SUMMARY:.*)$/m, "$1 board");
    })
    .join("");
  void lines;
  void inMaster;
  const put = await fetch(id, {
    method: "PUT",
    headers: {
      authorization: auth,
      "content-type": "text/calendar",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: out,
  });
  expect(put.ok).toBe(true);
}

/**
 * The organizer's "this and following" resize in another app, from `tuesday`:
 * the series ends before it (UNTIL), and a new series of 45 minutes starts there.
 */
async function splitSeries(id: string, tuesday: string): Promise<string> {
  const res = await fetch(id, { headers: { authorization: auth } });
  const etag = res.headers.get("etag");
  const text = (await res.text()).replace(/\r?\n[ \t]/g, "").replace(/\r\n/g, "\n");
  const date = tuesday.replace(/-/g, "");
  const until = new Date(localToUtc(ZONE, tuesday, 600) - 1000)
    .toISOString()
    .replace(/[-:]|\.\d{3}/g, "");
  const parts = text.split(/(?=BEGIN:VEVENT)|(?<=END:VEVENT\n)/);
  const master =
    parts.find((b) => b.startsWith("BEGIN:VEVENT") && !/^RECURRENCE-ID/m.test(b)) ?? "";
  // The old series keeps the instances before the split; later overrides go.
  const old = parts
    .filter((b) => {
      const rid = /^RECURRENCE-ID[^:\r\n]*:(\d{8}T\d{6})/m.exec(b)?.[1];
      return !rid || rid < `${date}T100000`;
    })
    .map((b) =>
      b === master ? b.replace(/^RRULE:(.*)$/m, (_l, r: string) => `RRULE:${r};UNTIL=${until}`) : b,
    )
    .join("");
  const put = await fetch(id, {
    method: "PUT",
    headers: {
      authorization: auth,
      "content-type": "text/calendar",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: old.replace(/\n/g, "\r\n"),
  });
  expect(put.ok).toBe(true);
  const uid = randomUUID();
  const zones = /BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\n/.exec(text)?.[0] ?? "";
  const next = master
    .replace(/^UID:.*$/m, `UID:${uid}`)
    .replace(/^(DTSTART[^:\r\n]*):\d{8}T\d{6}/m, `$1:${date}T100000`)
    .replace(/^(DTEND[^:\r\n]*):\d{8}T\d{6}/m, `$1:${date}T104500`)
    .replace(/^(EXDATE|RDATE).*\n/gm, "");
  const url2 = new URL(`${uid}.ics`, id).toString();
  const created = await fetch(url2, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "text/calendar" },
    body: `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n${zones}${next}END:VCALENDAR\n`.replace(
      /\n/g,
      "\r\n",
    ),
  });
  expect(created.ok).toBe(true);
  return url2;
}

describe("an all-events edit of a meeting series during a sync job", () => {
  it("a job that read the calendar before the edit does not undo it; the next jobs keep every occurrence on the new day and time", async () => {
    const now = () => Date.now();
    const s = await setup(now);
    const W = testWeek(now());
    await s.job();
    await s.job();
    const from = localToUtc(ZONE, W, 0);
    const to = localToUtc(ZONE, addDays(W, 14), 0);
    expect(await s.occurrences(from, to)).toEqual([
      `${addDays(W, 1)} 10:00-10:30`,
      `${addDays(W, 8)} 10:00-10:30`,
    ]);
    // A job reads the calendar; the organizer edits the series; the job plans and writes.
    await s.job(() => moveSeries(s.series(), addDays(W, 3)));
    for (let i = 0; i < 3; i++) await s.job();
    expect(await s.occurrences(from, to)).toEqual([
      `${addDays(W, 3)} 14:00-14:30`,
      `${addDays(W, 10)} 14:00-14:30`,
    ]);
    expect(
      all<{ key: string; locked: number }>(
        s.db,
        "SELECT key, locked FROM managed_events WHERE kind = 'meeting' AND locked = 1",
      ),
    ).toEqual([]);
  });

  it("a this-and-following resize during Tempoloom's first write of the series gives no second event in a period", async () => {
    const now = () => Date.now();
    const s = await setup(now);
    const W = testWeek(now());
    s.hook.afterInsert = async (id) => {
      await splitSeries(id, addDays(W, 8));
    };
    await s.job();
    for (let i = 0; i < 3; i++) await s.job();
    const from = localToUtc(ZONE, W, 0);
    const to = localToUtc(ZONE, addDays(W, 14), 0);
    expect(await s.occurrences(from, to)).toEqual([
      `${addDays(W, 1)} 10:00-10:30`,
      `${addDays(W, 8)} 10:00-10:45`,
    ]);
  });

  it.each(["afterInsert", "afterRead"] as const)(
    "an all-events edit at %s of Tempoloom's first series write moves every occurrence to the new time, and nothing locks",
    async (when) => {
      const now = () => Date.now();
      const s = await setup(now);
      const W = testWeek(now());
      s.hook[when] = (id) => moveSeries(id, addDays(W, 3));
      await s.job();
      for (let i = 0; i < 3; i++) await s.job();
      const from = localToUtc(ZONE, W, 0);
      const to = localToUtc(ZONE, addDays(W, 14), 0);
      expect(await s.occurrences(from, to)).toEqual([
        `${addDays(W, 3)} 14:00-14:30`,
        `${addDays(W, 10)} 14:00-14:30`,
      ]);
      expect(
        all(s.db, "SELECT key FROM managed_events WHERE kind = 'meeting' AND locked = 1"),
      ).toEqual([]);
    },
  );
});
