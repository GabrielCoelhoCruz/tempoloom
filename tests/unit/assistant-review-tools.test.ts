// The automation, policy and review tools of assistant chat
// (src/server/assistant/review-tools.ts), on an in-memory database.
//
// Ways it can fail:
// 1. A team member who is not an admin reads or stages team policies.
// 2. An automation or policy id of another user or team stages a change.
// 3. The review reads past its range limit, or a range that ends before it starts.
// 4. A video link goes on a meeting the user does not organize, or is not a video link.
// 5. A second fix of one event discards the first instead of merging; two meeting
//    check changes keep only the last; the chat does not say which proposal replaced
//    or merged another.
// 6. The daily review discards a change the user staged, turns preview mode on,
//    offers policy, automation or event-create tools, or counts toward the quota.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { createChat, REVIEW_TOOLS } from "../../src/server/assistant/chat.ts";
import { reviewTools } from "../../src/server/assistant/review-tools.ts";
import { chatTools } from "../../src/server/assistant/tools.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import { setInstanceLimit } from "../../src/server/limits.ts";
import type { Llm, LlmMessage } from "../../src/server/llm.ts";
import { type Caller, callTool, type Tool } from "../../src/server/mcp/rpc.ts";
import { mcpTools } from "../../src/server/mcp.ts";
import { createPreview, type PreviewDeps, previewMode } from "../../src/server/preview.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

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
  const update = mcpTools({ db, preview, baseUrl: "http://x", now }).find(
    (t) => t.name === "propose_update_event",
  ) as Tool;
  const tools = new Map(reviewTools({ db, preview, now, update }).map((t) => [t.name, t]));
  const admin = ensureUser(db, "admin@example.com", "Admin", T0) as User;
  const teamId =
    all<{ team_id: string }>(db, "SELECT team_id FROM team_members WHERE user_id = ?", admin.id)[0]
      ?.team_id ?? "";
  const member = ensureUser(db, "member@example.com", "Member", T0, teamId) as User;
  const other = ensureUser(db, "other@example.com", "Other", T0) as User;
  const call = (user: User, name: string, args: unknown) =>
    callTool(
      tools.get(name) as Tool,
      { user, client: "", source: "assistant_chat" } as Caller,
      args,
    );
  const staged = () => all(db, "SELECT id FROM staged_changes").length;
  return { db, admin, member, other, call, staged, preview, now };
}

describe("assistant review tools", () => {
  it("lets only team admins read and stage team policies (1)", async () => {
    const { admin, member, call, staged } = setup();
    const create = {
      action: "create",
      type: "focus_time",
      name: "Team focus",
      goal: { weeklyGoalMinutes: 480 },
    };
    expect((await call(member, "list_team_policies", {})).text).toMatch(/Only a team admin/);
    expect((await call(member, "propose_team_policy", create)).text).toMatch(/Only a team admin/);
    expect(staged()).toBe(0);
    const ok = await call(admin, "propose_team_policy", create);
    expect(ok.isError).toBe(false);
    expect(ok.isError ? null : ok.data.summary).toBe("New team policy “Team focus”");
    expect(staged()).toBe(1);
  });

  it("stages nothing for an automation or policy id of another user or team (2)", async () => {
    const { db, admin, other, call, staged } = setup();
    run(
      db,
      `INSERT INTO team_policies (id, team_id, type, name, scope, goal, enabled, started_at, created_at, updated_at)
       SELECT 'p1', team_id, 'focus_time', 'Theirs', '[]', '{}', 1, NULL, 0, 0 FROM team_members WHERE user_id = ?`,
      other.id,
    );
    const policy = await call(admin, "propose_team_policy", { action: "delete", id: "p1" });
    expect(policy.text).toMatch(/no policy p1/);
    const habit = await call(admin, "propose_automation", {
      action: "turn_off",
      type: "habit",
      id: "not-mine",
    });
    expect(habit.text).toMatch(/no habit not-mine/);
    expect(staged()).toBe(0);
  });

  it("limits the review range (3)", async () => {
    const { admin, call } = setup();
    expect(
      (await call(admin, "review_schedule", { from: "2026-10-20", to_exclusive: "2026-10-20" }))
        .text,
    ).toMatch(/must be after/);
    expect(
      (await call(admin, "review_schedule", { from: "2026-10-20", to_exclusive: "2026-12-20" }))
        .text,
    ).toMatch(/too long/);
    const ok = await call(admin, "review_schedule", {
      from: "2026-10-19",
      to_exclusive: "2026-10-26",
    });
    expect(ok.isError ? null : ok.data).toMatchObject({ issues: [], time_zone: "UTC" });
  });

  it("refuses a video link for an unknown event or a link of no video service (4)", async () => {
    const { admin, call, staged } = setup();
    expect(
      (
        await call(admin, "propose_video_link", {
          event_id: "ext:cal:none",
          link: "https://zoom.us/j/1",
        })
      ).text,
    ).toMatch(/No event/);
    expect(
      (await call(admin, "propose_video_link", { event_id: "x", link: "http://zoom.us/j/1" }))
        .isError,
    ).toBe(true);
    expect(staged()).toBe(0);
  });
});

const HOUR = 3_600_000;

/** A meeting the user organizes, with a guest and no video link, tomorrow 10:00. */
function meeting(db: Db, user: User): string {
  run(
    db,
    "INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at) VALUES ('a1', ?, 'caldav', 'x', ?, '{}', ?)",
    user.id,
    user.email,
    T0,
  );
  run(
    db,
    "INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability) VALUES ('c1', 'a1', 'p1', 'Work', 1, 1, 1)",
  );
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, location, start_ms, end_ms, attendees, attendee_count, organizer_self)
     VALUES ('c1', 'e1', 'Retro', '', ?, ?, '["dana@example.com"]', 2, 1)`,
    T0 + 26 * HOUR,
    T0 + 27 * HOUR,
  );
  return "ext:c1:e1";
}

const open = (db: Db) =>
  all<{ summary: string; after: string; client: string }>(
    db,
    "SELECT summary, after, client FROM staged_changes WHERE state IN ('pending', 'accepted') ORDER BY created_at, rowid",
  );

describe("fixes for one target", () => {
  it("merges a move and a video link of one event, in either order, and says so (5)", async () => {
    const { db, admin } = setup();
    const id = meeting(db, admin);
    const tools = new Map(
      chatTools({ db, preview: makePreview(db), baseUrl: "http://x", now: () => T0 }).map((t) => [
        t.tool.name,
        t.tool,
      ]),
    );
    const caller = { user: admin, client: "", source: "assistant_chat" } as Caller;
    const moveTo = {
      start: new Date(T0 + 30 * HOUR).toISOString(),
      end: new Date(T0 + 31 * HOUR).toISOString(),
    };
    expect(
      (
        await callTool(tools.get("propose_update_event") as Tool, caller, {
          event_id: id,
          ...moveTo,
        })
      ).isError,
    ).toBe(false);
    expect(
      (
        await callTool(tools.get("propose_video_link") as Tool, caller, {
          event_id: id,
          link: "https://zoom.us/j/1",
        })
      ).isError,
    ).toBe(false);
    const [one1] = open(db);
    expect(open(db)).toHaveLength(1);
    expect(JSON.parse(one1?.after ?? "{}")).toEqual({
      start: T0 + 30 * HOUR,
      end: T0 + 31 * HOUR,
      description: "https://zoom.us/j/1",
    });
    // The merged change keeps the description's stale check (apply compares it).
    expect(
      JSON.parse(
        all<{ before: string }>(db, "SELECT before FROM staged_changes WHERE state = 'pending'")[0]
          ?.before ?? "{}",
      ),
    ).toMatchObject({ description: "" });
    // A meeting with a link already gets no second one.
    run(db, "UPDATE events SET description = 'https://zoom.us/j/7'");
    expect(
      (
        await callTool(tools.get("propose_video_link") as Tool, caller, {
          event_id: id,
          link: "https://zoom.us/j/1",
        })
      ).text,
    ).toMatch(/has a video link already/);
    run(db, "UPDATE events SET description = ''");
    expect(one1?.summary).toMatch(/^New description for “Retro”.*; Move “Retro”/);
    expect(
      all<{ result: string }>(db, "SELECT result FROM staged_changes WHERE state = 'discarded'"),
    ).toEqual([{ result: "Merged into a later change" }]);
    // The other order: the move keeps the link.
    run(db, "UPDATE staged_changes SET state = 'discarded'");
    await callTool(tools.get("propose_video_link") as Tool, caller, {
      event_id: id,
      link: "https://zoom.us/j/2",
    });
    await callTool(tools.get("propose_update_event") as Tool, caller, { event_id: id, ...moveTo });
    expect(JSON.parse(open(db)[0]?.after ?? "{}")).toEqual({
      start: T0 + 30 * HOUR,
      end: T0 + 31 * HOUR,
      description: "https://zoom.us/j/2",
    });
  });

  it("keeps both meeting check changes in one proposal (5)", async () => {
    const { db, admin, call } = setup();
    await call(admin, "propose_automation", {
      action: "edit",
      type: "meeting_check",
      settings: { checks: { video_link: false } },
    });
    await call(admin, "propose_automation", {
      action: "edit",
      type: "meeting_check",
      settings: { checks: { agenda: true } },
    });
    const [only] = open(db);
    expect(open(db)).toHaveLength(1);
    expect(only?.summary).toBe("Edit meeting checks (video_link off, agenda on)");
    expect(JSON.parse(JSON.parse(only?.after ?? "{}").body)).toEqual({
      checks: { video_link: false, agenda: true },
    });
    const bad = await call(admin, "propose_automation", {
      action: "edit",
      type: "meeting_check",
      settings: { checks: "all" },
    });
    expect(bad.text).toMatch(/settings.checks/);
  });
});

function makePreview(db: Db) {
  return createPreview({
    db,
    sync: { runNow: async () => {}, idle: async () => {}, request: () => {} },
    mailer: {},
    live: { notify: () => {} },
    now: () => T0,
    app: () => new Hono(),
    dry: () => null,
  } as unknown as PreviewDeps);
}

describe("the daily review (6)", () => {
  function reviewSetup(
    script: (messages: LlmMessage[], n: number) => LlmMessage & { role: "assistant" },
  ) {
    const db = openDb(":memory:");
    const user = ensureUser(db, "owner@example.com", "Owner", T0) as User;
    const id = meeting(db, user);
    const sent: { tools: string[]; system: string }[] = [];
    const llm: Llm = {
      model: "m",
      complete: async (messages, tools) => {
        sent.push({
          tools: tools.map((t) => t.function.name),
          system: messages[0]?.content ?? "",
        });
        return script(messages, sent.length);
      },
    };
    const preview = makePreview(db);
    const chat = createChat({
      db,
      llm,
      tools: chatTools({ db, preview, baseUrl: "http://x", now: () => T0 }),
      now: () => T0,
    });
    return { db, user, id, sent, chat, preview };
  }
  const callOf = (name: string, args: unknown) => ({
    role: "assistant" as const,
    content: null,
    tool_calls: [
      {
        id: `c-${name}`,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });

  it("offers only reads and single-event fixes, and refuses the others by name", async () => {
    const { db, sent, chat, user } = reviewSetup((_m, n) =>
      n === 1
        ? callOf("propose_team_policy", { action: "delete", id: "p1" })
        : { role: "assistant", content: "done" },
    );
    const r = await chat.review(user, "2026-10-19", "2026-10-26");
    expect(r.complete).toBe(true);
    expect(new Set(sent[0]?.tools)).toEqual(REVIEW_TOOLS);
    expect(sent[0]?.system).toContain("This turn is the daily review");
    const tool = all<{ content: string }>(
      db,
      "SELECT content FROM assistant_messages WHERE role = 'tool'",
    );
    expect(tool[0]?.content).toBe("Error: there is no tool propose_team_policy.");
    expect(all(db, "SELECT id FROM staged_changes")).toHaveLength(0);
  });

  it("keeps preview mode off, leaves the user's own change, labels its own, and is outside the quota", async () => {
    const { db, chat, user, id, preview } = reviewSetup((m) =>
      m.at(-1)?.role === "user"
        ? callOf("propose_video_link", { event_id: "ext:c1:e1", link: "https://zoom.us/j/9" })
        : { role: "assistant", content: "done" },
    );
    setInstanceLimit(db, "assistant_chat_quota", 1);
    run(
      db,
      "INSERT INTO assistant_usage (user_id, day, count) VALUES (?, '2026-10-19', 1)",
      user.id,
    );
    // The user's own staged move of the meeting, then preview mode off by hand.
    preview.stage(user.id, {
      source: "assistant_chat",
      kind: "event_update",
      target: id,
      before: { title: "Retro", start: T0 + 26 * HOUR, end: T0 + 27 * HOUR },
      after: { start: T0 + 28 * HOUR, end: T0 + 29 * HOUR },
      impact: [],
      summary: "Move “Retro”",
    });
    run(db, "UPDATE preview_mode SET enabled = 0");
    const r = await chat.review(user, "2026-10-19", "2026-10-26");
    expect(r.conversationId).not.toBeNull();
    const tool = all<{ content: string }>(
      db,
      "SELECT content FROM assistant_messages WHERE role = 'tool'",
    );
    expect(tool[0]?.content).toMatch(/^Error: A change the user staged for this is waiting/);
    expect(open(db).map((c) => c.summary)).toEqual(["Move “Retro”"]);
    expect(previewMode(db, user.id).on).toBe(false);
    expect(one<{ count: number }>(db, "SELECT count FROM assistant_usage")?.count).toBe(1);

    // Without the user's change, the review stages its own fix, labeled, with preview mode still off.
    run(db, "UPDATE staged_changes SET state = 'discarded'");
    await chat.review(user, "2026-10-19", "2026-10-26");
    expect(open(db).map((c) => [c.summary.split(" · ")[0], c.client])).toEqual([
      ["New description for “Retro”", "daily review"],
    ]);
    expect(previewMode(db, user.id).on).toBe(false);
  });
});
