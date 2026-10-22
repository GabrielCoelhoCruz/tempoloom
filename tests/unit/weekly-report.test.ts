// The weekly report email (docs/specs/analytics-weekly-reports.md rules 1-6).
// The E2E suite covers delivery through the operator command and the server's
// own tick; these cases need two runs at the same instant or users the UI
// cannot make. Ways it can fail:
// 1. Two runs that overlap send a user's report twice.
// 2. A deactivated user, a user who never signed in, or a user without a
//    working calendar account gets the report.
// 3. The report counts events after the send time on the send day (rule 5).
// 4. A task on personal hours counts as solo work, not personal time (rule 6).
// 5. During a trip the preview puts an event on another day than the planner
//    (the planner shows the week in the home zone, timezones rule 10), or its
//    links open the week, not the planner at that day (rule 8).
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { Mailer, Message } from "../../src/server/mail.ts";
import { localToUtc, utcToLocal } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const FRI = "2026-11-13";
const t = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const T0 = t("2026-11-01", "12:00");
const reports = (sent: Message[]) =>
  sent.filter((m) => m.subject.startsWith("Your week")).map((m) => m.to);

function setup() {
  const db = openDb(":memory:");
  const sent: Message[] = [];
  const mailer: Mailer = {
    configured: true,
    // A slow server, so that a second run starts while the first one sends.
    send: async (m) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(m);
    },
  };
  const user = (email: string) => {
    const u = ensureUser(db, email, email, T0);
    run(db, "UPDATE users SET time_zone = ?, first_sign_in_at = ? WHERE id = ?", ZONE, T0, u.id);
    run(
      db,
      `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at, is_main)
       VALUES (?, ?, 'caldav', ?, ?, '', ?, 1)`,
      `acc-${email}`,
      u.id,
      email,
      email,
      T0,
    );
    run(
      db,
      `INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability)
       VALUES (?, ?, ?, 'Work', 1, 1)`,
      `cal-${email}`,
      `acc-${email}`,
      `cal-${email}`,
    );
    return u.id;
  };
  // One run of the server's email worker at `now`, as the server's interval and the CLI do.
  const tick = (now: number) =>
    new DailyMailWorker({
      db,
      mailer,
      now: () => now,
      baseUrl: "http://localhost",
      intervalMs: 60_000,
    }).tick();
  return { db, sent, user, tick };
}

describe("weekly report delivery", () => {
  it("sends each user one report when two runs overlap", async () => {
    const { sent, user, tick } = setup();
    user("ana@example.com");
    user("ben@example.com");
    await Promise.all([tick(t(FRI, "09:30")), tick(t(FRI, "09:30"))]);
    expect(reports(sent).sort()).toEqual(["ana@example.com", "ben@example.com"]);
  });

  it("skips deactivated users, users who never signed in and users without a working account", async () => {
    const { db, sent, user, tick } = setup();
    user("ok@example.com");
    const gone = user("gone@example.com");
    run(db, "UPDATE users SET deactivated_at = ? WHERE id = ?", T0, gone);
    const never = user("never@example.com");
    run(db, "UPDATE users SET first_sign_in_at = NULL WHERE id = ?", never);
    const reauth = user("reauth@example.com");
    run(db, "UPDATE accounts SET status = 'reauth_required' WHERE user_id = ?", reauth);
    await tick(t(FRI, "09:30"));
    expect(reports(sent)).toEqual(["ok@example.com"]);
  });

  it("counts the week up to the send time, not to the end of the send day", async () => {
    const { db, sent, user, tick } = setup();
    user("ana@example.com");
    const event = (id: string, date: string, from: string, to: string) =>
      run(
        db,
        `INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)`,
        "cal-ana@example.com",
        id,
        id,
        t(date, from),
        t(date, to),
      );
    event("Write spec", "2026-11-10", "09:00", "11:00");
    // Friday afternoon, after the 09:30 send: not in this report.
    event("Review", FRI, "14:00", "15:00");
    await tick(t(FRI, "09:30"));
    const report = sent.filter((m) => m.subject.startsWith("Your week"));
    expect(report).toHaveLength(1);
    expect(report[0]?.text).toContain("Solo work: 2 h\n");
  });

  it("counts a task on personal hours as personal time and a task on work hours as solo work", async () => {
    const { db, sent, user, tick } = setup();
    const id = user("ana@example.com");
    const hours = (kind: string) =>
      (
        db
          .prepare("SELECT id FROM hours_sets WHERE user_id = ? AND kind = ? LIMIT 1")
          .get(id, kind) as { id: string }
      ).id;
    const task = (title: string, kind: string, date: string, from: string, to: string) => {
      run(
        db,
        `INSERT INTO tasks (id, user_id, title, level, total_minutes, min_chunk_minutes, max_chunk_minutes,
           start_after, hours_set_id, created_at, rules_changed_at)
         VALUES (?, ?, ?, 3, 60, 60, 60, ?, ?, ?, ?)`,
        title,
        id,
        title,
        T0,
        hours(kind),
        T0,
        T0,
      );
      run(
        db,
        `INSERT INTO managed_events (id, user_id, calendar_id, key, kind, source_id, start_ms, end_ms, busy, title)
         VALUES (?, ?, ?, ?, 'task', ?, ?, ?, 1, ?)`,
        `me-${title}`,
        id,
        "cal-ana@example.com",
        `task:${title}`,
        title,
        t(date, from),
        t(date, to),
        title,
      );
    };
    task("Draft plan", "work", "2026-11-10", "09:00", "10:00");
    task("Pay bills", "personal", "2026-11-11", "19:00", "20:30");
    await tick(t(FRI, "09:30"));
    const report = sent.find((m) => m.subject.startsWith("Your week"));
    expect(report?.text).toContain("Solo work: 1 h\n");
    expect(report?.text).toContain("Personal time: 1 h 30 min\n");
  });

  it("during a trip, previews each event on the day the planner shows it (home zone) and links it to the planner at that day", async () => {
    const { db, sent, user, tick } = setup();
    const id = user("ana@example.com");
    run(
      db,
      "INSERT INTO travel_zones (id, user_id, tz, start_date, end_date, created_at) VALUES ('trip', ?, 'Asia/Tokyo', '2026-11-14', '2026-11-22', ?)",
      id,
      T0,
    );
    const event = (id: string, title: string, tokyoDate: string) => {
      const start = localToUtc("Asia/Tokyo", tokyoDate, 7 * 60);
      run(
        db,
        "INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms) VALUES (?, ?, ?, ?, ?)",
        "cal-ana@example.com",
        id,
        title,
        start,
        start + 3_600_000,
      );
      return start;
    };
    // Monday 07:00 in Tokyo is Sunday 23:00 at home: the planner shows it on
    // Sunday of this week, so next week's preview does not list it.
    const early = event("early", "Early call", "2026-11-16");
    expect(utcToLocal(ZONE, early).date).toBe("2026-11-15");
    // Tuesday 07:00 in Tokyo is Monday 23:00 at home: the planner's Monday.
    const standup = event("standup", "Tokyo standup", "2026-11-17");
    expect(utcToLocal(ZONE, standup).date).toBe("2026-11-16");
    await tick(t(FRI, "09:30"));
    const text = sent.find((m) => m.subject.startsWith("Your week"))?.text ?? "";
    expect(text).toContain("Monday 2026-11-16 (busiest), 1 h: http://localhost/?day=2026-11-16\n");
    expect(text).toContain("  23:00-24:00 Tokyo standup: http://localhost/?day=2026-11-16\n");
    expect(text).toContain(
      "Tuesday 2026-11-17 (lightest), 0 min: http://localhost/?day=2026-11-17\n",
    );
    expect(text).not.toContain("Early call");
  });
});
