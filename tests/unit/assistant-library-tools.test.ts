// The chat tools of the library's prompt entries (src/server/assistant/library-tools.ts)
// and the planner's offer of assistant chat (src/server/api/help.ts, rule 15 of
// teams-settings-templates.md), on an in-memory database.
//
// Ways it can fail:
// 1. A new priority is written at once instead of staged, or is staged for
//    another user's task or a done task; the dry run's plan changes or its
//    error do not reach the proposal.
// 2. Applying a re-ranking skips its later changes as stale, because an
//    earlier one touched every open task; or a task that really changed gets
//    the new priority anyway, or a stale message names an automation; or a
//    stale check of an unknown shape is skipped instead of failing the change.
// 3. Team stats reach the model for a team below 3 members, for a range the
//    team stats page refuses, or from another team; or they name people.
// 4. The chat offer shows without a model, after the user chatted, with a
//    usage limit of 0, or to a member who cannot turn the team switch on.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { helpRoutes } from "../../src/server/api/help.ts";
import type { AppEnv } from "../../src/server/app.ts";
import type { ChatRefusal } from "../../src/server/assistant/chat.ts";
import { saveTurn } from "../../src/server/assistant/store.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import {
  createPreview,
  decide,
  type PreviewDeps,
  type StageInput,
  stage,
} from "../../src/server/preview.ts";
import { type RequestBefore, taskLevelBefore } from "../../src/server/preview-kinds.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");
const HOUR = 3_600_000;

/**
 * The chat tools on an in-memory database. The dry run and apply replay
 * PATCH /api/tasks/:id on small apps: the dry one makes the task longer (a plan
 * change) or refuses task "t-bad"; the apply one sets the level and, as a lower
 * priority does in the real route (task-order.ts), touches every open task.
 */
function setup() {
  const db = openDb(":memory:");
  const now = () => T0;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const dryApp = new Hono<AppEnv>();
  dryApp.patch("/api/tasks/:id", (c) => {
    if (c.req.param("id") === "t-bad")
      return c.json({ issues: [{ message: "Due date must be after the start date" }] }, 400);
    run(db, "UPDATE tasks SET total_minutes = 240 WHERE id = ?", c.req.param("id"));
    return c.json({ ok: true });
  });
  const app = new Hono<AppEnv>();
  app.patch("/api/tasks/:id", async (c) => {
    const { level } = (await c.req.json()) as { level: number };
    run(db, "UPDATE tasks SET level = ? WHERE id = ?", level, c.req.param("id"));
    run(db, "UPDATE tasks SET rules_changed_at = rules_changed_at + 1 WHERE status = 'open'");
    return c.json({ ok: true });
  });
  const preview = createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => app,
    dry: () => ({ app: dryApp, db }),
  } as unknown as PreviewDeps);
  // Through chatTools: the same list and ref mapping the chat uses.
  const tools = chatTools({ db, preview, baseUrl: "http://localhost:3000", now });
  const byName = (name: string) => {
    const t = tools.find((x) => x.tool.name === name);
    if (!t) throw new Error(`no ${name}`);
    return t;
  };
  const caller = (u: User) => ({ user: u, client: "", source: "assistant_chat" as const });
  return { db, user, preview, byName, caller };
}

function addTask(db: Db, userId: string, id: string, level = 2, status = "open") {
  const hours =
    one<{ id: string }>(db, "SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1", userId)?.id ??
    "";
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, due_at, hours_set_id, created_at, rules_changed_at, status)
     VALUES (?, ?, ?, ?, 60, 30, 60, ?, NULL, ?, ?, ?, ?)`,
    id,
    userId,
    `Report ${id}`,
    level,
    T0,
    hours,
    T0,
    T0,
    status,
  );
}

const staged = (db: Db) =>
  all<{
    id: string;
    kind: string;
    source: string;
    target: string;
    before: string;
    after: string;
    impact: string;
  }>(
    db,
    "SELECT id, kind, source, target, before, after, impact FROM staged_changes ORDER BY rowid",
  );
const levelOf = (db: Db, id: string) =>
  one<{ level: number }>(db, "SELECT level FROM tasks WHERE id = ?", id)?.level;

describe("propose_task_priority", () => {
  it("stages the new priority as a replay of the task edit, with the dry run's plan change, and changes nothing", async () => {
    const { db, user, byName, caller } = setup();
    addTask(db, user.id, "t1");
    const t = byName("propose_task_priority");
    const r = await callTool(t.tool, caller(user), { task_id: "t1", priority: 1 });
    if (r.isError) throw new Error(r.text);
    expect(r.data.summary).toBe('New priority P2 to P1 for task "Report t1"');
    // The chat links the proposal to its message, as for the MCP stage tools.
    expect(t.ref?.(r.data)).toEqual({ kind: "proposal", id: r.data.id });
    expect(r.data.review_url).toMatch(/^http:\/\/localhost:3000\/\?week=/);
    const [s] = staged(db);
    expect(s?.kind).toBe("request");
    expect(s?.source).toBe("assistant_chat");
    expect(s?.target).toBe("tasks:t1");
    expect(JSON.parse(s?.before ?? "")).toEqual({
      kind: "task_level",
      task: "t1",
      title: "Report t1",
      level: 2,
    });
    expect(JSON.parse(s?.after ?? "")).toEqual({
      method: "PATCH",
      path: "/api/tasks/t1",
      body: JSON.stringify({ level: 1 }),
    });
    // The dry run ran: its plan change is the proposal's impact, and it was rolled back.
    expect(JSON.parse(s?.impact ?? "[]")).not.toEqual([]);
    expect(
      one<{ level: number; total_minutes: number }>(
        db,
        "SELECT level, total_minutes FROM tasks WHERE id = 't1'",
      ),
    ).toEqual({ level: 2, total_minutes: 60 });
  });

  it("gives the dry run's reason when the task edit is refused, and stages nothing", async () => {
    const { db, user, byName, caller } = setup();
    addTask(db, user.id, "t-bad");
    const r = await callTool(byName("propose_task_priority").tool, caller(user), {
      task_id: "t-bad",
      priority: 1,
    });
    expect(r).toMatchObject({
      isError: true,
      text: "Tempoloom cannot make this change: Due date must be after the start date",
    });
    expect(staged(db)).toEqual([]);
  });

  it("keeps a title with quotes inside the quotes of the summary", async () => {
    const { db, user, byName, caller } = setup();
    addTask(db, user.id, "t1");
    run(db, "UPDATE tasks SET title = ? WHERE id = 't1'", 'A": P4 to P1 "B');
    const r = await callTool(byName("propose_task_priority").tool, caller(user), {
      task_id: "t1",
      priority: 3,
    });
    if (r.isError) throw new Error(r.text);
    expect(r.data.summary).toBe('New priority P2 to P3 for task "A\\": P4 to P1 \\"B"');
  });

  it("refuses another user's task, a done task and the same priority, and stages nothing", async () => {
    const { db, user, byName, caller } = setup();
    const other = ensureUser(db, "other@example.com", "Other", T0) as User;
    addTask(db, other.id, "t-other");
    addTask(db, user.id, "t-done", 2, "done");
    addTask(db, user.id, "t-same");
    const t = byName("propose_task_priority").tool;
    for (const [task_id, priority, text] of [
      ["t-other", 1, "No task t-other"],
      ["t-done", 1, "The task is done"],
      ["t-same", 2, "The task already has P2"],
    ] as const) {
      const r = await callTool(t, caller(user), { task_id, priority });
      expect(r).toMatchObject({ isError: true, text });
    }
    expect(staged(db)).toEqual([]);
  });

  it("applies every change of a re-ranking, also after one that touched every open task", async () => {
    const { db, user, preview, byName, caller } = setup();
    for (const [id, level] of [
      ["a", 1],
      ["b", 4],
      ["c", 2],
    ] as const)
      addTask(db, user.id, id, level);
    const t = byName("propose_task_priority").tool;
    // Lower first: applying it touches b and c too.
    for (const [task_id, priority] of [
      ["a", 4],
      ["b", 1],
      ["c", 3],
    ] as const)
      expect((await callTool(t, caller(user), { task_id, priority })).isError).toBe(false);
    const ids = staged(db).map((x) => x.id);
    for (const id of ids) decide(db, user.id, id, "accepted", T0);
    const out = await preview.apply(user.id, ids);
    expect(out.stale).toEqual([]);
    expect(out.failed).toEqual([]);
    expect(out.applied).toHaveLength(3);
    expect(["a", "b", "c"].map((id) => levelOf(db, id))).toEqual([4, 1, 3]);
  });

  it("skips a new priority as stale when that task changed, and names the task", async () => {
    const { db, user, preview, byName, caller } = setup();
    for (const id of ["moved", "done", "gone"]) addTask(db, user.id, id);
    const t = byName("propose_task_priority").tool;
    for (const task_id of ["moved", "done", "gone"])
      await callTool(t, caller(user), { task_id, priority: 1 });
    run(db, "UPDATE tasks SET level = 3 WHERE id = 'moved'");
    run(db, "UPDATE tasks SET status = 'done' WHERE id = 'done'");
    run(db, "DELETE FROM tasks WHERE id = 'gone'");
    const ids = staged(db).map((x) => x.id);
    for (const id of ids) decide(db, user.id, id, "accepted", T0);
    const out = await preview.apply(user.id, ids);
    expect(out.applied).toEqual([]);
    expect(out.stale.map((x) => x.reason)).toEqual([
      'The task "Report moved" got another priority after this change was staged',
      'The task "Report done" was done after this change was staged',
      'The task "Report gone" was deleted after this change was staged',
    ]);
    expect(levelOf(db, "moved")).toBe(3);
  });

  it("still checks a change staged before the kind tag, and fails one whose check it does not know", async () => {
    const { db, user, preview } = setup();
    addTask(db, user.id, "old");
    addTask(db, user.id, "odd");
    const replay = (id: string) => ({
      method: "PATCH",
      path: `/api/tasks/${id}`,
      body: JSON.stringify({ level: 1 }),
    });
    // As stored before the tag: the same fields without `kind`.
    const legacy = stage(
      db,
      user.id,
      {
        source: "assistant_chat",
        kind: "request",
        before: { task: "old", title: "Report old", level: 2 } as unknown as RequestBefore,
        after: replay("old"),
        impact: [],
        summary: "old",
      },
      T0,
    );
    const odd = stage(
      db,
      user.id,
      {
        source: "assistant_chat",
        kind: "request",
        before: { taskId: "odd", level: 2 } as unknown as RequestBefore,
        after: replay("odd"),
        impact: [],
        summary: "odd",
      },
      T0,
    );
    run(db, "UPDATE tasks SET level = 3 WHERE id = 'old'");
    for (const c of [legacy, odd]) decide(db, user.id, c.id, "accepted", T0);
    const out = await preview.apply(user.id, [legacy.id, odd.id]);
    expect(out.applied).toEqual([]);
    expect(out.stale.map((x) => x.summary)).toEqual(["old"]);
    expect(out.failed.map((x) => x.summary)).toEqual(["odd"]);
    // Neither was replayed.
    expect([levelOf(db, "old"), levelOf(db, "odd")]).toEqual([3, 2]);
  });

  it("only takes a tagged stale check for a request (typecheck)", () => {
    // @ts-expect-error: a request's stale check must be a RequestBefore (taskLevelBefore and others).
    const input: StageInput = {
      source: "assistant_chat",
      kind: "request",
      before: { task: "t1", title: "x", level: 2 },
      after: {},
      impact: [],
      summary: "",
    };
    expect(input.kind).toBe("request");
    expect(taskLevelBefore({ id: "t1", title: "x", level: 2 })).toEqual({
      kind: "task_level",
      task: "t1",
      title: "x",
      level: 2,
    });
  });
});

/** A member with a calendar and one meeting of `minutes` with `with` on the Monday of the range. */
function member(db: Db, email: string, teamId: string | null, minutes: number, withEmail: string) {
  const u = ensureUser(db, email, `Name ${email}`, T0) as User;
  if (teamId)
    run(db, "UPDATE team_members SET team_id = ?, role = 'member' WHERE user_id = ?", teamId, u.id);
  run(
    db,
    "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES (?, ?, 'caldav', ?, ?, '{}', ?)",
    `acc-${email}`,
    u.id,
    email,
    email,
    T0,
  );
  run(
    db,
    "INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability) VALUES (?, ?, ?, 'Work', 1, 1, 1)",
    `cal-${email}`,
    `acc-${email}`,
    `p-${email}`,
  );
  const start = Date.parse("2026-10-12T09:00:00Z");
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, location, start_ms, end_ms, attendees, attendee_count, organizer_self, self_response)
     VALUES (?, ?, ?, '', ?, ?, ?, 2, 1, 'accepted')`,
    `cal-${email}`,
    `ev-${email}`,
    `Secret sync of ${email}`,
    start,
    start + (minutes / 60) * HOUR,
    JSON.stringify([email, withEmail]),
  );
  return u;
}
const teamOf = (db: Db, userId: string) =>
  one<{ team_id: string }>(db, "SELECT team_id FROM team_members WHERE user_id = ?", userId)
    ?.team_id ?? "";

describe("get_team_stats", () => {
  it("gives no values below 3 members and refuses ranges the team stats page refuses", async () => {
    const { user, byName, caller } = setup();
    const t = byName("get_team_stats").tool;
    const r = await callTool(t, caller(user), {
      start_date: "2026-10-12",
      end_date: "2026-10-18",
    });
    if (r.isError) throw new Error(r.text);
    expect(r.data).toMatchObject({ enough: false, minutes_per_week: null });
    for (const [start_date, end_date, text] of [
      ["2026-10-18", "2026-10-12", "end_date is before start_date"],
      [
        "2026-05-01",
        "2026-10-18",
        "The range is longer than the team stats page allows; ask for a shorter range",
      ],
      [
        "2026-07-01",
        "2026-07-08",
        "The range starts earlier than the team stats page allows; ask for a later start",
      ],
    ] as const) {
      const e = await callTool(t, caller(user), { start_date, end_date });
      expect(e).toMatchObject({ isError: true, text });
    }
  });

  it("reads only the caller's team: each team gets its own means, with no names, emails or titles", async () => {
    const { db, byName, caller } = setup();
    // Team A meets 1 h per person, team B 5 h; both have 3 members with a calendar.
    const a1 = member(db, "a1@a.example", null, 60, "a2@a.example");
    member(db, "a2@a.example", teamOf(db, a1.id), 60, "a1@a.example");
    member(db, "a3@a.example", teamOf(db, a1.id), 60, "a1@a.example");
    const b1 = member(db, "b1@b.example", null, 300, "b2@b.example");
    member(db, "b2@b.example", teamOf(db, b1.id), 300, "b1@b.example");
    member(db, "b3@b.example", teamOf(db, b1.id), 300, "b1@b.example");
    const t = byName("get_team_stats").tool;
    const read = async (u: User) => {
      const r = await callTool(t, caller(u), {
        start_date: "2026-10-12",
        end_date: "2026-10-18",
      });
      if (r.isError) throw new Error(r.text);
      return r.data as { enough: boolean; minutes_per_week: Record<string, number> };
    };
    const [a, b] = [await read(a1), await read(b1)];
    expect([a.enough, b.enough]).toEqual([true, true]);
    expect([a.minutes_per_week.meetings, b.minutes_per_week.meetings]).toEqual([60, 300]);
    // No field holds a person or an event: any name, email or title in it fails here.
    const text = JSON.stringify(a);
    for (const s of ["a1@", "a2@", "a3@", "b1@", "Name ", "Secret sync", "example"])
      expect(text).not.toContain(s);
    expect(Object.keys(a).sort()).toEqual([
      "enough",
      "heaviest_meeting_day",
      "lightest_meeting_day",
      "meeting_hours_per_week",
      "members_included",
      "members_without_calendar",
      "minutes_per_week",
      "most_productive_day",
    ]);
  });
});

describe("the planner's chat offer", () => {
  function hints(refusal: ChatRefusal | null) {
    const { db, user } = setup();
    const app = new Hono<AppEnv>();
    let as = user;
    app.use("*", async (c, next) => {
      c.set("user", as);
      await next();
    });
    app.route(
      "/api",
      helpRoutes(db, undefined, () => T0, {} as SyncService, { refusal: () => refusal }),
    );
    const get = async (u: User = user) => {
      as = u;
      const res = await app.request("http://x/api/hints");
      return (await res.json()) as { hints: string[]; chatOff?: boolean };
    };
    return { db, user, get };
  }
  const disabled: ChatRefusal = { error: "chat_disabled", message: "off", admins: [] };

  it("offers chat until the user's first conversation", async () => {
    const { db, user, get } = hints(null);
    expect(await get()).toMatchObject({ hints: expect.arrayContaining(["assistant-chat"]) });
    expect((await get()).chatOff).toBe(false);
    saveTurn(db, user.id, null, [{ role: "user", content: "hi" }], T0);
    expect((await get()).hints).not.toContain("assistant-chat");
  });

  it("does not offer chat when a usage limit of 0 refuses every message", async () => {
    const zero: ChatRefusal = { error: "quota", message: "limit", limit: 0, resetsAt: T0 };
    expect((await hints(zero).get()).hints).not.toContain("assistant-chat");
    const used: ChatRefusal = { error: "quota", message: "limit", limit: 5, resetsAt: T0 };
    expect((await hints(used).get()).hints).toContain("assistant-chat");
  });

  it("does not offer chat without a model", async () => {
    const { get } = hints({ error: "not_configured", message: "no" });
    expect((await get()).hints).not.toContain("assistant-chat");
  });

  it("while the team switch is off, offers to turn it on to an admin only", async () => {
    const { db, user, get } = hints(disabled);
    expect(await get()).toMatchObject({ chatOff: true });
    const member = ensureUser(db, "member@example.com", "Member", T0) as User;
    const team = one<{ team_id: string }>(
      db,
      "SELECT team_id FROM team_members WHERE user_id = ?",
      user.id,
    );
    run(
      db,
      "UPDATE team_members SET team_id = ?, role = 'member' WHERE user_id = ?",
      team?.team_id ?? "",
      member.id,
    );
    expect((await get(member)).hints).not.toContain("assistant-chat");
  });
});
