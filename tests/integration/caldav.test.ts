// Runs against a real Radicale server: scripts/caldav-server.sh start, then
// `eval "$(scripts/caldav-server.sh env | sed 's/^/export /')"; npm run test:integration`.
//
// Failure modes of the CalDAV provider:
// 1. Wrong credentials must fail as an auth error, not as an empty calendar.
// 2. Managed-event properties must survive a write and a read.
// 3. A stale ETag must fail as precondition_failed, so a user's edit is never overwritten.
// 4. Deleting an event twice must succeed.
// 5. A recurring series with a TZID must expand to the right instants across DST,
//    honor EXDATE, and use the moved time of an overridden instance.
// 6. All-day, free (TRANSPARENT) and cancelled events must be recognized.
// 7. The user's own attendee status and a foreign organizer must be read.
// 8. An unchanged calendar must report no changes; a changed one a full read.
import { randomUUID } from "node:crypto";
import { DAVClient } from "tsdav";
import { beforeAll, describe, expect, it } from "vitest";
import { CalDavProvider } from "../../src/server/providers/caldav.ts";
import { ProviderError } from "../../src/server/providers/types.ts";

const url = process.env.CALDAV_URL;
const username = process.env.CALDAV_USERNAME ?? "e2e";
const password = process.env.CALDAV_PASSWORD ?? "";
if (!url) throw new Error("CALDAV_URL is not set; start scripts/caldav-server.sh first");

const ZONE = "Europe/Berlin";
const EMAIL = "e2e@tempoloom.test";
const H = 3_600_000;
const from = Date.parse("2026-10-19T00:00:00Z");
const to = Date.parse("2026-11-09T00:00:00Z");

let calendarUrl = "";
let raw: DAVClient;

async function putRaw(ics: string): Promise<string> {
  const name = `${randomUUID()}.ics`;
  const cal = (await raw.fetchCalendars()).find((c) => c.url === calendarUrl);
  if (!cal) throw new Error("test calendar missing");
  const res = await raw.createCalendarObject({ calendar: cal, filename: name, iCalString: ics });
  expect(res.ok).toBe(true);
  return new URL(name, calendarUrl).toString();
}

const provider = () =>
  new CalDavProvider({ serverUrl: url, username, password, email: EMAIL }, ZONE);

beforeAll(async () => {
  raw = new DAVClient({
    serverUrl: url,
    credentials: { username, password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  await raw.login();
  const home = raw.account?.homeUrl;
  if (!home) throw new Error("no calendar home");
  calendarUrl = new URL(`it-${randomUUID()}/`, home).toString();
  await raw.makeCalendar({ url: calendarUrl, props: { displayname: "Integration" } });
});

describe("CalDavProvider", () => {
  it("fails with an auth error for a wrong password", async () => {
    const p = new CalDavProvider(
      { serverUrl: url, username, password: "wrong", email: EMAIL },
      ZONE,
    );
    await expect(p.listCalendars()).rejects.toMatchObject({ kind: "auth" });
  });

  it("lists the calendar", async () => {
    const cals = await provider().listCalendars();
    expect(cals.find((c) => c.id === calendarUrl)?.name).toBe("Integration");
  });

  it("writes, reads back, updates with ETag checks, and deletes a managed event", async () => {
    const p = provider();
    const write = {
      summary: "Write report",
      description: "Line 1\nLine, 2; with symbols",
      start: Date.parse("2026-10-20T08:00:00Z"),
      end: Date.parse("2026-10-20T09:30:00Z"),
      busy: false,
      colorId: null,
      privateProps: { tl: "1", tl_key: "task:abc:0" },
    };
    const created = await p.insertEvent(calendarUrl, write);
    expect(created).toMatchObject({
      summary: write.summary,
      description: write.description,
      start: write.start,
      end: write.end,
      busy: false,
      privateProps: write.privateProps,
    });
    expect(created.etag).toBeTruthy();

    const moved = await p.updateEvent(
      calendarUrl,
      created.id,
      { ...write, start: write.start + H, end: write.end + H, busy: true },
      created.etag,
    );
    expect(moved).toMatchObject({ start: write.start + H, busy: true });
    expect(moved.etag).not.toBe(created.etag);

    const stale = p.updateEvent(calendarUrl, created.id, write, created.etag);
    await expect(stale).rejects.toBeInstanceOf(ProviderError);
    await expect(stale).rejects.toMatchObject({ kind: "precondition_failed" });

    await p.deleteEvent(calendarUrl, created.id);
    await p.deleteEvent(calendarUrl, created.id);
    const after = await p.listEvents(calendarUrl, { syncToken: null, timeMin: from, timeMax: to });
    expect(after.events.find((e) => e.id === created.id)).toBeUndefined();
  });

  it("expands a recurring series across DST with EXDATE and a moved instance", async () => {
    const uid = randomUUID();
    const href = await putRaw(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261001T000000Z",
        "DTSTART;TZID=Europe/Berlin:20261020T100000",
        "DTEND;TZID=Europe/Berlin:20261020T110000",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "EXDATE;TZID=Europe/Berlin:20261103T100000",
        "SUMMARY:Weekly sync",
        "END:VEVENT",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261001T000000Z",
        "RECURRENCE-ID;TZID=Europe/Berlin:20261027T100000",
        "DTSTART;TZID=Europe/Berlin:20261027T140000",
        "DTEND;TZID=Europe/Berlin:20261027T150000",
        "SUMMARY:Weekly sync (moved)",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const { events } = await provider().listEvents(calendarUrl, {
      syncToken: null,
      timeMin: from,
      timeMax: to,
    });
    const series = events.filter((e) => e.recurringId === href).sort((a, b) => a.start - b.start);
    // 20 Oct is CEST (+02:00); 27 Oct is after the 25 Oct switch to CET (+01:00).
    expect(series.map((e) => [new Date(e.start).toISOString(), e.summary])).toEqual([
      ["2026-10-20T08:00:00.000Z", "Weekly sync"],
      ["2026-10-27T13:00:00.000Z", "Weekly sync (moved)"],
    ]);
  });

  it("reads all-day, free, cancelled and attendee facts", async () => {
    const vevent = (lines: string[]) =>
      putRaw(
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//test//EN",
          "BEGIN:VEVENT",
          `UID:${randomUUID()}`,
          "DTSTAMP:20261001T000000Z",
          ...lines,
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
      );
    const allDay = await vevent([
      "DTSTART;VALUE=DATE:20261021",
      "DTEND;VALUE=DATE:20261022",
      "SUMMARY:Holiday",
    ]);
    const free = await vevent([
      "DTSTART:20261021T120000Z",
      "DTEND:20261021T130000Z",
      "TRANSP:TRANSPARENT",
      "SUMMARY:Optional",
    ]);
    const declined = await vevent([
      "DTSTART:20261022T090000Z",
      "DTEND:20261022T100000Z",
      "SUMMARY:Invite",
      "ORGANIZER:mailto:boss@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
      `ATTENDEE;PARTSTAT=DECLINED:mailto:${EMAIL.toUpperCase()}`,
    ]);
    const cancelled = await vevent([
      "DTSTART:20261023T090000Z",
      "DTEND:20261023T100000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Gone",
    ]);
    const { events } = await provider().listEvents(calendarUrl, {
      syncToken: null,
      timeMin: from,
      timeMax: to,
    });
    const byId = new Map(events.map((e) => [e.id, e]));
    expect(byId.get(allDay)).toMatchObject({
      allDay: true,
      start: Date.parse("2026-10-20T22:00:00Z"),
      end: Date.parse("2026-10-21T22:00:00Z"),
    });
    expect(byId.get(free)?.busy).toBe(false);
    expect(byId.get(declined)).toMatchObject({
      selfResponse: "declined",
      organizerSelf: false,
      attendeeCount: 2,
    });
    expect(byId.get(cancelled)?.cancelled).toBe(true);
  });

  it("reports no changes for an unchanged calendar and a full read after a change", async () => {
    const p = provider();
    const first = await p.listEvents(calendarUrl, { syncToken: null, timeMin: from, timeMax: to });
    expect(first.full).toBe(true);
    expect(first.nextSyncToken).toBeTruthy();
    const same = await p.listEvents(calendarUrl, {
      syncToken: first.nextSyncToken,
      timeMin: from,
      timeMax: to,
    });
    expect(same).toMatchObject({ full: false, events: [] });
    await putRaw(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        `UID:${randomUUID()}`,
        "DTSTAMP:20261001T000000Z",
        "DTSTART:20261024T090000Z",
        "DTEND:20261024T100000Z",
        "SUMMARY:New",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"),
    );
    const changed = await p.listEvents(calendarUrl, {
      syncToken: first.nextSyncToken,
      timeMin: from,
      timeMax: to,
    });
    expect(changed.full).toBe(true);
    expect(changed.events.some((e) => e.summary === "New")).toBe(true);
  });
});
