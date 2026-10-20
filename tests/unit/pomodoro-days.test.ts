// Pomodoro counters (docs/specs/tools-pomodoro-timer.md rule 17) count days in
// the browser's zone. Ways it can fail across a DST change:
// 1. The streak steps back 24 hours: on a 23-hour day it skips a day (streak
//    too short); on a 25-hour day it counts the same day twice (too long).
// 2. "The last 30 days" starts one hour late, so a session on the first day is lost.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { counters, timerStats } from "../../src/web/views/tools.tsx";

const saved = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "America/New_York";
});
afterAll(() => {
  if (saved === undefined) delete process.env.TZ;
  else process.env.TZ = saved;
});

const at = (iso: string) => Date.parse(iso);
const log = (sessions: string[], minutes = 25) => ({
  sessions: sessions.map((s) => ({ at: at(s), minutes })),
  started: [],
  breaks: [],
  tasks: [],
});

describe("pomodoro streak and 30-day figures in America/New_York", () => {
  it("does not skip the 23-hour day (spring forward 2026-03-08)", () => {
    const l = log(["2026-03-07T17:00:00Z", "2026-03-08T16:00:00Z", "2026-03-09T04:10:00Z"]);
    // 2026-03-09 00:30 EDT.
    expect(counters(l, at("2026-03-09T04:30:00Z")).streak).toBe(3);
  });

  it("does not count the 25-hour day twice (fall back 2026-11-01)", () => {
    const l = log(["2026-10-31T16:00:00Z", "2026-11-01T17:00:00Z"]);
    // 2026-11-01 23:30 EST.
    expect(counters(l, at("2026-11-02T04:30:00Z")).streak).toBe(2);
  });

  it("counts a session on the first of the last 30 days when DST ends in between", () => {
    // 2026-10-22 00:30 EDT is on the first of the 30 days up to 2026-11-20.
    const l = log(["2026-10-22T04:30:00Z"], 300);
    expect(timerStats(l, at("2026-11-20T17:00:00Z"), "day").avgWorkPerDay).toBe(10);
  });
});
