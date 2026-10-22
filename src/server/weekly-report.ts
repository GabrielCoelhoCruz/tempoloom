// The weekly report email (docs/specs/analytics-weekly-reports.md rules 1-7):
// once a week, in the first hour of work on the last workday of the week, each
// user who has it on gets the week's three time totals and the calendar facts
// that the stats page shows for the same days. DailyMailWorker sends it, with
// the same users and clock as the other daily emails. It also previews next
// week, lists the priorities (rules 8-9), and offers share links to a public
// page of its top part (rules 10-12, src/server/weekly-share.ts).
import { randomBytes } from "node:crypto";
import { TimeSet } from "../scheduler/timeset.ts";
import { factText, hoursText } from "../shared/facts.ts";
import { addDays, type LocalDate, localToUtc, utcToLocal, weekdayOf } from "../shared/time.ts";
import { personalInsights } from "./analytics/personal.ts";
import { all, type Db, one, run } from "./db.ts";
import type { Message } from "./mail.ts";
import { publicName } from "./weekly-share.ts";

/** Rule 7: the facts show as colored blocks under the totals. */
const BLOCKS = ["#dbeafe", "#dcfce7", "#fef3c7", "#fce7f3"];
const HOUR_MINUTES = 60;

type Weekly = Record<string, [number, number][]>;

/** The weekly ranges of the user's work hours (keys "1" to "7", Monday first), or null. */
export const workHours = (db: Db, userId: string): Weekly | null => {
  const work = one<{ weekly: string }>(
    db,
    "SELECT weekly FROM hours_sets WHERE user_id = ? AND kind = 'work' ORDER BY created_at LIMIT 1",
    userId,
  );
  return work ? (JSON.parse(work.weekly) as Weekly) : null;
};

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
  const slot = sendSlot(workHours(db, userId));
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

const DAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

interface PreviewDay {
  date: LocalDate;
  minutes: number;
  mark: "busiest" | "lightest" | null;
  events: { time: string; title: string }[];
}

/**
 * Rule 8: next week's events on the primary calendar of the main account, on
 * each workday (Monday to Friday without work hours). The day with the most
 * busy time is the busiest, the one with the least the lightest (the first
 * on a tie); with equal days neither is marked.
 */
export function nextWeekPreview(
  db: Db,
  userId: string,
  zone: string,
  monday: LocalDate,
): PreviewDay[] {
  const weekly = workHours(db, userId);
  const workdays = [1, 2, 3, 4, 5, 6, 7].filter((d) => (weekly?.[String(d)] ?? []).length > 0);
  const days = (workdays.length > 0 ? workdays : [1, 2, 3, 4, 5]).map((d): PreviewDay => {
    const date = addDays(monday, d - 1);
    const from = localToUtc(zone, date, 0);
    const to = localToUtc(zone, addDays(date, 1), 0);
    const rows = all<{
      summary: string;
      start_ms: number;
      end_ms: number;
      all_day: number;
      busy: number;
    }>(
      db,
      `SELECT e.summary, e.start_ms, e.end_ms, e.all_day, e.busy FROM events e
       JOIN calendars c ON c.id = e.calendar_id
       WHERE c.is_primary = 1 AND c.account_id = (
           SELECT a.id FROM accounts a WHERE a.user_id = ? AND a.status = 'ok' AND a.grant_team_id IS NULL
           ORDER BY a.is_main DESC, a.created_at LIMIT 1)
         AND e.end_ms > ? AND e.start_ms < ? AND COALESCE(e.self_response, '') <> 'declined'
       ORDER BY e.all_day DESC, e.start_ms, e.summary`,
      userId,
      from,
      to,
    );
    const busy = TimeSet.from(
      rows
        .filter((r) => r.busy === 1 && r.all_day === 0)
        .map((r) => ({ start: Math.max(r.start_ms, from), end: Math.min(r.end_ms, to) })),
    );
    return {
      date,
      minutes: busy.total() / 60_000,
      mark: null,
      events: rows.map((r) => ({
        time:
          r.all_day === 1
            ? "all day"
            : `${hhmm(utcToLocal(zone, Math.max(r.start_ms, from)).minuteOfDay)}-${hhmm(r.end_ms >= to ? 1440 : utcToLocal(zone, r.end_ms).minuteOfDay)}`,
        title: r.summary,
      })),
    };
  });
  const max = Math.max(...days.map((d) => d.minutes));
  const min = Math.min(...days.map((d) => d.minutes));
  if (max > min) {
    const busiest = days.find((d) => d.minutes === max);
    const lightest = days.find((d) => d.minutes === min);
    if (busiest) busiest.mark = "busiest";
    if (lightest) lightest.mark = "lightest";
  }
  return days;
}

interface Priority {
  id: string;
  title: string;
  level: number;
}

/**
 * Rule 9: the 5 open tasks with the highest priority (then the nearest due
 * date), and the habits with an event next week, each by priority and rank.
 */
export function reportPriorities(
  db: Db,
  userId: string,
  next: { from: number; to: number },
): { tasks: Priority[]; habits: Priority[] } {
  return {
    tasks: all<Priority>(
      db,
      `SELECT id, title, level FROM tasks WHERE user_id = ? AND status = 'open'
       ORDER BY level, due_at IS NULL, due_at, created_at, id LIMIT 5`,
      userId,
    ),
    habits: all<Priority>(
      db,
      `SELECT h.id, h.title, h.level FROM habits h WHERE h.user_id = ? AND h.enabled = 1
         AND EXISTS (SELECT 1 FROM managed_events m WHERE m.user_id = h.user_id AND m.kind = 'habit'
                     AND m.source_id = h.id AND m.end_ms > ? AND m.start_ms < ?)
       ORDER BY h.level, h.rank, h.created_at, h.id`,
      userId,
      next.from,
      next.to,
    ),
  };
}

/** Rules 10-11: the share targets of the top part, in the order the email shows them. */
const SHARE_TARGETS = [
  ["link", "Direct link"],
  ["x", "X"],
  ["linkedin", "LinkedIn"],
  ["facebook", "Facebook"],
] as const;

/** Rules 5-12: the week from its first workday up to the send time, then next week. */
export function weeklyReport(
  db: Db,
  user: { id: string; email: string; time_zone: string },
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
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const url = (path: string) => new URL(path, baseUrl).toString();
  const a = (href: string, text: string) => `<a href="${esc(href)}">${esc(text)}</a>`;

  // Rules 10-11: the top part as sent, public once the user confirms a share.
  const token = randomBytes(24).toString("base64url");
  run(
    db,
    "INSERT INTO weekly_shares (token, user_id, name, week_from, week_to, totals, facts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    token,
    user.id,
    publicName(db, user.id),
    from,
    to,
    JSON.stringify(totals),
    JSON.stringify(facts),
    now,
  );
  const shares = SHARE_TARGETS.map(([target, label]) => ({
    label,
    href: url(`/r/${token}/share?to=${target}`),
  }));

  // The home zone: the planner shows the week in it, also during a trip
  // (timezones-home-and-travel.md rule 10), so each day and link match the planner.
  const zone = user.time_zone;
  const monday = addDays(from, 1 - weekdayOf(from));
  const nextMonday = addDays(monday, 7);
  const preview = nextWeekPreview(db, user.id, zone, nextMonday);
  const dayLabel = (d: PreviewDay) => `${DAY_NAMES[weekdayOf(d.date)]} ${d.date}`;
  // Rule 8: the planner at that day (its week, with the day marked).
  const planner = (d: PreviewDay) => url(`/?day=${d.date}`);
  const prio = reportPriorities(db, user.id, {
    from: localToUtc(zone, nextMonday, 0),
    to: localToUtc(zone, addDays(nextMonday, 7), 0),
  });
  const items = (kind: "tasks" | "habits") =>
    prio[kind].map((p) => ({
      text: `P${p.level} ${p.title}`,
      level: p.level,
      title: p.title,
      href: url(`/${kind}?edit=${encodeURIComponent(p.id)}`),
    }));
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
      "Share this part (totals and facts):",
      ...shares.map((x) => `${x.label}: ${x.href}`),
      "",
      // Only the facts are "- " lines; the lists below are indented.
      "Next week:",
      ...preview.flatMap((d) => [
        `${dayLabel(d)}${d.mark ? ` (${d.mark})` : ""}, ${hoursText(d.minutes)}: ${planner(d)}`,
        ...d.events.map((e) => `  ${e.time} ${e.title}: ${planner(d)}`),
      ]),
      "",
      "Priorities:",
      "Tasks:",
      ...(prio.tasks.length ? items("tasks").map((i) => `  ${i.text}: ${i.href}`) : ["  None"]),
      "Habits next week:",
      ...(prio.habits.length ? items("habits").map((i) => `  ${i.text}: ${i.href}`) : ["  None"]),
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
      `<p>Share this part (totals and facts): ${shares.map((x) => a(x.href, x.label)).join(" · ")}</p>`,
      "<h3>Next week</h3>",
      ...preview.map(
        (d) =>
          `<p><strong>${a(planner(d), dayLabel(d))}</strong>${d.mark ? ` <em>${d.mark}</em>` : ""}, ${esc(hoursText(d.minutes))}</p>` +
          (d.events.length
            ? `<ul>${d.events.map((e) => `<li>${a(planner(d), `${e.time} ${e.title}`)}</li>`).join("")}</ul>`
            : ""),
      ),
      "<h3>Priorities</h3>",
      "<p>Tasks</p>",
      prio.tasks.length
        ? `<ul>${items("tasks")
            .map((i) => `<li>P${i.level} ${a(i.href, i.title)}</li>`)
            .join("")}</ul>`
        : "<p>None</p>",
      "<p>Habits next week</p>",
      prio.habits.length
        ? `<ul>${items("habits")
            .map((i) => `<li>P${i.level} ${a(i.href, i.title)}</li>`)
            .join("")}</ul>`
        : "<p>None</p>",
      "<p>Turn this email off in Settings.</p>",
    ].join(""),
  };
}
