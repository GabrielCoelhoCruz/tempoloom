// Core planning rows proven end to end: chunk spacing, the calendar for task
// chunks, the order of item kinds and levels, urgency, focus time, external
// event priority, meeting hours, several ranges per day and moved chunks
// (planning-tasks.md, planning-priorities.md, planning-scheduler.md,
// planning-hours.md, planning-defense.md, events-external-priority.md,
// planning-calendar-edits.md).
//
// Ways this can fail, and the test that catches each:
// - the chunk spacing choice is missing, not saved, or not used (spacing test)
// - chunks go to the main calendar whatever the hours set says (calendar test)
// - a task takes a slot before a habit or meeting of its level, or a lower
//   level goes before a higher one (order test)
// - the urgency choice does not change the order of tasks (urgency test)
// - focus time goes before a P4 task, changes its free/busy status, or a P2
//   booking link offers its time (focus test)
// - a series level changes only one event, or one event's level changes the
//   series (series test)
// - an event of another calendar can change level, or a link offers it (other
//   calendar test)
// - meetings ignore meeting hours, or a change of meeting hours does not move
//   them (meeting hours test)
// - a second range is lost, copy to all misses a day or turns on a day that is
//   off, or a chunk spans the gap between ranges (ranges test)
// - a moved chunk's old time is used again by the same task (moved chunk test)
import type { Locator, Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { putSeries } from "./automation-helpers.ts";
import {
  automation,
  create,
  group,
  names,
  openAutomations,
  save,
} from "./automation-list-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import {
  addHabit,
  addTask,
  claimPage,
  inHours,
  MIN,
  openWeek,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";

test.skip(BACKEND === "google", "These tests use a second CalDAV calendar and raw series.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
type Evs = Awaited<ReturnType<typeof week>>;
const span = (e: { start: number; end: number }) => `${local(e.start)}-${local(e.end).slice(11)}`;
const overlaps = (e: { start: number; end: number }, s: number, t: number) =>
  e.start < t && e.end > s;

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
}

async function setRange(set: Locator, testId: string, from: string, to: string) {
  await set.getByTestId(testId).locator("input").first().fill(from);
  await set.getByTestId(testId).locator("input").last().fill(to);
}

/** Work hours cover the whole day, every day, so items can be placed close to now. */
async function allDayWorkHours(page: Page) {
  await openSettings(page);
  const work = page.getByTestId("hours-work");
  await setRange(work, "range-work-1-0", "00:00", "23:59");
  for (const d of [5, 6])
    await work.locator(".hours-day").nth(d).getByRole("button", { name: "+" }).click();
  await work.getByRole("button", { name: "Copy to all" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}

/** Adds a second calendar after sign-in, so the main calendar stays the main one. */
async function secondCalendar(page: Page, cal: CalendarDriver, name: string) {
  const other = await cal.newCalendar(name);
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(name);
  return other;
}

test("the time between chunks of a task is a setting: once a day puts each chunk on its own day, 2 hours keeps a 2-hour gap (TSK-14)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  const spacing = page.getByLabel("Time between chunks of a task");
  await expect(spacing).toHaveValue("none");
  await spacing.selectOption({ label: "Once a day" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByLabel("Time between chunks of a task")).toHaveValue("once-per-day");

  await addTask(page, { title: "AT-Daily", minutes: 180, min: 60, max: 60, due: "" });
  const daily = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Daily")).toHaveLength(3),
  );
  const days = titled(daily, "AT-Daily").map((e) => local(e.start).slice(0, 10));
  expect(new Set(days).size).toBe(3);
  expect(days[0]).toBe(W);

  await openSettings(page);
  await page.getByLabel("Time between chunks of a task").selectOption({ label: "2 hours" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Gap", minutes: 180, min: 60, max: 60, due: "", level: 1 });
  const gap = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Gap")).toHaveLength(3),
  );
  const chunks = titled(gap, "AT-Gap");
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const cur = chunks[i];
    if (!prev || !cur) continue;
    if (local(prev.start).slice(0, 10) === local(cur.start).slice(0, 10))
      expect(cur.start - prev.end).toBeGreaterThanOrEqual(120 * MIN);
  }
  // The P1 task starts at the first free time; its next chunk waits 2 hours.
  expect(span(chunks[0] ?? { start: 0, end: 0 })).toBe(`${W} 09:00-10:00`);
  expect(span(chunks[1] ?? { start: 0, end: 0 })).toBe(`${W} 12:00-13:00`);
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Time between chunks of a task")).toHaveValue("2h");
});

test("each hours set has a calendar for task chunks; chunks of tasks in that set go there (TSK-50, TSK-51, HRS-12)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const tasks = await secondCalendar(page, cal, "Task chunks");
  await page.reload();
  const work = page.getByTestId("hours-work");
  const choice = work.getByLabel("Calendar for task chunks");
  await expect(choice).toHaveValue("");
  await choice.selectOption({ label: "Task chunks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(
    page.getByTestId("hours-work").getByLabel("Calendar for task chunks"),
  ).not.toHaveValue("");

  await addTask(page, { title: "AT-Elsewhere", minutes: 60, split: false, due: "" });
  await addTask(page, {
    title: "AT-Personal",
    minutes: 60,
    split: false,
    due: "",
    hours: "Personal hours",
  });
  await eventually(
    () => week(tasks),
    (l) => expect(titled(l, "AT-Elsewhere")).toHaveLength(1),
  );
  const main = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Personal")).toHaveLength(1),
  );
  // Only the work hours set points at the other calendar.
  expect(titled(main, "AT-Elsewhere")).toHaveLength(0);
  expect(titled(await week(tasks), "AT-Personal")).toHaveLength(0);
});

test("a new calendar for task chunks keeps placed chunks and the saved hours; a calendar that is not the user's is refused (HRS-12, TSK-50)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const early = await cal.addEvent({ title: "Early", start: at(W, "09:00"), end: at(W, "10:00") });
  await signIn();
  await addTask(page, { title: "AT-Stay", minutes: 60, split: false, due: "" });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Stay").map(span)).toEqual([`${W} 10:00-11:00`]),
  );
  // 09:00 is free now, but a valid placement stays where it is.
  await cal.remove(early);
  await planNow(page);
  expect(titled(await week(cal), "AT-Stay").map(span)).toEqual([`${W} 10:00-11:00`]);

  const other = await secondCalendar(page, cal, "Chunks");
  await page.reload();
  await page.getByTestId("hours-work").getByLabel("Calendar for task chunks").selectOption({
    label: "Chunks",
  });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  // The menu changes no hours, so the chunk is not placed again.
  await planNow(page);
  expect(titled(await week(cal), "AT-Stay").map(span)).toEqual([`${W} 10:00-11:00`]);
  expect(titled(await week(other), "AT-Stay")).toHaveLength(0);
  await page.reload();
  const monday = page.getByTestId("hours-work").getByTestId("range-work-1-0").locator("input");
  await expect(monday.first()).toHaveValue("09:00");
  await expect(monday.last()).toHaveValue("17:00");
  await expect(
    page.getByTestId("hours-work").getByLabel("Calendar for task chunks"),
  ).not.toHaveValue("");

  // The API refuses a calendar id that is not one of the user's calendars.
  const put = (body: unknown) =>
    page.evaluate(async (b) => {
      const sets = (await (await fetch("/api/hours")).json()) as {
        hours: { id: string; kind: string }[];
      };
      const work = sets.hours.find((h) => h.kind === "work");
      const r = await fetch(`/api/hours/${work?.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      return r.status;
    }, body);
  expect(await put({ taskCalendarId: "not-a-calendar" })).toBe(400);
  expect(await put({ taskCalendarId: null })).toBe(200);
  await page.reload();
  await expect(page.getByTestId("hours-work").getByLabel("Calendar for task chunks")).toHaveValue(
    "",
  );
});

test("inside one level meetings go first, then habits, then tasks; a higher level goes before all of them (PRI-1, PRI-3, SCH-62, SCH-64, SCH-70)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday has one free hour, 13:00 to 14:00.
  await cal.addEvent({ title: "Morning block", start: at(W, "09:00"), end: at(W, "13:00") });
  await cal.addEvent({ title: "Afternoon block", start: at(W, "14:00"), end: at(W, "17:00") });
  await signIn();
  const slotStart = at(W, "13:00");
  const slotEnd = at(W, "14:00");
  const holder = (l: Evs) =>
    ["AT-Task", "AT-Habit", "AT-Meeting", "AT-Urgent"].filter((t) =>
      titled(l, t).some((e) => overlaps(e, slotStart, slotEnd)),
    );

  await addTask(page, { title: "AT-Task", minutes: 60, split: false, due: "", level: 2 });
  await eventually(
    () => week(cal),
    (l) => expect(holder(l)).toEqual(["AT-Task"]),
  );

  await addHabit(page, {
    title: "AT-Habit",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Mon"],
    noRoom: "Remove that day",
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(holder(l)).toEqual(["AT-Habit"]);
      expect(titled(l, "AT-Task")).toHaveLength(1);
    },
  );

  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("AT-Meeting");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByLabel("Ideal time").fill("13:00");
  await form.getByLabel("Duration (minutes)").fill("60");
  await form.getByLabel("Priority").selectOption({ label: "P2 high" });
  await form
    .getByLabel("When there is no time")
    .selectOption({ label: "Remove it for that period" });
  await form.getByLabel("Mon", { exact: true }).check();
  await form.getByLabel("Tue", { exact: true }).uncheck();
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="AT-Meeting"]')).toBeVisible();
  await eventually(
    () => week(cal),
    (l) => {
      expect(holder(l)).toEqual(["AT-Meeting"]);
      expect(titled(l, "AT-Habit").filter((e) => local(e.start).startsWith(W))).toHaveLength(0);
    },
  );

  // A P1 task goes before every P2 item, whatever its kind.
  await addTask(page, { title: "AT-Urgent", minutes: 60, split: false, due: "", level: 1 });
  await eventually(
    () => week(cal),
    (l) => expect(holder(l)).toEqual(["AT-Urgent"]),
  );

  // The order is kept after a reload; the list shows the P2 meeting before the habit.
  await page.reload();
  await openAutomations(page);
  await expect.poll(() => names(group(page, 2))).toEqual(["AT-Meeting", "AT-Habit"]);
  expect(holder(await week(cal))).toEqual(["AT-Urgent"]);
});

test("the urgency setting decides whether a low task that is short of time goes first (PRI-5, SCH-66, SCH-77, SCH-79)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  await expect(page.getByLabel("Urgency")).toHaveValue("due-date-and-work");
  // 2 hours of work due Monday 11:00 has 2 hours of room: two levels up, P4 to
  // P2, so it takes the time of the P3 task that came first.
  await addTask(page, { title: "AT-Plenty", minutes: 120, split: false, due: "", level: 3 });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Plenty").map(span)).toEqual([`${W} 09:00-11:00`]),
  );
  await addTask(page, {
    title: "AT-Short",
    minutes: 120,
    split: false,
    due: `${W}T11:00`,
    level: 4,
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Short").map(span)).toEqual([`${W} 09:00-11:00`]);
      expect(titled(l, "AT-Plenty").map(span)).toEqual([`${W} 11:00-13:00`]);
    },
  );

  // Priority only: the same case on Tuesday keeps the P3 task first.
  await openSettings(page);
  await page.getByLabel("Urgency").selectOption({ label: "Priority only" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const tue = `${day(1)}T09:00`;
  await addTask(page, {
    title: "AT-Tue plenty",
    minutes: 120,
    split: false,
    due: "",
    level: 3,
    startAfter: tue,
  });
  await addTask(page, {
    title: "AT-Tue short",
    minutes: 120,
    split: false,
    due: `${day(1)}T11:00`,
    level: 4,
    startAfter: tue,
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Tue plenty").map(span)).toEqual([`${day(1)} 09:00-11:00`]);
      expect(titled(l, "AT-Tue short").map(span)).toEqual([`${day(1)} 11:00-13:00`]);
    },
  );
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Urgency")).toHaveValue("priority-only");
});

test("with the 48-hour urgency mode a low task due within 48 hours goes up one level, a task due later does not (SCH-78)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await allDayWorkHours(page);
  // Nothing is placed before the next midnight, B.
  const today = local(Date.now()).slice(0, 10);
  const b = addDays(today, 1);
  await cal.addEvent({ title: "E2E blocker", start: Date.now() - 3_600_000, end: at(b, "00:00") });
  await openSettings(page);
  await page.getByLabel("Urgency").selectOption({ label: "Raise tasks due within 48 hours" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  const near = () => cal.events(at(b, "00:00"), at(addDays(b, 1), "00:00"));
  await addTask(page, { title: "AT-Plenty", minutes: 120, split: false, due: "", level: 3 });
  await eventually(near, (l) =>
    expect(titled(l, "AT-Plenty").map(span)).toEqual([`${b} 00:00-02:00`]),
  );
  // Due 16 hours after B: less than 48 hours from now, but with 8 times the
  // room it needs, so the default mode would not raise it.
  await addTask(page, {
    title: "AT-Soon",
    minutes: 120,
    split: false,
    due: `${b}T16:00`,
    level: 4,
  });
  // Due 50 hours after B: more than 48 hours from now.
  await addTask(page, {
    title: "AT-Later",
    minutes: 60,
    split: false,
    due: `${addDays(b, 2)}T02:00`,
    level: 4,
  });
  await eventually(near, (l) => {
    expect(titled(l, "AT-Soon").map(span)).toEqual([`${b} 00:00-02:00`]);
    expect(titled(l, "AT-Plenty").map(span)).toEqual([`${b} 02:00-04:00`]);
    expect(titled(l, "AT-Later").map(span)).toEqual([`${b} 04:00-05:00`]);
  });
  await page.reload();
  await openSettings(page);
  await expect(page.getByLabel("Urgency")).toHaveValue("due-date");
});

test("focus time goes after a P4 task, keeps the free/busy status set on it, and counts as P2 for booking links (PRI-20, PRI-21, DEF-40)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("AT-Focus");
  // Work tasks count toward the goal (PRI-22): 2 hours leaves 1 hour of focus
  // time after the 1-hour task below.
  await focus.getByLabel("Weekly goal (hours)").fill("2");
  await focus.getByLabel("Daily maximum (hours)").fill("1");
  await focus.getByLabel("Shortest block (minutes)").fill("60");
  await focus.getByLabel("Longest block (minutes)").fill("60");
  await save(focus);
  const first = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Focus")).toHaveLength(2),
  );
  const before = titled(first, "AT-Focus")[0];
  if (!before) throw new Error("no focus event");

  // A P4 task created later still gets the first focus event's time (PRI-20).
  await addTask(page, {
    title: "AT-Low",
    minutes: 60,
    split: false,
    level: 4,
    due: "",
    startAfter: `${local(before.start).replace(" ", "T")}`,
  });
  const after = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Low").map(span)).toEqual([span(before)]);
      expect(titled(l, "AT-Focus")).toHaveLength(1);
      for (const e of titled(l, "AT-Focus"))
        expect(overlaps(e, before.start, before.end)).toBe(false);
    },
  );
  const placed = titled(after, "AT-Focus")[0];
  if (!placed) throw new Error("no focus event");
  // DEF-40: busy as set, even a day or more ahead, where an adaptive item is free.
  expect(placed.start - Date.now()).toBeGreaterThan(24 * 60 * MIN);
  expect(placed.busy).toBe(true);

  // PRI-21: a P1 link offers the focus time, a P2 link does not.
  await claimPage(page, "fern");
  const v = await visitor(browser);
  await v.goto("/book/fern/important-meeting");
  await expect(slot(v, placed.start)).toBeVisible();
  await v.goto("/book/fern/meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, placed.start)).toHaveCount(0);

  // Free stays free, also close to the time.
  await openAutomations(page);
  await automation(page, "AT-Focus").getByRole("link", { name: "Edit" }).click();
  const edit = page.getByTestId("automation-form");
  await edit.getByLabel("Show as").selectOption({ label: "Free" });
  await save(edit);
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Focus")).toHaveLength(1);
      for (const e of titled(l, "AT-Focus")) expect(e.busy).toBe(false);
    },
  );
  await page.reload();
  await openAutomations(page);
  await automation(page, "AT-Focus").getByRole("link", { name: "Edit" }).click();
  await expect(page.getByTestId("automation-form").getByLabel("Show as")).toHaveValue("free");
});

test("free focus time stays free inside the 12 hours before it starts (DEF-40)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  // Focus time can start soon.
  await allDayWorkHours(page);

  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("AT-Near");
  await focus.getByLabel("Weekly goal (hours)").fill("2");
  await focus.getByLabel("Daily maximum (hours)").fill("1");
  await focus.getByLabel("Shortest block (minutes)").fill("60");
  await focus.getByLabel("Longest block (minutes)").fill("60");
  await focus.getByLabel("Show as").selectOption({ label: "Free" });
  await save(focus);
  const soon = () => cal.events(Date.now() - 3_600_000, Date.now() + 2 * 24 * 60 * MIN);
  const check = (l: Evs) => {
    const near = titled(l, "AT-Near").filter((e) => e.start - Date.now() < 12 * 60 * MIN);
    expect(near.length).toBeGreaterThan(0);
    for (const e of titled(l, "AT-Near")) expect(e.busy).toBe(false);
  };
  await eventually(soon, check);
  // A new plan run after a reload keeps it free.
  await page.reload();
  await planNow(page);
  check(await soon());
});

test("the level of a recurring external event applies to this event or to the whole series (events-external-priority rule 3, PRI-41)", async ({
  page,
  browser,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("needs Radicale");
  await blockUntil(cal, W);
  await putSeries(radicale, cal, {
    title: "AT-Standup",
    start: at(W, "09:00"),
    minutes: 60,
    byDay: "MO,TU,WE,TH,FR",
  });
  await signIn();
  await claimPage(page, "sera");
  const v = await visitor(browser);
  /** Whether the link offers the 09:00 time of a day; read until it settles. */
  const offers = (link: string, date: string) =>
    expect.poll(async () => {
      await v.goto(`/book/sera/${link}`);
      await expect(v.getByTestId("times")).toBeVisible();
      return (await slot(v, at(date, "09:00")).count()) > 0;
    });
  await offers("important-meeting", W).toBe(false);

  const setLevel = async (date: string, level: string, series: boolean) => {
    await openWeek(page);
    await page.locator(`.ev-external[data-start="${at(date, "09:00")}"]`).click();
    const form = page.getByTestId("external-priority");
    await form.getByLabel("Priority for booking links").selectOption(level);
    if (series) await form.getByLabel("All events in the series").check();
    const saved = page.waitForResponse(
      (r) => r.request().method() === "POST" && r.url().includes("/priority"),
    );
    await form.getByRole("button", { name: "Save priority" }).click();
    expect((await saved).status()).toBe(200);
  };

  // This event only: Monday becomes P3, so the P1 link and the P2 link offer
  // it; Tuesday stays P1 and closed.
  await setLevel(W, "3", false);
  await offers("important-meeting", W).toBe(true);
  await offers("meeting", W).toBe(true);
  await offers("important-meeting", day(1)).toBe(false);

  // All events at P2: every day opens to the P1 link. The series level
  // replaces Monday's own P3, so the P2 link no longer offers Monday.
  await setLevel(day(1), "2", true);
  for (const n of [0, 1, 2, 3, 4]) await offers("important-meeting", day(n)).toBe(true);
  for (const n of [0, 1, 4]) await offers("meeting", day(n)).toBe(false);

  // Tempoloom never moves the series; the level survives a reload.
  const standups = (await week(cal)).filter((e) => e.summary === "AT-Standup");
  expect(standups.map((e) => local(e.start).slice(11))).toEqual(Array(5).fill("09:00"));
  await page.reload();
  for (const date of [W, day(2)]) {
    await page.locator(`.ev-external[data-start="${at(date, "09:00")}"]`).click();
    await expect(
      page.getByTestId("external-priority").getByLabel("Priority for booking links"),
    ).toHaveValue("2");
  }
});

test("events of another connected calendar stay P1: the control is disabled with a note, and links never offer their time (events-external-priority rule 4, PRI-42)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const other = await secondCalendar(page, cal, "Family");
  await page
    .getByTestId("calendar-list")
    .locator("[data-calendar]", { hasText: "Family" })
    .getByRole("checkbox")
    .check();
  await other.addEvent({ title: "AT-School run", start: at(W, "10:00"), end: at(W, "11:00") });
  await cal.addEvent({ title: "AT-Main call", start: at(W, "14:00"), end: at(W, "15:00") });
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "AT-School run" }).click();
  const control = page.getByTestId("external-priority-fixed");
  await expect(control.getByLabel("Priority for booking links")).toBeDisabled();
  await expect(control.getByLabel("Priority for booking links")).toHaveValue("1");
  await expect(control).toContainText("Events from other calendars stay P1");
  await expect(page.getByTestId("external-priority")).toHaveCount(0);
  // An event on the main calendar can still change.
  await page.locator(".ev-external", { hasText: "AT-Main call" }).click();
  await expect(
    page.getByTestId("external-priority").getByLabel("Priority for booking links"),
  ).toBeEnabled();

  await claimPage(page, "otto");
  const v = await visitor(browser);
  await v.goto("/book/otto/important-meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "10:00"))).toHaveCount(0);
  await expect(slot(v, at(W, "11:00"))).toBeVisible();
  await page.reload();
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "AT-School run" }).click();
  await expect(
    page.getByTestId("external-priority-fixed").getByLabel("Priority for booking links"),
  ).toBeDisabled();
});

test("flexible meetings use meeting hours: a change there moves the meeting, and tasks keep work hours (HRS-1, HRS-7)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("AT-Sync");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="AT-Sync"]')).toBeVisible();
  await addTask(page, { title: "AT-Work", minutes: 60, split: false, due: "" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Sync").map(span)).toEqual([`${day(1)} 10:00-10:30`]);
      expect(titled(l, "AT-Work").map(span)).toEqual([`${W} 09:00-10:00`]);
    },
  );

  await openSettings(page);
  const meeting = page.getByTestId("hours-meeting");
  await setRange(meeting, "range-meeting-1-0", "14:00", "16:00");
  await meeting.getByRole("button", { name: "Copy to all" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Sync").map(span)).toEqual([`${day(1)} 14:00-14:30`]);
      expect(titled(l, "AT-Work").map(span)).toEqual([`${W} 09:00-10:00`]);
    },
  );
  await page.reload();
  for (const d of [1, 2, 3, 4, 5]) {
    const r = page.getByTestId("hours-meeting").getByTestId(`range-meeting-${d}-0`);
    await expect(r.locator("input").first()).toHaveValue("14:00");
    await expect(r.locator("input").last()).toHaveValue("16:00");
  }
});

test("a day can have several ranges and copy to all copies them to every day that is on; chunks never span the gap (HRS-2, HRS-3, HRS-4, HRS-5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday is full, so the first chunks fall on Tuesday.
  await cal.addEvent({ title: "Offsite", start: at(W, "09:00"), end: at(W, "17:00") });
  await signIn();
  await openSettings(page);
  const work = page.getByTestId("hours-work");
  await setRange(work, "range-work-1-0", "09:00", "12:00");
  await work.locator(".hours-day").first().getByRole("button", { name: "+" }).click();
  await setRange(work, "range-work-1-1", "13:00", "17:00");
  // HRS-6: copy to all saves at once, with no press on the save button.
  const saved1 = page.waitForResponse(
    (r) => r.request().method() === "PUT" && r.url().includes("/api/hours/"),
  );
  await work.getByRole("button", { name: "Copy to all" }).click();
  expect((await saved1).status()).toBe(200);
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  const saved = page.getByTestId("hours-work");
  for (const d of [1, 2, 3, 4, 5]) {
    await expect(saved.getByTestId(`range-work-${d}-0`).locator("input").last()).toHaveValue(
      "12:00",
    );
    await expect(saved.getByTestId(`range-work-${d}-1`).locator("input").first()).toHaveValue(
      "13:00",
    );
  }
  // Saturday and Sunday were off and stay off.
  await expect(saved.getByTestId("range-work-6-0")).toHaveCount(0);
  await expect(saved.getByTestId("range-work-7-0")).toHaveCount(0);
  // HRS-5: the source is the first day in the list, Monday. Personal hours
  // with Monday off and other hours on Tuesday have nothing to copy.
  const personal = page.getByTestId("hours-personal");
  const mondayP = personal.locator(".hours-day").first();
  while ((await mondayP.locator(".range").count()) > 0)
    await mondayP.locator(".range").first().getByRole("button", { name: "−" }).click();
  await setRange(personal, "range-personal-2-0", "06:00", "07:00");
  await expect(personal.getByRole("button", { name: "Copy to all" })).toBeDisabled();
  await page.reload();

  await addTask(page, { title: "AT-Ranges", minutes: 420, min: 60, max: 240, due: "" });
  const evs = await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "AT-Ranges").reduce((a, e) => a + (e.end - e.start), 0)).toBe(420 * MIN),
  );
  for (const e of titled(evs, "AT-Ranges")) {
    expect(
      inHours(e.start, e.end, "09:00", "12:00") || inHours(e.start, e.end, "13:00", "17:00"),
    ).toBe(true);
  }
  expect(titled(evs, "AT-Ranges")[0] && span(titled(evs, "AT-Ranges")[0] as Evs[number])).toBe(
    `${day(1)} 09:00-12:00`,
  );
});

test("a chunk moved in the calendar leaves its old time closed to that task only (CED-10)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Mover", minutes: 120, min: 30, max: 60, due: "" });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Mover")).toHaveLength(2),
  );
  const [, second] = titled(placed, "AT-Mover");
  if (!second) throw new Error("no second chunk");
  const old = { start: second.start, end: second.end };
  // The user drags the second chunk to 15:00 in the calendar app.
  await cal.update(second.id, { start: at(W, "15:00"), end: at(W, "16:00") });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Mover").map(span)).toContain(`${W} 15:00-16:00`),
  );

  // More work for the same task avoids the old time; another task may use it.
  await page.getByRole("link", { name: "Tasks" }).click();
  await page
    .locator('[data-task-title="AT-Mover"]')
    .getByRole("button", { name: "+30 min" })
    .click();
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Mover").reduce((a, e) => a + (e.end - e.start), 0)).toBe(150 * MIN),
  );
  await addTask(page, { title: "AT-Other", minutes: 60, split: false, due: "", level: 4 });
  // The other task takes the first free time, which is inside the old time.
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Other")).toHaveLength(1);
      expect(overlaps(titled(l, "AT-Other")[0] as Evs[number], old.start, old.end)).toBe(true);
    },
  );
  for (const e of titled(evs, "AT-Mover")) expect(overlaps(e, old.start, old.end)).toBe(false);

  // The closed time is stored: after a server restart, with the other task
  // deleted and the old time free, more work still goes elsewhere.
  await app.restart();
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await page
    .locator('[data-task-title="AT-Other"]')
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.locator('[data-task-title="AT-Other"]')).toHaveCount(0);
  await page
    .locator('[data-task-title="AT-Mover"]')
    .getByRole("button", { name: "+30 min" })
    .click();
  await planNow(page);
  const again = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Other")).toHaveLength(0);
      expect(titled(l, "AT-Mover").reduce((a, e) => a + (e.end - e.start), 0)).toBe(180 * MIN);
    },
  );
  for (const e of titled(again, "AT-Mover")) expect(overlaps(e, old.start, old.end)).toBe(false);
});
