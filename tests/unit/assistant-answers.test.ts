// The read tools and the task proposal of assistant chat
// (src/server/assistant/answers.ts), called as the chat calls them, on an
// in-memory database.
//
// Ways it can fail:
// 1. A read tool gives data that the caller cannot see in the app: another
//    user's tasks, another team's absences, organization analytics to a member.
// 2. The task proposal creates the task before approval, or stages a body
//    that the tasks API would refuse at apply time.
// 3. The help search finds nothing for a plain question, or answers a
//    question the help does not cover.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { all, type Db, openDb, run } from "../../src/server/db.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";
import { createTask } from "../../src/server/tasks.ts";
import { membership } from "../../src/server/teams.ts";
import { searchHelp } from "../../src/shared/help-pages.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const DAY = 86_400_000;

function setup() {
  const db = openDb(":memory:");
  const now = () => T0;
  const preview = createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => new Hono(),
    dry: () => null,
  } as unknown as PreviewDeps);
  const tools = chatTools({ db, preview, baseUrl: "http://localhost:3000", now });
  const call = async (user: User, name: string, args: unknown = {}) => {
    const t = tools.find((x) => x.tool.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return callTool(t.tool, { user, client: "", source: "assistant_chat" }, args);
  };
  return { db, call };
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

describe("assistant chat answers", () => {
  it("task suggestions list only the caller's tasks, the best first", async () => {
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

  it("who is away lists the absences of the caller's own team only", async () => {
    const { db, call } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    const out = ensureUser(db, "x@example.com", "Xena", T0);
    const ours = membership(db, admin.id).team.id;
    const theirs = membership(db, out.id).team.id;
    for (const [id, team, owner] of [
      ["ooo-1", ours, admin.id],
      ["ooo-2", theirs, out.id],
    ] as const)
      run(
        db,
        "INSERT INTO ooo_calendars (id, team_id, name, owner_id, created_at) VALUES (?, ?, 'OOO', ?, ?)",
        id,
        team,
        owner,
        T0,
      );
    absence(db, "ooo-1", bob, "2026-10-21", "2026-10-23");
    absence(db, "ooo-1", bob, "2026-12-01", "2026-12-02");
    absence(db, "ooo-2", out, "2026-10-21", "2026-10-22");

    const r = await call(admin, "list_team_time_away", {
      start_date: "2026-10-19",
      end_date: "2026-10-25",
    });
    if (r.isError) throw new Error(r.text);
    expect(r.data.absences).toEqual([
      { name: "b", email: "b@example.com", start: "2026-10-21", end: "2026-10-22", all_day: true },
    ]);
    // Another team's member sees none of these absences, only their own team's.
    const other = await call(out, "list_team_time_away", {
      start_date: "2026-10-19",
      end_date: "2026-10-25",
    });
    if (other.isError) throw new Error(other.text);
    expect(other.text).not.toContain("b@example.com");
    expect((other.data.absences as { email: string }[]).map((x) => x.email)).toEqual([
      "x@example.com",
    ]);
  });

  it("organization analytics answer team admins and refuse members", async () => {
    const { db, call } = setup();
    const admin = ensureUser(db, "a@example.com", "Ann", T0);
    const bob = member(db, "b@example.com", admin);
    const args = { start_date: "2026-10-12", end_date: "2026-10-18" };
    const refused = await call(bob, "get_org_analytics", args);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toMatch(/Only analytics admins/);
    const r = await call(admin, "get_org_analytics", args);
    if (r.isError) throw new Error(r.text);
    expect(r.data).toMatchObject({
      from: "2026-10-12",
      to: "2026-10-18",
      group_by: "company",
      groups: [{ label: "Company", people: 0, without_calendar: 2 }],
    });
    // Too old for the reports: 12 weeks of history.
    const old = await call(admin, "get_org_analytics", {
      start_date: "2026-01-05",
      end_date: "2026-01-11",
    });
    expect(old.text).toMatch(/12 weeks/);
  });

  it("help search finds the help page of a question and nothing for another topic", async () => {
    expect(searchHelp("My habit keeps coming back after I delete its event")[0]?.slug).toBe(
      "events-come-back",
    );
    expect(searchHelp("Why is my focus time not placed?")[0]?.slug).toBe("focus-not-placed");
    expect(searchHelp("pizza recipe")).toEqual([]);
    expect(searchHelp("Can Tempoloom order pizza?")).toEqual([]);
    const { db, call } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const r = await call(u, "search_help", { query: "copies appear twice" });
    if (r.isError) throw new Error(r.text);
    expect((r.data.pages as { link: string }[])[0]?.link).toBe("/help/copies-twice");
  });

  it("a task by chat is only proposed: no task exists until apply, and a bad body is refused at once", async () => {
    const { db, call } = setup();
    const u = ensureUser(db, "u@example.com", "U", T0);
    const r = await call(u, "propose_create_task", {
      title: "Write report",
      minutes: 100,
      priority: 2,
      due: "2026-10-23T17:00:00+00:00",
    });
    if (r.isError) throw new Error(r.text);
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
    const bad = await call(u, "propose_create_task", {
      title: "Too late",
      due: "2026-10-19T09:00:00+00:00",
      start_after: "2026-10-20T09:00:00+00:00",
    });
    expect(bad).toMatchObject({ isError: true, text: "The due date must be after the start" });
    expect(all(db, "SELECT id FROM staged_changes WHERE user_id = ?", u.id)).toHaveLength(1);
  });
});
