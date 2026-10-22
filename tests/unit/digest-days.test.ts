// The days of the daily meeting digest (assistant-chat.md rule 15;
// automations-meeting-quality.md rule 6) and the video-only buffer filter
// (buffers-automation.md `has_video_link`). The E2E tests cover the journeys;
// these cover the cases they do not reach.
// Failure modes, each covered below:
//  1. The digest covers 7 days instead of the rest of the week and 2 workdays.
//  2. The planning week start is ignored.
//  3. Days without work hours count as workdays, or no work hours give no days;
//     a week with fewer than 2 workdays runs past the end of next week.
//  4. The video filter misses a link in the conference, location or description,
//     or takes a link that names no video service.
import { describe, expect, it } from "vitest";
import type { ExternalEvent } from "../../src/scheduler/model.ts";
import { matchesFilter } from "../../src/scheduler/plan.ts";
import { digestDays } from "../../src/server/daily-mail.ts";
import { localToUtc } from "../../src/shared/time.ts";

const ZONE = "Europe/Berlin";
const at = (date: string) => localToUtc(ZONE, date, 8 * 60 + 5);
const WEEKDAYS = [1, 2, 3, 4, 5];

describe("digestDays", () => {
  it("covers the rest of a week from Monday and its next Monday and Tuesday", () => {
    // 2026-11-02 is a Monday.
    expect(digestDays(ZONE, at("2026-11-02"), 1, WEEKDAYS)).toEqual({
      from: "2026-11-02",
      to: "2026-11-10",
    });
    expect(digestDays(ZONE, at("2026-11-05"), 1, WEEKDAYS)).toEqual({
      from: "2026-11-05",
      to: "2026-11-10",
    });
    expect(digestDays(ZONE, at("2026-11-08"), 1, WEEKDAYS)).toEqual({
      from: "2026-11-08",
      to: "2026-11-10",
    });
  });

  it("uses the planning week start: a Sunday starts a week from Sunday", () => {
    expect(digestDays(ZONE, at("2026-11-08"), 7, WEEKDAYS)).toEqual({
      from: "2026-11-08",
      to: "2026-11-17",
    });
    expect(digestDays(ZONE, at("2026-11-07"), 7, WEEKDAYS)).toEqual({
      from: "2026-11-07",
      to: "2026-11-10",
    });
  });

  it("counts only days with work hours, and Monday to Friday without any", () => {
    // Work hours Tuesday to Saturday: next week's first 2 workdays are Tuesday and Wednesday.
    expect(digestDays(ZONE, at("2026-11-05"), 1, [2, 3, 4, 5, 6])).toEqual({
      from: "2026-11-05",
      to: "2026-11-11",
    });
    // One workday a week (Saturday): the digest stops at the end of next week, not later.
    expect(digestDays(ZONE, at("2026-11-05"), 1, [6])).toEqual({
      from: "2026-11-05",
      to: "2026-11-15",
    });
    expect(digestDays(ZONE, at("2026-11-08"), 7, [6])).toEqual({
      from: "2026-11-08",
      to: "2026-11-21",
    });
    expect(digestDays(ZONE, at("2026-11-05"), 1, [])).toEqual({
      from: "2026-11-05",
      to: "2026-11-10",
    });
  });
});

describe("buffer filter videoLink", () => {
  const event = (e: Partial<ExternalEvent>): ExternalEvent => ({
    id: "e",
    start: 0,
    end: 3_600_000,
    allDay: false,
    busy: true,
    title: "Review",
    description: "",
    selfResponse: "accepted",
    organizerSelf: true,
    attendeeCount: 2,
    location: "",
    eventType: "default",
    bookedViaLink: false,
    ...e,
  });
  const video = { videoLink: true };

  it("takes a link in the conference data, the location or the description", () => {
    expect(matchesFilter(video, event({ conference: "https://example.com/c/1" }))).toBe(true);
    expect(matchesFilter(video, event({ location: "https://zoom.us/j/1" }))).toBe(true);
    expect(matchesFilter(video, event({ description: "Join https://meet.jit.si/x" }))).toBe(true);
  });

  it("skips an event with no video link; without the condition every event matches", () => {
    const room = event({ location: "Room 4", description: "Notes: https://docs.example.com/a" });
    expect(matchesFilter(video, room)).toBe(false);
    expect(matchesFilter({}, room)).toBe(true);
  });
});
