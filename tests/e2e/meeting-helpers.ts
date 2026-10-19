// Shared steps for meeting checks, meeting moves and meeting emails: raw
// iCalendar objects with guests and answers, as another calendar app or a
// CalDAV server with scheduling (RFC 6638) writes them, and the UI steps.
import type { Page } from "@playwright/test";
import { utcToLocal } from "../../src/shared/time.ts";
import { eventually, expect, type Mailbox, ZONE } from "./fixtures.ts";
import { credentials, putEvent } from "./ics.ts";

export type Answer = "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE" | "DECLINED";

const utc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

export interface RawMeeting {
  title: string;
  start: number;
  end: number;
  organizer: string;
  /** The organizer is written as an accepted attendee first. */
  attendees: { email: string; answer: Answer }[];
  location?: string;
  description?: string;
  /** An RFC 7986 CONFERENCE link. */
  conference?: string;
  /** For example "FREQ=WEEKLY;COUNT=6". */
  rrule?: string;
  free?: boolean;
}

/** Writes (or replaces, with `id`) a meeting with guests; returns its id. */
export const putMeeting = (calendarUrl: string, m: RawMeeting, id?: string) =>
  putEvent(
    calendarUrl,
    [
      `DTSTART:${utc(m.start)}`,
      `DTEND:${utc(m.end)}`,
      `SUMMARY:${m.title}`,
      ...(m.description ? [`DESCRIPTION:${m.description}`] : []),
      ...(m.location ? [`LOCATION:${m.location.replace(/,/g, "\\,")}`] : []),
      ...(m.conference ? [`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${m.conference}`] : []),
      ...(m.rrule ? [`RRULE:${m.rrule}`] : []),
      `TRANSP:${m.free ? "TRANSPARENT" : "OPAQUE"}`,
      `ORGANIZER:mailto:${m.organizer}`,
      `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${m.organizer}`,
      ...m.attendees.map((a) => `ATTENDEE;PARTSTAT=${a.answer}:mailto:${a.email}`),
    ],
    id,
  );

/** The stored iCalendar text of an event. */
export async function rawEvent(calendarUrl: string, id: string): Promise<string> {
  const res = await fetch(id.split("#")[0] ?? id, {
    headers: { authorization: credentials(calendarUrl) },
  });
  if (!res.ok) throw new Error(`GET ${id} failed: ${res.status}`);
  return (await res.text()).replace(/\r?\n[ \t]/g, "");
}

/**
 * Sets one guest's answer on the organizer's copy of an event, as a CalDAV
 * server with scheduling does when that guest replies.
 */
export async function answerAs(
  calendarUrl: string,
  id: string,
  email: string,
  answer: Answer,
): Promise<void> {
  const url = id.split("#")[0] ?? id;
  const res = await fetch(url, { headers: { authorization: credentials(calendarUrl) } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const etag = res.headers.get("etag");
  const text = (await res.text()).replace(/\r?\n[ \t]/g, "");
  const lines = text.split(/\r?\n/).map((l) => {
    if (!/^ATTENDEE[;:]/i.test(l) || !l.toLowerCase().endsWith(`mailto:${email.toLowerCase()}`))
      return l;
    const [head, ...rest] = l.split(/:(?=mailto:)/i);
    const params = (head ?? "").split(";").filter((p) => !/^PARTSTAT=/i.test(p));
    return `${[...params, `PARTSTAT=${answer}`].join(";")}:${rest.join(":")}`;
  });
  if (lines.join("\n") === text.split(/\r?\n/).join("\n"))
    throw new Error(`${email} is not a guest of ${url}`);
  const put = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: credentials(calendarUrl),
      "content-type": "text/calendar",
      ...(etag ? { "if-match": etag } : {}),
    },
    body: lines.join("\r\n"),
  });
  if (!put.ok) throw new Error(`PUT ${url} failed: ${put.status}`);
}

/** A local "HH:MM" in the test zone at least 20 seconds ahead: the next daily email time. */
export function soon(now = Date.now()): string {
  const l = utcToLocal(ZONE, now + 20_000);
  const m = (l.minuteOfDay + 1) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Waits for a daily email (it goes out when its local time comes, within about 90 s). */
export async function dailyMail(mail: Mailbox, to: string, subject: RegExp) {
  await eventually(
    () => mail.count(to),
    (n) => expect(n, `daily mail to ${to}`).toBeGreaterThan(0),
    150_000,
  );
  return mail.message(to, subject);
}

/** The planner's Issues tab (automations-meeting-quality.md rule 6). */
export async function openIssues(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(page.getByTestId("checks-issues")).toBeVisible();
}

export const issue = (page: Page, check: string, title: string) =>
  page.locator(`[data-testid="issue"][data-check="${check}"]`, { hasText: title });

export async function openChecks(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Meeting checks" }).click();
  await expect(page.getByTestId("checks-page")).toBeVisible();
}

export interface MeetingForm {
  title: string;
  guests: string;
  optional?: string;
  idealTime?: string;
  days?: ("Mon" | "Tue" | "Wed" | "Thu" | "Fri")[];
  moves?: "No automatic moves" | "1 per day" | "3 per day" | "5 per day";
}

/** Fills and saves the flexible meeting form. */
export async function addMeeting(page: Page, m: MeetingForm): Promise<void> {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(m.guests);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  if (m.optional) await form.getByLabel("Optional guests (comma list)").fill(m.optional);
  if (m.idealTime) await form.getByLabel("Ideal time").fill(m.idealTime);
  if (m.days) {
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
      await form.getByLabel(d, { exact: true }).setChecked(m.days.includes(d as "Mon"));
  }
  if (m.moves) await form.getByLabel("Automatic moves").selectOption({ label: m.moves });
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator(`[data-meeting-title="${m.title}"]`)).toBeVisible();
}

/** The meeting email settings on the Settings page. */
export async function meetingEmails(
  page: Page,
  s: { guests?: boolean; daysAhead?: number; atRisk?: boolean; newSeries?: boolean; time?: string },
): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("meeting-emails");
  if (s.guests !== undefined)
    await form
      .getByLabel("Email guests when Tempoloom moves or cancels a meeting")
      .setChecked(s.guests);
  if (s.daysAhead !== undefined)
    await form.getByLabel("Only for meetings in the next (days)").fill(String(s.daysAhead));
  if (s.atRisk !== undefined)
    await form.getByLabel("Daily email about meetings at risk").setChecked(s.atRisk);
  if (s.newSeries !== undefined)
    await form.getByLabel("Email me about new recurring meetings").setChecked(s.newSeries);
  if (s.time) await form.getByLabel("Send daily emails at").fill(s.time);
  await form.getByRole("button", { name: "Save meeting emails" }).click();
  await expect(form.getByTestId("meeting-emails-saved")).toHaveText("Saved");
}
