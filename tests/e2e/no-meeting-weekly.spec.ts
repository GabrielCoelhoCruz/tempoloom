// The weekly no-meeting day (docs/specs/events-tags.md rules 3-7 and
// acceptance test 2; automations-library.md entry 33).
//
// Ways it can fail, and the test that catches each:
// - the library entry writes nothing, one event per week instead of one
//   weekly series, a free event, or an event without the tag          -> one test
// - the tag works for the first week only, not for later occurrences   -> one test
// - habits leave the day (the tag turned into plain busy)              -> one test
// - a flexible meeting or a booking link still uses the day            -> one test
// - the day is lost after a reload, or the library shows no badge      -> one test
// - removing the day leaves the event, or new meetings and the booking
//   link stay off the day                                              -> one test
import type { Browser } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addHabit, addLink, claimPage, titled, visitor, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "No-meeting day E2E reads the CalDAV calendar.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const TITLE = "No meetings #tl_free";

/** Offered starts on one local date, from the page's first two spans of two weeks. */
async function offered(browser: Browser, path: string, date: string): Promise<string[]> {
  const v = await visitor(browser);
  await v.goto(path);
  await expect(v.getByTestId("times")).toBeVisible();
  const read = () =>
    v
      .locator('[data-testid="times"] button[data-start]')
      .evaluateAll((bs) => bs.map((b) => Number(b.getAttribute("data-start"))));
  const first = await read();
  await v.getByRole("button", { name: "Later" }).click();
  await expect(v.getByRole("button", { name: "Earlier" })).toBeVisible();
  await expect(v.getByTestId("times")).toBeVisible();
  const list = [...first, ...(await read())];
  await v.context().close();
  return list
    .map(local)
    .filter((s) => s.startsWith(date))
    .map((s) => s.slice(11));
}

test("the weekly no-meeting day from the library writes one weekly all-day busy #tl_free series: habits keep the day, flexible meetings and booking links stay off it every week, and removing it ends that (events-tags.md rules 3-7; library entry 33)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Other" }).click();
  const entry = page.locator('[data-entry="Weekly no-meeting day"]');
  await entry.getByRole("button", { name: "Use" }).click();
  const nm = page.getByTestId("no-meeting-day");
  await expect(nm.getByLabel("Day")).toHaveValue("3");
  await nm.getByRole("button", { name: "Add no-meeting day" }).click();
  await expect(nm).toContainText("No meetings on Wednesdays");

  const days = await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(l.filter((e) => e.summary === TITLE).map((e) => local(e.start))).toEqual([
        `${day(2)} 00:00`,
        `${day(9)} 00:00`,
      ]),
  );
  const series = days.filter((e) => e.summary === TITLE);
  expect(series.every((e) => e.allDay && e.busy)).toBe(true);
  expect(new Set(series.map((e) => e.recurringId)).size).toBe(1);
  expect(series[0]?.recurringId).toBeTruthy();

  await addHabit(page, { title: "Coding", ideal: "10:00", min: 120, max: 120, days: ["Wed"] });
  await addMeeting(page, { title: "Sync", guests: "dana@example.com", days: ["Wed"] });
  await claimPage(page, "quiet");
  await addLink(page, { title: "Intro", durations: "30", level: 1 });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Coding")).toEqual([`${day(2)} 10:00-12:00`, `${day(9)} 10:00-12:00`]);
      const sync = starts(l, "Sync");
      expect(sync).toHaveLength(2);
      expect(sync.some((s) => s.startsWith(day(2)) || s.startsWith(day(9)))).toBe(false);
    },
  );
  expect(await offered(browser, "/book/quiet/intro", day(2))).toEqual([]);
  expect(await offered(browser, "/book/quiet/intro", day(9))).toEqual([]);
  expect((await offered(browser, "/book/quiet/intro", day(3))).length).toBeGreaterThan(0);

  await page.reload();
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Other" }).click();
  await expect(entry.locator(".badge")).toHaveText("Added");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(nm).toContainText("No meetings on Wednesdays");

  // Removing the day deletes the series: a new meeting may use Wednesday again,
  // and so may the booking link. Placed meetings keep their time (rule 7).
  await nm.getByRole("button", { name: "Remove no-meeting day" }).click();
  await expect(nm.getByRole("button", { name: "Add no-meeting day" })).toBeVisible();
  await addMeeting(page, { title: "Retro", guests: "dana@example.com", days: ["Wed"] });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(l.filter((e) => e.summary === TITLE)).toEqual([]);
      expect(starts(l, "Retro")).toEqual([`${day(2)} 10:00-10:30`, `${day(9)} 10:00-10:30`]);
    },
  );
  expect((await offered(browser, "/book/quiet/intro", day(9))).length).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(nm.getByRole("button", { name: "Add no-meeting day" })).toBeVisible();
});
