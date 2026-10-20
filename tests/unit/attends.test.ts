import { describe, expect, it } from "vitest";
import type { ExternalEvent } from "../../src/scheduler/model.ts";
import { attends } from "../../src/scheduler/blocking.ts";

const ev = (e: Pick<ExternalEvent, "selfResponse" | "organizerSelf" | "attendeeCount">) => e as ExternalEvent;

describe("attends (events-out-of-office rule 10)", () => {
  it("does not count someone else's invitation that lists only a mailing list", () => {
    expect(attends(ev({ selfResponse: null, organizerSelf: false, attendeeCount: 1 }))).toBe(false);
  });
  it("counts it once the user's own answer is yes or maybe", () => {
    expect(attends(ev({ selfResponse: "accepted", organizerSelf: false, attendeeCount: 2 }))).toBe(true);
    expect(attends(ev({ selfResponse: "tentative", organizerSelf: false, attendeeCount: 2 }))).toBe(true);
  });
  it("keeps own events and events without guests", () => {
    expect(attends(ev({ selfResponse: null, organizerSelf: true, attendeeCount: 3 }))).toBe(true);
    expect(attends(ev({ selfResponse: null, organizerSelf: false, attendeeCount: 0 }))).toBe(true);
  });
  it("does not count declined or unanswered invitations", () => {
    expect(attends(ev({ selfResponse: "declined", organizerSelf: true, attendeeCount: 2 }))).toBe(false);
    expect(attends(ev({ selfResponse: "needsAction", organizerSelf: false, attendeeCount: 2 }))).toBe(false);
  });
});
