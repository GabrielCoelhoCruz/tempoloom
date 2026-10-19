// External event priority (docs/specs/events-external-priority.md): one event
// or the whole series, and events whose priority cannot change.
//
// Ways this can fail, each covered below:
// - a priority set on one occurrence changes the whole series, or the series
//   choice changes only one occurrence;
// - a series priority leaves an older single-event priority in place;
// - the planner offers a priority control on a connected calendar's event or a
//   mirrored copy, or gives no reason why it cannot change.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { addPolicy, copies } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { openWeek, slot, visitor, W } from "./helpers.ts";
import { putEvent } from "./ics.ts";

test.skip(BACKEND === "google", "The series and the second calendar are CalDAV objects.");

const day = (n: number) => addDays(W, n);
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, "");

/** Sets the priority of the standup on day n in the planner. */
async function setLevel(page: Page, n: number, level: string, series: boolean) {
  await openWeek(page);
  await page.locator(`.ev-external[data-start="${at(day(n), "09:00")}"]`).click();
  const form = page.getByTestId("external-priority");
  await form.getByLabel("Priority for booking links").selectOption(level);
  if (series) await form.getByLabel("All events in the series").check();
  await form.getByRole("button", { name: "Save priority" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
}

async function expectLevel(page: Page, n: number, level: string) {
  await page.locator(`.ev-external[data-start="${at(day(n), "09:00")}"]`).click();
  const select = page.getByTestId("external-priority").getByLabel("Priority for booking links");
  await expect(select).toHaveValue(level);
  await page
    .getByTestId("event-drawer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
}

test("a priority for one occurrence of a series changes only that one; for the whole series it changes every occurrence (rules 2, 3, 5)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await putEvent(cal.calendarId, [
    `DTSTART:${stamp(at(W, "09:00"))}`,
    `DTEND:${stamp(at(W, "10:00"))}`,
    "RRULE:FREQ=DAILY;COUNT=5",
    "SUMMARY:Team standup",
    "TRANSP:OPAQUE",
  ]);
  await signIn();
  await page.getByRole("link", { name: "Booking links" }).click();
  await page.getByTestId("claim-form").getByLabel("Page address").fill("hana");
  await page.getByRole("button", { name: "Create booking page" }).click();
  await expect(page.getByTestId("link-row")).toHaveCount(3);
  const v = await visitor(browser);
  const offered = async () => {
    await v.goto("/book/hana/meeting");
    await expect(v.getByTestId("times")).toBeVisible();
    await expect(v.locator(`[data-day="${day(4)}"]`)).toBeVisible();
    const out: string[] = [];
    for (let n = 0; n < 5; n++)
      if ((await slot(v, at(day(n), "09:00")).count()) > 0) out.push(local(at(day(n), "09:00")));
    return out;
  };
  expect(await offered()).toEqual([]);

  // Only Monday's standup.
  await setLevel(page, 0, "3", false);
  await eventually(offered, (o) => expect(o).toEqual([`${W} 09:00`]));
  await page.reload();
  await expectLevel(page, 0, "3");
  await expectLevel(page, 1, "1");

  // The whole series, chosen on Tuesday's standup.
  await setLevel(page, 1, "4", true);
  await eventually(offered, (o) => expect(o).toHaveLength(5));
  await page.reload();
  for (const n of [0, 2, 4]) await expectLevel(page, n, "4");
  // The standup itself never moves.
  const standups = (await cal.events(at(W, "00:00"), at(day(7), "00:00"))).filter(
    (e) => e.summary === "Team standup",
  );
  expect(standups.map((e) => local(e.start))).toEqual(
    [0, 1, 2, 3, 4].map((n) => `${day(n)} 09:00`),
  );
});

test("an event of another connected calendar, which a copy mirrors to the main calendar, shows a fixed P1 with the reason (rule 4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Planning", start: at(W, "14:00"), end: at(W, "15:00") });
  await signIn();
  const side = await cal.newCalendar("Side");
  await side.addEvent({ title: "Dentist", start: at(W, "09:00"), end: at(W, "10:00") });
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  const box = page
    .getByTestId("calendar-list")
    .locator("label", { hasText: "Side" })
    .getByRole("checkbox");
  await box.check();
  await expect(box).toBeChecked();
  await addPolicy(page, { from: "Side", to: "Work" });

  // The copy on the main calendar is written; the planner shows its source event once.
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(copies(l)).toHaveLength(1),
  );
  const check = async () => {
    await openWeek(page);
    // The main calendar's own event can change.
    await page.locator(".ev-external", { hasText: "Planning" }).click();
    await expect(page.getByTestId("external-priority")).toBeVisible();
    await expect(page.getByTestId("fixed-priority")).toHaveCount(0);
    // The connected calendar's event, which the copy mirrors, cannot.
    await expect(page.locator(`.ev[data-start="${at(W, "09:00")}"]`)).toHaveCount(1);
    await page.locator(".ev-external", { hasText: "Dentist" }).click();
    const fixed = page.getByTestId("fixed-priority");
    await expect(fixed).toContainText(
      "Events from other calendars, their mirrored copies and booked meetings stay P1.",
    );
    await expect(fixed.getByLabel("Priority for booking links")).toBeDisabled();
    await expect(page.getByTestId("external-priority")).toHaveCount(0);
  };
  await check();
  await page.reload();
  await check();
});
