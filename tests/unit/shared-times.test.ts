// Failure modes of shared times (docs/specs/booking-links-sharing.md rules 18-22):
//  1. Adjacent times do not merge in text format with ranges and without links,
//     or they merge in another format.                                       (rule 19)
//  2. A time link misses day, time, duration or zone, or uses the 12-hour format.  (rule 22)
//  3. Times are not grouped by date in the chosen zone, or not in order.
//  4. Template variables are not replaced, or replaced in the wrong format.
//  5. The HTML part does not escape the template text.
//  6. Buttons have no plain-text fallback with the links.                    (rule 18)
import { describe, expect, it } from "vitest";
import { localToUtc } from "../../src/shared/time.ts";
import { sharedTimes } from "../../src/web/lib/shared-times.ts";

const ZONE = "Europe/Berlin";
const TUE = "2026-11-10";
const WED = "2026-11-11";
const at = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return localToUtc(ZONE, date, h * 60 + m);
};
const slot = (date: string, hhmm: string, minutes = 30) => ({
  start: at(date, hhmm),
  end: at(date, hhmm) + minutes * 60_000,
});
const base = {
  zone: ZONE,
  format: "24" as const,
  style: "text" as const,
  showRanges: false,
  includeLinks: true,
  template: "{times}",
  bookingUrl: "https://tl.example/book/ann/chat",
  duration: 30,
  dayLabel: (t: number) => new Date(t).toISOString().slice(0, 10),
};

describe("sharedTimes", () => {
  it("merges adjacent times into one range in text format with ranges and without links", () => {
    const r = sharedTimes({
      ...base,
      showRanges: true,
      includeLinks: false,
      times: [slot(TUE, "10:30"), slot(TUE, "10:00"), slot(TUE, "14:00")],
    });
    expect(r.text).toContain("10:00–11:00, 14:00–14:30");
    expect(r.text).not.toContain("10:30");
    expect(r.html).toContain("10:00–11:00");
  });

  it("keeps each time apart when links are included or ranges are off", () => {
    const linked = sharedTimes({
      ...base,
      showRanges: true,
      times: [slot(TUE, "10:00"), slot(TUE, "10:30")],
    });
    expect(linked.text).toContain("10:00–10:30");
    expect(linked.text).toContain("10:30–11:00");
    const starts = sharedTimes({
      ...base,
      includeLinks: false,
      times: [slot(TUE, "10:00"), slot(TUE, "10:30")],
    });
    expect(starts.text).toContain("10:00, 10:30");
  });

  it("links each time to the booking page with day, time, duration and zone", () => {
    const r = sharedTimes({ ...base, format: "12", times: [slot(TUE, "14:00")] });
    const url = `https://tl.example/book/ann/chat?day=${TUE}&time=14:00&duration=30&tz=Europe%2FBerlin`;
    expect(r.html).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
    expect(r.html).toContain(">2:00 PM</a>");
    expect(r.text).toContain(`2:00 PM (${url})`);
  });

  it("groups times by date in the chosen zone, in order", () => {
    const r = sharedTimes({
      ...base,
      includeLinks: false,
      times: [slot(WED, "09:00"), slot(TUE, "16:00")],
    });
    expect(r.text.indexOf(base.dayLabel(at(TUE, "16:00")))).toBeLessThan(
      r.text.indexOf(base.dayLabel(at(WED, "09:00"))),
    );
    const tokyo = sharedTimes({
      ...base,
      zone: "Asia/Tokyo",
      includeLinks: false,
      times: [slot(TUE, "16:00")],
    });
    expect(tokyo.text).toContain("00:00");
  });

  it("replaces the template variables and escapes the template in HTML", () => {
    const r = sharedTimes({
      ...base,
      includeLinks: false,
      template: "<b>Hi</b> ({timezone}, {duration}):\n{times}\nOr: {link}",
      times: [slot(TUE, "10:00")],
    });
    expect(r.text).toBe(
      `<b>Hi</b> (Europe/Berlin, 30 minutes):\n${base.dayLabel(at(TUE, "10:00"))}: 10:00\nOr: ${base.bookingUrl}`,
    );
    expect(r.html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
    expect(r.html).toContain(`<a href="${base.bookingUrl}">${base.bookingUrl}</a>`);
  });

  it("writes buttons as styled links in HTML, with links in the plain text", () => {
    const r = sharedTimes({ ...base, style: "buttons", times: [slot(TUE, "10:00")] });
    expect(r.html).toMatch(/<a [^>]*style="[^"]*border[^"]*"[^>]*>10:00<\/a>/);
    expect(r.text).toContain("10:00 (https://tl.example/book/ann/chat?day=");
  });
});
