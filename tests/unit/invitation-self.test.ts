// Who the user is on an invitation (planning-scheduler.md SCH-20, SCH-21):
// an invitation the user did not answer blocks nothing; one the user
// organizes or accepted blocks time.
//
// Ways it can fail:
// 1. Google leaves out `organizer.self` when it is false, so reading a missing
//    `self` as "the user organizes it" makes every unanswered invitation block.
// 2. On CalDAV the user is found only by the account email, so an invitation
//    sent to another address of the user (RFC 6638 calendar-user-address-set)
//    is not seen as the user's: an accepted one does not block, and one the
//    user organizes from the other address is read as someone else's.
// 3. The address set is read again for every sync, one request per read.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blocksPlanning } from "../../src/scheduler/blocking.ts";
import type { ExternalEvent } from "../../src/scheduler/model.ts";
import type { GoogleEvent } from "../../src/server/google/calendar.ts";
import {
  CalDavProvider,
  eventsFromObject,
  forgetAddresses,
} from "../../src/server/providers/caldav.ts";
import { fromGoogleEvent } from "../../src/server/providers/google.ts";
import type { ProviderEvent } from "../../src/server/providers/types.ts";

const ME = "me@example.com";
const ALIAS = "me.alias@example.org";
const FROM = Date.parse("2026-10-19T00:00:00Z");
const TO = Date.parse("2026-10-30T00:00:00Z");

/** The scheduler view of a provider event, as planner/events.ts builds it from the cache. */
const external = (e: ProviderEvent): ExternalEvent => ({
  id: e.id,
  start: e.start,
  end: e.end,
  allDay: e.allDay,
  busy: e.busy,
  title: e.summary,
  description: e.description,
  rsvpNote: e.rsvpNote ?? "",
  selfResponse: e.selfResponse,
  organizerSelf: e.organizerSelf,
  attendeeCount: e.attendeeCount,
  location: e.location,
  eventType: e.eventType,
  bookedViaLink: false,
  attendees: e.attendees,
});

describe("Google invitations", () => {
  const google = (
    organizer: NonNullable<GoogleEvent["organizer"]>,
    response: "needsAction" | "accepted",
  ): GoogleEvent => ({
    id: "g1",
    status: "confirmed",
    summary: "Planning",
    start: { dateTime: "2026-10-22T10:00:00Z" },
    end: { dateTime: "2026-10-22T11:00:00Z" },
    organizer,
    attendees: [
      { email: "boss@example.com", responseStatus: "accepted" },
      { email: ME, self: true, responseStatus: response },
    ],
  });

  it("an unanswered invitation from someone else blocks nothing (SCH-21)", () => {
    // Google sends no `self` on someone else's organizer.
    const e = fromGoogleEvent(google({ email: "boss@example.com" }, "needsAction"), "UTC");
    expect(e.organizerSelf).toBe(false);
    expect(e.selfResponse).toBe("needsAction");
    expect(blocksPlanning(external(e))).toBe(false);
  });

  it("the same invitation blocks once the user accepts it (SCH-20)", () => {
    const e = fromGoogleEvent(google({ email: "boss@example.com" }, "accepted"), "UTC");
    expect(blocksPlanning(external(e))).toBe(true);
  });

  it("a meeting the user organizes blocks, with the user's own line unanswered", () => {
    const e = fromGoogleEvent(google({ email: ME, self: true }, "needsAction"), "UTC");
    expect(e.organizerSelf).toBe(true);
    expect(blocksPlanning(external(e))).toBe(true);
  });

  it("the user's line with self: true decides when the user is listed twice", () => {
    const e = fromGoogleEvent(
      {
        ...google({ email: "boss@example.com" }, "accepted"),
        attendees: [
          { email: ME, self: true, responseStatus: "accepted" },
          { email: "me.alias@example.org", responseStatus: "needsAction" },
        ],
      },
      "UTC",
    );
    expect(e.selfResponse).toBe("accepted");
  });

  it("an organizer with self false is someone else", () => {
    const e = fromGoogleEvent(
      google({ email: "x@example.com", self: false }, "needsAction"),
      "UTC",
    );
    expect(e.organizerSelf).toBe(false);
  });
});

const invitation = (organizer: string, attendees: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:inv-1",
    "DTSTAMP:20261019T080000Z",
    "DTSTART:20261022T100000Z",
    "DTEND:20261022T110000Z",
    "SUMMARY:Planning",
    `ORGANIZER:${organizer}`,
    ...attendees,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

describe("CalDAV invitations to another address of the user", () => {
  const read = (data: string, self: readonly string[]) =>
    eventsFromObject(data, "/cal/inv-1.ics", null, FROM, TO, "UTC", self)[0] as ProviderEvent;

  it("finds the user's attendee line at any address, in any case", () => {
    const e = read(
      invitation("mailto:boss@example.com", [
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
        "ATTENDEE;PARTSTAT=ACCEPTED:MAILTO:Me.Alias@Example.ORG",
      ]),
      [ME, ALIAS],
    );
    expect(e.selfResponse).toBe("accepted");
    expect(e.organizerSelf).toBe(false);
    expect(blocksPlanning(external(e))).toBe(true);
  });

  it("an unanswered invitation at another address blocks nothing", () => {
    const e = read(
      invitation("mailto:boss@example.com", [
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ALIAS}`,
      ]),
      [ME, ALIAS],
    );
    expect(e.selfResponse).toBe("needsAction");
    expect(blocksPlanning(external(e))).toBe(false);
  });

  it("the account's own address decides when the user is listed twice", () => {
    const e = read(
      invitation("mailto:boss@example.com", [
        `ATTENDEE;PARTSTAT=ACCEPTED;X-RESPONSE-COMMENT="Mine":mailto:${ME}`,
        `ATTENDEE;PARTSTAT=NEEDS-ACTION;X-RESPONSE-COMMENT="Alias":mailto:${ALIAS}`,
      ]),
      [ME, ALIAS],
    );
    expect(e.selfResponse).toBe("accepted");
    expect(e.rsvpNote).toBe("Mine");
  });

  it("without the account's address, the first line of another address decides", () => {
    const e = read(
      invitation("mailto:boss@example.com", [
        `ATTENDEE;PARTSTAT=TENTATIVE:mailto:${ALIAS}`,
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me.third@example.net",
      ]),
      [ME, ALIAS, "me.third@example.net"],
    );
    expect(e.selfResponse).toBe("tentative");
  });

  it("a meeting the user organizes from another address is the user's", () => {
    const e = read(
      invitation(`MAILTO:${ALIAS.toUpperCase()}`, [
        `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ALIAS}`,
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:guest@example.com",
      ]),
      [ME, ALIAS],
    );
    expect(e.organizerSelf).toBe(true);
    expect(blocksPlanning(external(e))).toBe(true);
  });
});

// A small CalDAV server: one principal with two addresses, one calendar with
// one invitation sent to the second address.
describe("CalDAV provider reads the principal's addresses", () => {
  let server: Server;
  let base = "";
  let addressReads = 0;
  /** Status of the next address-set reads; 207 when empty. */
  let addressStatus: number[] = [];
  const startObject = () =>
    invitation("mailto:boss@example.com", [
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
      `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ALIAS}`,
    ]);
  let stored = startObject();
  let puts: string[] = [];
  let addressSet = `<C:calendar-user-address-set><D:href>mailto:${ME}</D:href><D:href>MAILTO:${ALIAS.toUpperCase()}</D:href><D:href>/principals/me/</D:href></C:calendar-user-address-set>`;
  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c: Buffer) => {
        s += c.toString();
      });
      req.on("end", () => resolve(s));
    });
  const ms = (inner: string) =>
    `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${inner}</D:multistatus>`;
  const resp = (href: string, props: string) =>
    `<D:response><D:href>${href}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const text = await body(req);
      const url = req.url ?? "/";
      res.setHeader("content-type", "application/xml; charset=utf-8");
      if (req.method === "PUT") {
        stored = text;
        puts.push(text);
        res.setHeader("etag", `"${puts.length + 1}"`);
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "REPORT") {
        const ics = stored;
        res.statusCode = 207;
        res.end(
          ms(
            resp(
              "/cal/me/work/inv-1.ics",
              `<D:getetag>"${puts.length + 1}"</D:getetag><C:calendar-data><![CDATA[${ics}]]></C:calendar-data>`,
            ),
          ),
        );
        return;
      }
      if (req.method !== "PROPFIND") {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.statusCode = 207;
      if (/calendar-user-address-set/.test(text)) {
        addressReads++;
        const status = addressStatus.shift() ?? 207;
        if (status !== 207) {
          res.statusCode = status;
          res.end();
          return;
        }
        res.end(ms(resp(url, addressSet)));
      } else if (/calendar-home-set/.test(text)) {
        res.end(
          ms(resp(url, "<C:calendar-home-set><D:href>/cal/me/</D:href></C:calendar-home-set>")),
        );
      } else if (url.startsWith("/cal/me/")) {
        res.end(
          ms(
            resp(
              "/cal/me/work/",
              '<D:displayname>Work</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
            ),
          ),
        );
      } else {
        res.end(
          ms(
            resp(
              url,
              "<D:current-user-principal><D:href>/principals/me/</D:href></D:current-user-principal>",
            ),
          ),
        );
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    forgetAddresses();
    addressReads = 0;
    addressStatus = [];
    stored = startObject();
    puts = [];
  });

  const provider = (username = "u1") =>
    new CalDavProvider({ serverUrl: base, username, password: "pw", email: ME }, "UTC");
  const invite = async (p: CalDavProvider) => {
    const [cal] = await p.listCalendars();
    const { events } = await p.listEvents(cal?.id ?? "", {
      syncToken: null,
      timeMin: FROM,
      timeMax: TO,
    });
    return events[0] as ProviderEvent;
  };
  /** PARTSTAT of the attendee line of `email` in a written object, or null. */
  const partstat = (ics: string, email: string) => {
    const line = ics
      .replace(/\r\n[ \t]/g, "")
      .split(/\r\n/)
      .find((l) => /^ATTENDEE/i.test(l) && l.toLowerCase().endsWith(`:mailto:${email}`));
    return line ? (/;PARTSTAT=([A-Z-]+)/i.exec(line)?.[1] ?? null) : null;
  };

  it("an invitation accepted at another address of the user blocks time", async () => {
    const e = await invite(provider());
    expect(e.selfResponse).toBe("accepted");
    expect(blocksPlanning(external(e))).toBe(true);
  });

  it("reads the address set once per account", async () => {
    await invite(provider());
    await invite(provider());
    expect(addressReads).toBe(1);
  });

  it("keeps the account email when the server gives no address set", async () => {
    const saved = addressSet;
    addressSet = "";
    try {
      const e = await invite(provider());
      // The invitation is to the alias the server did not name: no line of the user.
      expect(e.selfResponse).toBe(null);
    } finally {
      addressSet = saved;
    }
  });

  it("reads the address set again after a server error, and uses the email meanwhile", async () => {
    addressStatus = [500];
    expect((await invite(provider())).selfResponse).toBe(null);
    expect((await invite(provider())).selfResponse).toBe("accepted");
    expect(addressReads).toBe(2);
    expect((await invite(provider())).selfResponse).toBe("accepted");
    expect(addressReads).toBe(2);
  });

  it("an answer to an invitation at another address goes on that address's line", async () => {
    const p = provider();
    const e = await invite(p);
    const [cal] = await p.listCalendars();
    const back = await p.editExternal(cal?.id ?? "", e.id, { selfResponse: "declined" }, e.etag);
    expect(puts).toHaveLength(1);
    expect(partstat(puts[0] ?? "", ALIAS)).toBe("DECLINED");
    expect(partstat(puts[0] ?? "", "boss@example.com")).toBe("ACCEPTED");
    expect(back.selfResponse).toBe("declined");
  });

  it("an answer goes on one line only when the user is listed twice", async () => {
    stored = invitation("mailto:boss@example.com", [
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ALIAS}`,
      `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${ME}`,
    ]);
    const p = provider();
    const e = await invite(p);
    const [cal] = await p.listCalendars();
    await p.editExternal(cal?.id ?? "", e.id, { selfResponse: "accepted" }, e.etag);
    expect(partstat(puts[0] ?? "", ME)).toBe("ACCEPTED");
    expect(partstat(puts[0] ?? "", ALIAS)).toBe("NEEDS-ACTION");
  });

  it("a new time asks the guests again but keeps the answer on the user's alias line", async () => {
    const p = provider();
    const e = await invite(p);
    const [cal] = await p.listCalendars();
    await p.editExternal(
      cal?.id ?? "",
      e.id,
      { start: e.start + 3_600_000, end: e.end + 3_600_000 },
      e.etag,
    );
    expect(partstat(puts[0] ?? "", ALIAS)).toBe("ACCEPTED");
    expect(partstat(puts[0] ?? "", "boss@example.com")).toBe(null);
  });
});
