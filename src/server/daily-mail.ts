// Meeting emails: guest update emails for flexible meeting changes
// (planning-notifications.md NTF-20 to NTF-22), the daily digest of meeting
// issues (automations-meeting-quality.md rule 6), the at-risk digest
// (meetings-flexible-rescheduling.md rule 35), the new recurring meeting
// email (NTF-30) and the weekly report (analytics-weekly-reports.md). Each
// daily email goes out at its local time; a new time takes effect at its next
// occurrence.
import type { ReportEntry } from "../scheduler/model.ts";
import { addDays, localToUtc, utcToLocal } from "../shared/time.ts";
import { all, type Db, one, run } from "./db.ts";
import type { Mailer, Message } from "./mail.ts";
import { openIssues } from "./meeting-checks.ts";
import { getPrefs } from "./meeting-prefs.ts";
import { adoptableSeries } from "./meeting-series.ts";
import { attendeesOf } from "./planner/meetings.ts";
import { claimWeeklyReport, weeklyReport } from "./weekly-report.ts";

/** "weekly" rows are claimed in weekly-report.ts. */
export type DailyKind = "checks" | "daily";

const pad = (n: number) => String(n).padStart(2, "0");
const when = (zone: string, t: number) => {
  const l = utcToLocal(zone, t);
  return `${l.date} ${pad(Math.floor(l.minuteOfDay / 60))}:${pad(l.minuteOfDay % 60)}`;
};
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

/** The next instant after `now` at local time `hhmm` in `zone`. */
export function nextAt(zone: string, hhmm: string, now: number): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const today = utcToLocal(zone, now).date;
  const t = localToUtc(zone, today, h * 60 + m);
  return t > now ? t : localToUtc(zone, addDays(today, 1), h * 60 + m);
}

export function scheduleDaily(
  db: Db,
  userId: string,
  kind: DailyKind,
  zone: string,
  hhmm: string,
  now: number,
): void {
  run(
    db,
    `INSERT INTO daily_mail (user_id, kind, next_at) VALUES (?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE SET next_at = excluded.next_at`,
    userId,
    kind,
    nextAt(zone, hhmm, now),
  );
}

/** True when the email is due now; then its next time moves to the next day. */
function due(db: Db, userId: string, kind: DailyKind, zone: string, hhmm: string, now: number) {
  const row = one<{ next_at: number }>(
    db,
    "SELECT next_at FROM daily_mail WHERE user_id = ? AND kind = ?",
    userId,
    kind,
  );
  if (row && row.next_at > now) return false;
  scheduleDaily(db, userId, kind, zone, hhmm, now);
  return row !== undefined;
}

export interface DailyMailDeps {
  db: Db;
  mailer: Mailer;
  now: () => number;
  baseUrl: string;
  intervalMs: number;
  /** false: no weekly reports (the operator's WEEKLY_REPORTS=off). */
  weeklyReports?: boolean;
  log?: (msg: string, err?: unknown) => void;
}

export class DailyMailWorker {
  readonly #d: DailyMailDeps;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<unknown> | undefined;

  constructor(deps: DailyMailDeps) {
    this.#d = deps;
  }

  start(): void {
    this.#timer = setInterval(() => {
      this.#running ??= this.tick().finally(() => {
        this.#running = undefined;
      });
    }, this.#d.intervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#running;
  }

  #log(msg: string, err?: unknown) {
    (this.#d.log ?? ((m, e) => console.error(m, e ?? "")))(msg, err);
  }

  async #send(to: string, subject: string, text: string, ics?: string) {
    await this.#mail({
      to,
      subject,
      text,
      ...(ics ? { icalEvent: { method: "REQUEST", content: ics } } : {}),
    });
  }

  /** True when the message went out. */
  async #mail(m: Message): Promise<boolean> {
    try {
      await this.#d.mailer.send(m);
      return true;
    } catch (err) {
      this.#log(`email to ${m.to} failed`, err);
      return false;
    }
  }

  /** Sends the emails due now; returns how many weekly reports went out. */
  async tick(): Promise<number> {
    if (!this.#d.mailer.configured) return 0;
    let reports = 0;
    await this.#guestUpdates();
    const { db } = this.#d;
    const now = this.#d.now();
    for (const u of all<{ id: string; email: string; name: string; time_zone: string }>(
      db,
      `SELECT u.id, u.email, u.name, u.time_zone FROM users u
       WHERE u.deactivated_at IS NULL AND u.first_sign_in_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'ok')`,
    )) {
      const prefs = getPrefs(db, u.id);
      if (prefs.digest === "email" && due(db, u.id, "checks", u.time_zone, prefs.digestTime, now)) {
        await this.#digest(u, now);
      }
      if (
        (prefs.atRiskDigest || prefs.newSeriesEmail) &&
        due(db, u.id, "daily", u.time_zone, prefs.dailyTime, now)
      ) {
        if (prefs.atRiskDigest) await this.#atRisk(u, now);
        if (prefs.newSeriesEmail) await this.#newSeries(u, now);
      }
      if (this.#d.weeklyReports !== false && prefs.weeklyReport) {
        const week = claimWeeklyReport(db, u.id, u.time_zone, now);
        if (week && (await this.#mail(weeklyReport(db, u, week, this.#d.baseUrl, now)))) reports++;
      }
    }
    return reports;
  }

  /** Rule 6: open issues of the next 7 days; nothing when there are none. */
  async #digest(u: { id: string; email: string; time_zone: string }, now: number) {
    const issues = openIssues(this.#d.db, u.id, now);
    if (issues.length === 0) return;
    const lines = issues.map((i) => `- ${when(u.time_zone, i.start)} ${i.title}: ${i.message}`);
    await this.#send(
      u.email,
      `Meeting issues: ${issues.length} to look at`,
      [
        "Tempoloom found these problems with your meetings in the next 7 days:",
        "",
        ...lines,
        "",
        `Open the planner to fix or ignore them: ${new URL("/", this.#d.baseUrl).toString()}`,
      ].join("\n"),
    );
  }

  /** Rule 35: meetings with an occurrence in the next 14 days that is unplaced or in conflict. */
  async #atRisk(u: { id: string; email: string; time_zone: string }, now: number) {
    const { db } = this.#d;
    const report = JSON.parse(
      one<{ report: string }>(db, "SELECT report FROM plan_reports WHERE user_id = ?", u.id)
        ?.report ?? "[]",
    ) as ReportEntry[];
    const limit = addDays(utcToLocal(u.time_zone, now).date, 14);
    const lines: string[] = [];
    for (const e of report) {
      if (e.itemKind !== "meeting" || (e.status !== "conflict" && e.status !== "unplaced"))
        continue;
      const period = e.demandKey.slice(e.demandKey.lastIndexOf(":") + 1);
      if (period > limit) continue;
      const title =
        one<{ title: string }>(db, "SELECT title FROM meetings WHERE id = ?", e.itemId)?.title ??
        "";
      const row = one<{ start_ms: number }>(
        db,
        "SELECT start_ms FROM managed_events WHERE user_id = ? AND key = ?",
        u.id,
        e.demandKey,
      );
      lines.push(
        row
          ? `- ${title}: ${when(u.time_zone, row.start_ms)}, kept in conflict`
          : `- ${title}: no time found in the period from ${period}`,
      );
    }
    if (lines.length === 0) return;
    await this.#send(
      u.email,
      `Meetings at risk: ${lines.length} in the next 14 days`,
      [
        "These flexible meetings have no good time in the next 14 days:",
        "",
        ...lines,
        "",
        `Review them: ${new URL("/meetings", this.#d.baseUrl).toString()}`,
      ].join("\n"),
    );
  }

  /** NTF-30: recurring meetings the user organizes that are not flexible yet, each offered once. */
  async #newSeries(u: { id: string; email: string; time_zone: string }, now: number) {
    const { db } = this.#d;
    const fresh = adoptableSeries(db, u.id, now).filter(
      (s) =>
        !one(
          db,
          "SELECT 1 FROM series_offers WHERE user_id = ? AND series_id = ?",
          u.id,
          s.seriesId,
        ),
    );
    if (fresh.length === 0) return;
    const lines = fresh.map((s) => {
      const how =
        s.everyWeeks === "daily"
          ? "every day"
          : `every ${s.everyWeeks === 1 ? "week" : `${s.everyWeeks} weeks`} on ${DAY_NAMES[s.idealDay]}`;
      const link = new URL(`/meetings?adopt=${s.key}`, this.#d.baseUrl).toString();
      return `- ${s.title} (${how} at ${s.idealTime}): ${link}`;
    });
    await this.#send(
      u.email,
      "Recurring meetings you could make flexible",
      [
        "Tempoloom can move these meetings to a time that suits everyone when plans change:",
        "",
        ...lines,
      ].join("\n"),
    );
    for (const s of fresh)
      run(
        db,
        "INSERT OR IGNORE INTO series_offers (user_id, series_id, offered_at) VALUES (?, ?, ?)",
        u.id,
        s.seriesId,
        now,
      );
  }

  /** NTF-20: one email per guest for each change that asked for it. */
  async #guestUpdates() {
    const { db } = this.#d;
    for (const c of all<{
      id: number;
      user_id: string;
      meeting_id: string;
      occurrence_key: string;
      old_start: number | null;
      old_end: number | null;
      new_start: number | null;
      new_end: number | null;
    }>(db, "SELECT * FROM meeting_changes WHERE notify = 1 ORDER BY id")) {
      run(db, "UPDATE meeting_changes SET notify = 2 WHERE id = ?", c.id);
      const m = one<{ title: string; location: string }>(
        db,
        "SELECT title, location FROM meetings WHERE id = ?",
        c.meeting_id,
      );
      const org = one<{ email: string; name: string; time_zone: string }>(
        db,
        "SELECT email, name, time_zone FROM users WHERE id = ?",
        c.user_id,
      );
      if (!m || !org) continue;
      const zone = org.time_zone;
      const span = (s: number | null, e: number | null) =>
        s === null || e === null ? "" : `${when(zone, s)} to ${when(zone, e).slice(11)}`;
      const moved = c.new_start !== null;
      const text = [
        `${org.name || org.email} ${moved ? "moved" : "cancelled"} "${m.title}".`,
        "",
        `Was: ${span(c.old_start, c.old_end)}`,
        ...(moved ? [`Now: ${span(c.new_start, c.new_end)}`] : []),
        `Times are in ${zone}.`,
      ].join("\n");
      const event = one<{ event_id: string }>(
        db,
        "SELECT event_id FROM managed_events WHERE user_id = ? AND key = ?",
        c.user_id,
        c.occurrence_key,
      )?.event_id;
      const ics =
        moved && event && !event.includes("#")
          ? invite(event, m.title, org.email, attendeesOf(db, c.meeting_id), c)
          : undefined;
      for (const a of attendeesOf(db, c.meeting_id)) {
        if (a.email === org.email) continue;
        await this.#send(a.email, `${moved ? "Updated" : "Cancelled"}: ${m.title}`, text, ics);
      }
    }
  }
}

const icsTime = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** An iTIP REQUEST (RFC 5546) for guests whose calendar server does not deliver updates. */
function invite(
  eventId: string,
  title: string,
  organizer: string,
  attendees: { email: string; required: boolean }[],
  c: { id: number; new_start: number | null; new_end: number | null },
): string {
  const uid = decodeURIComponent(eventId.slice(eventId.lastIndexOf("/") + 1)).replace(/\.ics$/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Tempoloom//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${c.id}`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART:${icsTime(c.new_start ?? 0)}`,
    `DTEND:${icsTime(c.new_end ?? 0)}`,
    `SUMMARY:${title.replace(/[\\;,]/g, (x) => `\\${x}`)}`,
    `ORGANIZER:mailto:${organizer}`,
    ...attendees.map(
      (a) =>
        `ATTENDEE;ROLE=${a.required ? "REQ-PARTICIPANT" : "OPT-PARTICIPANT"};PARTSTAT=NEEDS-ACTION:mailto:${a.email}`,
    ),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
