// Home and travel time zones: travel entries with dates, booking links that
// follow them, prompts when the browser zone differs, two time columns, and
// the wrong-hours checks (docs/specs/timezones-home-and-travel.md rules 1-12,
// AT 1-4; docs/specs/planning-hours.md edge case 6).
//
// Ways it can fail, and the check that catches each:
// - travel days keep home hours                                     -> Radicale 09:00 Tokyo
// - days before and after the trip move too                          -> Mon/Fri 09:00 Berlin
// - a second entry is refused, or overlapping entries are accepted    -> list, field error
// - an entry that ends before it starts is accepted                  -> field error
// - deleting the entry leaves events in the travel zone              -> Radicale 09:00 Berlin
// - booking pages keep offering home hours on travel days            -> slots in 09:00-17:00 Tokyo
// - no prompt when the browser is elsewhere, or the prompt changes
//   the home zone without consent                                    -> prompt; settings zone
// - no prompt to end the trip once home                              -> prompt, entry gone
// - no second time column while travelling                           -> zone heads, labels
// - a browser that reports UTC is taken as the user's zone            -> warning; zone unchanged
// - a forgotten trip is not visible where hours are set               -> hours zone note
import type { Browser, Page } from "@playwright/test";
import { addDays, localToUtc, utcToLocal } from "../../src/shared/time.ts";
import { hhmm } from "../../src/web/lib/format.ts";
import { blockUntil, eventually, expect, test, visitorContexts, ZONE } from "./fixtures.ts";
import { addHabit, addLink, allEvents, claimPage, titled, visitor, W } from "./helpers.ts";
import { alwaysHours } from "./s3-helpers.ts";

const TOKYO = "Asia/Tokyo";
const NEW_YORK = "America/New_York";
const day = (n: number) => addDays(W, n);
const at = (zone: string, date: string, hm: string) => {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return localToUtc(zone, date, h * 60 + m);
};

async function addTravel(page: Page, tz: string, from: string, to: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("travel-form");
  await form.getByLabel("Travel zone").fill(tz);
  await form.getByLabel("From").fill(from);
  await form.getByLabel("To").fill(to);
  await form.getByRole("button", { name: "Add travel time zone" }).click();
}

/** The same signed-in user in a browser that reports another time zone. */
async function browserIn(browser: Browser, page: Page, timezoneId: string): Promise<Page> {
  const ctx = await browser.newContext({
    timezoneId,
    locale: "en-GB",
    baseURL: new URL(page.url()).origin,
    storageState: await page.context().storageState(),
  });
  visitorContexts.push(ctx);
  const p = await ctx.newPage();
  await p.goto("/");
  await expect(p.getByTestId("planner")).toBeVisible();
  return p;
}

test("a travel zone places habits in its local time on its dates; several entries are allowed, overlaps are refused, and delete returns home (rules 1-7, AT 1, 3, 4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Standup prep", ideal: "09:00", min: 30, max: 30 });
  await eventually(
    () => allEvents(cal),
    (l) =>
      expect(
        titled(l, "Standup prep").find((e) => e.start === at(ZONE, day(1), "09:00")),
      ).toBeTruthy(),
  );

  await addTravel(page, TOKYO, day(1), day(3));
  await expect(page.getByTestId("travel-list").locator("[data-travel-zone]")).toHaveCount(1);
  await addTravel(page, NEW_YORK, day(4), day(4));
  await expect(page.getByTestId("travel-list").locator("[data-travel-zone]")).toHaveCount(2);
  const starts = (l: Awaited<ReturnType<typeof allEvents>>) =>
    new Set(titled(l, "Standup prep").map((e) => e.start));
  await eventually(
    () => allEvents(cal),
    (l) => {
      const s = starts(l);
      expect(s.has(at(ZONE, day(0), "09:00"))).toBe(true);
      for (const n of [1, 2, 3]) expect(s.has(at(TOKYO, day(n), "09:00"))).toBe(true);
      expect(s.has(at(NEW_YORK, day(4), "09:00"))).toBe(true);
      expect(s.has(at(ZONE, day(1), "09:00"))).toBe(false);
    },
  );

  // Overlap and reversed dates are refused with a field error; nothing changes.
  await addTravel(page, "Europe/London", day(3), day(5));
  await expect(page.getByTestId("travel-error")).toContainText("overlaps");
  await addTravel(page, "Europe/London", day(9), day(8));
  await expect(page.getByTestId("travel-error")).toContainText("ends before it starts");
  await page.reload();
  const rows = page.getByTestId("travel-list").locator("[data-travel-zone]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-travel-zone", TOKYO);
  expect(starts(await allEvents(cal)).has(at(TOKYO, day(3), "09:00"))).toBe(true);

  await rows.first().getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveCount(1);
  await eventually(
    () => allEvents(cal),
    (l) => {
      const s = starts(l);
      for (const n of [1, 2, 3]) expect(s.has(at(ZONE, day(n), "09:00"))).toBe(true);
      expect(s.has(at(NEW_YORK, day(4), "09:00"))).toBe(true);
    },
  );
  await page.reload();
  await expect(rows).toHaveCount(1);
  expect(starts(await allEvents(cal)).has(at(ZONE, day(2), "09:00"))).toBe(true);
});

test("a booking link offers times in the travel zone on travel days (rule 3, AT 2)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "s3-travel");
  await addLink(page, { title: "Chat", durations: "30" });
  await addTravel(page, TOKYO, day(1), day(3));
  await expect(page.getByTestId("travel-list").locator("[data-travel-zone]")).toHaveCount(1);

  const v = await visitor(browser);
  await v.goto("/book/s3-travel");
  await v.getByTestId("public-link").filter({ hasText: "Chat" }).click();
  await expect(v.locator('[data-testid="times"] button[data-start]').first()).toBeVisible();
  const tripStart = at(TOKYO, day(1), "00:00");
  const tripEnd = at(TOKYO, day(4), "00:00");
  const check = async (p: Page) => {
    const offered = (
      await p
        .locator('[data-testid="times"] button[data-start]')
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))))
    ).filter((t) => t >= at(ZONE, day(0), "00:00") && t < at(ZONE, day(5), "00:00"));
    const inTrip = offered.filter((t) => t >= tripStart && t < tripEnd);
    expect(inTrip.length).toBeGreaterThan(0);
    for (const t of offered) {
      const zone = t >= tripStart && t < tripEnd ? TOKYO : ZONE;
      const minute = utcToLocal(zone, t).minuteOfDay;
      expect(minute, `${new Date(t).toISOString()} in ${zone}`).toBeGreaterThanOrEqual(9 * 60);
      expect(minute + 30).toBeLessThanOrEqual(17 * 60);
    }
    await expect(
      p.locator(`[data-testid="times"] button[data-start="${at(TOKYO, day(2), "09:00")}"]`),
    ).toBeVisible();
  };
  await check(v);
  await v.reload();
  await expect(v.locator('[data-testid="times"] button[data-start]').first()).toBeVisible();
  await check(v);
});

test("the planner prompts for a travel zone when the browser is elsewhere, shows two time columns, and offers to end the trip back home (rules 8-10)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await signIn();
  await alwaysHours(page);
  await addHabit(page, { title: "AT-Tz", ideal: "09:00", min: 30, max: 30, hours: "AT-Always" });
  await expect(page.getByTestId("travel-prompt")).toHaveCount(0);

  const tokyo = await browserIn(browser, page, TOKYO);
  const prompt = tokyo.getByTestId("travel-prompt");
  await expect(prompt).toContainText(TOKYO);
  await expect(prompt).toContainText(ZONE);
  const todayTokyo = utcToLocal(TOKYO, Date.now()).date;
  await expect(prompt.getByLabel("Until")).toHaveValue(addDays(todayTokyo, 6));
  await prompt.getByRole("button", { name: "Add travel time zone" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(tokyo.getByTestId("zone-head")).toHaveText(["Berlin", "Tokyo"]);
  const ref = utcToLocal(ZONE, Date.now()).date;
  const nine = utcToLocal(TOKYO, localToUtc(ZONE, ref, 540)).minuteOfDay;
  await expect(tokyo.getByTestId("extra-hour").nth(9)).toHaveText(hhmm(nine));
  await tokyo.reload();
  await expect(tokyo.getByTestId("zone-head")).toHaveText(["Berlin", "Tokyo"]);
  await expect(tokyo.getByTestId("travel-prompt")).toHaveCount(0);

  const check = addDays(todayTokyo, 2);
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Tz").map((e) => e.start)).toContain(at(TOKYO, check, "09:00")),
  );

  // Back home: the home browser offers to end the trip early.
  await page.goto("/");
  await expect(page.getByTestId("zone-head")).toHaveText(["Berlin", "Tokyo"]);
  const home = page.getByTestId("travel-prompt");
  await expect(home).toContainText(TOKYO);
  await home.getByRole("button", { name: "End trip" }).click();
  await expect(home).toHaveCount(0);
  await expect(page.getByTestId("zone-head")).toHaveCount(0);
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Tz").map((e) => e.start)).toContain(at(ZONE, check, "09:00")),
  );
  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("travel-list").locator("[data-travel-zone]")).toHaveCount(0);
});

test("a browser that reports UTC gets a warning and never changes the home zone; an active trip shows on the hours page (planning-hours edge case 6, rules 11-12)", async ({
  page,
  browser,
  signIn,
}) => {
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("hours-zone")).toHaveText(`Hours apply in ${ZONE}.`);

  const utc = await browserIn(browser, page, "UTC");
  const prompt = utc.getByTestId("travel-prompt");
  await expect(prompt).toContainText(
    "An extension or a privacy setting can make a browser report UTC",
  );
  await utc.reload();
  await utc.getByRole("link", { name: "Settings" }).click();
  await expect(utc.getByLabel("Time zone", { exact: true })).toHaveValue(ZONE);

  const today = utcToLocal(ZONE, Date.now()).date;
  await addTravel(page, TOKYO, today, addDays(today, 4));
  await expect(page.getByTestId("hours-zone")).toHaveText(
    `Hours apply in ${TOKYO} until ${addDays(today, 4)} (travel time zone), then in ${ZONE}.`,
  );
  await page.reload();
  await expect(page.getByTestId("hours-zone")).toContainText(TOKYO);
});
