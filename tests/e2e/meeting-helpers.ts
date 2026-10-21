// Shared steps for meeting checks, meeting moves and meeting emails: raw
// iCalendar objects with guests and answers, as another calendar app or a
// CalDAV server with scheduling (RFC 6638) writes them, and the UI steps.
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { localToUtc, utcToLocal } from "../../src/shared/time.ts";
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

/** The stored iCalendar text of a whole calendar object (a series: master and overrides). */
export async function rawObject(calendarUrl: string, id: string): Promise<string> {
  const res = await fetch(id.split("#")[0] ?? id, {
    headers: { authorization: credentials(calendarUrl) },
  });
  if (!res.ok) throw new Error(`GET ${id} failed: ${res.status}`);
  return (await res.text()).replace(/\r?\n[ \t]/g, "");
}

/**
 * The stored iCalendar text of an event. For an instance of a series
 * (`<object url>#<recurrence id>`): its own VEVENT, the override, else the master.
 */
export async function rawEvent(calendarUrl: string, id: string): Promise<string> {
  const text = await rawObject(calendarUrl, id);
  if (!id.includes("#")) return text;
  return overrideOf(text.replace(/\r\n/g, "\n"), id) ?? masterOf(text.replace(/\r\n/g, "\n"));
}

/**
 * Replaces lines of a stored event, as another calendar app edits it. An
 * instance of a series gets the edit in its override ("this event").
 */
export async function editRaw(
  calendarUrl: string,
  id: string,
  edit: (lines: string[]) => string[],
): Promise<void> {
  if (id.includes("#")) return editInstance(calendarUrl, { id }, edit);
  const url = id.split("#")[0] ?? id;
  const auth = { authorization: credentials(calendarUrl) };
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const etag = res.headers.get("etag");
  const lines = edit((await res.text()).replace(/\r?\n[ \t]/g, "").split(/\r?\n/));
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...auth, "content-type": "text/calendar", ...(etag ? { "if-match": etag } : {}) },
    body: lines.join("\r\n"),
  });
  if (!put.ok) throw new Error(`PUT ${url} failed: ${put.status}`);
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
  // One instance of a series: the answer goes in its override.
  if (id.includes("#"))
    return editInstance(calendarUrl, { id }, (lines) =>
      lines.map((l) => {
        if (!/^ATTENDEE[;:]/i.test(l) || !l.toLowerCase().endsWith(`mailto:${email.toLowerCase()}`))
          return l;
        const [head, ...rest] = l.split(/:(?=mailto:)/i);
        const params = (head ?? "").split(";").filter((p) => !/^PARTSTAT=/i.test(p));
        return `${[...params, `PARTSTAT=${answer}`].join(";")}:${rest.join(":")}`;
      }),
    );
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
  duration?: number;
  /** Other fields of the form, filled before save. */
  more?: (form: Locator) => Promise<void>;
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
  if (m.duration) await form.getByLabel("Duration (minutes)").fill(String(m.duration));
  if (m.more) await m.more(form);
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

// A recurring series as one stored object (RFC 5545): a master with an RRULE
// and an override (RECURRENCE-ID) per changed instance. The steps below edit
// it as a calendar app does for "this event", "this and following events"
// and "all events".

/** The VEVENT blocks of an iCalendar text (unfolded), master first as stored. */
export const vevents = (ics: string) =>
  [...ics.matchAll(/BEGIN:VEVENT\r?\n[\s\S]*?END:VEVENT/g)].map((m) => m[0]);

/** The value of a property in one VEVENT block, without parameters; null when missing. */
export const blockProp = (block: string, name: string) =>
  new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "im").exec(block)?.[1]?.trim() ?? null;

/** The series master: the VEVENT without a RECURRENCE-ID. */
export const masterOf = (ics: string) =>
  vevents(ics).find((b) => blockProp(b, "RECURRENCE-ID") === null) ?? "";

/** The recurrence id in an instance id (`<object url>#<recurrence id>`), in iCalendar form. */
const ridOf = (id: string) => (id.split("#")[1] ?? "").replace(/[-:]/g, "");

/** The override of one instance, or null when the instance has none. */
export function overrideOf(ics: string, id: string): string | null {
  return vevents(ics).find((b) => blockProp(b, "RECURRENCE-ID") === ridOf(id)) ?? null;
}

/** What a guest's calendar app shows of one instance: its override, else the master. */
export async function instanceRaw(calendarUrl: string, id: string): Promise<string> {
  const ics = await rawEvent(calendarUrl, id);
  return overrideOf(ics, id) ?? masterOf(ics);
}

const icsUtc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Reads, changes and stores the series object of an instance id. */
async function editObject(calendarUrl: string, id: string, edit: (ics: string) => string) {
  const url = id.split("#")[0] ?? id;
  const auth = { authorization: credentials(calendarUrl) };
  const res = await fetch(url, { headers: auth });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  const etag = res.headers.get("etag");
  const ics = (await res.text()).replace(/\r?\n[ \t]/g, "").replace(/\r\n/g, "\n");
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...auth, "content-type": "text/calendar", ...(etag ? { "if-match": etag } : {}) },
    body: edit(ics).replace(/\n/g, "\r\n"),
  });
  if (!put.ok) throw new Error(`PUT ${url} failed: ${put.status}`);
}

/** "This event": edits the instance's override, made from the master when it has none. */
export async function editInstance(
  calendarUrl: string,
  e: { id: string; start?: number; end?: number },
  edit: (lines: string[]) => string[],
): Promise<void> {
  await editObject(calendarUrl, e.id, (ics) => {
    const own = overrideOf(ics, e.id);
    const master = masterOf(ics);
    const tzid = /^DTSTART;TZID=([^:;]+)/m.exec(master)?.[1];
    // The instance's rule time and the series length, when the caller gives no times.
    const at = (v: string) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
      if (!m) throw new Error(`Bad time ${v}`);
      const [, y, mo, d, h, mi, , z] = m;
      return z || !tzid
        ? Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))
        : localToUtc(tzid, `${y}-${mo}-${d}`, Number(h) * 60 + Number(mi));
    };
    const value = (name: string) =>
      new RegExp(`^${name}[^:\\n]*:(\\S+)$`, "m").exec(master)?.[1] ?? "";
    const start = e.start ?? at(ridOf(e.id));
    const end = e.end ?? start + (at(value("DTEND")) - at(value("DTSTART")));
    const block =
      own ??
      master
        .split("\n")
        .filter((l) => !/^(RRULE|RDATE|EXDATE|DTSTART|DTEND|DURATION)[:;]/.test(l))
        .flatMap((l) =>
          l.startsWith("UID:")
            ? [
                l,
                `RECURRENCE-ID${tzid ? `;TZID=${tzid}` : ""}:${ridOf(e.id)}`,
                `DTSTART:${icsUtc(start)}`,
                `DTEND:${icsUtc(end)}`,
              ]
            : [l],
        )
        .join("\n");
    const changed = edit(block.split("\n")).join("\n");
    return own
      ? ics.replace(own, changed)
      : ics.replace("END:VCALENDAR", `${changed}\nEND:VCALENDAR`);
  });
}

/** "All events": edits the master only; overrides keep their own values. */
export async function editMaster(
  calendarUrl: string,
  id: string,
  edit: (lines: string[]) => string[],
): Promise<void> {
  await editObject(calendarUrl, id, (ics) => {
    const master = masterOf(ics);
    return ics.replace(master, edit(master.split("\n")).join("\n"));
  });
}

/**
 * "This and following events", as calendar apps split a series: the old
 * series ends before the instance (RRULE UNTIL), its later overrides go, and a
 * new series (a new object and UID, the same properties) starts at the
 * instance's rule time. `edit` changes the new master. Returns the new object URL.
 */
export async function splitSeries(
  calendarUrl: string,
  e: { id: string },
  edit: (lines: string[]) => string[],
): Promise<string> {
  const rid = ridOf(e.id);
  let master = "";
  let zones = "";
  await editObject(calendarUrl, e.id, (ics) => {
    master = masterOf(ics);
    zones = [...ics.matchAll(/BEGIN:VTIMEZONE\n[\s\S]*?END:VTIMEZONE/g)]
      .map((m) => m[0])
      .join("\n");
    const tzid = /^DTSTART;TZID=([^:;]+)/m.exec(master)?.[1];
    // The last instant before the instance, in UTC (RFC 5545 3.3.10 UNTIL).
    const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(rid);
    if (!local) throw new Error(`Bad recurrence id ${rid}`);
    const [, y, mo, d, h, mi, s] = local;
    const start = tzid
      ? localToUtc(tzid, `${y}-${mo}-${d}`, Number(h) * 60 + Number(mi))
      : Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    const ended = master.replace(/^RRULE:(.*)$/m, (_l, rule: string) => {
      const parts = rule.split(";").filter((p) => !/^(UNTIL|COUNT)=/.test(p));
      return `RRULE:${[...parts, `UNTIL=${icsUtc(start - 1000)}`].join(";")}`;
    });
    let out = ics.replace(master, ended);
    for (const b of vevents(ics)) {
      const r = blockProp(b, "RECURRENCE-ID");
      if (r && r >= rid) out = out.replace(`${b}\n`, "").replace(b, "");
    }
    return out;
  });
  const uid = randomUUID();
  const url = new URL(`${uid}.ics`, calendarUrl).toString();
  const shift = (l: string) => {
    if (/^DTSTART[:;]/.test(l)) return l.replace(/:\d{8}T\d{6}(Z?)$/, `:${rid}`);
    return l;
  };
  const startOf = (block: string) => /^DTSTART[^:]*:(\S+)$/m.exec(block)?.[1] ?? "";
  const endOf = (block: string) => /^DTEND[^:]*:(\S+)$/m.exec(block)?.[1] ?? "";
  // The new master keeps the old length: DTEND moves by as much as DTSTART.
  const toMs = (v: string) =>
    Date.UTC(
      Number(v.slice(0, 4)),
      Number(v.slice(4, 6)) - 1,
      Number(v.slice(6, 8)),
      Number(v.slice(9, 11)),
      Number(v.slice(11, 13)),
    );
  const length = toMs(endOf(master)) - toMs(startOf(master));
  const end = new Date(toMs(rid) + length)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z/, "");
  const lines = master
    .split("\n")
    .filter((l) => !/^(EXDATE|RDATE)[:;]/.test(l))
    .map((l) =>
      l.startsWith("UID:")
        ? `UID:${uid}`
        : /^DTEND[:;]/.test(l)
          ? l.replace(/:\d{8}T\d{6}(Z?)$/, (_m, z: string) => `:${end}${z}`)
          : shift(l),
    );
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tempoloom-e2e//EN",
    ...(zones ? [zones] : []),
    ...edit(lines),
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: credentials(calendarUrl), "content-type": "text/calendar" },
    body: body.replace(/\r?\n/g, "\r\n"),
  });
  if (!res.ok) throw new Error(`PUT ${url} failed: ${res.status}`);
  return url;
}
