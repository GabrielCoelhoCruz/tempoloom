// Meeting start-time intervals (docs/specs/meetings-start-intervals.md).
//
// Ways it can fail, and the test that catches each:
// - the settings form saves an empty set                               -> one test
// - a flexible meeting starts at a minute the user turned off, for
//   example right after an event that ends at :15                      -> one test
// - the booking page offers starts at minutes the user turned off       -> one test
// - a change of the set moves meetings placed before it (rule 6)       -> one test
// - new meetings after the change ignore the new set                   -> one test
// - the set is lost after a reload                                     -> one test
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
import { addLink, claimPage, titled, visitor, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Start-time E2E reads the CalDAV calendar.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof twoWeeks>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

/** Offered start times of a public booking link on one local date, as "HH:MM". */
async function offered(browser: Browser, path: string, date: string): Promise<string[]> {
  const v = await visitor(browser);
  await v.goto(path);
  await expect(v.getByTestId("times")).toBeVisible();
  const list = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((bs) => bs.map((b) => Number(b.getAttribute("data-start"))));
  await v.context().close();
  return list
    .map(local)
    .filter((s) => s.startsWith(date))
    .map((s) => s.slice(11));
}

const hourly = (minute: string) =>
  ["09", "10", "11", "12", "13", "14", "15", "16"].map((h) => `${h}:${minute}`);

test("start times limit flexible meetings and booking pages to the chosen minutes, and a change does not move meetings placed before it (rules 1-3, 6)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Dentist", start: at(day(1), "09:00"), end: at(day(1), "10:15") });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  const times = page.getByTestId("start-times");
  for (const m of [":15", ":30", ":45", ":00"])
    await times.getByLabel(m, { exact: true }).uncheck();
  await times.getByRole("button", { name: "Save start times" }).click();
  await expect(times.getByRole("alert")).toHaveText("Keep at least one start time.");
  await times.getByLabel(":00", { exact: true }).check();
  await times.getByRole("button", { name: "Save start times" }).click();
  await expect(times.getByTestId("start-times-saved")).toHaveText("Saved");

  await claimPage(page, "starts");
  await addLink(page, { title: "Intro", durations: "30", level: 4 });
  expect(await offered(browser, "/book/starts/intro", day(2))).toEqual(hourly("00"));

  // The Dentist ends at 10:15, so the meeting starts at 11:00, not 10:15 or 10:30.
  await addMeeting(page, { title: "Sync", guests: "dana@example.com" });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Sync")).toEqual([`${day(1)} 11:00-11:30`, `${day(8)} 10:00-10:30`]),
  );

  // Only :15 from now on: existing occurrences stay; new ones and the booking
  // page follow the new set.
  await page.getByRole("link", { name: "Settings" }).click();
  await times.getByLabel(":15", { exact: true }).check();
  await times.getByLabel(":00", { exact: true }).uncheck();
  await times.getByRole("button", { name: "Save start times" }).click();
  await expect(times.getByTestId("start-times-saved")).toHaveText("Saved");
  await addMeeting(page, { title: "Check-in", guests: "dana@example.com", days: ["Wed"] });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "Check-in")).toEqual([`${day(2)} 10:15-10:45`, `${day(9)} 10:15-10:45`]);
      expect(starts(l, "Sync")).toEqual([`${day(1)} 11:00-11:30`, `${day(8)} 10:00-10:30`]);
    },
  );
  expect(await offered(browser, "/book/starts/intro", day(3))).toEqual(hourly("15"));

  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(times.getByLabel(":15", { exact: true })).toBeChecked();
  for (const m of [":00", ":30", ":45"])
    await expect(times.getByLabel(m, { exact: true })).not.toBeChecked();
  expect(starts(await twoWeeks(cal), "Sync")).toEqual([
    `${day(1)} 11:00-11:30`,
    `${day(8)} 10:00-10:30`,
  ]);
});
