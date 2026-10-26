// The chat tools of the library's prompt entries (src/server/assistant/library-tools.ts)
// and the planner's offer of assistant chat (src/server/api/help.ts, rule 15 of
// teams-settings-templates.md), on an in-memory database.
//
// Ways it can fail:
// 1. A new priority is written at once instead of staged, or is staged for
//    another user's task or a done task.
// 2. Team stats reach the model for a team below 3 members, or for a range the
//    team stats page refuses.
// 3. The chat offer shows without a model, after the user chatted, or to a
//    member who cannot turn the team switch on.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { helpRoutes } from "../../src/server/api/help.ts";
import type { AppEnv } from "../../src/server/app.ts";
import type { ChatRefusal } from "../../src/server/assistant/chat.ts";
import { libraryTools } from "../../src/server/assistant/library-tools.ts";
import { saveTurn } from "../../src/server/assistant/store.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { callTool } from "../../src/server/mcp/rpc.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const now = () => T0;
  const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
  const preview = createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now,
    app: () => new Hono(),
    dry: () => null,
  } as unknown as PreviewDeps);
  const tools = libraryTools({ db, preview, baseUrl: "http://localhost:3000", now });
  const byName = (name: string) => {
    const t = tools.find((x) => x.tool.name === name);
    if (!t) throw new Error(`no ${name}`);
    return t.tool;
  };
  const caller = (u: User) => ({ user: u, client: "", source: "assistant_chat" as const });
  return { db, user, byName, caller };
}

function addTask(db: Db, userId: string, id: string, status = "open") {
  const hours =
    one<{ id: string }>(db, "SELECT id FROM hours_sets WHERE user_id = ? LIMIT 1", userId)?.id ??
    "";
  run(
    db,
    `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
       start_after, due_at, hours_set_id, created_at, rules_changed_at, status)
     VALUES (?, ?, 'Report', 2, 60, 30, 60, ?, NULL, ?, ?, ?, ?)`,
    id,
    userId,
    T0,
    hours,
    T0,
    T0,
    status,
  );
}

const staged = (db: Db) =>
  all<{ kind: string; source: string; target: string; before: string; after: string }>(
    db,
    "SELECT kind, source, target, before, after FROM staged_changes",
  );

describe("propose_task_priority", () => {
  it("stages the new priority as a replay of the task edit, with the task's version, and changes nothing", async () => {
    const { db, user, byName, caller } = setup();
    addTask(db, user.id, "t1");
    const r = await callTool(byName("propose_task_priority"), caller(user), {
      task_id: "t1",
      priority: 1,
    });
    if (r.isError) throw new Error(r.text);
    expect(r.data.summary).toBe("Priority of task “Report”: P2 to P1");
    const [s] = staged(db);
    expect(s?.kind).toBe("request");
    expect(s?.source).toBe("assistant_chat");
    expect(s?.target).toBe("tasks:t1");
    expect(JSON.parse(s?.before ?? "")).toEqual({ table: "tasks", id: "t1", rulesChangedAt: T0 });
    expect(JSON.parse(s?.after ?? "")).toEqual({
      method: "PATCH",
      path: "/api/tasks/t1",
      body: JSON.stringify({ level: 1 }),
    });
    expect(one<{ level: number }>(db, "SELECT level FROM tasks WHERE id = 't1'")?.level).toBe(2);
  });

  it("refuses another user's task, a done task and the same priority, and stages nothing", async () => {
    const { db, user, byName, caller } = setup();
    const other = ensureUser(db, "other@example.com", "Other", T0) as User;
    addTask(db, other.id, "t-other");
    addTask(db, user.id, "t-done", "done");
    addTask(db, user.id, "t-same");
    const t = byName("propose_task_priority");
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
});

describe("get_team_stats", () => {
  it("gives no values below 3 members and refuses ranges the team stats page refuses", async () => {
    const { user, byName, caller } = setup();
    const t = byName("get_team_stats");
    const r = await callTool(t, caller(user), {
      start_date: "2026-10-12",
      end_date: "2026-10-18",
    });
    if (r.isError) throw new Error(r.text);
    expect(r.data).toMatchObject({ enough: false, minutes_per_week: null });
    for (const [start_date, end_date, text] of [
      ["2026-10-18", "2026-10-12", "end_date is before start_date"],
      ["2026-05-01", "2026-10-18", "The range is too long: at most 120 days"],
      ["2026-07-01", "2026-07-08", "Team stats start at most 84 days before today"],
    ] as const) {
      const e = await callTool(t, caller(user), { start_date, end_date });
      expect(e).toMatchObject({ isError: true, text });
    }
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
