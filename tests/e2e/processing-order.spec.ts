// The processing order across item kinds (planning-scheduler.md "Processing
// order", SCH-61 to SCH-74). Each test builds a week with one free hour per
// day, so the item that the scheduler takes first gets that hour; a wrong
// order gives a different placement.
//
// Ways this can fail, and the test that catches each:
// - a locked chunk or a booked meeting is placed as a demand, so a P1 task
//   created later takes its time (fixed test)
// - next-up tasks go before P1 habits or P1 flexible meetings, or after P2
//   automations (next-up test)
// - focus time goes before a habit, a flexible meeting or a buffer of P4
//   (focus test)
// - a new automation goes to the end of its level instead of after the last
//   automation of the same or an earlier kind (kind order test)
// - tasks of one level go in creation order instead of by due date, then
//   more remaining minutes, then the older task (task key test)
// - a buffer moved to another level lands before the habits there instead of
//   at the end of the level (level change test)
// - the occurrences of one habit are placed in another order than their
//   dates (one item test)
import type { Page } from "@playwright/test";
import { day, span, week } from "./automation-helpers.ts";
import { create, edit, group, names, openAutomations, save } from "./automation-list-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  planNow,
  test,
} from "./fixtures.ts";
import {
  addHabit,
  addTask,
  book,
  claimPage,
  openEvent,
  openWeek,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";

test.skip(BACKEND === "google", "The order is the same on both backends; CalDAV proves it.");

type Evs = Awaited<ReturnType<typeof week>>;
const inWeek = (l: Evs, title: string) => titled(l, title).map(span);

/** Leaves only `from` to `to` free in the work hours of `date`. */
async function onlyFree(cal: CalendarDriver, date: string, from = "13:00", to = "14:00") {
  await cal.addEvent({ title: "E2E busy", start: at(date, "09:00"), end: at(date, from) });
  await cal.addEvent({ title: "E2E busy", start: at(date, to), end: at(date, "17:00") });
}

const LEVEL = { 1: "P1 critical", 2: "P2 high", 3: "P3 medium", 4: "P4 low" } as const;

/** A flexible meeting with one guest on one day, removed when there is no time. */
async function addMeeting(
  page: Page,
  m: { title: string; level: 1 | 2 | 3 | 4; day: "Mon" | "Tue" | "Wed" },
) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByLabel("Ideal time").fill("13:00");
  await form.getByLabel("Duration (minutes)").fill("60");
  await form.getByLabel("Priority").selectOption({ label: LEVEL[m.level] });
  await form
    .getByLabel("When there is no time")
    .selectOption({ label: "Remove it for that period" });
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    await form.getByLabel(d, { exact: true }).setChecked(d === m.day);
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator(`[data-meeting-title="${m.title}"]`)).toBeVisible();
}

/** A recovery buffer after (or before) meetings with other people, 60 minutes by default. */
async function addBuffer(
  page: Page,
  title: string,
  level: 1 | 2 | 3 | 4,
  side: "After" | "Before" = "After",
  minutes = 60,
) {
  const form = await create(page, "Buffer");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Priority").selectOption({ label: LEVEL[level] });
  await form.getByLabel("Side").selectOption({ label: side });
  await form
    .getByLabel(side === "After" ? "After the event (minutes)" : "Before the event (minutes)")
    .fill(String(minutes));
  await form.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await save(form);
}

test("locked chunks and booked meetings are in place before any demand: a P1 task created later does not take their time (SCH-61)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue, wed] = [W, day(1), day(2)];
  await onlyFree(cal, mon);
  await onlyFree(cal, tue);
  await signIn();

  await addTask(page, { title: "AT-Locked", minutes: 60, split: false, due: "", level: 3 });
  await eventually(
    () => week(cal),
    (l) => expect(inWeek(l, "AT-Locked")).toEqual([`${mon} 13:00-14:00`]),
  );
  await openWeek(page);
  await openEvent(page, "AT-Locked");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Locked")[0]?.summary).toBe("🔒 AT-Locked"),
  );

  // A P2 link offers the time of a P3 task; the booking takes it.
  await addTask(page, { title: "AT-Low", minutes: 60, split: false, due: "", level: 3 });
  await eventually(
    () => week(cal),
    (l) => expect(inWeek(l, "AT-Low")).toEqual([`${tue} 13:00-14:00`]),
  );
  await claimPage(page, "order");
  const v = await visitor(browser);
  await v.goto("/book/order/meeting");
  await expect(slot(v, at(tue, "13:00"))).toBeVisible();
  await book(v, at(tue, "13:00"), "Bo Booker", "bo@example.com");
  const booked = (l: Evs) =>
    l.filter((e) => e.start === at(tue, "13:00") && e.privateProps.tl_booking === "1").length;
  await eventually(
    () => week(cal),
    (l) => {
      expect(booked(l)).toBe(1);
      expect(inWeek(l, "AT-Low")).toEqual([`${wed} 09:00-10:00`]);
    },
  );

  // A P1 task goes before every P3 demand, but not before fixed things.
  await addTask(page, { title: "AT-Top", minutes: 60, split: false, due: "", level: 1 });
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-Locked")).toEqual([`${mon} 13:00-14:00`]);
    expect(booked(l)).toBe(1);
    expect(inWeek(l, "AT-Top")).toEqual([`${wed} 09:00-10:00`]);
    expect(inWeek(l, "AT-Low")).toEqual([`${wed} 10:00-11:00`]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev", { hasText: "AT-Top" }).first()).toBeVisible();
  check(await week(cal));
});

test("P1 habits and P1 flexible meetings go before next-up tasks; P2 habits go after them (SCH-67, SCH-70)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue, wed] = [W, day(1), day(2)];
  await onlyFree(cal, mon);
  await onlyFree(cal, tue);
  await signIn();

  await addTask(page, {
    title: "AT-Now",
    minutes: 60,
    split: false,
    due: "",
    level: 4,
    nextUp: true,
  });
  await eventually(
    () => week(cal),
    (l) => expect(inWeek(l, "AT-Now")).toEqual([`${mon} 13:00-14:00`]),
  );

  await addHabit(page, {
    title: "AT-Lunch",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 1,
    days: ["Mon"],
    noRoom: "Remove that day",
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Lunch")).toEqual([`${mon} 13:00-14:00`]);
      expect(inWeek(l, "AT-Now")).toEqual([`${tue} 13:00-14:00`]);
    },
  );

  await addMeeting(page, { title: "AT-Sync", level: 1, day: "Tue" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Sync")).toEqual([`${tue} 13:00-14:00`]);
      expect(inWeek(l, "AT-Now")).toEqual([`${wed} 09:00-10:00`]);
    },
  );

  // A P2 habit that wants the same hour gives way to the next-up task.
  await addHabit(page, {
    title: "AT-Walk",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Wed"],
    noRoom: "Remove that day",
  });
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-Lunch")).toEqual([`${mon} 13:00-14:00`]);
    expect(inWeek(l, "AT-Sync")).toEqual([`${tue} 13:00-14:00`]);
    expect(inWeek(l, "AT-Now")).toEqual([`${wed} 09:00-10:00`]);
    expect(inWeek(l, "AT-Walk")).toEqual([`${wed} 10:00-11:00`]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  check(await week(cal));
});

test("focus time goes after habits, flexible meetings and buffers, also of P4 (SCH-68)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue, wed, thu, fri] = [W, day(1), day(2), day(3), day(4)];
  // Monday to Thursday have one free hour each, 13:00 to 14:00; on Wednesday a
  // meeting with a guest ends at 13:00, so a recovery buffer wants that hour.
  await onlyFree(cal, mon);
  await onlyFree(cal, tue);
  await cal.addEvent({ title: "E2E busy", start: at(wed, "09:00"), end: at(wed, "12:00") });
  await cal.addEvent({
    title: "AT-Call",
    start: at(wed, "12:00"),
    end: at(wed, "13:00"),
    attendees: ["ana@example.com"],
  });
  await cal.addEvent({ title: "E2E busy", start: at(wed, "14:00"), end: at(wed, "17:00") });
  await onlyFree(cal, thu);
  await cal.addEvent({ title: "E2E busy", start: at(fri, "09:00"), end: at(fri, "17:00") });
  await signIn();

  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("AT-Focus");
  await focus.getByLabel("Weekly goal (hours)").fill("4");
  await focus.getByLabel("Daily maximum (hours)").fill("1");
  await focus.getByLabel("Shortest block (minutes)").fill("60");
  await focus.getByLabel("Longest block (minutes)").fill("60");
  await save(focus);
  await eventually(
    () => week(cal),
    (l) =>
      expect(inWeek(l, "AT-Focus")).toEqual([
        `${mon} 13:00-14:00`,
        `${tue} 13:00-14:00`,
        `${wed} 13:00-14:00`,
        `${thu} 13:00-14:00`,
      ]),
  );

  await addHabit(page, {
    title: "AT-Habit",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 4,
    days: ["Mon"],
    noRoom: "Remove that day",
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Habit")).toEqual([`${mon} 13:00-14:00`]);
      expect(inWeek(l, "AT-Focus")).toEqual([
        `${tue} 13:00-14:00`,
        `${wed} 13:00-14:00`,
        `${thu} 13:00-14:00`,
      ]);
    },
  );

  await addMeeting(page, { title: "AT-Meeting", level: 4, day: "Tue" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Meeting")).toEqual([`${tue} 13:00-14:00`]);
      expect(inWeek(l, "AT-Focus")).toEqual([`${wed} 13:00-14:00`, `${thu} 13:00-14:00`]);
    },
  );

  await addBuffer(page, "AT-Recovery", 4);
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-Habit")).toEqual([`${mon} 13:00-14:00`]);
    expect(inWeek(l, "AT-Meeting")).toEqual([`${tue} 13:00-14:00`]);
    expect(inWeek(l, "AT-Recovery")).toEqual([`${wed} 13:00-14:00`]);
    expect(inWeek(l, "AT-Focus")).toEqual([`${thu} 13:00-14:00`]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await openAutomations(page);
  await expect(group(page, 4).locator('[data-name="AT-Focus"]')).toBeVisible();
  check(await week(cal));
});

test("a new automation goes after the last one of its level whose kind comes first: flexible meetings, then buffers, then habits (SCH-71)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue, wed] = [W, day(1), day(2)];
  await onlyFree(cal, mon);
  await onlyFree(cal, tue);
  // A buffer before the call: buffers-automation rule 18 lets a habit with no
  // other slot take the time of a recovery buffer (after side) only.
  await cal.addEvent({ title: "E2E busy", start: at(wed, "09:00"), end: at(wed, "13:00") });
  await cal.addEvent({
    title: "AT-Call",
    start: at(wed, "14:00"),
    end: at(wed, "15:00"),
    attendees: ["ana@example.com"],
  });
  await cal.addEvent({ title: "E2E busy", start: at(wed, "15:00"), end: at(wed, "17:00") });
  // Thursday and Friday are full, so the habit has no other day in the week.
  for (const d of [day(3), day(4)])
    await cal.addEvent({ title: "E2E busy", start: at(d, "09:00"), end: at(d, "17:00") });
  await signIn();

  await addHabit(page, {
    title: "AT-Habit",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Mon", "Tue", "Wed"],
    noRoom: "Remove that day",
  });
  await eventually(
    () => week(cal),
    (l) =>
      expect(inWeek(l, "AT-Habit")).toEqual([
        `${mon} 13:00-14:00`,
        `${tue} 13:00-14:00`,
        `${wed} 13:00-14:00`,
      ]),
  );
  await addMeeting(page, { title: "AT-First", level: 2, day: "Mon" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-First")).toEqual([`${mon} 13:00-14:00`]);
      expect(inWeek(l, "AT-Habit")).toEqual([`${tue} 13:00-14:00`, `${wed} 13:00-14:00`]);
    },
  );
  // The second meeting goes after the first one, so before the older habit.
  await addMeeting(page, { title: "AT-Second", level: 2, day: "Tue" });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Second")).toEqual([`${tue} 13:00-14:00`]);
      expect(inWeek(l, "AT-Habit")).toEqual([`${wed} 13:00-14:00`]);
    },
  );
  await addBuffer(page, "AT-Recovery", 2, "Before");
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-First")).toEqual([`${mon} 13:00-14:00`]);
    expect(inWeek(l, "AT-Second")).toEqual([`${tue} 13:00-14:00`]);
    expect(inWeek(l, "AT-Recovery")).toEqual([`${wed} 13:00-14:00`]);
    expect(inWeek(l, "AT-Habit")).toEqual([]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await openAutomations(page);
  await expect
    .poll(() => names(group(page, 2)))
    .toEqual(["AT-First", "AT-Second", "AT-Recovery", "AT-Habit"]);
  check(await week(cal));
});

test("tasks of one level go by due date with no due date last, then more remaining minutes, then the older task (SCH-72, SCH-74)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue] = [W, day(1)];
  // Monday has two free hours, 13:00 to 15:00; Tuesday is free.
  await onlyFree(cal, mon, "13:00", "15:00");
  await signIn();
  const due = `${day(4)}T17:00`;

  await addTask(page, { title: "AT-Short", minutes: 60, split: false, due: "", level: 3 });
  await eventually(
    () => week(cal),
    (l) => expect(inWeek(l, "AT-Short")).toEqual([`${mon} 13:00-14:00`]),
  );
  // Same level, no due date: more remaining minutes go first.
  await addTask(page, { title: "AT-Long", minutes: 120, split: false, due: "", level: 3 });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Long")).toEqual([`${mon} 13:00-15:00`]);
      expect(inWeek(l, "AT-Short")).toEqual([`${tue} 09:00-10:00`]);
    },
  );
  // A due date goes before no due date, whatever the minutes.
  await addTask(page, { title: "AT-Due", minutes: 60, split: false, due, level: 3 });
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Due")).toEqual([`${mon} 13:00-14:00`]);
      expect(inWeek(l, "AT-Short")).toEqual([`${mon} 14:00-15:00`]);
      expect(inWeek(l, "AT-Long")).toEqual([`${tue} 09:00-11:00`]);
    },
  );
  // Same due date and minutes: the older task goes first.
  await addTask(page, { title: "AT-Twin", minutes: 60, split: false, due, level: 3 });
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-Due")).toEqual([`${mon} 13:00-14:00`]);
    expect(inWeek(l, "AT-Twin")).toEqual([`${mon} 14:00-15:00`]);
    expect(inWeek(l, "AT-Long")).toEqual([`${tue} 09:00-11:00`]);
    expect(inWeek(l, "AT-Short")).toEqual([`${tue} 11:00-12:00`]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await expect(page.locator('[data-task-title="AT-Twin"]')).toBeVisible();
  check(await week(cal));
});

test("the occurrences of one habit are placed in date order: Monday's takes the free day nearest to it first (SCH-73)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const [mon, tue, wed, thu] = [W, day(1), day(2), day(3)];
  // Monday and Tuesday are full; Wednesday has one free hour; Thursday is free.
  for (const d of [mon, tue])
    await cal.addEvent({ title: "E2E busy", start: at(d, "09:00"), end: at(d, "17:00") });
  await onlyFree(cal, wed);
  await signIn();

  // Both occurrences go to another day of the week; the nearest free day of
  // both is Wednesday. Monday's occurrence comes first, so it gets Wednesday.
  await addHabit(page, {
    title: "AT-Weekly",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 3,
    days: ["Mon", "Tue"],
    noRoom: "Remove that day",
  });
  const check = (l: Evs) => {
    const evs = titled(l, "AT-Weekly");
    expect(evs.map(span)).toEqual([`${wed} 13:00-14:00`, `${thu} 13:00-14:00`]);
    expect(evs.map((e) => e.privateProps.tl_key?.split(":").at(-1))).toEqual([mon, tue]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await expect(page.locator('[data-habit-title="AT-Weekly"]')).toBeVisible();
  check(await week(cal));
});

test("a buffer moved to another level goes to the end of that level, after its habits (automations-overview rule 7)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const wed = day(2);
  // Only Wednesday 13:00 to 14:00 is free, after a meeting with a guest.
  for (const d of [W, day(1), day(3), day(4)])
    await cal.addEvent({ title: "E2E busy", start: at(d, "09:00"), end: at(d, "17:00") });
  await cal.addEvent({ title: "E2E busy", start: at(wed, "09:00"), end: at(wed, "12:00") });
  await cal.addEvent({
    title: "AT-Call",
    start: at(wed, "12:00"),
    end: at(wed, "13:00"),
    attendees: ["ana@example.com"],
  });
  await cal.addEvent({ title: "E2E busy", start: at(wed, "14:00"), end: at(wed, "17:00") });
  await signIn();

  // P2 holds a buffer, then a habit; a P3 buffer wants the habit's hour.
  await addBuffer(page, "AT-Prep", 2, "Before", 15);
  await addHabit(page, {
    title: "AT-Habit",
    ideal: "13:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Wed"],
    noRoom: "Remove that day",
  });
  await addBuffer(page, "AT-Moved", 3);
  await eventually(
    () => week(cal),
    (l) => {
      expect(inWeek(l, "AT-Habit")).toEqual([`${wed} 13:00-14:00`]);
      expect(inWeek(l, "AT-Moved")).toEqual([]);
    },
  );

  const moved = await edit(page, "AT-Moved");
  await moved.getByLabel("Priority").selectOption({ label: LEVEL[2] });
  await save(moved);
  await expect.poll(() => names(group(page, 2))).toEqual(["AT-Prep", "AT-Habit", "AT-Moved"]);
  await planNow(page);
  const check = (l: Evs) => {
    expect(inWeek(l, "AT-Habit")).toEqual([`${wed} 13:00-14:00`]);
    expect(inWeek(l, "AT-Moved")).toEqual([]);
  };
  await eventually(() => week(cal), check);
  await page.reload();
  await openAutomations(page);
  await expect.poll(() => names(group(page, 2))).toEqual(["AT-Prep", "AT-Habit", "AT-Moved"]);
  await planNow(page);
  check(await week(cal));
});
