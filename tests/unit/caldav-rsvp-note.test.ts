// The user's RSVP note on CalDAV (docs/specs/events-tags.md "Where Tempoloom
// looks", edge case 5).
//
// Ways it can fail:
// 1. The organizer's COMMENT on the invitation is read as the user's note, so
//    a tag the organizer wrote adds travel time or changes the category.
// 2. The X-RESPONSE-COMMENT of the user's own attendee line is not read.
import { describe, expect, it } from "vitest";
import { eventsFromObject } from "../../src/server/providers/caldav.ts";

const ME = "me@example.com";

const invitation = (lines: string[]) =>
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
    "ORGANIZER:mailto:boss@example.com",
    ...lines,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const note = (data: string) =>
  eventsFromObject(
    data,
    "/cal/inv-1.ics",
    null,
    Date.parse("2026-10-19T00:00:00Z"),
    Date.parse("2026-10-30T00:00:00Z"),
    "UTC",
    ME,
  )[0]?.rsvpNote;

describe("CalDAV RSVP note", () => {
  it("ignores the organizer's COMMENT on an invitation (edge case 5)", () => {
    expect(
      note(
        invitation([
          "COMMENT:Bring your laptop #tl_travel",
          "ATTENDEE;PARTSTAT=ACCEPTED:mailto:boss@example.com",
          `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${ME}`,
        ]),
      ),
    ).toBe("");
  });

  it("reads the note on the user's own attendee line", () => {
    expect(
      note(
        invitation([
          'ATTENDEE;PARTSTAT=ACCEPTED;X-RESPONSE-COMMENT="Boss note #tl_flight":mailto:boss@example.com',
          `ATTENDEE;PARTSTAT=ACCEPTED;X-RESPONSE-COMMENT="From home #tl_travel":mailto:${ME}`,
        ]),
      ),
    ).toBe("From home #tl_travel");
  });
});
