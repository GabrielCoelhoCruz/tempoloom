// The weekly report email (docs/specs/analytics-weekly-reports.md rules 1-7):
// once a week, in the first hour of work on the last workday of the week, each
// user who has it on gets the week's three time totals and the calendar facts
// that the stats page shows for the same days. DailyMailWorker sends it, with
// the same users and clock as the other daily emails. Next week's preview, the
// priorities and the share page are not built yet.
import { factText, hoursText } from "../shared/facts.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../shared/time.ts";
import { personalInsights } from "./analytics/personal.ts";
import { type Db, one } from "./db.ts";
import type { Message } from "./mail.ts";

/** Rule 7: the facts show as colored blocks under the totals. */
const BLOCKS = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3"];
const HOUR_MINUTES = 60;

type Weekly = Record<string, [number, number][]>;

/**
 * Rules 3-4 and edge case 1: the last weekday with work hours and the start of
 * its first range; without work hours, Friday at 09:00.
 */
export function sendSlot(weekly: Weekly | null): { first: number; last: number; start: number } {
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => (weekly?.[String(d)] ?? []).length > 0);
  const last = days.at(-1);
  if (last === undefined) return { first: 1, last: 5, start: 540 };
  const start = Math.min(...(weekly?.[String(last)] ?? []).map(([s]) => s));
  return { first: days[0] ?? 1, last, start };
}

/**
 * Claims the user's report when `now` is in its send hour (edge case 3: the
 * work hours in force now). One UPDATE moves `next_at` to the start of next
 * week, so of two runs at the same time only one gets the claim. Returns the
 * days the report covers, or null.
 */
export function claimWeeklyReport(
  db: Db,
  userId: string,
  zone: string,
  now: number,
): { from: string; to: string } | null {
  const work = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    userId,
  );
  const slot = sendSlot(work ? (JSON.parse(work.weekly) as Weekly) : null);
  const l = utcToLocal(zone, now);
  const weekday = weekdayOf(l.date);
  if (
    weekday !== slot.last ||
    l.minuteOfDay < slot.start ||
    l.minuteOfDay >= slot.start + HOUR_MINUTES
  )
    return null;
  const monday = addDays(l.date, 1 - weekday);
  // A user seen for the first time may get this week's report.
  db.prepare(
    "INSERT OR IGNORE INTO daily_mail (user_id, kind, next_at) VALUES (?, 'weekly', ?)",
  ).run(userId, localToUtc(zone, monday, 0));
  const claimed = db
    .prepare(
      "UPDATE daily_mail SET next_at = ? WHERE user_id = ? AND kind = 'weekly' AND next_at <= ?",
    )
    .run(localToUtc(zone, addDays(monday, 7), 0), userId, now).changes;
  return claimed === 1 ? { from: addDays(monday, slot.first - 1), to: l.date } : null;
}

/** Rules 5-7: the week from its first workday up to the send time. */
export function weeklyReport(
  db: Db,
  user: { id: string; email: string },
  week: { from: string; to: string },
  baseUrl: string,
  now: number,
): Message {
  const { from, to } = week;
  const stats = personalInsights(db, user.id, from, to, now, now);
  const c = stats.categories;
  const totals = [
    `Meetings: ${hoursText(c.one_on_one + c.team_meeting + c.external_meeting)}`,
    `Solo work: ${hoursText(c.deep_work + c.shallow_work)}`,
    `Personal time: ${hoursText(c.personal)}`,
  ];
  const facts = stats.facts.map(factText);
  const link = new URL(`/stats?from=${from}&to=${to}`, baseUrl).toString();
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return {
    to: user.email,
    subject: `Your week: ${from} to ${to}`,
    text: [
      `Your week from ${from} to ${to}.`,
      "",
      ...totals,
      "",
      "Calendar facts:",
      ...(facts.length ? facts.map((f) => `- ${f}`) : ["No facts this week."]),
      "",
      `See your stats: ${link}`,
      "",
      "Turn this email off in Settings.",
    ].join("\n"),
    html: [
      `<p>Your week from ${from} to ${to}.</p>`,
      `<ul>${totals.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`,
      "<h3>Calendar facts</h3>",
      facts.length
        ? facts
            .map(
              (f, i) =>
                `<div style="display:inline-block;margin:4px;padding:8px 12px;border-radius:6px;background:${BLOCKS[i % BLOCKS.length]}">${esc(f)}</div>`,
            )
            .join("")
        : "<p>No facts this week.</p>",
      `<p><a href="${esc(link)}">See your stats</a></p>`,
      "<p>Turn this email off in Settings.</p>",
    ].join(""),
  };
}
