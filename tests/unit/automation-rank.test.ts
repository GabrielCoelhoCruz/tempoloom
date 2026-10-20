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
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { automationRoutes, listAutomations } from "../../src/server/api/automations.ts";
import { itemRoutes } from "../../src/server/api/items.ts";
import { meetingRoutes } from "../../src/server/api/meetings.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { openDb, run } from "../../src/server/db.ts";
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
  app.route("/api", meetingRoutes(db, sync, now));
  app.route("/api", automationRoutes(db, sync, now));
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
