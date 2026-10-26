// The automation, policy and review tools of assistant chat
// (src/server/assistant/review-tools.ts), on an in-memory database.
//
// Ways it can fail:
// 1. A team member who is not an admin reads or stages team policies.
// 2. An automation or policy id of another user or team stages a change.
// 3. The review reads past its range limit, or a range that ends before it starts.
// 4. A video link goes on a meeting the user does not organize, or is not a video link.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { reviewTools } from "../../src/server/assistant/review-tools.ts";
import { all, openDb, run } from "../../src/server/db.ts";
import { type Caller, callTool, type Tool } from "../../src/server/mcp/rpc.ts";
import { createPreview, type PreviewDeps } from "../../src/server/preview.ts";

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
  const tools = new Map(reviewTools({ db, preview, now }).map((t) => [t.name, t]));
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
  return { db, admin, member, other, call, staged };
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
