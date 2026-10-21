// Planner views (docs/specs/planning-planner.md): the day filter (PLN-3), the
// busy all-day pattern (PLN-5), "view as" others (PLN-6), the connected
// calendars panel (PLN-20) and the panel modes (PLN-21).
//
// Ways this can fail, and the check that catches each:
// - the filter shows the wrong days, or forgets the choice on reload  -> day columns, events
// - a busy all-day day has no pattern, or a free one has it          -> day-busy class, reload
// - "view as" shows free events or private titles                    -> event boxes and text
// - "view as" leaves open details, the now line or the conflicts
//   panel with titles in them                                        -> drawer, now line, conflicts
// - a hidden calendar still shows, stops blocking, or is disconnected -> boxes, Radicale, settings
// - two panels show at once                                          -> panel visibility
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { calendarRow, openSettings } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, planNow, test } from "./fixtures.ts";
import { addTask, allEvents, openWeek, titled, W } from "./helpers.ts";
import { allDayBusy, putEvent } from "./ics.ts";

test.skip(BACKEND === "google", "These tests write raw CalDAV events.");

const day = (n: number) => addDays(W, n);
const heads = (page: Page) => page.locator(".week-head [data-date]");
const box = (page: Page, text: string) => page.locator(".ev", { hasText: text });

/** Opens the gear menu and picks the days to show; waits for the save. */
async function showDays(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: "Planner options" }).click();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH" && r.ok(),
  );
  await page.getByLabel("Days shown").selectOption({ label });
  await saved;
}

test("the gear menu shows weekdays only or a rolling 9 days, and the choice stays after reload (PLN-3; AT 1)", async ({
  page,
  cal,
  signIn,
}) => {
  await cal.addEvent({ title: "AT-Sat", start: at(day(5), "10:00"), end: at(day(5), "11:00") });
  await cal.addEvent({ title: "AT-NextTue", start: at(day(8), "10:00"), end: at(day(8), "11:00") });
  await signIn();
  await openWeek(page);
  // Default: all 7 days of the week.
  await expect(heads(page)).toHaveCount(7);
  await expect(box(page, "AT-Sat")).toBeVisible();
  await expect(box(page, "AT-NextTue")).toHaveCount(0);

  await showDays(page, "Weekdays only");
  await expect(heads(page)).toHaveCount(5);
  await expect(heads(page).first()).toHaveAttribute("data-date", W);
  await expect(heads(page).last()).toHaveAttribute("data-date", day(4));
  await expect(box(page, "AT-Sat")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("week-label")).toContainText(W);
  await expect(heads(page)).toHaveCount(5);
  await expect(box(page, "AT-Sat")).toHaveCount(0);

  // A rolling 9 days runs into the next week.
  await showDays(page, "Rolling 9 days");
  await expect(heads(page)).toHaveCount(9);
  await expect(heads(page).last()).toHaveAttribute("data-date", day(8));
  await expect(box(page, "AT-Sat")).toBeVisible();
  await expect(box(page, "AT-NextTue")).toBeVisible();
  await page.reload();
  await expect(heads(page)).toHaveCount(9);
  await expect(box(page, "AT-NextTue")).toBeVisible();

  await showDays(page, "All days");
  await expect(heads(page)).toHaveCount(7);
});

test("a day with a busy all-day event shows the dashed pattern and gets no managed event (PLN-5; AT 6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await allDayBusy(cal.calendarId, "AT-Offsite", W);
  // A free all-day event uses no availability: no pattern.
  await putEvent(cal.calendarId, [
    `DTSTART;VALUE=DATE:${day(1).replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${day(2).replace(/-/g, "")}`,
    "SUMMARY:AT-Birthday",
    "TRANSP:TRANSPARENT",
  ]);
  await signIn();
  await addTask(page, { title: "AT-PL6", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-PL6")[0]?.start ?? 0)).toBe(`${day(1)} 09:00`),
  );
  await openWeek(page);
  const col = (d: string) => page.locator(`.day-col[data-date="${d}"]`);
  await expect(col(W)).toHaveClass(/day-busy/);
  await expect(col(W)).toHaveAttribute("title", /AT-Offsite/);
  await expect(col(day(1))).not.toHaveClass(/day-busy/);
  await expect(col(day(2))).not.toHaveClass(/day-busy/);
  await page.reload();
  await expect(col(W)).toHaveClass(/day-busy/);
  await expect(col(day(1))).not.toHaveClass(/day-busy/);
});

test("view as others hides free events and the details of private events (PLN-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await cal.addEvent({ title: "AT-Standup", start: at(W, "09:00"), end: at(W, "09:30") });
  await cal.addEvent({
    title: "AT-Optional talk",
    start: at(W, "11:00"),
    end: at(W, "12:00"),
    busy: false,
  });
  await putEvent(cal.calendarId, [
    `DTSTART:${new Date(at(day(1), "14:00")).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    `DTEND:${new Date(at(day(1), "15:00")).toISOString().replace(/[-:]|\.\d{3}/g, "")}`,
    "SUMMARY:AT-Doctor",
    "CLASS:PRIVATE",
  ]);
  await signIn();
  await openWeek(page);
  const viewAs = page.getByLabel("View as");
  // As the user: every event with its title.
  for (const t of ["AT-Standup", "AT-Optional talk", "AT-Doctor"])
    await expect(box(page, t)).toBeVisible();
  await expect(viewAs).toHaveValue("me");

  await viewAs.selectOption({ label: "Others" });
  await expect(box(page, "AT-Standup")).toBeVisible();
  await expect(box(page, "AT-Optional talk")).toHaveCount(0);
  await expect(page.getByTestId("planner")).not.toContainText("AT-Doctor");
  const hidden = page.locator(`.ev[data-start="${at(day(1), "14:00")}"]`);
  await expect(hidden).toHaveText(/^Busy/);
  // Details stay closed: a click shows nothing private.
  await hidden.click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);

  // The view is for a look only: a reload shows the user's own view again.
  await page.reload();
  await expect(page.getByLabel("View as")).toHaveValue("me");
  await expect(box(page, "AT-Doctor")).toBeVisible();
  await page.getByLabel("View as").selectOption({ label: "Others" });
  await expect(box(page, "AT-Doctor")).toHaveCount(0);
  await expect(page.locator(`.ev[data-start="${at(day(1), "14:00")}"]`)).toHaveText(/^Busy/);
});

test("view as others closes the open event details and the conflicts panel, and the now line shows a private meeting as busy (PLN-6)", async ({
  page,
  cal,
  signIn,
}) => {
  const ics = (t: number) => new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const soon = Math.ceil(Date.now() / 60_000) * 60_000 + 30 * 60_000;
  await putEvent(cal.calendarId, [
    `DTSTART:${ics(soon)}`,
    `DTEND:${ics(soon + 30 * 60_000)}`,
    "SUMMARY:AT-Secret call",
    "LOCATION:https://meet.example.test/secret",
    "CLASS:PRIVATE",
  ]);
  await cal.addEvent({ title: "AT-Clash A", start: at(day(1), "10:00"), end: at(day(1), "11:00") });
  await cal.addEvent({ title: "AT-Clash B", start: at(day(1), "10:30"), end: at(day(1), "11:30") });
  await signIn();
  await openWeek(page);
  const next = page.getByTestId("now-bar").getByTestId("next-meeting");
  await expect(next).toContainText("Next: AT-Secret call");
  const viewAs = page.getByLabel("View as");

  // Open details of an event, then switch: the details close.
  await box(page, "AT-Clash A").click();
  await expect(page.getByTestId("event-drawer")).toContainText("AT-Clash A");
  await viewAs.selectOption({ label: "Others" });
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  // The now line shows the private meeting as busy, with no link.
  await expect(next).toContainText("Next: Busy");
  await expect(next.getByRole("link", { name: "Join" })).toHaveCount(0);
  await expect(page.getByTestId("planner")).not.toContainText("AT-Secret");
  await expect(page.getByRole("button", { name: "1 conflict" })).toHaveCount(0);

  // As the user again: the conflicts panel opens with both titles; switching closes it.
  await viewAs.selectOption({ label: "Me" });
  await expect(next).toContainText("Next: AT-Secret call");
  await page.getByRole("button", { name: "1 conflict" }).click();
  await expect(page.getByTestId("conflicts")).toContainText("AT-Clash A and AT-Clash B overlap");
  await viewAs.selectOption({ label: "Others" });
  await expect(page.getByTestId("conflicts")).toHaveCount(0);
  await expect(page.getByTestId("planner")).not.toContainText("AT-Secret");
});

test("the calendars panel hides a connected calendar from the planner; it still blocks time and stays connected (PLN-20; AT 5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const side = await cal.newCalendar("AT-Side");
  await side.addEvent({
    title: "AT-Thu block",
    start: at(day(3), "09:00"),
    end: at(day(3), "17:00"),
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await calendarRow(page, "AT-Side").getByRole("checkbox").check();
  await expect(calendarRow(page, "AT-Side").getByRole("checkbox")).toBeChecked();
  await planNow(page);

  await openWeek(page);
  await expect(box(page, "AT-Thu block")).toBeVisible();
  await page.getByRole("button", { name: "Calendars" }).click();
  const panel = page.getByTestId("calendars-panel");
  const show = panel.getByLabel("AT-Side");
  await expect(show).toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH" && r.ok(),
  );
  await show.uncheck();
  await saved;
  await expect(box(page, "AT-Thu block")).toHaveCount(0);

  // Hidden is not disconnected: the scheduler still keeps Thursday free of the task.
  await addTask(page, {
    title: "AT-PL5",
    minutes: 60,
    split: false,
    due: `${day(4)}T17:00`,
    startAfter: `${day(3)}T00:00`,
  });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-PL5")[0]?.start ?? 0)).toBe(`${day(4)} 09:00`),
  );

  await openWeek(page);
  await expect(box(page, "AT-PL5")).toBeVisible();
  await expect(box(page, "AT-Thu block")).toHaveCount(0);
  await page.getByRole("button", { name: "Calendars" }).click();
  await expect(page.getByTestId("calendars-panel").getByLabel("AT-Side")).not.toBeChecked();
  await page.getByTestId("calendars-panel").getByRole("link", { name: "Edit calendars" }).click();
  await expect(calendarRow(page, "AT-Side").getByRole("checkbox")).toBeChecked();

  // Showing it again brings its events back.
  await openWeek(page);
  await page.getByRole("button", { name: "Calendars" }).click();
  await page.getByTestId("calendars-panel").getByLabel("AT-Side").check();
  await expect(box(page, "AT-Thu block")).toBeVisible();
});

test("the details panel has one mode at a time: tasks, priorities or event details (PLN-21)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Modes", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Modes")).toHaveLength(1),
  );
  await openWeek(page);
  const bar = page.getByTestId("now-bar");
  const tasks = page.getByTestId("tasks-panel");
  const priorities = page.getByTestId("priorities-panel");
  const details = page.getByTestId("event-drawer");

  await bar.getByRole("button", { name: "Tasks" }).click();
  await expect(tasks).toBeVisible();
  await box(page, "AT-Modes").click();
  await expect(details).toContainText("AT-Modes");
  await expect(tasks).toHaveCount(0);
  await expect(bar.getByRole("button", { name: "Tasks" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );

  await bar.getByRole("button", { name: "Priorities" }).click();
  await expect(priorities).toBeVisible();
  await expect(priorities).toContainText("AT-Modes");
  await expect(details).toHaveCount(0);

  await bar.getByRole("button", { name: "Tasks" }).click();
  await expect(tasks).toBeVisible();
  await expect(priorities).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("week-label")).toContainText(W);
  await box(page, "AT-Modes").click();
  await expect(details).toContainText("AT-Modes");
  await bar.getByRole("button", { name: "Priorities" }).click();
  await expect(priorities).toContainText("AT-Modes");
  await expect(details).toHaveCount(0);
});
