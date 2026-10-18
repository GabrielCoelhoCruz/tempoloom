// E2E fixtures: a real Tempoloom server with an empty database per test, a
// real calendar backend, and a driver that reads and writes that calendar
// directly, the way another calendar app would.
//
// Backend: TEMPOLOOM_E2E_BACKEND=caldav (default; Radicale in Docker) or
// google (a Google service account; see tests/e2e/README.md).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test as base, expect, type Page } from "@playwright/test";
import { DAVClient } from "tsdav";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import {
  parseServiceAccountKey,
  serviceAccountToken,
} from "../../src/server/google/service-account.ts";
import { CalDavProvider } from "../../src/server/providers/caldav.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../src/shared/time.ts";

export const ZONE = "Europe/Berlin";
export const PORT = Number(process.env.TEMPOLOOM_E2E_PORT ?? 8788);
export const BASE_URL = `http://localhost:${PORT}`;
const ROOT = join(import.meta.dirname, "../..");
const EMAIL = "e2e@tempoloom.test";
export const BACKEND: "caldav" | "google" =
  process.env.TEMPOLOOM_E2E_BACKEND === "google" ? "google" : "caldav";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

export interface AppServer {
  baseUrl: string;
  dataDir: string;
  /** Environment of the server process, for the operator CLI. */
  env: Record<string, string>;
  restart(): Promise<void>;
  /** Reads the server database (read-only), for checks the UI does not show. */
  query<T>(sql: string, ...params: (string | number)[]): T[];
  log: string[];
}

export interface CalendarDriver {
  backend: "caldav" | "google";
  calendarId: string;
  addEvent(e: {
    title: string;
    start: number;
    end: number;
    busy?: boolean;
    attendees?: string[];
    location?: string;
  }): Promise<string>;
  update(id: string, change: { start: number; end: number; summary?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  events(from: number, to: number): Promise<ProviderEvent[]>;
  /** A busy or free all-day event on a local date. */
  addAllDay(date: string, title: string, busy: boolean): Promise<string>;
  /** An invitation from someone else, with the user's answer (CalDAV only). */
  addInvite(e: {
    title: string;
    start: number;
    end: number;
    answer: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE";
  }): Promise<string>;
  /** Another calendar of the same account (CalDAV only). */
  newCalendar(name: string): Promise<CalendarDriver>;
}

/** The first Monday at least 2 days ahead: the test week W. */
export function testWeek(now = Date.now()): string {
  let d = addDays(utcToLocal(ZONE, now).date, 2);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

export const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};

export const local = (t: number) => {
  const l = utcToLocal(ZONE, t);
  return `${l.date} ${String(Math.floor(l.minuteOfDay / 60)).padStart(2, "0")}:${String(l.minuteOfDay % 60).padStart(2, "0")}`;
};

interface RadicaleEnv {
  url: string;
  username: string;
  password: string;
}

function radicaleEnv(): RadicaleEnv {
  const out = execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["env"], { encoding: "utf8" });
  const env = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  return { url: env.CALDAV_URL, username: env.CALDAV_USERNAME, password: env.CALDAV_PASSWORD };
}

async function caldavDriver(env: RadicaleEnv): Promise<CalendarDriver> {
  const client = new DAVClient({
    serverUrl: env.url,
    credentials: { username: env.username, password: env.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await client.login();
  // Start from one empty calendar: delete every calendar of the test user.
  for (const cal of await client.fetchCalendars()) {
    await client.deleteObject({ url: cal.url });
  }
  const home = client.account?.homeUrl;
  if (!home) throw new Error("No calendar home on the CalDAV server");
  return caldavCalendar(env, client, home, "Work");
}

async function caldavCalendar(
  env: RadicaleEnv,
  client: DAVClient,
  home: string,
  name: string,
): Promise<CalendarDriver> {
  const calendarId = new URL(`${name.toLowerCase()}-${randomUUID().slice(0, 8)}/`, home).toString();
  await client.makeCalendar({ url: calendarId, props: { displayname: name } });
  const putRaw = async (lines: string[]) => {
    const cal = (await client.fetchCalendars()).find((c) => c.url === calendarId);
    if (!cal) throw new Error("calendar missing");
    const uid = randomUUID();
    const res = await client.createCalendarObject({
      calendar: cal,
      filename: `${uid}.ics`,
      iCalString: [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//tempoloom-e2e//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20260101T000000Z",
        ...lines,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    });
    if (!res.ok) throw new Error(`create failed ${res.status}`);
    return new URL(`${uid}.ics`, calendarId).toString();
  };
  const utc = (t: number) =>
    new Date(t)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const provider = new CalDavProvider(
    { serverUrl: env.url, username: env.username, password: env.password, email: EMAIL },
    ZONE,
  );
  const attendeesOf = new Map<string, string[]>();
  const byId = async (id: string) => {
    const all = await provider.listEvents(calendarId, {
      syncToken: null,
      timeMin: Date.now() - 86_400_000,
      timeMax: Date.now() + 90 * 86_400_000,
    });
    const ev = all.events.find((e) => e.id === id);
    if (!ev) throw new Error(`No event ${id}`);
    return ev;
  };
  return {
    backend: "caldav",
    calendarId,
    async addEvent(e) {
      const ev = await provider.insertEvent(calendarId, {
        summary: e.title,
        description: "",
        start: e.start,
        end: e.end,
        busy: e.busy ?? true,
        colorId: null,
        privateProps: {},
        ...(e.attendees ? { attendees: [EMAIL, ...e.attendees] } : {}),
        ...(e.location ? { location: e.location } : {}),
      });
      if (e.attendees) attendeesOf.set(ev.id, [EMAIL, ...e.attendees]);
      return ev.id;
    },
    async update(id, change) {
      const ev = await byId(id);
      const attendees = attendeesOf.get(id);
      await provider.updateEvent(
        calendarId,
        id,
        {
          summary: change.summary ?? ev.summary,
          description: ev.description,
          start: change.start,
          end: change.end,
          busy: ev.busy,
          colorId: null,
          privateProps: ev.privateProps,
          ...(attendees ? { attendees } : {}),
        },
        null,
      );
    },
    remove: (id) => provider.deleteEvent(calendarId, id),
    async events(from, to) {
      return (
        await provider.listEvents(calendarId, { syncToken: null, timeMin: from, timeMax: to })
      ).events;
    },
    addAllDay: (date, title, busy) =>
      putRaw([
        `DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, "")}`,
        `SUMMARY:${title}`,
        `TRANSP:${busy ? "OPAQUE" : "TRANSPARENT"}`,
      ]),
    addInvite: (e) =>
      putRaw([
        `DTSTART:${utc(e.start)}`,
        `DTEND:${utc(e.end)}`,
        `SUMMARY:${e.title}`,
        "ORGANIZER:mailto:organizer@example.com",
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:organizer@example.com",
        `ATTENDEE;PARTSTAT=${e.answer}:mailto:${EMAIL}`,
      ]),
    newCalendar: (name) => caldavCalendar(env, client, home, name),
  };
}

/** Google: the service account owns one fresh test calendar per test. */
async function googleDriver(): Promise<CalendarDriver> {
  if (!SA_JSON)
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set; run scripts/e2e-google.sh");
  const key = parseServiceAccountKey(SA_JSON);
  let token: { value: string; exp: number } | undefined;
  const api = new GoogleCalendarApi({
    getAccessToken: async () => {
      if (!token || token.exp < Date.now()) {
        const t = await serviceAccountToken(key);
        token = { value: t.accessToken, exp: t.expiresAt };
      }
      return token.value;
    },
  });
  for (const c of await api.listCalendars()) {
    if (c.summary.startsWith("tempoloom-e2e")) await api.deleteCalendar(c.id);
  }
  const created = await api.createCalendar(`tempoloom-e2e-${randomUUID().slice(0, 8)}`, ZONE);
  const provider = new GoogleProvider(api, ZONE);
  const calendarId = created.id;
  return {
    backend: "google",
    calendarId,
    async addEvent(e) {
      if (e.attendees) throw new Error("A service account cannot invite attendees");
      const ev = await provider.insertEvent(calendarId, {
        summary: e.title,
        description: "",
        start: e.start,
        end: e.end,
        busy: e.busy ?? true,
        colorId: null,
        privateProps: {},
        ...(e.location ? { location: e.location } : {}),
      });
      return ev.id;
    },
    async update(id, change) {
      await api.patchEvent(calendarId, id, {
        start: { dateTime: new Date(change.start).toISOString() },
        end: { dateTime: new Date(change.end).toISOString() },
        ...(change.summary ? { summary: change.summary } : {}),
      });
    },
    remove: (id) => api.deleteEvent(calendarId, id),
    async events(from, to) {
      return (
        await provider.listEvents(calendarId, { syncToken: null, timeMin: from, timeMax: to })
      ).events.filter((e) => !e.cancelled);
    },
    async addAllDay(date, title, busy) {
      const ev = await api.insertEvent(calendarId, {
        summary: title,
        start: { date },
        end: { date: addDays(date, 1) },
        transparency: busy ? "opaque" : "transparent",
      });
      return ev.id;
    },
    addInvite: () => Promise.reject(new Error("A service account cannot receive invitations")),
    newCalendar: () => Promise.reject(new Error("Not supported for the Google backend yet")),
  };
}

type TestFixtures = {
  app: AppServer;
  cal: CalendarDriver;
  signIn: () => Promise<void>;
};
type WorkerFixtures = { radicale: RadicaleEnv | null };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  radicale: [
    async ({}, use) => {
      if (BACKEND !== "caldav") {
        await use(null);
        return;
      }
      execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["start"], { stdio: "ignore" });
      await use(radicaleEnv());
      // Keep the server log for failure analysis (it holds no secrets).
      execFileSync("sh", [
        "-c",
        `docker logs tempoloom-e2e-radicale >> "${join(ROOT, ".e2e/radicale.log")}" 2>&1 || true`,
      ]);
      if (!process.env.TEMPOLOOM_E2E_KEEP_CALDAV) {
        execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["stop"], { stdio: "ignore" });
      }
    },
    { scope: "worker" },
  ],

  cal: async ({ radicale }, use) => {
    await use(radicale ? await caldavDriver(radicale) : await googleDriver());
  },

  app: async ({}, use, info) => {
    const dataDir = mkdtempSync(join(tmpdir(), "tempoloom-e2e-"));
    const secretKey = randomBytes(32).toString("base64");
    const log: string[] = [];
    let proc: ChildProcess | undefined;
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      PORT: String(PORT),
      HOST: "127.0.0.1",
      BASE_URL,
      DATA_DIR: dataDir,
      SECRET_KEY: secretKey,
      SYNC_INTERVAL_SECONDS: "5",
      WEB_DIST: join(ROOT, "dist/web"),
      // Webhook tests use a receiver on loopback and short retry delays.
      WEBHOOK_ALLOW_PRIVATE: "1",
      WEBHOOK_RETRY_BASE_MS: "500",
      ...(SA_JSON ? { GOOGLE_SERVICE_ACCOUNT_JSON: SA_JSON } : {}),
    };
    const start = async () => {
      proc = spawn(process.execPath, ["src/server/main.ts"], {
        cwd: ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      proc.stdout?.on("data", (b: Buffer) => log.push(b.toString()));
      proc.stderr?.on("data", (b: Buffer) => log.push(b.toString()));
      for (let i = 0; i < 100; i++) {
        if (proc.exitCode !== null) throw new Error(`Server exited:\n${log.join("")}`);
        try {
          if ((await fetch(`${BASE_URL}/healthz`)).ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Server did not start:\n${log.join("")}`);
    };
    const stop = async () => {
      if (!proc || proc.exitCode !== null) return;
      const p = proc;
      await new Promise<void>((r) => {
        p.once("exit", () => r());
        p.kill("SIGTERM");
      });
    };
    await start();
    await use({
      baseUrl: BASE_URL,
      dataDir,
      env,
      log,
      restart: async () => {
        await stop();
        await start();
      },
      query: <T>(sql: string, ...params: (string | number)[]) => {
        const db = new DatabaseSync(join(dataDir, "tempoloom.db"), { readOnly: true });
        try {
          return db.prepare(sql).all(...params) as T[];
        } finally {
          db.close();
        }
      },
    });
    await stop();
    if (info.status !== info.expectedStatus) {
      await info.attach("server.log", { body: log.join(""), contentType: "text/plain" });
    }
  },

  signIn: async ({ page, app, radicale }, use) => {
    await use(async () => {
      if (!radicale) {
        // Operator flow: connect the service account, then sign in with a one-time link.
        const cli = (...args: string[]) =>
          execFileSync(process.execPath, ["src/server/cli.ts", ...args], {
            cwd: ROOT,
            env: app.env,
            encoding: "utf8",
          });
        cli("connect-google-service-account", "--email", EMAIL);
        await page.goto(cli("login-link", "--email", EMAIL).trim());
        await expect(page.getByTestId("app-shell")).toBeVisible();
        // A new account's calendars are read on the next sync tick.
        await planNow(page);
        return;
      }
      await page.goto(app.baseUrl);
      const form = page.getByTestId("caldav-form");
      await form.getByLabel("CalDAV server URL").fill(radicale.url);
      await form.getByLabel("User name", { exact: true }).fill(radicale.username);
      await form.getByLabel("Password", { exact: true }).fill(radicale.password);
      await form.getByLabel(/^Email/).fill(EMAIL);
      await form.getByRole("button", { name: /sign in with caldav/i }).click();
      await expect(page.getByTestId("app-shell")).toBeVisible();
    });
  },
});

/** Polls the calendar until `check` passes; the server syncs every 5 seconds. */
export async function eventually<T>(
  read: () => Promise<T>,
  check: (v: T) => void,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    const v = await read();
    try {
      check(v);
      return v;
    } catch (err) {
      last = err;
      if (Date.now() > deadline) throw last;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/** A busy blocker from now to Monday 00:00 of the test week, so nothing is placed before W. */
export async function blockUntil(cal: CalendarDriver, date: string): Promise<void> {
  await cal.addEvent({
    title: "E2E blocker",
    start: Date.now() - 3_600_000,
    end: at(date, "00:00"),
  });
}

export async function planNow(page: Page): Promise<void> {
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }).then((r) => r.json()));
}

export const managed = (events: ProviderEvent[]) => events.filter((e) => e.privateProps.tl === "1");

export { expect };
