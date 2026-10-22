// Task calendar per hours set (docs/specs/accounts-connected-calendars.md
// rules 19, 21; AT-6): chunks of a task go to the task calendar of the hours
// set the task uses; other sets keep the main calendar.
//
// Ways it can fail, and the check that catches each:
// - the choice is not offered, not saved, or lost on reload    -> select value after reload
// - chunks ignore the set's task calendar                      -> chunk on "Tasks", not on Work
// - one set's choice leaks to another set                      -> work-hours task stays on Work
// - chunks on a secondary calendar stop holding their time     -> the habit keeps away from the chunk
// - chunks on a secondary calendar still block other people    -> link offers the time; colleague's meeting takes it
// - a locked chunk on a secondary calendar is open to bookings -> the link stops offering the time after Lock
//   (a booking there would overlap a chunk that never moves, LCK-1, LCK-2)

import { addDays } from "../../src/shared/time.ts";
import { openSettings } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, EMAIL, eventually, expect, local, test } from "./fixtures.ts";
import {
  addHabit,
  addTask,
  allEvents,
  claimPage,
  inHours,
  openEvent,
  openWeek,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "The test adds a second CalDAV calendar.");

test("tasks on personal hours go to that set's task calendar; work-hours tasks stay on the main calendar (rule 21, AT-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const tasks = await cal.newCalendar("Tasks");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Tasks");
  await page.reload();

  const pick = (kind: string) =>
    page.getByTestId(`hours-${kind}`).getByLabel("Calendar for task chunks");
  await expect(pick("personal")).toHaveValue("");
  await pick("personal").selectOption({ label: "Tasks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(pick("personal").locator("option:checked")).toHaveText("Tasks");
  await expect(pick("work")).toHaveValue("");

  await addTask(page, {
    title: "AT-Evening",
    minutes: 60,
    split: false,
    due: "",
    hours: "Personal hours",
  });
  await addTask(page, {
    title: "AT-Day",
    minutes: 60,
    split: false,
    due: "",
    hours: "Work hours",
  });
  const onTasks = await eventually(
    () => allEvents(tasks),
    (l) => expect(titled(l, "AT-Evening")).toHaveLength(1),
  );
  const [chunk] = titled(onTasks, "AT-Evening");
  expect(inHours(chunk?.start ?? 0, chunk?.end ?? 0, "18:00", "22:00")).toBe(true);
  expect(titled(onTasks, "AT-Day")).toHaveLength(0);
  const onWork = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Day")).toHaveLength(1),
  );
  expect(titled(onWork, "AT-Evening")).toHaveLength(0);

  await page.reload();
  await openSettings(page);
  await expect(pick("personal").locator("option:checked")).toHaveText("Tasks");
  expect(titled(await allEvents(tasks), "AT-Evening")).toHaveLength(1);
});

test("task chunks on a secondary calendar hold their time against other items but leave it open to booking links and colleagues' meetings (DEF-50)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const other = await colleague.signIn();
  await signIn();
  const tasks = await cal.newCalendar("Tasks");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Tasks");
  await page.reload();
  const pick = page.getByTestId("hours-work").getByLabel("Calendar for task chunks");
  await pick.selectOption({ label: "Tasks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  // A P1 task due Monday 10:00 has one possible hour, so its chunk is busy.
  const nine = at(W, "09:00");
  const range = (c: typeof cal) => c.events(at(W, "00:00"), at(addDays(W, 1), "00:00"));
  const span = (e: { start: number; end: number }) => `${local(e.start)}-${local(e.end).slice(11)}`;
  const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
    a.start < b.end && a.end > b.start;
  await addTask(page, {
    title: "DEF-Report",
    minutes: 60,
    split: false,
    due: `${W}T10:00`,
    level: 1,
  });
  const placed = await eventually(
    () => range(tasks),
    (l) => expect(titled(l, "DEF-Report").map(span)).toEqual([`${W} 09:00-10:00`]),
  );
  expect(titled(placed, "DEF-Report")[0]?.busy).toBe(true);
  expect(titled(await range(cal), "DEF-Report")).toHaveLength(0);

  // The chunk still holds its time in the user's own plan: a habit that wants 09:00 keeps away.
  await addHabit(page, {
    title: "DEF-Walk",
    ideal: "09:00",
    min: 30,
    max: 30,
    level: 3,
    days: ["Mon"],
  });
  await eventually(
    () => range(cal),
    (l) => expect(titled(l, "DEF-Walk").map(span)).toEqual([`${W} 10:00-10:30`]),
  );

  // Other people see main-calendar availability: the user's booking link offers the chunk's time.
  await claimPage(page, "def-fifty");
  const v = await visitor(browser);
  await v.goto("/book/def-fifty/meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, nine)).toBeVisible();

  // A colleague's flexible meeting with the user takes the chunk's time; the chunk moves.
  // It starts in the test week: an occurrence in the rest of the real week
  // (a Friday run) would push Monday's away (cadence, meetings-flexible.md rule 18).
  await addMeeting(other, {
    title: "DEF-Sync",
    guests: EMAIL,
    idealTime: "09:00",
    days: ["Mon"],
    more: (form) => form.getByLabel("Starting").fill(W),
  });
  await eventually(
    () => range(colleague.cal),
    (l) => expect(titled(l, "DEF-Sync").map(span)).toEqual([`${W} 09:00-09:30`]),
  );
  const sync = { start: nine, end: at(W, "09:30") };
  await eventually(
    () => range(tasks),
    (l) => {
      const [chunk] = titled(l, "DEF-Report");
      expect(chunk).toBeDefined();
      expect(overlap(chunk ?? sync, sync)).toBe(false);
    },
  );

  await page.reload();
  await openSettings(page);
  await expect(pick.locator("option:checked")).toHaveText("Tasks");
  const mine = await range(cal);
  const [chunk] = titled(await range(tasks), "DEF-Report");
  for (const walk of titled(mine, "DEF-Walk")) expect(overlap(walk, chunk ?? sync)).toBe(false);
});

test("a locked task chunk on a secondary calendar blocks booking links like any locked event (DEF-50, LCK-1)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const tasks = await cal.newCalendar("Tasks");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Tasks");
  await page.reload();
  await page
    .getByTestId("hours-work")
    .getByLabel("Calendar for task chunks")
    .selectOption({ label: "Tasks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  const nine = at(W, "09:00");
  const range = () => tasks.events(at(W, "00:00"), at(addDays(W, 1), "00:00"));
  await addTask(page, {
    title: "DEF-Locked",
    minutes: 60,
    split: false,
    due: `${W}T10:00`,
    level: 1,
  });
  await eventually(range, (l) =>
    expect(titled(l, "DEF-Locked").map((e) => e.start)).toEqual([nine]),
  );

  // Unlocked, the chunk leaves the time open to the link (the rule above).
  await claimPage(page, "def-locked");
  const v = await visitor(browser);
  await v.goto("/book/def-locked/meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, nine)).toBeVisible();

  await openWeek(page);
  await openEvent(page, "DEF-Locked");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(range, (l) =>
    expect(titled(l, "DEF-Locked")[0]?.summary).toBe("\u{1F512} DEF-Locked"),
  );
  // Locked, it never moves, so the link must not offer its time.
  await eventually(
    async () => {
      await v.reload();
      await expect(v.getByTestId("times")).toBeVisible();
      return slot(v, nine).count();
    },
    (n) => expect(n).toBe(0),
  );
  expect(titled(await range(), "DEF-Locked").map((e) => e.start)).toEqual([nine]);
});
