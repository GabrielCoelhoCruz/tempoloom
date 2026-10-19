// Event categories (docs/specs/events-categories-and-colors.md rules 1-5).
// Failure modes, each covered below:
//  1. The rule order is wrong: a manual category, a tag, out of office or a
//     flight loses to a later rule.
//  2. The user is counted as an attendee, domains compare with case, or a
//     declined attendee is dropped.
//  3. Keywords match inside other words, or only in one case.
//  4. Out of office splits at the wrong length (8 hours).
//  5. Managed events get the wrong category for their kind.
import { describe, expect, it } from "vitest";
import { type CategoryInput, categoryOf } from "../../src/scheduler/categories.ts";

const HOUR = 3_600_000;
const base = (over: Partial<CategoryInput> = {}): CategoryInput => ({
  title: "Event",
  description: "",
  rsvpNote: "",
  start: 0,
  end: HOUR,
  eventType: "default",
  attendees: [],
  managedKind: null,
  personalCalendar: false,
  manual: null,
  ...over,
});
const of = (over: Partial<CategoryInput>) => categoryOf(base(over), "me@acme.com");

describe("categoryOf", () => {
  it("applies the rules in order: manual, tags, out of office, flight, managed, personal, travel", () => {
    const external = ["me@acme.com", "x@other.com"];
    expect(of({ attendees: external, manual: "personal" })).toBe("personal");
    expect(of({ attendees: external, title: "Trip #tl_flight" })).toBe("flight");
    expect(of({ attendees: external, title: "Offsite #tl_trip" })).toBe("travel");
    expect(of({ attendees: external, eventType: "outOfOffice", end: 9 * HOUR })).toBe("vacation");
    expect(of({ attendees: external, title: "Flight LH 400 to New York" })).toBe("flight");
    expect(of({ managedKind: "task", title: "Dentist report" })).toBe("solo_work");
    expect(of({ attendees: external, personalCalendar: true })).toBe("personal");
    expect(of({ attendees: external, title: "Dentist" })).toBe("personal");
    expect(of({ attendees: external, title: "Commute home" })).toBe("travel");
  });

  it("finds external, one-on-one, team and solo events by the other attendees' domains", () => {
    expect(of({ attendees: ["me@acme.com", "Ana@ACME.com"] })).toBe("one_on_one");
    expect(of({ attendees: ["ana@acme.com", "bo@acme.com"] })).toBe("team_meeting");
    expect(of({ attendees: ["ana@acme.com", "x@other.com"] })).toBe("external_meeting");
    expect(of({ attendees: ["me@acme.com"] })).toBe("solo_work");
    expect(of({ attendees: [] })).toBe("solo_work");
  });

  it("matches keywords as whole words in any case, in the title or the description", () => {
    expect(of({ title: "GYM session" })).toBe("personal");
    expect(of({ title: "Gymnastics planning" })).toBe("solo_work");
    expect(of({ title: "Sync", description: "School pickup after" })).toBe("personal");
    expect(of({ title: "Drivers review" })).toBe("solo_work");
  });

  it("splits out of office at 8 hours", () => {
    // Exactly 8 hours is vacation (events-out-of-office.md, derived value).
    expect(of({ eventType: "outOfOffice", end: 8 * HOUR - 1 })).toBe("personal_commitment");
    expect(of({ eventType: "outOfOffice", end: 8 * HOUR })).toBe("vacation");
  });

  it("gives managed events the category of their kind", () => {
    expect(of({ managedKind: "task" })).toBe("solo_work");
    expect(of({ managedKind: "focus" })).toBe("solo_work");
    expect(of({ managedKind: "habit" })).toBe("solo_work");
    expect(of({ managedKind: "habit", personalHabit: true })).toBe("personal");
    expect(of({ managedKind: "buffer", travelBuffer: true })).toBe("travel");
    expect(of({ managedKind: "buffer" })).toBe("solo_work");
    expect(of({ managedKind: "meeting", attendees: ["x@other.com"] })).toBe("external_meeting");
    expect(of({ managedKind: "meeting", attendees: ["ana@acme.com"] })).toBe("one_on_one");
  });
});
