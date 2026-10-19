// The task timer and its stop dialog, and logged time in stats
// (docs/specs/planning-task-progress.md PRG-20, PRG-22, PRG-30 to PRG-32;
// docs/specs/analytics-personal-stats.md rule 15).
//
// Ways it can fail, and the check that catches each:
// - the timer is lost on reload (kept only in the page)               -> running after reload
// - "Keep going" stops the timer, or "Discard" writes an event         -> bar after; Radicale empty
// - the record is written before the user applies it                   -> Radicale before "Log time"
// - edited minutes are ignored                                         -> event length 25 min
// - the logged event goes to the main calendar, not the chosen one     -> event on "Worklog" only
// - the logged event is not in the past, ending at the stop time       -> end within 2 minutes of stop
// - logged time does not reduce the remaining work                     -> future chunk 95 min, "left"
// - "Mark the task done" is ignored, or leaves future chunks           -> Done list, Radicale
// - stats do not count time logged on a task or on a habit              -> stat-tasks, stat-workHabits
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../../src/shared/time.ts";
import { blockUntil, eventually, expect, test, ZONE } from "./fixtures.ts";
import { addHabit, addTask, allEvents, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";
import { chooseSetting } from "./s3-helpers.ts";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

test("the task timer logs the recorded time as a past event on the chosen calendar only after Log time (PRG-30 to PRG-32)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // A second calendar for the logged time; its address sorts after the main one.
  const log = await cal.newCalendar("Worklog");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Worklog");
  await addTask(page, { title: "AT-Timer", minutes: 120, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Timer")).toHaveLength(1),
  );
  const row = page.locator('[data-task-title="AT-Timer"]');
  await row.getByRole("button", { name: "Start timer" }).click();
  await expect(row.getByTestId("timer-running")).toBeVisible();

  await page.getByRole("link", { name: "Planner" }).click();
  const bar = page.getByTestId("timer-bar");
  await expect(bar).toContainText("AT-Timer");
  await page.reload();
  await expect(bar).toContainText("AT-Timer");

  const dialog = page.getByRole("dialog", { name: "Stop timer" });
  await bar.getByRole("button", { name: "Stop" }).click();
  await expect(dialog.getByLabel("Minutes")).toHaveValue("1");
  await dialog.getByRole("button", { name: "Keep going" }).click();
  await expect(dialog).toBeHidden();
  await expect(bar).toContainText("AT-Timer");

  await bar.getByRole("button", { name: "Stop" }).click();
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toBeHidden();

  await page.getByRole("link", { name: "Tasks" }).click();
  await row.getByRole("button", { name: "Start timer" }).click();
  await row.getByRole("button", { name: "Stop" }).click();
  await dialog.getByLabel("Minutes").fill("25");
  await dialog.getByLabel("Calendar").selectOption({ label: "Worklog" });
  await expect(dialog.getByTestId("timer-preview")).toContainText("25 min");
  await expect(dialog.getByTestId("timer-preview")).toContainText("Worklog");
  expect(
    titled(await log.events(Date.now() - 86_400_000, Date.now() + 86_400_000), "AT-Timer"),
  ).toHaveLength(0);
  const stopped = Date.now();
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(dialog).toBeHidden();

  const [logged] = titled(
    await eventually(
      () => log.events(Date.now() - 86_400_000, Date.now() + 86_400_000),
      (l) => expect(titled(l, "AT-Timer")).toHaveLength(1),
    ),
    "AT-Timer",
  );
  expect(logged?.end ?? 0).toBeLessThanOrEqual(Date.now());
  expect(Math.abs((logged?.end ?? 0) - stopped)).toBeLessThan(2 * MIN);
  expect((logged?.end ?? 0) - (logged?.start ?? 0)).toBe(25 * MIN);
  await eventually(
    () => allEvents(cal),
    (l) => {
      const future = titled(l, "AT-Timer").filter((e) => e.start > Date.now());
      expect(future.reduce((a, e) => a + e.end - e.start, 0)).toBe(95 * MIN);
    },
  );
  await page.reload();
  await expect(row.getByTestId("task-left")).toHaveText("1 h 35 min left");

  // Complete the task from the dialog: its future chunks go.
  await row.getByRole("button", { name: "Start timer" }).click();
  await row.getByRole("button", { name: "Stop" }).click();
  await dialog.getByLabel("Mark the task done").check();
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(row).toBeHidden();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('[data-task-title="AT-Timer"]')).toBeVisible();
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Timer").filter((e) => e.start > Date.now())).toHaveLength(0),
  );
});

test("time logged with the timer on a task and on a habit counts in stats (analytics-personal-stats rule 15)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await chooseSetting(page, "Task placement", "Suggestions only (no task events)");
  await addTask(page, { title: "AT-Logged task", minutes: 60, split: false, due: "" });
  // The habit's day is not today, so today's habit minutes come from the log only.
  const today = utcToLocal(ZONE, Date.now()).date;
  const habitDay = DAY_NAMES[weekdayOf(addDays(today, 2)) - 1] as (typeof DAY_NAMES)[number];
  await addHabit(page, { title: "AT-Read", ideal: "11:00", min: 30, max: 30, days: [habitDay] });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Read").length).toBeGreaterThan(0),
  );

  const dialog = page.getByRole("dialog", { name: "Stop timer" });
  await page.getByRole("link", { name: "Tasks" }).click();
  const row = page.locator('[data-task-title="AT-Logged task"]');
  await row.getByRole("button", { name: "Start timer" }).click();
  await row.getByRole("button", { name: "Stop" }).click();
  await dialog.getByLabel("Minutes").fill("25");
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(dialog).toBeHidden();

  await openWeek(page, W);
  await openEvent(page, "AT-Read");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Start timer" }).click();
  const bar = page.getByTestId("timer-bar");
  await expect(bar).toContainText("AT-Read");
  await bar.getByRole("button", { name: "Stop" }).click();
  await dialog.getByLabel("Minutes").fill("15");
  await expect(dialog.getByLabel("Mark the task done")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(bar).toBeHidden();

  const dayStart = localToUtc(ZONE, today, 0);
  const evs = await eventually(
    () => cal.events(dayStart, dayStart + 86_400_000),
    (l) => {
      expect(titled(l, "AT-Logged task")).toHaveLength(1);
      expect(titled(l, "AT-Read")).toHaveLength(1);
    },
  );
  expect(titled(evs, "AT-Read").map((e) => e.end - e.start)).toEqual([15 * MIN]);

  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(today);
  await page.getByLabel("To").fill(today);
  await expect(page.getByTestId("stat-tasks")).toHaveText("25 min");
  await expect(page.getByTestId("stat-workHabits")).toHaveText("15 min");
  await page.reload();
  await page.getByLabel("From").fill(today);
  await page.getByLabel("To").fill(today);
  await expect(page.getByTestId("stat-tasks")).toHaveText("25 min");
  await expect(page.getByTestId("stat-workHabits")).toHaveText("15 min");
});
