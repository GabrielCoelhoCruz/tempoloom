// The read tools and the task proposal for assistant chat and AI tools
// (src/server/mcp/answers.ts), called as the chat calls them, on an in-memory
// database.
//
// Ways it can fail:
// 1. A read tool gives data that the caller cannot see in the app: another
//    user's tasks, another team's absences, organization analytics to a member;
//    or it gives a teammate who does not own the out-of-office calendar nothing.
// 2. Who is away answers "nobody" for a past range, whose absences are not kept,
//    or lists a deactivated person.
// 3. group_by "company" (the name the result uses) gives a "No company" group.
// 4. A large report or list goes to the model whole.
// 5. The task proposal creates the task before approval, or a proposal whose
//    due date passed creates an overdue task at apply.
// 6. The automation ideas list one series twice (as a meeting and a habit),
//    or list a series that a habit, Tempoloom or a meeting already covers.
// 7. The help search misses another form of a word, or answers a single word
//    that a page only uses in passing.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import { createApiKey } from "../../src/server/api-keys.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import type { Message } from "../../src/server/mail.ts";
import { MAX_CHARS } from "../../src/server/mcp/answers.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import { mcpRoutes } from "../../src/server/mcp.ts";
import { updatePrefs } from "../../src/server/meeting-prefs.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";
import type { SyncService } from "../../src/server/sync/service.ts";
import { createTask } from "../../src/server/tasks.ts";
import { membership } from "../../src/server/teams.ts";
import { searchHelp, stem } from "../../src/shared/help-pages.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z"); // Monday
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The real tasks API on a connection, as the first user of the database. */
function tasksApp(db: Db, now: () => number) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const user = one<User>(db, "SELECT id, email, name, time_zone FROM users LIMIT 1") as User;
    c.set("user", user);
    await next();
  });
  app.route("/api", itemRoutes(db, { request: () => {} } as unknown as SyncService, now));
  return app;
}

/**
 * `file`: a database file with a second connection for dry runs, as the
 * server has; else an in-memory database without dry runs.
 */
function setup(file?: string) {
  const db = openDb(file ?? ":memory:");
  let t = T0;
  const now = () => t;
  // The app that apply replays a staged request on: the real tasks API.
  const app = tasksApp(db, now);
  const dryDb = file ? openDb(file) : null;
  const dry = dryDb && { db: dryDb, app: tasksApp(dryDb, now) };
  const preview = createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => app,
    dry: () => dry,
  } as unknown as PreviewDeps);
  const tools = chatTools({ db, preview, baseUrl: "http://localhost:3000", now });
  // The MCP server of the same tools, called with a user's API key.
  const mcp = mcpRoutes({ db, preview, baseUrl: "http://localhost:3000", writeEnabled: true, now });
  const viaMcp = async (user: User, name: string, args: Record<string, unknown>) => {
    const { secret } = createApiKey(db, user.id, { name: "Claude", expires: "never" }, T0);
    const res = await mcp.request("/", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return ((await res.json()) as { result: { isError?: boolean; content: { text: string }[] } })
      .result;
  };
  const call = async (user: User, name: string, args: unknown = {}) => {
    const tool = tools.find((x) => x.tool.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return callTool(tool.tool, { user, client: "", source: "assistant_chat" }, args);
  };
  const ok = async (user: User, name: string, args: unknown = {}) => {
    const r = await call(user, name, args);
    if (r.isError) throw new Error(r.text);
    return r.data;
  };
  return { db, call, ok, preview, viaMcp, setNow: (x: number) => (t = x) };
}

/** A user in the team of `admin`, as a member. */
const member = (db: Db, email: string, admin: User) =>
  ensureUser(db, email, email.split("@")[0] ?? "", T0, membership(db, admin.id).team.id);

/** A copy of an absence on a team out-of-office calendar, as syncTarget saves it. */
function absence(db: Db, oooId: string, user: User, from: string, to: string) {
  run(
    db,
    `INSERT INTO ooo_copies (ooo_id, source, user_id, mode, event_id, written, source_end_ms)
     VALUES (?, ?, ?, 'all_day', ?, ?, ?)`,
    oooId,
    `cal|${user.id}|${from}`,
    user.id,
    `copy-${user.id}-${from}`,
    JSON.stringify([
      `${user.name} out of office`,
      Date.parse(`${from}T00:00:00Z`),
      Date.parse(`${to}T00:00:00Z`),
      { start: from, end: to },
    ]),
    Date.parse(`${to}T00:00:00Z`),
  );
}

const oooCalendar = (db: Db, id: string, team: string, owner: string) =>
  run(
    db,
    "INSERT INTO ooo_calendars (id, team_id, name, owner_id, created_at) VALUES (?, ?, 'OOO', ?, ?)",
    id,
    team,
    owner,
    T0,
  );

describe("task suggestions", () => {
  it("list only the caller's tasks, the best first", async () => {
    const { db, call } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const v = ensureUser(db, "v@example.com", "V", T0);
    createTask(db, u, { title: "Low one", level: 4, startAfter: T0 - DAY }, T0);
    createTask(db, u, { title: "Urgent one", level: 1, startAfter: T0 - DAY }, T0);
    createTask(db, v, { title: "Not yours", level: 1, startAfter: T0 - DAY }, T0);
    const r = await call(u, "get_task_suggestions");
    if (r.isError) throw new Error(r.text);
    const data = r.data as { suggested_now: { title: string }[] };
    expect(data.suggested_now.map((t) => t.title)).toEqual(["Urgent one", "Low one"]);
    expect(r.text).not.toContain("Not yours");
  });
});

describe("who is away", () => {
  const week = { start_date: "2026-10-19", end_date: "2026-10-25" };

  it("lists the absences of the caller's own team to every member, not only the calendar's owner", async () => {
    const { db, ok } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    const cat = member(db, "c@example.com", admin);
    const out = ensureUser(db, "x@example.com", "Xena", T0);
    const ours = membership(db, admin.id).team.id;
    const theirs = membership(db, out.id).team.id;
    oooCalendar(db, "ooo-1", ours, admin.id);
    oooCalendar(db, "ooo-2", theirs, out.id);
    absence(db, "ooo-1", bob, "2026-10-21", "2026-10-23");
    absence(db, "ooo-1", bob, "2026-12-01", "2026-12-02");
    absence(db, "ooo-2", out, "2026-10-21", "2026-10-22");

    const bobAway = {
      name: "b",
      email: "b@example.com",
      start: "2026-10-21",
      end: "2026-10-22",
      all_day: true,
    };
    // Cat neither owns the calendar nor is away: she sees Bob, and nobody of the other team.
    for (const caller of [admin, cat]) {
      const r = await ok(caller, "list_team_time_away", week);
      expect(r).toMatchObject({ out_of_office_calendars: 1, absences: [bobAway], truncated: 0 });
    }
    // The other team's member sees their own team only.
    const other = await ok(out, "list_team_time_away", week);
    expect((other.absences as { email: string }[]).map((x) => x.email)).toEqual(["x@example.com"]);

    // A deactivated person is not listed.
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, bob.id);
    expect((await ok(cat, "list_team_time_away", week)).absences).toEqual([]);
  });

  it("refuses a past range instead of saying nobody was away, and starts a range from today", async () => {
    const { db, call, ok } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    oooCalendar(db, "ooo-1", membership(db, admin.id).team.id, admin.id);
    absence(db, "ooo-1", bob, "2026-10-21", "2026-10-23");
    const past = await call(admin, "list_team_time_away", {
      start_date: "2026-10-12",
      end_date: "2026-10-18",
    });
    expect(past).toMatchObject({ isError: true });
    expect(past.text).toMatch(/^Past absences are not kept/);
    const partly = await ok(admin, "list_team_time_away", {
      start_date: "2026-10-12",
      end_date: "2026-10-25",
    });
    expect(partly).toMatchObject({
      from: "2026-10-19",
      note: "Past absences are not kept; the list starts today (2026-10-19).",
    });
    expect((partly.absences as unknown[]).length).toBe(1);
  });
});

describe("organization analytics", () => {
  it("answer team admins, refuse members, and take group_by in the words of their result", async () => {
    const { db, call, ok } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    const args = { start_date: "2026-10-12", end_date: "2026-10-18" };
    const refused = await call(bob, "get_org_analytics", args);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/Only analytics admins/);

    const byDefault = await ok(admin, "get_org_analytics", args);
    expect(byDefault).toMatchObject({
      from: "2026-10-12",
      to: "2026-10-18",
      group_by: "company",
      groups: [{ label: "Company", people: 0, without_calendar: 2 }],
      truncated: 0,
    });
    // The name the result gives is a valid input: still the company, not "No company".
    const again = await ok(admin, "get_org_analytics", { ...args, group_by: "company" });
    expect(again.groups).toEqual(byDefault.groups);
    expect(again.group_by).toBe("company");
    const manager = await ok(admin, "get_org_analytics", { ...args, group_by: "manager" });
    expect(manager).toMatchObject({ group_by: "manager", groups: [{ label: "No manager" }] });
    // The CSV's name of the manager line is the same grouping.
    expect(await ok(admin, "get_org_analytics", { ...args, group_by: "manager_line" })).toEqual(
      manager,
    );
    // A name of an object property is only an attribute that nobody has.
    expect(
      await ok(admin, "get_org_analytics", { ...args, group_by: "constructor" }),
    ).toMatchObject({ group_by: "constructor", groups: [{ label: "No constructor" }] });

    const old = await call(admin, "get_org_analytics", {
      start_date: "2026-01-05",
      end_date: "2026-01-11",
    });
    expect(old.text).toMatch(/12 weeks/);
  });

  it("cut a large report to a bounded size and say how many groups were left out", async () => {
    const { db, ok } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    for (let i = 0; i < 300; i++) member(db, `person${i}@example.com`, admin);
    const r = await ok(admin, "get_org_analytics", {
      start_date: "2026-08-01",
      end_date: "2026-11-27",
      group_by: "person",
    });
    const groups = r.groups as unknown[];
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.length + (r.truncated as number)).toBe(301);
    expect(r.truncated).toBeGreaterThan(0);
    expect(JSON.stringify(groups).length).toBeLessThanOrEqual(MAX_CHARS);
  });
  it("keep every group of a quarter: five people over 12 and over 18 weeks", async () => {
    const { db, ok } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const people = [admin, ...[1, 2, 3, 4].map((i) => member(db, `p${i}@example.com`, admin))];
    // A connected calendar each, so every person has values.
    for (const p of people)
      run(
        db,
        "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES (?, ?, 'caldav', ?, ?, '{}', ?)",
        `acc-${p.id}`,
        p.id,
        p.id,
        p.email,
        T0,
      );
    for (const [from, to, periods] of [
      ["2026-07-27", "2026-10-18", 12],
      ["2026-07-27", "2026-11-23", 18],
    ] as const) {
      const r = await ok(admin, "get_org_analytics", {
        start_date: from,
        end_date: to,
        group_by: "person",
      });
      expect(r.truncated).toBe(0);
      const groups = r.groups as { people: number; values: (number[] | null)[] }[];
      expect(groups).toHaveLength(5);
      expect((r.periods as unknown[]).length).toBe(periods);
      for (const g of groups) {
        expect(g.people).toBe(1);
        expect(g.values).toHaveLength(periods);
        expect(g.values[0]).toHaveLength((r.metrics as string[]).length);
      }
    }
  });
});

describe("the team tools through the MCP server", () => {
  it("refuse organization analytics to a member and give a user of another team none of this team's absences", async () => {
    const { db, viaMcp } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    const out = ensureUser(db, "x@example.com", "Xena", T0);
    oooCalendar(db, "ooo-1", membership(db, admin.id).team.id, admin.id);
    oooCalendar(db, "ooo-2", membership(db, out.id).team.id, out.id);
    absence(db, "ooo-1", bob, "2026-10-21", "2026-10-23");
    absence(db, "ooo-2", out, "2026-10-21", "2026-10-22");
    const range = { start_date: "2026-10-12", end_date: "2026-10-18" };

    const refused = await viaMcp(bob, "get_org_analytics", range);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toMatch(/^Only analytics admins/);
    expect((await viaMcp(admin, "get_org_analytics", range)).isError).toBeFalsy();

    const week = { start_date: "2026-10-19", end_date: "2026-10-25" };
    const theirs = await viaMcp(out, "list_team_time_away", week);
    expect(theirs.content[0]?.text).toContain("x@example.com");
    expect(theirs.content[0]?.text).not.toContain("b@example.com");
    expect((await viaMcp(admin, "list_team_time_away", week)).content[0]?.text).toContain(
      "b@example.com",
    );
  });
});

describe("automation ideas", () => {
  it("put each own series in one list, with one rule for the user's addresses, and skip series that a habit, Tempoloom or a meeting covers", async () => {
    const { db, ok } = setup();
    const u = ensureUser(db, "login@example.com", "U", T0);
    const hours =
      one<{ id: string }>(db, "SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1", u.id)?.id ??
      "";
    // The calendar account's address is not the sign-in address.
    run(
      db,
      "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES ('a1', ?, 'caldav', 'x', 'cal@example.com', '{}', ?)",
      u.id,
      T0,
    );
    run(
      db,
      "INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability) VALUES ('c1', 'a1', 'p1', 'Work', 1, 1, 1)",
    );
    const series = (
      id: string,
      title: string,
      attendees: string[],
      opts: { tl?: boolean; organizerSelf?: boolean } = {},
    ) => {
      for (const week of [1, 2])
        run(
          db,
          `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, attendees, attendee_count,
             organizer_self, recurring_id, private_props)
           VALUES ('c1', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          `${id}#${week}`,
          title,
          T0 + week * 7 * DAY + DAY,
          T0 + week * 7 * DAY + DAY + HOUR,
          JSON.stringify(attendees),
          attendees.length,
          opts.organizerSelf === false ? 0 : 1,
          id,
          JSON.stringify(opts.tl ? { tl: "1" } : {}),
        );
    };
    series("s-sync", "Weekly sync", ["cal@example.com", "dana@example.com"]);
    // Only the user's own account address as attendee: solo, so a habit and not a meeting.
    series("s-self", "Plan the week", ["cal@example.com"]);
    series("s-run", "Morning run", []);
    series("s-read", "Reading", []);
    series("s-tl", "Planned by Tempoloom", [], { tl: true });
    series("s-guest", "Their standup", ["cal@example.com", "eve@example.com"], {
      organizerSelf: false,
    });
    series("s-adopted", "Adopted sync", ["cal@example.com", "fay@example.com"]);
    run(
      db,
      `INSERT INTO habits (id, user_id, title, level, rank, hours_set_id, ideal_minute, min_minutes, max_minutes,
         frequency, defense, when_unplaceable, created_at, rules_changed_at)
       VALUES ('h1', ?, 'reading', 2, 0, ?, 540, 30, 60, '{}', 'adaptive', 'remove', ?, ?)`,
      u.id,
      hours,
      T0,
      T0,
    );
    run(
      db,
      `INSERT INTO meetings (id, user_id, title, level, frequency, ideal_minute, duration_minutes, shortest_minutes,
         hours_mode, hours_set_id, defense, when_unplaceable, created_at, rules_changed_at,
         series_calendar_id, series_event_id)
       VALUES ('m1', ?, 'Adopted sync', 2, '{}', 600, 30, 30, 'everyone', ?, 'adaptive', 'remove', ?, ?, 'c1', 's-adopted')`,
      u.id,
      hours,
      T0,
      T0,
    );

    const r = (await ok(u, "suggest_automations")) as {
      flexible_meetings: { title: string; attendees: string[] }[];
      habits: { title: string; days: string[] }[];
    };
    expect(r.flexible_meetings).toEqual([
      expect.objectContaining({ title: "Weekly sync", attendees: ["dana@example.com"] }),
    ]);
    expect(r.habits.map((h) => h.title).sort()).toEqual(["Morning run", "Plan the week"]);
    expect(r.habits[0]?.days).toEqual(["Tuesday"]);

    // The other callers of the same rule: the /meetings adopt list and the daily email (NTF-30).
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("user", u);
      await next();
    });
    app.route(
      "/api",
      meetingRoutes(db, { request: () => {} } as unknown as SyncService, () => T0),
    );
    const listed = (await (await app.request("/api/meetings/series")).json()) as {
      series: { title: string; attendees: string[] }[];
    };
    expect(listed.series.map((x) => [x.title, x.attendees])).toEqual([
      ["Weekly sync", ["dana@example.com"]],
    ]);
    updatePrefs(db, u.id, { dailyTime: "08:00", atRiskDigest: false, newSeriesEmail: true });
    run(db, "UPDATE users SET first_sign_in_at = ? WHERE id = ?", T0 - DAY, u.id);
    const sent: Message[] = [];
    let clock = T0 - HOUR;
    const worker = new DailyMailWorker({
      db,
      mailer: { configured: true, send: async (m) => void sent.push(m) },
      now: () => clock,
      baseUrl: "http://localhost",
      intervalMs: 60_000,
      weeklyReports: false,
    });
    // The first tick sets the send time (08:00); the second comes after it.
    await worker.tick();
    clock = T0 + 5 * 60_000;
    await worker.tick();
    const offer = sent.find((m) => m.subject === "Recurring meetings you could make flexible");
    expect(offer?.text).toContain("Weekly sync");
    expect(offer?.text).not.toContain("Plan the week");
  });
});

describe("help search", () => {
  it("matches the forms of one word and leaves out a single word used in passing", () => {
    expect(searchHelp("my meetings are not placed")[0]?.slug).toBe("meeting-not-placed");
    expect(searchHelp("focused time missing")[0]?.slug).toBe("focus-not-placed");
    expect(searchHelp("My habit keeps coming back after I delete its event")[0]?.slug).toBe(
      "events-come-back",
    );
    expect(searchHelp("Why is my focus time not placed?")[0]?.slug).toBe("focus-not-placed");
    expect(searchHelp("copy appears twice")[0]?.slug).toBe("copies-twice");
    expect(searchHelp("focus")[0]?.slug).toBe("focus-not-placed");
    // A word that names the page's topic is enough.
    expect(searchHelp("buffers missing")[0]?.slug).toBe("buffer-missing");
    expect(searchHelp("my colors are gone")[0]?.slug).toBe("colors");
    expect(searchHelp("why are my habits not scheduled")[0]?.slug).toBe("item-not-placed");
    expect(stem("series")).toBe("series");
    expect(searchHelp("order")).toEqual([]);
    expect(searchHelp("Can Tempoloom order pizza?")).toEqual([]);
    expect(searchHelp("pizza recipe")).toEqual([]);
  });

  it("gives the page text and link to the model", async () => {
    const { db, ok } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const r = await ok(u, "search_help", { query: "copies appear twice" });
    expect((r.pages as { link: string }[])[0]?.link).toBe("/help/copies-twice");
  });
});

describe("task proposal", () => {
  it("stages the New task request as the chat; no task exists until apply", async () => {
    const { db, ok } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const r = await ok(u, "propose_create_task", {
      title: "Write report",
      minutes: 100,
      priority: 2,
      due: "2026-10-23T17:00:00+00:00",
    });
    expect(r.review_url).toBe("http://localhost:3000/?week=2026-10-19");
    expect(all(db, "SELECT id FROM tasks WHERE user_id = ?", u.id)).toEqual([]);
    const [staged] = all<{ source: string; after: string; summary: string; state: string }>(
      db,
      "SELECT source, after, summary, state FROM staged_changes WHERE user_id = ?",
      u.id,
    );
    expect(staged?.source).toBe("assistant_chat");
    expect(staged?.state).toBe("pending");
    expect(staged?.summary).toMatch(/^New task “Write report” · 105 min · P2 · due /);
    expect(JSON.parse(staged?.after ?? "{}")).toEqual({
      method: "POST",
      path: "/api/tasks",
      body: JSON.stringify({
        title: "Write report",
        minutes: 105,
        level: 2,
        dueAt: Date.parse("2026-10-23T17:00:00Z"),
      }),
    });
  });

  it("apply refuses a proposal whose due date passed: POST /api/tasks checks the due date against the start", async () => {
    const { db, ok, preview, setNow } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const fine = (await ok(u, "propose_create_task", {
      title: "Soon",
      due: "2026-10-19T12:00:00+00:00",
    })) as { id: string };
    const late = (await ok(u, "propose_create_task", {
      title: "Too late",
      due: "2026-10-19T09:00:00+00:00",
    })) as { id: string };
    // Two hours later: "Too late" would start after its due date.
    setNow(T0 + 2 * HOUR);
    const result = await preview.apply(u.id, [fine.id, late.id]);
    expect(result.applied.map((x) => x.id)).toEqual([fine.id]);
    expect(result.failed).toEqual([
      expect.objectContaining({ id: late.id, error: "Due date must be after the start date" }),
    ]);
    expect(all<{ title: string }>(db, "SELECT title FROM tasks").map((t) => t.title)).toEqual([
      "Soon",
    ]);
  });
});

describe("dry runs", () => {
  it("run one at a time on the shared connection: parallel task proposals all stage, with their chunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tl-dry-"));
    try {
      const { db, call } = setup(join(dir, "tempoloom.db"));
      const u = ensureUser(db, "u@example.com", "U", T0);
      const results = await Promise.all(
        ["Task A", "Task B", "Task C"].map((title) =>
          call(u, "propose_create_task", { title, minutes: 60 }),
        ),
      );
      expect(results.map((r) => (r.isError ? r.text : "ok"))).toEqual(["ok", "ok", "ok"]);
      const staged = all<{ impact: string }>(
        db,
        "SELECT impact FROM staged_changes WHERE user_id = ? ORDER BY summary",
        u.id,
      );
      expect(staged).toHaveLength(3);
      for (const row of staged) {
        const impact = JSON.parse(row.impact) as { start: number; end: number }[];
        expect(impact.reduce((m, c) => m + (c.end - c.start), 0)).toBe(HOUR);
      }
      // The dry runs were rolled back: no task exists.
      expect(all(db, "SELECT id FROM tasks")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
