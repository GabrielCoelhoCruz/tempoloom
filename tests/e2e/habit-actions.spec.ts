// Habit actions (docs/specs/habits-automation.md rules 5, 6, 8, 15, 30, 40,
// Outputs; planning-planner.md PLN-11; planning-next-up.md NXT-40 to NXT-44;
// teams-executive-assistant-use.md rule 11): make a habit from a recurring
// event, reschedule one occurrence, edit a habit from any of its events, the
// done marker, monthly habits and a task search per habit.
//
// Ways it can fail, and the check that catches each:
// - "Make a habit" is missing on a solo series, or offered on a series with
//   guests                                                         -> drawer buttons and note
// - the form is not filled with the series title, length, weekdays and start
//   time                                                          -> editor field values
// - saving the habit changes or deletes the original series        -> series still at 10:00
// - the new habit uses other days or another length               -> event days and lengths
// - reschedule moves other days too, or ignores the chosen time    -> start time per day
// - a time outside the hours or on a busy time is not snapped to the nearest
//   legal slot                                                     -> 09:00 and 14:00
// - a rescheduled occurrence moves back on a later run or after a reload
//                                                                  -> times after more runs and a reload
// - "Edit habit" opens another habit, or the edit changes another habit
//                                                                  -> editor values from a second event; other habit unchanged
// - an ended occurrence keeps its free or busy marker, or a future one gets the
//   done marker                                                    -> titles on the calendar
// - the planner does not show the occurrence as done               -> drawer status after reload
// - a monthly habit is placed daily or weekly, or on the wrong date -> one event on the chosen date
// - "nth weekday" picks the wrong week                            -> the event date
// - a task search on a habit is a snapshot, changes placement, or does not
//   show while the habit runs                                      -> list after a new task, unchanged events, current panel
import { addDays, weekdayOf } from "../../src/shared/time.ts";
import {
  boxOf,
  day,
  moveToNow,
  newTaskSearch,
  own,
  putSeries,
  span,
  week,
} from "./automation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  eventually,
  expect,
  local,
  managed,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "These scenarios write raw CalDAV objects and move events.");

test("a solo recurring event becomes a habit from the planner; a series with guests offers a flexible meeting instead (rules 6, 8; PLN-11)", async ({
  page,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  const tue = day(1);
  const thu = day(3);
  await putSeries(radicale, cal, {
    title: "Morning review",
    start: at(tue, "10:00"),
    minutes: 30,
    byDay: "TU,TH",
  });
  await putSeries(radicale, cal, {
    title: "Team sync",
    start: at(tue, "14:00"),
    minutes: 60,
    byDay: "TU",
    attendees: ["ana@example.com"],
  });
  await signIn();
  // The series were written straight to the calendar: wait for the sync that reads them.
  await planNow(page);
  await openWeek(page);
  const drawer = page.getByTestId("event-drawer");
  await page.locator(".ev-external", { hasText: "Team sync" }).first().click();
  await expect(drawer.getByTestId("event-actions")).toContainText(
    "This series has other guests: make it a flexible meeting instead.",
  );
  await expect(drawer.getByRole("link", { name: "Flexible meetings" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Make a habit" })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Close" }).click();

  await page.locator(".ev-external", { hasText: "Morning review" }).first().click();
  await drawer.getByRole("button", { name: "Make a habit" }).click();
  const editor = page.getByTestId("habit-editor");
  await expect(editor.getByLabel("Title")).toHaveValue("Morning review");
  await expect(editor.getByLabel("Ideal time")).toHaveValue("10:00");
  await expect(editor.getByLabel("Shortest (minutes)")).toHaveValue("30");
  await expect(editor.getByLabel("Longest (minutes)")).toHaveValue("30");
  await expect(editor.locator('input[name="days"]:checked')).toHaveCount(2);
  await expect(editor.getByLabel("Tue", { exact: true })).toBeChecked();
  await expect(editor.getByLabel("Thu", { exact: true })).toBeChecked();
  await editor.getByRole("button", { name: "Save habit" }).click();
  await expect(page.locator('[data-habit-title="Morning review"]')).toContainText("Tue, Thu");

  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Morning review")).toHaveLength(2),
  );
  // The series still holds 10:00, so the nearest free start wins; a tie goes to the earlier one.
  expect(titled(evs, "Morning review").map(span)).toEqual([
    `${tue} 09:30-10:00`,
    `${thu} 09:30-10:00`,
  ]);
  // Edge case 8: the original series stays as it was.
  expect(own(evs, "Morning review").map(span)).toEqual([
    `${tue} 10:00-10:30`,
    `${thu} 10:00-10:30`,
  ]);
  await page.reload();
  await expect(page.locator('[data-habit-title="Morning review"]')).toContainText("Tue, Thu");
  await expect(page.locator('[data-habit-title="Morning review"]')).toContainText("30 min");
});

test("reschedule places one occurrence at the legal slot nearest the chosen time and keeps it there (rule 30)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Supplier call",
    start: at(day(4), "15:00"),
    end: at(day(4), "16:00"),
  });
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  const lunchOn = (n: number) => {
    const e = titled(evs, "Lunch").find((x) => local(x.start).startsWith(day(n)));
    if (!e) throw new Error(`no lunch on day ${n}`);
    return e;
  };
  await openWeek(page);
  const reschedule = async (n: number, time: string) => {
    await (await boxOf(page, app, lunchOn(n).id)).click();
    const form = page.getByTestId("reschedule-form");
    await form.getByLabel("Reschedule to").fill(time);
    await form.getByRole("button", { name: "Reschedule" }).click();
    await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  };
  await reschedule(2, "15:00");
  await reschedule(3, "07:00");
  await reschedule(4, "15:00");
  const expected = [
    `${day(0)} 12:00-13:00`,
    `${day(1)} 12:00-13:00`,
    `${day(2)} 15:00-16:00`,
    // 07:00 is before work hours: the nearest legal start is 09:00.
    `${day(3)} 09:00-10:00`,
    // The supplier call holds 15:00; 14:00 and 16:00 are equally near, the earlier wins.
    `${day(4)} 14:00-15:00`,
  ];
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(expected),
  );
  // Later runs keep the chosen times.
  await page.waitForTimeout(11_000);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Lunch" })).toHaveCount(5);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
});

test("edit habit opens the habit of any of its events; the edit moves its future events only (rules 5, 6)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Standup notes", ideal: "16:00", min: 30, max: 30 });
  await addHabit(page, { title: "Walk", ideal: "13:00", min: 30, max: 30 });
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Standup notes")).toHaveLength(5);
      expect(titled(l, "Walk")).toHaveLength(5);
    },
  );
  const on = (n: number) => {
    const e = titled(evs, "Standup notes").find((x) => local(x.start).startsWith(day(n)));
    if (!e) throw new Error(`no notes on day ${n}`);
    return e;
  };
  await openWeek(page);
  await (await boxOf(page, app, on(1).id)).click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Edit habit" }).click();
  const editor = page.getByTestId("habit-editor");
  await expect(editor.getByLabel("Title")).toHaveValue("Standup notes");
  await expect(editor.getByLabel("Ideal time")).toHaveValue("16:00");
  await editor.getByLabel("Title").fill("Daily notes");
  await editor.getByLabel("Ideal time").fill("10:00");
  await editor.getByRole("button", { name: "Save habit" }).click();
  await expect(page.locator('[data-habit-title="Daily notes"]')).toContainText("ideal 10:00");

  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Daily notes").map(span)).toEqual(
        [0, 1, 2, 3, 4].map((n) => `${day(n)} 10:00-10:30`),
      );
      expect(titled(l, "Standup notes")).toHaveLength(0);
      expect(titled(l, "Walk").map(span)).toEqual(
        [0, 1, 2, 3, 4].map((n) => `${day(n)} 13:00-13:30`),
      );
    },
  );
  // Another event of the same habit opens the same, edited habit.
  const after = titled(await week(cal), "Daily notes");
  await openWeek(page);
  await (await boxOf(page, app, after[3]?.id ?? "")).click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Edit habit" }).click();
  await expect(editor.getByLabel("Title")).toHaveValue("Daily notes");
  await expect(editor.getByLabel("Ideal time")).toHaveValue("10:00");
  await page.reload();
  await expect(page.locator('[data-habit-title="Daily notes"]')).toContainText("ideal 10:00");
  await expect(page.locator("[data-habit-title]")).toHaveCount(2);
});

test("an ended habit occurrence gets the done marker; future ones keep their state marker (Outputs; title markers rule 2)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  const [monday] = titled(evs, "Lunch");
  if (!monday) throw new Error("no Monday lunch");
  // The user did Monday's lunch yesterday instead, and moves it there in the calendar.
  const yesterday = addDays(local(Date.now()).slice(0, 10), -1);
  await cal.update(monday.id, { start: at(yesterday, "12:00"), end: at(yesterday, "13:00") });
  const range = () => cal.events(at(yesterday, "00:00"), at(day(7), "00:00"));
  const done = await eventually(range, (l) =>
    expect(managed(l).find((e) => e.id === monday.id)?.summary).toBe("✅ Lunch"),
  );
  // Monday of week W gets no second lunch, and the other days keep the free marker.
  const inW = titled(done, "Lunch").filter((e) => e.id === monday.id || local(e.start) >= W);
  expect(inW.map((e) => e.summary)).toEqual([
    "✅ Lunch",
    "○ Lunch",
    "○ Lunch",
    "○ Lunch",
    "○ Lunch",
  ]);
  await openWeek(page, addDays(yesterday, 1 - weekdayOf(yesterday)));
  await (await boxOf(page, app, monday.id)).click();
  await expect(page.getByTestId("occurrence-done")).toHaveText("Done");
  await page.reload();
  await (await boxOf(page, app, monday.id)).click();
  await expect(page.getByTestId("occurrence-done")).toHaveText("Done");
  expect(managed(await range()).find((e) => e.id === monday.id)?.summary).toBe("✅ Lunch");
});

test("a monthly habit is placed once a month, on a day of the month or on the nth weekday (frequency; executive monthly reviews)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const wed = day(2);
  const thu = day(3);
  const dayOfMonth = Number(wed.slice(8, 10));
  const nth = Math.ceil(Number(thu.slice(8, 10)) / 7);
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Metrics review");
  await form.getByLabel("Ideal time").fill("14:00");
  await form.getByLabel("Shortest (minutes)").fill("60");
  await form.getByLabel("Longest (minutes)").fill("60");
  await form.getByLabel("Repeat").selectOption({ label: "Monthly on a day" });
  await form.getByLabel("Day of month").fill(String(dayOfMonth));
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Metrics review"]')).toContainText(
    `monthly on day ${dayOfMonth}`,
  );

  await form.getByLabel("Title").fill("Customer feedback review");
  await form.getByLabel("Ideal time").fill("10:00");
  await form.getByLabel("Shortest (minutes)").fill("60");
  await form.getByLabel("Longest (minutes)").fill("60");
  await form.getByLabel("Repeat").selectOption({ label: "Monthly on a weekday" });
  await form.getByLabel("Week of month").selectOption(String(nth));
  await form.getByLabel("Day of the week").selectOption({ label: "Thursday" });
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Customer feedback review"]')).toBeVisible();

  const all = () => cal.events(Date.now(), at(addDays(W, 21), "00:00"));
  await eventually(all, (l) => {
    expect(titled(l, "Metrics review").map(span)).toEqual([`${wed} 14:00-15:00`]);
    expect(titled(l, "Customer feedback review").map(span)).toEqual([`${thu} 10:00-11:00`]);
  });
  await page.reload();
  await expect(page.locator('[data-habit-title="Metrics review"]')).toContainText(
    `monthly on day ${dayOfMonth}`,
  );
  await expect(page.locator('[data-habit-title="Customer feedback review"]')).toContainText(
    `monthly on the ${["", "1st", "2nd", "3rd", "4th", "5th"][nth]} Thursday`,
  );
});

test("a habit carries a saved task search: its events list the matching tasks, live, and placement does not change (rule 40; NXT-40 to NXT-44)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "Spec review", minutes: 30, split: false, due: "", level: 4 });
  await addTask(page, { title: "Expense report", minutes: 30, split: false, due: "", level: 4 });
  await addHabit(page, { title: "Deep work", ideal: "09:00", min: 120, max: 120, level: 2 });
  const before = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Deep work")).toHaveLength(5);
      expect(titled(l, "Spec review")).toHaveLength(1);
    },
  );
  const [first, second] = titled(before, "Deep work");
  if (!first || !second) throw new Error("no habit events");

  // Assign a search from one of the habit's events in the planner.
  await openWeek(page);
  await (await boxOf(page, app, first.id)).click();
  const search = page.getByTestId("event-task-search");
  await newTaskSearch(search, "Specs", "spec");
  await expect(search.getByTestId("search-tasks").locator("[data-task]")).toHaveText([
    "Spec review",
  ]);
  // Every event of the habit shows the same search.
  await page.getByTestId("event-drawer").getByRole("button", { name: "Close" }).click();
  await (await boxOf(page, app, second.id)).click();
  await expect(search.getByLabel("Task search").locator("option:checked")).toHaveText("Specs");
  // A saved search, not a snapshot: a new matching task shows up.
  await addTask(page, { title: "API spec", minutes: 30, split: false, due: "", level: 4 });
  await openWeek(page);
  await (await boxOf(page, app, second.id)).click();
  await expect(search.getByTestId("search-tasks").locator("[data-task]")).toHaveText([
    "Spec review",
    "API spec",
  ]);
  // The habit's events did not change for the assignment.
  const now = await week(cal);
  expect(titled(now, "Deep work").map((e) => [e.id, span(e), e.summary, e.description])).toEqual(
    titled(before, "Deep work").map((e) => [e.id, span(e), e.summary, e.description]),
  );

  // While a habit event runs, the planner lists the tasks of its search.
  await moveToNow(cal, first);
  await page.goto("/");
  const panel = page.getByTestId("current-tasks");
  await expect(panel).toContainText("Deep work", { timeout: 30_000 });
  await expect(panel.locator("[data-task]")).toHaveText(["Spec review", "API spec"]);
  await page.reload();
  await expect(panel.locator("[data-task]")).toHaveText(["Spec review", "API spec"]);
});
