// The time format, date format and week start of the calendar account in the
// planner, on the hours page and in the task and habit lists
// (docs/specs/settings-profile.md PRF-6, AT 2). CalDAV has no such settings, so
// the test stores them through the settings API, as the Google sync does
// (googleWeekStart, timeFormat, dateFormat). Planning keeps the week start set
// in Tempoloom (settings-profile.md, "Which week each feature uses").
//
// Ways it can fail, and the check that catches each:
// - a view keeps 24-hour times or year-month-day dates     -> defaults first, then 12 h and DMY
// - the planner week starts on Monday whatever the setting  -> first day and week label on Sunday
// - "weekdays only" shows Sunday to Thursday               -> weekdays from Monday
// - the hours page keeps Monday first or 24-hour ranges     -> first day, range text
// - the lists show times and dates in the old format        -> task due date, habit ideal time, trip dates
// - the Google week start moves the planning week           -> profile: planning week Monday
// - the formats are lost at a reload                        -> reload
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, expect, test } from "./fixtures.ts";
import { addHabit, addTask, W } from "./helpers.ts";

const SUN = addDays(W, -1);
const TUE = addDays(W, 1);
const FRI = addDays(W, 4);
const TRIP = addDays(W, 30);
const dmy = (d: string) => d.split("-").reverse().join("/");

const dayNames = (page: Page) => page.locator(".week-head .day-name");
const hourLabel = (page: Page, h: number) =>
  page.locator(".week-body > .hours:not(.extra-hours) > .hour-label").nth(h);

interface Expected {
  label: string;
  first: string;
  head: string;
  evTime: string;
  hour: string;
  when: string;
  due: string;
  ideal: string;
  firstHoursDay: string;
  workHours: string;
  trip: string;
}

async function check(page: Page, x: Expected) {
  await page.goto(`/?week=${W}`);
  await expect(page.getByTestId("week-label")).toHaveText(`Week of ${x.label}`);
  await expect(dayNames(page)).toHaveCount(7);
  await expect(dayNames(page).first()).toHaveAttribute("data-date", x.first);
  await expect(dayNames(page).first()).toHaveText(x.head);
  const ev = page.locator(".ev", { hasText: "Format check" });
  await expect(ev.locator(".ev-time")).toHaveText(x.evTime);
  await expect(hourLabel(page, 14)).toHaveText(x.hour);
  await ev.click();
  await expect(page.getByTestId("event-drawer")).toContainText(x.when);

  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(
    page.locator('[data-task-title="Formatted task"]').getByTestId("task-due"),
  ).toHaveText(x.due);
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Formatted habit"]')).toContainText(
    `ideal ${x.ideal}`,
  );

  await page.goto("/settings?section=hours");
  const work = page.getByTestId("hours-work");
  await expect(work.locator(".hours-day .day").first()).toHaveText(x.firstHoursDay);
  await expect(page.getByTestId("hours-text-work")).toHaveText(x.workHours);
  await expect(page.getByTestId("travel-list")).toContainText(x.trip);
}

test("the planner, the hours page and the task and habit lists use the time format, date format and week start from the calendar account, also after a reload (PRF-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Format check", start: at(TUE, "14:00"), end: at(TUE, "15:30") });
  await signIn();
  await addTask(page, { title: "Formatted task", minutes: 30, due: `${FRI}T16:00` });
  await addHabit(page, { title: "Formatted habit", ideal: "14:30" });
  const trip = await page.request.post("/api/travel", {
    data: { tz: "Asia/Tokyo", startDate: TRIP, endDate: addDays(TRIP, 2) },
  });
  expect(trip.status(), await trip.text()).toBe(201);

  // The defaults: 24-hour times, year-month-day dates, weeks from Monday.
  await check(page, {
    label: W,
    first: W,
    head: `Mon ${Number(W.slice(8))}`,
    evTime: "14:00–15:30",
    hour: "14:00",
    when: `Tue ${TUE} 14:00`,
    due: `Fri ${FRI} 16:00`,
    ideal: "14:30",
    firstHoursDay: "Mon",
    workHours: "Mon, Tue, Wed, Thu, Fri 09:00–17:00",
    trip: `${TRIP} to ${addDays(TRIP, 2)}`,
  });

  // The calendar account says: 12-hour times, day-month-year, weeks from Sunday.
  const saved = await page.request.patch("/api/settings", {
    data: { googleWeekStart: 7, timeFormat: "12h", dateFormat: "DMY" },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const sunday: Expected = {
    label: dmy(SUN),
    first: SUN,
    head: `Sun ${Number(SUN.slice(8))}`,
    evTime: "2:00 PM–3:30 PM",
    hour: "2 PM",
    when: `Tue ${dmy(TUE)} 2:00 PM`,
    due: `Fri ${dmy(FRI)} 4:00 PM`,
    ideal: "2:30 PM",
    firstHoursDay: "Sun",
    workHours: "Mon, Tue, Wed, Thu, Fri 9:00 AM–5:00 PM",
    trip: `${dmy(TRIP)} to ${dmy(addDays(TRIP, 2))}`,
  };
  await check(page, sunday);
  await page.reload();
  await check(page, sunday);

  // "Weekdays only" shows Monday to Friday of the Sunday week.
  const weekdays = await page.request.patch("/api/settings", {
    data: { plannerDays: "weekdays" },
  });
  expect(weekdays.status()).toBe(200);
  await page.goto(`/?week=${W}`);
  await expect(page.getByTestId("week-label")).toHaveText(`Week of ${dmy(SUN)}`);
  await expect(dayNames(page)).toHaveCount(5);
  await expect(dayNames(page).first()).toHaveAttribute("data-date", W);
  await expect(dayNames(page).last()).toHaveAttribute("data-date", FRI);

  // Planning keeps the week start set in Tempoloom; the profile shows both.
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  const fixed = page.getByTestId("profile-fixed");
  await expect(fixed.locator(".row", { hasText: "Planning week starts on" })).toContainText(
    "Monday",
  );
  await expect(
    fixed.locator(".row", { hasText: "Week start in your Google calendar" }),
  ).toContainText("Sunday");
  await expect(fixed.locator(".row", { hasText: "Time format" })).toContainText("12-hour");
});
