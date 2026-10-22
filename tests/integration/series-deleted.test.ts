// A meeting series that the organizer deleted in another calendar app, on a
// real Radicale server (docs/specs/meetings-flexible.md rule 2;
// meetings-flexible-rescheduling.md edge case 5). Run as caldav.test.ts.
//
// Ways it can fail:
// 1. The CalDAV client gives a plain error for the missing object, so a
//    "not found" is never seen: the plan run stops, and the meeting cannot be
//    turned off or deleted.
// 2. The run that finds the deleted series writes its occurrences as single
//    events, so the guests get invitations to a meeting that is gone.
import { randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { Hono } from "hono";
import { DAVClient } from "tsdav";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { type DesiredEvent, pushSchedule } from "../../src/server/planner/push.ts";
import { CalDavProvider } from "../../src/server/providers/caldav.ts";
import { ProviderError } from "../../src/server/providers/types.ts";
import { pullEvents } from "../../src/server/sync/pull.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../src/shared/time.ts";

const url = process.env.CALDAV_URL;
const username = process.env.CALDAV_USERNAME ?? "e2e";
const password = process.env.CALDAV_PASSWORD ?? "";
if (!url) throw new Error("CALDAV_URL is not set; start scripts/caldav-server.sh first");
const ZONE = "Europe/Berlin";
const EMAIL = "e2e@tempoloom.test";
const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

let calendarUrl = "";

beforeAll(async () => {
  const raw = new DAVClient({
    serverUrl: url,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await raw.login();
  const home = raw.account?.homeUrl;
  if (!home) throw new Error("no calendar home");
  calendarUrl = new URL(`it-${randomUUID()}/`, home).toString();
  await raw.makeCalendar({ url: calendarUrl, props: { displayname: "Series deleted" } });
});

/** Monday of the week after next, in the test zone. */
function nextWeeks(): string {
  let d = addDays(utcToLocal(ZONE, Date.now()).date, 7);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

function setup(server = url as string, calendar = calendarUrl) {
  const db = openDb(":memory:");
  const user = ensureUser(db, EMAIL, "Owner", Date.now());
  run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', ?, '', 'ok', ?, 1)`,
    user.id,
    EMAIL,
    Date.now(),
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
     VALUES ('cal', 'acc', ?, 'Work', 1, 1, 1)`,
    calendar,
  );
  const title = `Sync ${randomUUID().slice(0, 8)}`;
  run(
    db,
    `INSERT INTO meetings (id, user_id, title, level, rank, frequency, ideal_minute, duration_minutes,
       shortest_minutes, hours_mode, hours_set_id, defense, when_unplaceable, created_at,
       rules_changed_at, series_owned)
     VALUES ('m1', ?, ?, 2, 0, ?, 600, 30, 30, 'organizer',
       (SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1), 'busy', 'keep_as_conflict', ?, ?, 1)`,
    user.id,
    title,
    JSON.stringify({ period: "weekly", everyWeeks: 1, idealDays: [2] }),
    user.id,
    Date.now(),
    Date.now(),
  );
  run(
    db,
    "INSERT INTO meeting_attendees (meeting_id, email, required) VALUES ('m1', 'dana@example.com', 1)",
  );
  const p = new CalDavProvider({ serverUrl: server, username, password, email: EMAIL }, ZONE);
  const monday = nextWeeks();
  const occurrence = (week: number): DesiredEvent => {
    const date = addDays(monday, 7 * week + 1);
    const start = localToUtc(ZONE, date, 600);
    return {
      key: `meeting:m1:${addDays(monday, 7 * week)}`,
      kind: "meeting",
      sourceId: "m1",
      calendarId: "cal",
      start,
      end: start + 30 * 60_000,
      title: `● ${title}`,
      description: "",
      busy: true,
      colorId: null,
      attendees: ["dana@example.com"],
      optionalAttendees: [],
      organizer: EMAIL,
    };
  };
  const task: DesiredEvent = {
    ...occurrence(0),
    key: `task:t-${title}:0`,
    kind: "task",
    sourceId: "t1",
    title: `Task for ${title}`,
    attendees: [],
    start: localToUtc(ZONE, monday, 600),
    end: localToUtc(ZONE, monday, 630),
  };
  const push = (desired: DesiredEvent[]) =>
    pushSchedule(
      {
        db: db as Db,
        userId: user.id,
        now: Date.now(),
        target: () => ({ provider: p, providerCalendarId: calendar }),
      },
      desired,
    );
  const seriesId = () =>
    one<{ id: string | null }>(db, "SELECT series_event_id AS id FROM meetings WHERE id = 'm1'")
      ?.id ?? null;
  /** The organizer deletes the whole series in another app; the next pull reads the calendar. */
  const deleteSeries = async () => {
    const id = seriesId();
    if (!id) throw new Error("no series");
    const res = await fetch(id, { method: "DELETE", headers: { authorization: auth } });
    expect(res.ok).toBe(true);
    await pullEvents(db, p, "cal", Date.now());
    return id;
  };
  /** Events in Radicale with this title, and those that invite Dana. */
  const onServer = async (text: string) => {
    const { events } = await p.listEvents(calendar, {
      syncToken: null,
      timeMin: Date.now() - 86_400_000,
      timeMax: Date.now() + 60 * 86_400_000,
    });
    const hits = events.filter((e) => e.summary.includes(text));
    return {
      events: hits.length,
      invitations: hits.filter((e) => e.attendees.includes("dana@example.com")).length,
    };
  };
  return {
    db,
    userId: user.id,
    p,
    title,
    occurrence,
    task,
    push,
    seriesId,
    deleteSeries,
    onServer,
  };
}

describe("a deleted meeting series on Radicale", () => {
  it("answers not found to each series call", async () => {
    const s = setup();
    await s.push([s.occurrence(0), s.occurrence(1)]);
    const id = await s.deleteSeries();
    const kind = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e: unknown) => (e instanceof ProviderError ? e.kind : `plain: ${String(e)}`),
      );
    const t = s.occurrence(2).start;
    expect({
      instances: await kind(s.p.seriesInstances(calendarUrl, id, t - 86_400_000, t)),
      add: await kind(
        s.p.addInstance(calendarUrl, id, {
          summary: "x",
          description: "",
          start: t,
          end: t + 1_800_000,
          busy: true,
          colorId: null,
          privateProps: {},
        }),
      ),
      master: await kind(s.p.editExternal(calendarUrl, id, { summary: "x" }, null)),
      instance: await kind(
        s.p.editExternal(calendarUrl, `${id}#2030-01-01T10:00:00`, { summary: "x" }, null),
      ),
      end: await kind(s.p.endSeries(calendarUrl, id, Date.now(), [])),
    }).toEqual({
      instances: "not_found",
      add: "not_found",
      master: "not_found",
      instance: "not_found",
      end: "ok",
    });
  });

  it("a plan run writes the user's other items, turns the meeting off with a log entry, and writes no single event or invitation for it, also in the next run", async () => {
    const s = setup();
    await s.push([s.occurrence(0), s.occurrence(1)]);
    await s.deleteSeries();
    await s.push([s.occurrence(0), s.occurrence(1), s.occurrence(2), s.task]);
    expect((await s.onServer(`Task for ${s.title}`)).events).toBe(1);
    expect(
      one<{ enabled: number; series: string | null }>(
        s.db,
        "SELECT enabled, series_event_id AS series FROM meetings WHERE id = 'm1'",
      ),
    ).toEqual({ enabled: 0, series: null });
    expect(
      all<{ reason: string }>(s.db, "SELECT reason FROM meeting_changes WHERE meeting_id = 'm1'"),
    ).toEqual([{ reason: "seriesDeleted" }]);
    expect(await s.onServer(`● ${s.title}`)).toEqual({ events: 0, invitations: 0 });
    // The next run plans no occurrence of a meeting that is off.
    await s.push([s.task]);
    expect(await s.onServer(`● ${s.title}`)).toEqual({ events: 0, invitations: 0 });
  });

  it.each(["DELETE", "OFF"])("%s of the meeting works after the series is gone", async (action) => {
    const s = setup();
    await s.push([s.occurrence(0), s.occurrence(1)]);
    await s.deleteSeries();
    const pool = { get: () => s.p };
    const sync = {
      request() {},
      exclusive: async (_u: string, fn: (p: typeof pool) => Promise<unknown>) => fn(pool),
    } as unknown as SyncService;
    const owner = one<{ id: string }>(s.db, "SELECT * FROM users WHERE id = ?", s.userId);
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", owner as never);
      await next();
    });
    app.route(
      "/api",
      meetingRoutes(s.db, sync, () => Date.now()),
    );
    const res =
      action === "DELETE"
        ? await app.request("/api/meetings/m1", { method: "DELETE" })
        : await app.request("/api/meetings/m1/enabled", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          });
    expect(res.status).toBeLessThan(300);
  });
});

/**
 * A proxy in front of Radicale that can fail: "pass" forwards each request;
 * "503" answers with an HTML body that names 404 and 410; "401" refuses the
 * login; "reset" closes the connection.
 */
async function failingProxy() {
  const target = new URL(url as string);
  const state = { mode: "pass" as "pass" | "503" | "401" | "reset" };
  const server = createServer((req, res) => {
    if (state.mode === "503") {
      res.writeHead(503, { "content-type": "text/html" });
      res.end(
        "<h1>503 Service Unavailable</h1><p>upstream answered 404 and 410 during restart</p>",
      );
      return;
    }
    if (state.mode === "401") {
      res.writeHead(401, { "content-type": "text/html" });
      res.end("<p>login refused; the object was 404 or 410</p>");
      return;
    }
    if (state.mode === "reset") {
      req.socket.destroy();
      return;
    }
    const up = request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: target.host },
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    req.pipe(up);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const via = (u: string) => {
    const x = new URL(u);
    x.host = `127.0.0.1:${port}`;
    return x.toString();
  };
  return { state, via, close: () => server.close() };
}

describe("a meeting series behind a failing server", () => {
  it.each(["503", "401", "reset"] as const)(
    "a %s answer is not a deleted series: the meeting stays on with its series, and delete and turn-off do not unlink it",
    async (mode) => {
      const proxy = await failingProxy();
      try {
        const s = setup(proxy.via(url as string), proxy.via(calendarUrl));
        await s.push([s.occurrence(0), s.occurrence(1)]);
        const id = s.seriesId();
        expect(id).not.toBeNull();
        // The pull read nothing of the series (an empty cache): the run asks the server.
        run(s.db, "DELETE FROM events");
        proxy.state.mode = mode;
        await s
          .push([s.occurrence(0), s.occurrence(1), s.occurrence(2), s.task])
          .catch(() => undefined);
        const state = () =>
          one<{ enabled: number; series: string | null }>(
            s.db,
            "SELECT enabled, series_event_id AS series FROM meetings WHERE id = 'm1'",
          );
        expect(state()).toEqual({ enabled: 1, series: id });
        const pool = { get: () => s.p };
        const sync = {
          request() {},
          exclusive: async (_u: string, fn: (p: typeof pool) => Promise<unknown>) => fn(pool),
        } as unknown as SyncService;
        const owner = one<{ id: string }>(s.db, "SELECT * FROM users WHERE id = ?", s.userId);
        const app = new Hono<AppEnv>();
        app.use("*", async (c, next) => {
          c.set("user", owner as never);
          await next();
        });
        app.route(
          "/api",
          meetingRoutes(s.db, sync, () => Date.now()),
        );
        await app.request("/api/meetings/m1/enabled", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        });
        expect(state()).toEqual({ enabled: 1, series: id });
        await app.request("/api/meetings/m1", { method: "DELETE" });
        expect(state()).toEqual({ enabled: 1, series: id });
        expect(all(s.db, "SELECT reason FROM meeting_changes WHERE meeting_id = 'm1'")).toEqual([]);
        // The series and its guest are still on the server.
        proxy.state.mode = "pass";
        const res = await fetch(id as string, { headers: { authorization: auth } });
        expect([
          res.status,
          (await res.text()).toLowerCase().includes("mailto:dana@example.com"),
        ]).toEqual([200, true]);
      } finally {
        proxy.close();
      }
    },
  );
});
