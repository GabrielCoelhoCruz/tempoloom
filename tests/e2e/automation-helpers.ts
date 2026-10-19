// Steps shared by the habit action, focus, meeting overload and buffer filter
// scenarios. They drive the UI or act like another calendar app would.
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays } from "../../src/shared/time.ts";
import { type AppServer, at, type CalendarDriver, expect, local } from "./fixtures.ts";
import { W } from "./helpers.ts";

export const day = (n: number) => addDays(W, n);
export const week = (cal: CalendarDriver, from = W) =>
  cal.events(at(from, "00:00"), at(addDays(from, 7), "00:00"));
export const span = (e: { start: number; end: number }) =>
  `${local(e.start)}-${local(e.end).slice(11)}`;
export const minutesOf = (evs: { start: number; end: number }[]) =>
  evs.reduce((a, e) => a + (e.end - e.start), 0) / 60_000;
export const own = (evs: ProviderEvent[], title: string) =>
  evs.filter((e) => e.privateProps.tl !== "1" && e.summary === title);

/** Basic credentials of a Radicale user (the `radicale` worker fixture). */
export interface DavUser {
  username: string;
  password: string;
}

const auth = (u: DavUser) =>
  `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`;

const utc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** The raw iCalendar text of one event on the CalDAV server, lines unfolded. */
export async function rawEvent(user: DavUser, id: string): Promise<string> {
  const res = await fetch(id.split("#")[0] as string, { headers: { Authorization: auth(user) } });
  if (!res.ok) throw new Error(`GET ${res.status}`);
  return (await res.text()).replace(/\r?\n[ \t]/g, "");
}

/** A weekly series written straight to the CalDAV server, like another calendar app would. */
export async function putSeries(
  user: DavUser,
  cal: CalendarDriver,
  s: {
    title: string;
    start: number;
    minutes: number;
    byDay: string;
    attendees?: string[];
    selfEmail?: string;
  },
): Promise<string> {
  const uid = randomUUID();
  const url = new URL(`${uid}.ics`, cal.calendarId).toString();
  const people = s.attendees
    ? [
        `ORGANIZER:mailto:${s.selfEmail ?? "e2e@tempoloom.test"}`,
        `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${s.selfEmail ?? "e2e@tempoloom.test"}`,
        ...s.attendees.map((a) => `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${a}`),
      ]
    : [];
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tempoloom-e2e//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "DTSTAMP:20260101T000000Z",
    `DTSTART:${utc(s.start)}`,
    `DTEND:${utc(s.start + s.minutes * 60_000)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${s.byDay};COUNT=12`,
    `SUMMARY:${s.title}`,
    ...people,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: auth(user), "Content-Type": "text/calendar; charset=utf-8" },
    body,
  });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
  return url;
}

/** Moves a managed event in the calendar so that it runs now (a calendar move locks it). */
export async function moveToNow(cal: CalendarDriver, e: ProviderEvent): Promise<void> {
  const start = Date.now() - 5 * 60_000;
  await cal.update(e.id, { start, end: start + 60 * 60_000 });
}

/** The planner box of the managed event that the calendar holds as `eventId`. */
export async function boxOf(page: Page, app: AppServer, eventId: string) {
  const [row] = app.query<{ id: string }>(
    "SELECT id FROM managed_events WHERE event_id = ?",
    eventId,
  );
  if (!row) throw new Error(`No managed event for ${eventId}`);
  return page.locator(`[data-event-id="${row.id}"]`);
}

export async function openSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

export async function openLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
}

/** An invitation from someone else to the test user (CalDAV), unanswered unless said. */
export const invite = (
  cal: CalendarDriver,
  title: string,
  date: string,
  from: string,
  to: string,
  answer: "NEEDS-ACTION" | "ACCEPTED" | "DECLINED" = "NEEDS-ACTION",
) => cal.addInvite({ title, start: at(date, from), end: at(date, to), answer });

/** Creates a task search in a task search picker and leaves it selected. */
export async function newTaskSearch(
  scope: ReturnType<Page["getByTestId"]>,
  name: string,
  keyword: string,
): Promise<void> {
  const box = scope.getByTestId("new-task-search");
  await box.getByLabel("Search name").fill(name);
  await box.getByLabel("Title contains").fill(keyword);
  await box.getByRole("button", { name: "Save search" }).click();
  await expect(scope.getByLabel("Task search")).toHaveValue(/.+/);
}
