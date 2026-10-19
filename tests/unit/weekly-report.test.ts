// The weekly report email (docs/specs/analytics-weekly-reports.md rules 1-6).
// The E2E suite covers delivery through the operator command and the server's
// own tick; these cases need two runs at the same instant or users the UI
// cannot make. Ways it can fail:
// 1. Two runs that overlap send a user's report twice.
// 2. A deactivated user, a user who never signed in, or a user without a
//    working calendar account gets the report.
// 3. The report counts events after the send time on the send day (rule 5).
import { describe, expect, it } from "vitest";
import { ensureUser } from "../../src/server/accounts.ts";
import { DailyMailWorker } from "../../src/server/daily-mail.ts";
import { openDb, run } from "../../src/server/db.ts";
import type { Mailer, Message } from "../../src/server/mail.ts";
import { localToUtc } from "../../src/shared/time.ts";

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
});
