// Stack rank of new and moved automations (planning-scheduler.md SCH-71,
// automations-overview.md rules 7 and 8). Ranks are one list per level, focus
// time and the meeting overload included at P4.
//
// Ways it can fail:
// 1. A new automation goes to the end of its own table's ranks, so a second
//    meeting goes after an older habit (SCH-71).
// 2. A level change takes the end of one table's ranks, so a moved buffer
//    lands before the habits of its new level (rule 7).
// 3. An insert ignores focus time at P4 and undoes the user's drag order (rule 8).
// 4. Old data with tied ranks changes order when a new automation comes in.
// 5. A new focus goal or meeting overload, from its form or from a team
//    policy, takes rank 0 or the next focus rank and lands in the middle of P4.
// 6. The meeting preview ranks a new or moved meeting other than the save
//    does, so it shows a time that the plan run gives to another automation.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { automationRoutes, listAutomations } from "../../src/server/api/automations.ts";
import { focusExtraRoutes } from "../../src/server/api/focus-extras.ts";
import { habitRoutes } from "../../src/server/api/habits.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb, run } from "../../src/server/db.ts";
import { applyPolicies } from "../../src/server/policies/apply.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  const clock = { t: T0 };
  const now = () => (clock.t += 1000);
  const pool = { get: () => ({ setSeriesProps: async () => undefined }) };
  const sync = {
    request: () => {},
    exclusive: async (_userId: string, fn: (p: typeof pool) => Promise<unknown>) => fn(pool),
  } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route("/api", itemRoutes(db, sync, now));
  app.route("/api", habitRoutes(db, sync, now));
  app.route("/api", meetingRoutes(db, sync, now));
  app.route("/api", automationRoutes(db, sync, now));
  app.route("/api", focusExtraRoutes(db, sync, now));
  const send = async (method: string, url: string, body: unknown) => {
    const res = await app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
  const meetingBody = (title: string, level: number) => ({
    title,
    attendees: [{ email: "dana@example.com" }],
    frequency: { period: "weekly", everyWeeks: 1, idealDays: [2] },
    idealTime: "10:00",
    durationMinutes: 30,
    level,
  });
  const ids: Record<string, { type: string; id: string }> = {};
  const add = {
    habit: async (title: string, level: number) => {
      const r = await send("POST", "/api/habits", {
        title,
        idealTime: "10:00",
        minMinutes: 30,
        maxMinutes: 30,
        level,
      });
      ids[title] = { type: "habit", id: (r.habit as { id: string }).id };
    },
    buffer: async (title: string, level: number) => {
      const r = await send("POST", "/api/buffers", { title, side: "after", level });
      ids[title] = { type: "buffer", id: (r.buffer as { id: string }).id };
    },
    meeting: async (title: string, level: number) => {
      const r = await send("POST", "/api/meetings", meetingBody(title, level));
      ids[title] = { type: "flexible_meeting", id: r.id as string };
    },
    focus: async (title: string) => {
      const r = await send("POST", "/api/focus", { title, weeklyGoalMinutes: 120 });
      ids[title] = { type: "focus_time", id: (r.focus as { id: string }).id };
    },
    overload: async (title: string) => {
      const r = await send("POST", "/api/meeting-overloads", { title, dailyMaxMinutes: 240 });
      ids[title] = { type: "meeting_overload", id: (r.overload as { id: string }).id };
    },
  };
  const group = (level: number) =>
    listAutomations(db, user.id)
      .filter((a) => a.level === level && a.type !== "meeting_check")
      .map((a) => a.name);
  const order = (level: number, names: string[]) =>
    send("POST", "/api/automations/order", {
      level,
      items: names.map((n) => ids[n]),
    });
  return { db, user, send, add, ids, group, order, meetingBody };
}

describe("rank of a new automation (SCH-71)", () => {
  it("goes after the last automation of its level whose kind comes first", async () => {
    const { add, group } = setup();
    await add.habit("H", 2);
    await add.meeting("M1", 2);
    await add.meeting("M2", 2);
    await add.buffer("B", 2);
    expect(group(2)).toEqual(["M1", "M2", "B", "H"]);
    await add.habit("H2", 2);
    expect(group(2)).toEqual(["M1", "M2", "B", "H", "H2"]);
  });

  it("keeps a dragged order and the order of old tied ranks", async () => {
    const { db, user, add, group, order } = setup();
    await add.meeting("M", 2);
    await add.habit("H", 2);
    await order(2, ["H", "M"]);
    await add.meeting("M2", 2);
    await add.buffer("B", 2);
    expect(group(2)).toEqual(["H", "M", "M2", "B"]);
    // Old data: every table counted its own ranks from 0.
    await add.meeting("Old M", 3);
    await add.habit("Old H", 3);
    await add.meeting("Old M2", 3);
    run(db, "UPDATE meetings SET rank = 0 WHERE title = 'Old M' AND user_id = ?", user.id);
    run(db, "UPDATE habits SET rank = 0 WHERE title = 'Old H' AND user_id = ?", user.id);
    run(db, "UPDATE meetings SET rank = 1 WHERE title = 'Old M2' AND user_id = ?", user.id);
    expect(group(3)).toEqual(["Old M", "Old H", "Old M2"]);
    await add.buffer("New B", 3);
    expect(group(3)).toEqual(["Old M", "Old H", "Old M2", "New B"]);
  });

  it("counts focus time at P4 and keeps it where the user dragged it (rule 8)", async () => {
    const { add, group, order } = setup();
    await add.focus("F");
    await add.habit("H", 4);
    await add.meeting("M", 4);
    await order(4, ["F", "H", "M"]);
    await add.buffer("B", 4);
    expect(group(4)).toEqual(["F", "H", "M", "B"]);
  });

  it("puts a new focus goal or meeting overload at its kind's place in P4", async () => {
    const { add, group } = setup();
    await add.meeting("M", 4);
    await add.buffer("B", 4);
    await add.habit("H", 4);
    await add.focus("F");
    expect(group(4)).toEqual(["M", "B", "H", "F"]);
    await add.overload("O");
    expect(group(4)).toEqual(["M", "B", "H", "O", "F"]);
    await add.focus("F2");
    expect(group(4)).toEqual(["M", "B", "H", "O", "F", "F2"]);
  });

  it("puts a focus goal from a team policy at the end of P4", async () => {
    const { db, user, add, group } = setup();
    await add.meeting("M", 4);
    await add.buffer("B", 4);
    await add.habit("H", 4);
    run(
      db,
      `INSERT INTO team_policies (id, team_id, type, name, goal, enabled, created_at, updated_at)
       SELECT 'p', team_id, 'focus_time', 'Focus', '{"weeklyGoalMinutes":600}', 1, 0, 0
       FROM team_members WHERE user_id = ?`,
      user.id,
    );
    applyPolicies(db, user.id, T0);
    expect(group(4)).toEqual(["M", "B", "H", "Focus time"]);
  });
});

describe("rank in the meeting preview", () => {
  it("is the rank that the save gives, for a new meeting and for a new priority", async () => {
    const { add, ids, send, order, meetingBody } = setup();
    // P2 in the dragged order H, M: both want Tuesday 10:00, so H holds it.
    await add.habit("H", 2);
    await add.meeting("M", 2);
    await order(2, ["H", "M"]);
    await add.meeting("Moved", 3);
    const starts = async (url: string, body: unknown) =>
      ((await send("POST", url, body)).occurrences as { start: number }[]).map((o) =>
        new Date(o.start).toISOString().slice(11, 16),
      );
    // A new P2 meeting goes after M (SCH-71); a meeting moved to P2 goes to the end (rule 7).
    const fresh = await starts("/api/meetings/preview", meetingBody("New", 2));
    const moved = await starts(
      `/api/meetings/preview?id=${ids.Moved?.id}`,
      meetingBody("Moved", 2),
    );
    expect(fresh[0]).toBeDefined();
    expect(fresh[0]).not.toBe("10:00");
    expect(moved[0]).not.toBe("10:00");
    // Without a contest the preview shows the ideal time.
    const free = await starts("/api/meetings/preview", meetingBody("Alone", 1));
    expect(free[0]).toBe("10:00");
  });
});

describe("rank after a level change (rule 7)", () => {
  it("puts a buffer, a habit or a meeting at the end of its new level", async () => {
    const { add, group, ids, send, meetingBody } = setup();
    await add.meeting("M", 2);
    await add.buffer("B", 2);
    await add.habit("H", 2);
    await add.buffer("Moved B", 3);
    await add.habit("Moved H", 3);
    await add.meeting("Moved M", 3);
    expect(group(2)).toEqual(["M", "B", "H"]);
    await send("PATCH", `/api/buffers/${ids["Moved B"]?.id}`, { level: 2 });
    expect(group(2)).toEqual(["M", "B", "H", "Moved B"]);
    await send("PATCH", `/api/habits/${ids["Moved H"]?.id}`, { level: 2 });
    expect(group(2)).toEqual(["M", "B", "H", "Moved B", "Moved H"]);
    await send("PUT", `/api/meetings/${ids["Moved M"]?.id}`, meetingBody("Moved M", 2));
    expect(group(2)).toEqual(["M", "B", "H", "Moved B", "Moved H", "Moved M"]);
    expect(group(3)).toEqual([]);
  });
});
