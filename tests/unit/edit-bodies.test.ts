// Edit routes that take a partial body (automations-overview.md rule 11,
// decision "an edit sends only the fields it changed"): PUT /api/mirrors/:id
// and PUT /api/team/habit-templates/:id.
//
// Ways it can fail:
// 1. A field the body leaves out is set to its default or cleared.
// 2. The merged body is not checked, so an invalid pair or value is saved.
// 3. A full body (an API client) no longer works.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { mirrorRoutes } from "../../src/server/api/mirrors.ts";
import { teamDefaultRoutes } from "../../src/server/api/team-defaults.ts";
import type { AppEnv } from "../../src/server/app.ts";
import { one, openDb, run } from "../../src/server/db.ts";
import type { SyncService } from "../../src/server/sync/service.ts";

const T0 = Date.parse("2026-10-19T08:00:00Z");

function setup() {
  const db = openDb(":memory:");
  const user = ensureUser(db, "owner@example.com", "Owner", T0);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, status, created_at, is_main)
     VALUES ('acc', ?, 'caldav', 'acc', 'owner@example.com', '', 'ok', ?, 0)`,
    user.id,
    T0,
  );
  for (const id of ["src", "dst", "other"])
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, writable)
       VALUES (?, 'acc', ?, ?, 0, 1, 1)`,
      id,
      id,
      id,
    );
  run(
    db,
    `INSERT INTO mirror_policies (id, user_id, source_calendar_id, dest_calendar_id, calendar_type,
       visibility, all_day_mode, copy_outside_work_hours, color_override, created_at)
     VALUES ('p', ?, 'src', 'dst', 'business', 'details_private', 'all', 0, '5', ?)`,
    user.id,
    T0,
  );
  const sync = { request() {} } as unknown as SyncService;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("user", user);
    await next();
  });
  app.route(
    "/api",
    mirrorRoutes(db, sync, () => T0),
  );
  app.route(
    "/api",
    teamDefaultRoutes(db, () => T0),
  );
  const call = (method: string, path: string, body: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const policy = () =>
    one<Record<string, unknown>>(
      db,
      `SELECT source_calendar_id, dest_calendar_id, calendar_type, visibility, all_day_mode,
         copy_outside_work_hours, color_override FROM mirror_policies WHERE id = 'p'`,
    );
  return { db, call, policy };
}

describe("PUT /api/mirrors/:id", () => {
  it("changes only the fields of the body; the others keep their stored value", async () => {
    const { call, policy } = setup();
    const before = policy();
    expect((await call("PUT", "/mirrors/p", { visibility: "busy_only" })).status).toBe(200);
    expect(policy()).toEqual({ ...before, visibility: "busy_only" });
    // A new destination is checked with the stored source.
    expect((await call("PUT", "/mirrors/p", { destCalendarId: "src" })).status).toBe(400);
    expect((await call("PUT", "/mirrors/p", { allDayMode: "sometimes" })).status).toBe(400);
    expect(policy()).toEqual({ ...before, visibility: "busy_only" });
    // A full body still works.
    const full = {
      sourceCalendarId: "src",
      destCalendarId: "other",
      calendarType: "personal",
      visibility: "label_only",
      allDayMode: "none",
      copyOutsideWorkHours: true,
      colorOverride: null,
    };
    expect((await call("PUT", "/mirrors/p", full)).status).toBe(200);
    expect(policy()).toEqual({
      source_calendar_id: "src",
      dest_calendar_id: "other",
      calendar_type: "personal",
      visibility: "label_only",
      all_day_mode: "none",
      copy_outside_work_hours: 1,
      color_override: null,
    });
  });
});

describe("PUT /api/team/habit-templates/:id", () => {
  it("changes only the fields of the body, and refuses an invalid number", async () => {
    const { db, call } = setup();
    const made = await call("POST", "/team/habit-templates", {
      title: "Lunch",
      idealTime: "12:00",
      minutes: 60,
      days: [1, 3],
      level: 2,
      hours: "personal",
    });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const stored = () =>
      one<{ title: string; fields: string }>(
        db,
        "SELECT title, fields FROM team_habit_templates WHERE id = ?",
        id,
      );
    expect((await call("PUT", `/team/habit-templates/${id}`, { minutes: 45 })).status).toBe(200);
    expect(stored()?.title).toBe("Lunch");
    expect(JSON.parse(stored()?.fields ?? "{}")).toEqual({
      idealTime: "12:00",
      minutes: 45,
      days: [1, 3],
      level: 2,
      hours: "personal",
    });
    // A NaN of the form reaches the server as null: a 400, not a dropped field.
    expect((await call("PUT", `/team/habit-templates/${id}`, { minutes: null })).status).toBe(400);
    expect(JSON.parse(stored()?.fields ?? "{}").minutes).toBe(45);
  });
});
