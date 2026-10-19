// The limit on scope changes and "repaint all" (docs/specs/
// events-categories-and-colors.md rules 11, 12), with a clock the test sets.
//
// Ways it can fail:
// 1. A third use within a minute is accepted.
// 2. A refused use counts, so the user waits longer than a minute.
// 3. Users share one limit.
import { describe, expect, it } from "vitest";
import { slotLimiter } from "../../src/server/api/settings.ts";

describe("slotLimiter", () => {
  it("allows 2 uses in any minute per user", () => {
    let t = 0;
    const take = slotLimiter(() => t, 2, 60_000);
    expect([take("a"), take("a"), take("a"), take("b")]).toEqual([true, true, false, true]);
    t = 59_999;
    expect(take("a")).toBe(false);
    // The first two uses leave the window; the refused ones never counted.
    t = 60_000;
    expect([take("a"), take("a"), take("a")]).toEqual([true, true, false]);
  });
});
