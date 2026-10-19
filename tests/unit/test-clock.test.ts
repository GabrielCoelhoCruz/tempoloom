// The test clock (TEST_CLOCK_START): the acceptance tests of
// analytics-weekly-reports.md and analytics-personal-stats.md rule 16 set the
// server clock. Ways it can fail:
// 1. A server outside tests starts with a moved clock.
// 2. The clock changes the global Date.now for every library in the process.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as config from "../../src/server/config.ts";

const base = () => ({
  SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
  DATA_DIR: mkdtempSync(join(tmpdir(), "tempoloom-clock-")),
});

describe("test clock", () => {
  it("refuses TEST_CLOCK_START without TEMPOLOOM_TEST_MODE=1", () => {
    expect(() =>
      config.loadConfig({ ...base(), TEST_CLOCK_START: "2026-11-13T08:00:00Z" }),
    ).toThrow(/TEMPOLOOM_TEST_MODE/);
    expect(() =>
      config.loadConfig({
        ...base(),
        TEST_CLOCK_START: "2026-11-13T08:00:00Z",
        TEMPOLOOM_TEST_MODE: "0",
      }),
    ).toThrow(/TEMPOLOOM_TEST_MODE/);
  });

  it("runs on from the start instant and leaves Date.now alone", () => {
    const realNow = Date.now;
    const c = config.loadConfig({
      ...base(),
      TEST_CLOCK_START: "2026-11-13T08:00:00Z",
      TEMPOLOOM_TEST_MODE: "1",
    });
    const now = config.clockOf(c);
    const t = now();
    expect(t).toBeGreaterThanOrEqual(Date.parse("2026-11-13T08:00:00Z"));
    expect(t).toBeLessThan(Date.parse("2026-11-13T08:00:05Z"));
    expect(Date.now).toBe(realNow);
    expect(config.clockOf(config.loadConfig(base()))).toBe(Date.now);
  });
});
