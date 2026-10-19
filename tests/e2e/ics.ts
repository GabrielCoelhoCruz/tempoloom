// Raw iCalendar objects in a test user's Radicale calendar, for events the
// calendar driver does not write: out-of-office events and invitations from a
// named organizer with a description. Another calendar app writes them the
// same way. A PUT to the same id replaces the event (a move or a new answer).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { addDays } from "../../src/shared/time.ts";

const ROOT = join(import.meta.dirname, "../..");

/** The Radicale password of the user who owns a calendar URL (scripts/caldav-server.sh env). */
export function credentials(calendarUrl: string): string {
  const username = new URL(calendarUrl).pathname.split("/")[1] ?? "";
  const env = Object.fromEntries(
    execFileSync(join(ROOT, "scripts/caldav-server.sh"), ["env"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.split(/=(.*)/s).slice(0, 2)),
  );
  const suffix = Object.entries(env)
    .find(([k, v]) => k.startsWith("CALDAV_USERNAME") && v === username)?.[0]
    .slice("CALDAV_USERNAME".length);
  if (suffix === undefined) throw new Error(`No Radicale user for ${calendarUrl}`);
  return `Basic ${Buffer.from(`${username}:${env[`CALDAV_PASSWORD${suffix}`]}`).toString("base64")}`;
}

const utc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
const date = (d: string) => d.replace(/-/g, "");

/** When the event happens: whole local dates (end exclusive) or instants. */
export type Span = { from: string; to: string } | { start: number; end: number };

const spanLines = (s: Span) =>
  "from" in s
    ? [`DTSTART;VALUE=DATE:${date(s.from)}`, `DTEND;VALUE=DATE:${date(s.to)}`]
    : [`DTSTART:${utc(s.start)}`, `DTEND:${utc(s.end)}`];

/** Writes (or replaces, when `id` is given) one event; returns its id, as the provider reads it. */
export async function putEvent(calendarUrl: string, lines: string[], id?: string): Promise<string> {
  const url = id ?? new URL(`${randomUUID()}.ics`, calendarUrl).toString();
  const uid = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1)).replace(/\.ics$/, "");
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: credentials(calendarUrl), "content-type": "text/calendar" },
    body: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//tempoloom-e2e//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${utc(Date.now())}`,
      ...lines,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
  });
  if (!res.ok) throw new Error(`PUT ${url} failed: ${res.status}`);
  return url;
}

/** An out-of-office event, as Outlook-style CalDAV clients mark it. */
export const outOfOffice = (calendarUrl: string, title: string, span: Span, id?: string) =>
  putEvent(
    calendarUrl,
    [...spanLines(span), `SUMMARY:${title}`, "TRANSP:OPAQUE", "X-MICROSOFT-CDO-BUSYSTATUS:OOF"],
    id,
  );

/** A busy all-day event on one local date. */
export const allDayBusy = (calendarUrl: string, title: string, day: string) =>
  putEvent(calendarUrl, [...spanLines({ from: day, to: addDays(day, 1) }), `SUMMARY:${title}`]);

/** A busy invitation from `organizer`, with this calendar owner's answer. */
export const invitation = (
  calendarUrl: string,
  e: {
    title: string;
    description: string;
    span: Span;
    organizer: string;
    attendees: { email: string; answer: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED" }[];
  },
  id?: string,
) =>
  putEvent(
    calendarUrl,
    [
      ...spanLines(e.span),
      `SUMMARY:${e.title}`,
      `DESCRIPTION:${e.description}`,
      "TRANSP:OPAQUE",
      `ORGANIZER:mailto:${e.organizer}`,
      `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${e.organizer}`,
      ...e.attendees.map((a) => `ATTENDEE;PARTSTAT=${a.answer}:mailto:${a.email}`),
    ],
    id,
  );
