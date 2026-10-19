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
import {
  type Browser,
  type BrowserContext,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import { DAVClient } from "tsdav";
import { GoogleCalendarApi } from "../../src/server/google/calendar.ts";
import {
  parseServiceAccountKey,
  serviceAccountToken,
} from "../../src/server/google/service-account.ts";
import { CalDavProvider, retryRead } from "../../src/server/providers/caldav.ts";
import { GoogleProvider } from "../../src/server/providers/google.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../src/shared/time.ts";

export const ZONE = "Europe/Berlin";
export const PORT = Number(process.env.TEMPOLOOM_E2E_PORT ?? 8788);
export const BASE_URL = `http://localhost:${PORT}`;
const ROOT = join(import.meta.dirname, "../..");
export const EMAIL = "e2e@tempoloom.test";
export const COLLEAGUE_EMAIL = "colleague@tempoloom.test";
export const BACKEND: "caldav" | "google" =
  process.env.TEMPOLOOM_E2E_BACKEND === "google" ? "google" : "caldav";
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

export interface AppServer {
  baseUrl: string;
  dataDir: string;
  /** Environment of the server process, for the operator CLI. */
  env: Record<string, string>;
  restart(): Promise<void>;
  /** Runs an operator command (src/server/cli.ts) with the server's environment. */
  cli(...args: string[]): string;
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
    description?: string;
  }): Promise<string>;
  update(id: string, change: { start: number; end: number; summary?: string }): Promise<void>;
  remove(id: string): Promise<void>;
  events(from: number, to: number): Promise<ProviderEvent[]>;
  /** Guests of an event, with the optional flag. */
  guests(id: string): Promise<{ email: string; optional: boolean }[]>;
  /** A busy or free all-day event on a local date. */
  addAllDay(date: string, title: string, busy: boolean): Promise<string>;
  /** An invitation from someone else, with the user's answer (CalDAV only). */
  addInvite(e: {
    title: string;
    start: number;
    end: number;
    answer: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" | "TENTATIVE";
    description?: string;
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

interface RadicaleUser {
  url: string;
  username: string;
  password: string;
}

interface RadicaleEnv extends RadicaleUser {
  /** A second user, for meetings between two people. */
  colleague: RadicaleUser;
  /** Users e2e3 to e2e6, by number: more team members. */
  users: Record<number, RadicaleUser>;
  /** e2egrant reads every user's calendars (scripts/caldav-server.sh). */
  grant: RadicaleUser;
}

function radicaleEnv(): RadicaleEnv {
  const out = execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["env"], { encoding: "utf8" });
  const env = Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  const user = (n: string) => ({
    url: env.CALDAV_URL,
    username: env[`CALDAV_USERNAME${n}`],
    password: env[`CALDAV_PASSWORD${n}`],
  });
  return {
    ...user(""),
    colleague: user("2"),
    users: Object.fromEntries([3, 4, 5, 6].map((n) => [n, user(String(n))])),
    grant: user("grant"),
  };
}

async function caldavDriver(env: RadicaleUser, email = EMAIL): Promise<CalendarDriver> {
  const client = new DAVClient({
    serverUrl: env.url,
    credentials: { username: env.username, password: env.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await client.login();
  // Start from one empty calendar: delete every calendar of the test user.
  for (const cal of await retryRead(() => client.fetchCalendars())) {
    await client.deleteObject({ url: cal.url });
  }
  const home = client.account?.homeUrl;
  if (!home) throw new Error("No calendar home on the CalDAV server");
  return caldavCalendar(env, client, home, "Work", email);
}

async function caldavCalendar(
  env: RadicaleUser,
  client: DAVClient,
  home: string,
  name: string,
  email: string,
): Promise<CalendarDriver> {
  const calendarId = new URL(`${name.toLowerCase()}-${randomUUID().slice(0, 8)}/`, home).toString();
  await client.makeCalendar({ url: calendarId, props: { displayname: name } });
  const putRaw = async (lines: string[]) => {
    const cal = (await retryRead(() => client.fetchCalendars())).find((c) => c.url === calendarId);
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
    { serverUrl: env.url, username: env.username, password: env.password, email },
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
        description: e.description ?? "",
        start: e.start,
        end: e.end,
        busy: e.busy ?? true,
        colorId: null,
        privateProps: {},
        ...(e.attendees ? { attendees: [email, ...e.attendees] } : {}),
        ...(e.location ? { location: e.location } : {}),
      });
      if (e.attendees) attendeesOf.set(ev.id, [email, ...e.attendees]);
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
        `ATTENDEE;PARTSTAT=${e.answer}:mailto:${email}`,
        ...(e.description ? [`DESCRIPTION:${e.description.replace(/\n/g, "\\n")}`] : []),
      ]),
    newCalendar: (name) => caldavCalendar(env, client, home, name, email),
    async guests(id) {
      const cal = (await retryRead(() => client.fetchCalendars())).find(
        (c) => c.url === calendarId,
      );
      if (!cal) throw new Error("calendar missing");
      const [obj] = await retryRead(() =>
        client.fetchCalendarObjects({ calendar: cal, objectUrls: [id] }),
      );
      const lines = String(obj?.data ?? "")
        .replace(/\r?\n[ \t]/g, "")
        .split(/\r?\n/);
      return lines
        .filter((l) => l.startsWith("ATTENDEE"))
        .map((l) => ({
          email: l.slice(l.toLowerCase().lastIndexOf("mailto:") + 7).toLowerCase(),
          optional: /ROLE=OPT-PARTICIPANT/i.test(l),
        }));
    },
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
        description: e.description ?? "",
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
    guests: () => Promise.reject(new Error("Not supported for the Google backend yet")),
  };
}

/** A second user of the same instance, with a CalDAV calendar of their own. */
export interface Colleague {
  email: string;
  cal: CalendarDriver;
  /** Signs the colleague in, in a browser context of their own, starting at `path` (default "/"). */
  signIn: (path?: string) => Promise<Page>;
}

/** Another user of the instance: Radicale user e2e<n> with a calendar of their own. */
export interface Person extends Colleague {
  username: string;
  /** Fills and sends the sign-in form without waiting for the app; for refused sign-ins. */
  attemptSignIn: () => Promise<Page>;
}

/** Messages that the instance sent, read from the loopback mail server. */
export interface Mailbox {
  /** Waits for a message to `to` with a matching subject. */
  message(to: string, subject: RegExp): Promise<{ subject: string; text: string; html: string }>;
  /** Number of messages to `to` so far. */
  count(to: string): Promise<number>;
}

/** Browser contexts that helpers open for signed-out visitors; closed after each test. */
export const visitorContexts: BrowserContext[] = [];

type TestFixtures = {
  closeVisitors: undefined;
  app: AppServer;
  cal: CalendarDriver;
  signIn: () => Promise<void>;
  colleague: Colleague;
  /** people(3) is Radicale user e2e3 with email e2e3@tempoloom.test, unless `email` is given. */
  people: (n: 3 | 4 | 5 | 6, email?: string) => Promise<Person>;
  mail: Mailbox;
};
type WorkerFixtures = {
  radicale: RadicaleEnv | null;
  mailServer: { smtpUrl: string; apiUrl: string };
};

async function signInAs(
  browser: Browser,
  baseUrl: string,
  env: RadicaleUser,
  email: string,
  contexts: BrowserContext[],
  path = "/",
  wait = true,
): Promise<Page> {
  const ctx = await browser.newContext({ timezoneId: ZONE, locale: "en-GB", baseURL: baseUrl });
  contexts.push(ctx);
  const page = await ctx.newPage();
  await page.goto(path);
  const form = page.getByTestId("caldav-form");
  await form.getByLabel("CalDAV server URL").fill(env.url);
  await form.getByLabel("User name", { exact: true }).fill(env.username);
  await form.getByLabel("Password", { exact: true }).fill(env.password);
  await form.getByLabel(/^Email/).fill(email);
  await form.getByRole("button", { name: /sign in with caldav/i }).click();
  if (wait) await expect(page.getByTestId("app-shell")).toBeVisible();
  return page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  closeVisitors: [
    async ({}, use) => {
      await use(undefined);
      for (const c of visitorContexts.splice(0)) await c.close();
    },
    { auto: true },
  ],

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
        `docker logs ${process.env.TEMPOLOOM_CALDAV_CONTAINER ?? "tempoloom-e2e-radicale"} >> "${join(ROOT, ".e2e/radicale.log")}" 2>&1 || true`,
      ]);
      if (!process.env.TEMPOLOOM_E2E_KEEP_CALDAV) {
        execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["stop"], { stdio: "ignore" });
      }
    },
    { scope: "worker" },
  ],

  mailServer: [
    async ({}, use) => {
      const script = join(ROOT, "scripts/mail-server.sh");
      execFileSync(script, ["start"], { stdio: "ignore" });
      const env = Object.fromEntries(
        execFileSync(script, ["env"], { encoding: "utf8" })
          .trim()
          .split("\n")
          .map((l) => l.split(/=(.*)/s).slice(0, 2)),
      );
      await use({ smtpUrl: env.SMTP_URL, apiUrl: env.MAIL_API_URL });
      execFileSync(script, ["stop"], { stdio: "ignore" });
    },
    { scope: "worker" },
  ],

  mail: async ({ mailServer }, use) => {
    const api = (p: string, init?: RequestInit) => fetch(new URL(p, mailServer.apiUrl), init);
    await api("api/v1/messages", { method: "DELETE" });
    interface Summary {
      ID: string;
      Subject: string;
      To: { Address: string }[];
    }
    const list = async (to: string) =>
      (
        (await (await api("api/v1/messages?limit=200")).json()) as { messages: Summary[] }
      ).messages.filter((m) => m.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()));
    await use({
      async message(to, subject) {
        const m = await eventually(
          async () => (await list(to)).find((x) => subject.test(x.Subject)),
          (v) => expect(v, `mail to ${to} matching ${subject}`).toBeTruthy(),
          20_000,
        );
        const full = (await (await api(`api/v1/message/${m?.ID}`)).json()) as {
          Text: string;
          HTML: string;
        };
        // Mail bodies use CRLF line ends; tests compare with \n.
        return {
          subject: m?.Subject ?? "",
          text: full.Text.replace(/\r\n/g, "\n"),
          html: full.HTML,
        };
      },
      count: async (to) => (await list(to)).length,
    });
  },

  cal: async ({ radicale }, use) => {
    await use(radicale ? await caldavDriver(radicale) : await googleDriver());
  },

  app: async ({ mailServer }, use, info) => {
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
      SMTP_URL: mailServer.smtpUrl,
      MAIL_FROM: "Tempoloom <noreply@tempoloom.test>",
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
      cli: (...args) =>
        execFileSync(process.execPath, ["src/server/cli.ts", ...args], {
          cwd: ROOT,
          env,
          encoding: "utf8",
        }),
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

  colleague: async ({ radicale, browser, app }, use) => {
    if (!radicale) throw new Error("The colleague fixture needs the CalDAV backend.");
    const env = radicale.colleague;
    const cal = await caldavDriver(env, COLLEAGUE_EMAIL);
    const contexts: BrowserContext[] = [];
    await use({
      email: COLLEAGUE_EMAIL,
      cal,
      signIn: (path) => signInAs(browser, app.baseUrl, env, COLLEAGUE_EMAIL, contexts, path),
    });
    for (const c of contexts) await c.close();
  },

  people: async ({ radicale, browser, app }, use) => {
    if (!radicale) throw new Error("The people fixture needs the CalDAV backend.");
    const contexts: BrowserContext[] = [];
    const made = new Map<number, Person>();
    await use(async (n, email) => {
      const known = made.get(n);
      if (known) return known;
      const env = radicale.users[n];
      if (!env) throw new Error(`No Radicale user e2e${n}`);
      const address = email ?? `e2e${n}@tempoloom.test`;
      const person: Person = {
        email: address,
        username: env.username,
        cal: await caldavDriver(env, address),
        signIn: (path) => signInAs(browser, app.baseUrl, env, address, contexts, path),
        attemptSignIn: () => signInAs(browser, app.baseUrl, env, address, contexts, "/", false),
      };
      made.set(n, person);
      return person;
    });
    for (const c of contexts) await c.close();
  },

  // Depends on `cal`, so the user's calendar is reset and exists before sign-in.
  signIn: async ({ page, app, radicale, cal: _cal }, use) => {
    await use(async () => {
      if (!radicale) {
        // Operator flow: connect the service account, then sign in with a one-time link.
        app.cli("connect-google-service-account", "--email", EMAIL);
        await page.goto(app.cli("login-link", "--email", EMAIL).trim());
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
