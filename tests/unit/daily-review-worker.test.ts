// The email worker's daily digest with the daily review (src/server/daily-mail.ts;
// assistant-chat.md rules 15-18), on an in-memory database with a fake review.
//
// Ways it can fail:
// 1. A user the review cannot run for (chat off) takes a slot of the daily cap.
// 2. One user's bad data stops the run, and the other digests do not go out.
// 3. Two workers (the server and the operator CLI) both send one digest.
// 4. A run that stopped before it sent loses the digest for good.
import { describe, expect, it } from "vitest";
import { ensureUser, type User } from "../../src/server/accounts.ts";
import { DailyMailWorker, leaseDigest, scheduleDaily } from "../../src/server/daily-mail.ts";
import { all, type Db, one, openDb, run } from "../../src/server/db.ts";
import type { Mailer, Message } from "../../src/server/mail.ts";
import { updatePrefs } from "../../src/server/meeting-prefs.ts";

const T0 = Date.parse("2026-10-19T06:00:00Z"); // Monday 06:00 UTC
const HOUR = 3_600_000;
const AT = T0 + 2 * HOUR; // 08:00 UTC: after each user's 08:00 digest time in UTC

function userWithIssue(db: Db, name: string): User {
  const u = ensureUser(db, `${name}@example.com`, name, T0) as User;
  run(db, "UPDATE users SET first_sign_in_at = ?, time_zone = 'UTC' WHERE id = ?", T0, u.id);
  run(
    db,
    `INSERT INTO accounts (id, user_id, provider, external_id, email, credentials, created_at)
     VALUES (?, ?, 'caldav', ?, ?, '{}', ?)`,
    `a-${name}`,
    u.id,
    name,
    u.email,
    T0,
  );
  run(
    db,
    `INSERT INTO calendars (id, account_id, provider_id, name, writable, is_primary, check_availability)
     VALUES (?, ?, 'p', 'Work', 1, 1, 1)`,
    `c-${name}`,
    `a-${name}`,
  );
  // A meeting the user organizes with a guest and no video link: one open issue.
  run(
    db,
    `INSERT INTO events (calendar_id, event_id, summary, location, start_ms, end_ms, attendees, attendee_count, organizer_self)
     VALUES (?, 'e', 'Retro', '', ?, ?, '["guest@example.com"]', 2, 1)`,
    `c-${name}`,
    AT + 26 * HOUR,
    AT + 27 * HOUR,
  );
  updatePrefs(db, u.id, { digest: "email", digestTime: "08:00" });
  scheduleDaily(db, u.id, "checks", "UTC", "08:00", T0);
  return { ...u, time_zone: "UTC" };
}

function worker(
  db: Db,
  sent: Message[],
  reviewed: string[],
  eligible: (u: { email: string }) => boolean,
  maxUsers = 2,
) {
  const mailer: Mailer = { configured: true, send: async (m) => void sent.push(m) };
  return new DailyMailWorker({
    db,
    mailer,
    now: () => AT,
    baseUrl: "http://localhost",
    intervalMs: 60_000,
    weeklyReports: false,
    log: () => {},
    review: {
      run: async (u) => {
        reviewed.push(u.email);
        return { conversationId: `conv-${u.email}`, complete: true };
      },
      eligible,
      maxUsers,
      turnMs: 1000,
    },
  });
}

const digestsTo = (sent: Message[]) =>
  sent.filter((m) => m.subject.startsWith("Meeting issues")).map((m) => m.to);

describe("daily review in the email worker", () => {
  it("gives the cap's slots only to users the review can run for (1)", async () => {
    const db = openDb(":memory:");
    for (const n of ["ana", "bo", "cy"]) userWithIssue(db, n);
    const sent: Message[] = [];
    const reviewed: string[] = [];
    await worker(db, sent, reviewed, (u) => u.email !== "ana@example.com").tick();
    // Ana has chat off: no slot. Bo and Cy fill the cap of 2.
    expect(reviewed.sort()).toEqual(["bo@example.com", "cy@example.com"]);
    expect(
      one<{ n: number }>(
        db,
        "SELECT sum(count) AS n FROM assistant_usage WHERE day LIKE 'review:%'",
      )?.n,
    ).toBe(2);
    expect(digestsTo(sent).sort()).toEqual(["ana@example.com", "bo@example.com", "cy@example.com"]);
    const ana = sent.find((m) => m.to === "ana@example.com");
    expect(ana?.text).toContain("Open the planner to fix or ignore them");
  });

  it("logs one user's failure and still sends the other digests; the failed one waits for the next day (2)", async () => {
    const db = openDb(":memory:");
    for (const n of ["ana", "bo"]) userWithIssue(db, n);
    const ana = one<{ id: string }>(db, "SELECT id FROM users WHERE email = 'ana@example.com'");
    run(
      db,
      "UPDATE hours_sets SET weekly = '{' WHERE user_id = ? AND kind = 'work'",
      ana?.id ?? "",
    );
    const sent: Message[] = [];
    const logged: string[] = [];
    const w = new DailyMailWorker({
      db,
      mailer: { configured: true, send: async (m) => void sent.push(m) },
      now: () => AT,
      baseUrl: "http://localhost",
      intervalMs: 60_000,
      weeklyReports: false,
      log: (m) => void logged.push(m),
    });
    await w.tick();
    expect(digestsTo(sent)).toEqual(["bo@example.com"]);
    expect(logged).toEqual(["digest for ana@example.com failed"]);
    // Claimed for today: the next run does not fail on Ana again.
    await w.tick();
    expect(logged).toHaveLength(1);
    expect(
      all<{ next_at: number }>(db, "SELECT next_at FROM daily_mail WHERE kind = 'checks'").every(
        (r) => r.next_at > AT,
      ),
    ).toBe(true);
  });

  it("leases a due digest to one worker; a stopped run's digest is due again after the lease (3, 4)", () => {
    const db = openDb(":memory:");
    const u = userWithIssue(db, "ana");
    const lease = 10 * 60_000;
    // The server's run and the CLI's run read the same due digest: one wins.
    expect(leaseDigest(db, u, "08:00", AT, lease)).toBe(true);
    expect(leaseDigest(db, u, "08:00", AT, lease)).toBe(false);
    expect(leaseDigest(db, u, "08:00", AT + lease - 1, lease)).toBe(false);
    // The winner stopped before it sent: after the lease the digest is due again.
    expect(leaseDigest(db, u, "08:00", AT + lease, lease)).toBe(true);
  });

  it("sends each digest once when two workers run at the same time (3)", async () => {
    const db = openDb(":memory:");
    userWithIssue(db, "ana");
    const sent: Message[] = [];
    const reviewed: string[] = [];
    await Promise.all([
      worker(db, sent, reviewed, () => true).tick(),
      worker(db, sent, reviewed, () => true).tick(),
    ]);
    expect(digestsTo(sent)).toEqual(["ana@example.com"]);
    expect(reviewed).toEqual(["ana@example.com"]);
  });
});
