// The weekly report email (docs/specs/analytics-weekly-reports.md rules 1-7):
// once a week, in the first hour of work on the last workday of the week, each
// user who has it on gets the week's three time totals and the calendar facts
// that the stats page shows for the same days. Next week's preview, the
// priorities and the share page are not built yet.
import { addDays, utcToLocal, weekdayOf } from "../shared/time.ts";
import { personalInsights } from "./analytics/personal.ts";
import { all, type Db, one, run } from "./db.ts";
import type { Mailer } from "./mail.ts";

/** Rule 7: the facts show as colored blocks under the totals. */
const BLOCKS = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3"];

type Weekly = Record<string, [number, number][]>;
type Fact = ReturnType<typeof personalInsights>["facts"][number];

const duration = (minutes: number) => {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};

/** The same wording as the stats page's calendar facts. */
function factText(f: Fact): string {
  switch (f.kind) {
    case "busiest_day":
      return `Busiest meeting day: ${f.day} (${duration(f.minutes ?? 0)})`;
    case "longest_focus":
      return `Longest focus session: ${duration(f.minutes ?? 0)}`;
    case "booked_meetings":
      return `Meetings booked through links: ${f.count}`;
    case "breaks":
      return `Breaks taken: ${duration(f.minutes ?? 0)}`;
    default:
      return `People met: ${f.count}`;
  }
}

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

/** Sends the reports due at `now`; returns how many went out. */
export async function sendDueWeeklyReports(
  db: Db,
  mailer: Mailer,
  baseUrl: string,
  now: number,
): Promise<number> {
  if (!mailer.configured) return 0;
  let sent = 0;
  const users = all<{ id: string; email: string; time_zone: string; sent: string | null }>(
    db,
    `SELECT id, email, time_zone, weekly_report_sent AS sent FROM users
     WHERE weekly_report_enabled = 1 AND email <> ''`,
  );
  for (const u of users) {
    const work = one<{ weekly: string }>(
      db,
      "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
      u.id,
    );
    const slot = sendSlot(work ? (JSON.parse(work.weekly) as Weekly) : null);
    const l = utcToLocal(u.time_zone, now);
    const weekday = weekdayOf(l.date);
    if (weekday !== slot.last || l.minuteOfDay < slot.start || l.minuteOfDay >= slot.start + 60)
      continue;
    const monday = addDays(l.date, 1 - weekday);
    if (u.sent === monday) continue;
    // Rule 5: the work week from its first workday up to the send day.
    const from = addDays(monday, slot.first - 1);
    const to = l.date;
    const week = personalInsights(db, u.id, from, to, now);
    const c = week.categories;
    const totals = [
      `Meetings: ${duration(c.one_on_one + c.team_meeting + c.external_meeting)}`,
      `Solo work: ${duration(c.deep_work + c.shallow_work)}`,
      `Personal time: ${duration(c.personal)}`,
    ];
    const facts = week.facts.map(factText);
    const link = new URL(`/stats?from=${from}&to=${to}`, baseUrl).toString();
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    // Mark first, so a failed send is not repeated every minute.
    run(db, "UPDATE users SET weekly_report_sent = ? WHERE id = ?", monday, u.id);
    try {
      await mailer.send({
        to: u.email,
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
      });
      sent++;
    } catch (err) {
      console.error("weekly report failed", err);
    }
  }
  return sent;
}
