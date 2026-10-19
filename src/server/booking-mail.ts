// Emails about bookings (docs/specs/booking-links.md rules 14, 21;
// booking-links-booking-page.md rules 21-23): confirmation, update and cancel
// emails to the booker and the organizers, and the reminder to the booker.
// Without SMTP_URL nothing is sent; the calendar invitation is the only notice.

import { type Branding, brandingFor, resolveLinkBranding } from "./api/branding.ts";
import { type Db, one } from "./db.ts";
import type { Mailer } from "./mail.ts";

export interface Answer {
  question: string;
  answer: string;
}

/** What every booking email says. Times are UTC milliseconds. */
export interface BookingFacts {
  link: { user_id: string; branding: Branding; group_id: string | null };
  title: string;
  start: number;
  end: number;
  location: string;
  bookerName: string;
  bookerEmail: string;
  /** The zone the booker chose on the page. */
  bookerZone: string;
  message: string;
  answers: Answer[];
  /** Organizers and the round-robin assignee (user ids). */
  people: string[];
  /** The booking's manage token; the booker's email links to its actions. */
  token: string | null;
}

export type BookingChange = "created" | "rescheduled" | "cancelled";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** "Tuesday 20 October 2026, 10:00 to 10:30 (Europe/Berlin)" in one zone. */
export function when(zone: string, start: number, end: number): string {
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(start);
  const hm = (t: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(t);
  return `${date}, ${hm(start)} to ${hm(end)} (${zone})`;
}

const manageUrl = (baseUrl: string, token: string, action: "reschedule" | "cancel") =>
  new URL(`/book/manage/${token}?action=${action}`, baseUrl).toString();

/** The brand header of an HTML email: the link's branding with absolute URLs (rules 23, 25). */
function brandHtml(db: Db, baseUrl: string, link: BookingFacts["link"]): string {
  const b = brandingFor(db, link.user_id, resolveLinkBranding(db, link));
  if (b.mode === "none") return "";
  if (b.mode === "default") return `<p style="font-weight:700">Tempoloom</p>`;
  const abs = (u: string) => new URL(u, baseUrl).toString();
  const banner = b.banner
    ? `<img src="${esc(abs(b.banner))}" alt="" width="600" style="width:100%;max-width:600px;aspect-ratio:3/1;object-fit:cover">`
    : "";
  const logo = b.logo ? `<img src="${esc(abs(b.logo))}" alt="Logo" height="48">` : "";
  const linked = logo && b.homepage ? `<a href="${esc(b.homepage)}">${logo}</a>` : logo;
  return `<div>${banner}${linked}</div>`;
}

interface Mail {
  to: string;
  subject: string;
  lines: string[];
  links: [string, string][];
}

function render(db: Db, baseUrl: string, link: BookingFacts["link"], m: Mail) {
  const text = [...m.lines, ...m.links.map(([label, url]) => `${label}: ${url}`)].join("\n");
  const html = [
    "<!doctype html><html><body>",
    brandHtml(db, baseUrl, link),
    ...m.lines.map((l) => (l ? `<p>${esc(l).replaceAll("\n", "<br>")}</p>` : "")),
    ...m.links.map(([label, url]) => `<p><a href="${esc(url)}">${esc(label)}</a></p>`),
    "</body></html>",
  ].join("");
  return { to: m.to, subject: m.subject, text, html };
}

const user = (db: Db, id: string) =>
  one<{ name: string; email: string; time_zone: string }>(
    db,
    "SELECT name, email, time_zone FROM users WHERE id = ?",
    id,
  );

const VERB: Record<BookingChange, [string, string]> = {
  created: ["Booked", "Your meeting is booked."],
  rescheduled: ["Rescheduled", "Your meeting has a new time."],
  cancelled: ["Cancelled", "Your meeting is cancelled."],
};

/** The emails of one change: one to the booker, one to each organizer. */
export function bookingMails(db: Db, baseUrl: string, change: BookingChange, f: BookingFacts) {
  const [verb, news] = VERB[change];
  const answers = f.answers.filter((a) => a.answer).map((a) => `${a.question}\n${a.answer}`);
  const location = f.location ? [`Location: ${f.location}`] : [];
  const names = f.people.map((id) => user(db, id)?.name ?? "").filter(Boolean);
  const mails: Mail[] = [
    {
      to: f.bookerEmail,
      subject: `${verb}: ${f.title}, ${when(f.bookerZone, f.start, f.end)}`,
      lines: [
        `Hello ${f.bookerName},`,
        news,
        f.title,
        when(f.bookerZone, f.start, f.end),
        ...location,
        ...(names.length > 0 ? [`With: ${names.join(", ")}`] : []),
      ],
      // The actions are the booker's: anyone with the link can use them (page rule 21).
      links:
        change !== "cancelled" && f.token
          ? [
              ["Reschedule", manageUrl(baseUrl, f.token, "reschedule")],
              ["Cancel", manageUrl(baseUrl, f.token, "cancel")],
            ]
          : [],
    },
  ];
  const lead = change === "created" ? "New booking" : verb;
  for (const id of new Set(f.people)) {
    const u = user(db, id);
    if (!u?.email || u.email === f.bookerEmail.toLowerCase()) continue;
    mails.push({
      to: u.email,
      subject: `${lead}: ${f.title} with ${f.bookerName}, ${when(u.time_zone, f.start, f.end)}`,
      lines: [
        `${f.bookerName} (${f.bookerEmail})`,
        f.title,
        when(u.time_zone, f.start, f.end),
        ...location,
        ...(f.message ? [`Message:\n${f.message}`] : []),
        ...answers,
      ],
      links: [],
    });
  }
  return mails.map((m) => render(db, baseUrl, f.link, m));
}

/** Sends the emails of a change in the background; a failure is logged, never thrown. */
export function notifyBooking(
  db: Db,
  mailer: Mailer,
  baseUrl: string,
  change: BookingChange,
  f: BookingFacts,
): void {
  if (!mailer.configured) return;
  const mails = bookingMails(db, baseUrl, change, f);
  void (async () => {
    for (const m of mails) {
      try {
        await mailer.send(m);
      } catch (err) {
        console.error(`booking email to ${m.to} failed`, err);
      }
    }
  })();
}

/**
 * Whether a reminder is due at `now` (rule 21, edge case 7): its time has come,
 * the meeting has not started, and the reminder time was still ahead both when
 * the booking was made or moved and when the setting was saved.
 */
export function reminderDue(
  b: { start: number; updatedAt: number },
  r: { hoursBefore: number; savedAt: number },
  now: number,
): boolean {
  const at = b.start - r.hoursBefore * 3_600_000;
  return at <= now && now < b.start && at > b.updatedAt && at > r.savedAt;
}

interface ReminderRow {
  id: string;
  start_ms: number;
  end_ms: number;
  updated_at: number;
  name: string;
  email: string;
  time_zone: string;
  title: string;
  location: string;
  user_id: string;
  branding: Branding;
  group_id: string | null;
  reminder_hours: number;
  reminder_message: string;
  reminder_saved_at: number;
}

/** Sends every reminder that is due at `now`, once. Returns how many were sent. */
export async function sendDueReminders(
  db: Db,
  mailer: Mailer,
  baseUrl: string,
  now: number,
): Promise<number> {
  if (!mailer.configured) return 0;
  const rows = db
    .prepare(
      `SELECT b.id, b.start_ms, b.end_ms, b.updated_at, b.name, b.email, b.time_zone,
         l.title, l.location, l.user_id, l.branding, l.group_id, l.reminder_hours, l.reminder_message,
         l.reminder_saved_at
       FROM bookings b JOIN booking_links l ON l.id = b.link_id
       WHERE b.status = 'booked' AND b.reminder_sent_at IS NULL AND l.reminder_enabled = 1
         AND b.start_ms > ? AND b.start_ms - l.reminder_hours * 3600000 <= ?`,
    )
    .all(now, now) as unknown as ReminderRow[];
  let sent = 0;
  for (const r of rows) {
    if (
      !reminderDue(
        { start: r.start_ms, updatedAt: r.updated_at },
        { hoursBefore: r.reminder_hours, savedAt: r.reminder_saved_at },
        now,
      )
    )
      continue;
    // Claim it first, so a second sender (the server or the CLI) skips it.
    const claimed = db
      .prepare("UPDATE bookings SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL")
      .run(now, r.id).changes;
    if (claimed !== 1) continue;
    const link = { user_id: r.user_id, branding: r.branding, group_id: r.group_id };
    const mail = render(db, baseUrl, link, {
      to: r.email,
      subject: `Reminder: ${r.title}, ${when(r.time_zone, r.start_ms, r.end_ms)}`,
      lines: [
        `Hello ${r.name},`,
        r.reminder_message,
        r.title,
        when(r.time_zone, r.start_ms, r.end_ms),
        ...(r.location ? [`Location: ${r.location}`] : []),
      ],
      links: [],
    });
    try {
      await mailer.send(mail);
      sent++;
    } catch (err) {
      // Free the claim so the next run tries again.
      db.prepare("UPDATE bookings SET reminder_sent_at = NULL WHERE id = ?").run(r.id);
      console.error(`reminder to ${r.email} failed`, err);
    }
  }
  return sent;
}
