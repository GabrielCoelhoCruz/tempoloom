// Habit rules (docs/specs/habits-automation.md): hours sets and one-off
// windows, custom frequencies, a weekly occurrence that moves to another day,
// adaptive free to busy, lock and unlock of one occurrence, and per-habit
// progress on the stats page (analytics-personal-stats.md).
//
// Ways it can fail, and the check that catches each:
// - a habit on a named hours set is placed in work hours, or a change of its
//   hours keeps the old events                              -> evening times, then work times
// - "every 2 days" or "every 2 weeks" places every day or every week
//                                                          -> exact event dates
// - the custom frequency is lost on reload or on an edit    -> list text after reload and edit
// - a weekly occurrence with no room is dropped or moved to a day of another week
//                                                          -> the Monday event
// - an adaptive habit is busy while it has room, or stays free when it has none
//                                                          -> transparency and marker per day
// - lock from the planner does not hold the time, or unlock does not free it
//                                                          -> lock marker, start after a clash, start after unlock
// - stats show no per-habit numbers, or count other habits  -> progress rows per habit
import { addDays } from "../../src/shared/time.ts";
import { day, span, week } from "./automation-helpers.ts";
import { edit, save } from "./automation-list-helpers.ts";
import { at, blockUntil, eventually, expect, local, managed, test } from "./fixtures.ts";
import { addHabit, inHours, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";

const dates = (evs: { start: number }[]) => evs.map((e) => local(e.start).slice(0, 10));

test("a habit uses a named hours set or its own window, and a change of hours moves its events (rules 9-10; hours concept)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Guitar",
    ideal: "19:00",
    min: 60,
    max: 60,
    hours: "Personal hours",
  });
  await expect(page.locator('[data-habit-title="Guitar"]')).toContainText("ideal 19:00");
  const evening = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Guitar")).toHaveLength(7),
  );
  for (const e of titled(evening, "Guitar")) expect(span(e).slice(11)).toBe("19:00-20:00");

  // The shared form changes the hours to work hours: the events move there.
  const form = await edit(page, "Guitar");
  await form.getByLabel("Hours").selectOption({ label: "Work hours" });
  await form.getByLabel("Ideal time").fill("16:00");
  await save(form);
  const work = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Guitar")).toHaveLength(5);
      for (const e of titled(l, "Guitar")) expect(span(e).slice(11)).toBe("16:00-17:00");
    },
  );
  expect(dates(titled(work, "Guitar"))).toEqual([W, day(1), day(2), day(3), day(4)]);
  await page.reload();
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Guitar"]')).toContainText("ideal 16:00");
  for (const e of titled(await week(cal), "Guitar")) expect(inHours(e.start, e.end)).toBe(true);
});

test("a custom frequency places a habit every N days or every N weeks on its days (Frequency: custom)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Plants");
  await form.getByLabel("Ideal time").fill("09:00");
  await form.getByLabel("Shortest (minutes)").fill("30");
  await form.getByLabel("Longest (minutes)").fill("30");
  await form.getByLabel("Starting").fill(W);
  await form.getByLabel("Interval").fill("2");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Plants"]')).toContainText("every 2 days");

  await form.getByLabel("Title").fill("Retro");
  await form.getByLabel("Ideal time").fill("15:00");
  await form.getByLabel("Shortest (minutes)").fill("60");
  await form.getByLabel("Longest (minutes)").fill("60");
  await form.getByLabel("Starting").fill(W);
  await form.getByLabel("Tue", { exact: true }).check();
  await form.getByLabel("Interval").fill("2");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Retro"]')).toContainText("every 2 weeks on Tue");

  const twoWeeks = () => cal.events(at(W, "00:00"), at(addDays(W, 14), "00:00"));
  // Every 2 days from Monday: Mon, Wed, Fri; Sunday has no work hours; then Tue and Thu.
  const expected = [W, day(2), day(4), day(8), day(10)];
  await eventually(twoWeeks, (l) => {
    expect(dates(titled(l, "Plants"))).toEqual(expected);
    expect(dates(titled(l, "Retro"))).toEqual([day(1)]);
  });
  await page.reload();
  await expect(page.locator('[data-habit-title="Plants"]')).toContainText("every 2 days");
  await expect(page.locator('[data-habit-title="Retro"]')).toContainText("every 2 weeks on Tue");

  // An edit in the shared form keeps the custom frequency.
  const shared = await edit(page, "Retro");
  await expect(shared.getByLabel("Interval")).toHaveValue("2");
  await shared.getByLabel("Ideal time").fill("16:00");
  await save(shared);
  await eventually(twoWeeks, (l) => {
    expect(titled(l, "Retro").map(span)).toEqual([`${day(1)} 16:00-17:00`]);
    expect(dates(titled(l, "Plants"))).toEqual(expected);
  });
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Retro"]')).toContainText("every 2 weeks on Tue");
});

test("a weekly occurrence with no room on its day moves to the nearest other day of that week (rule 14)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Offsite", start: at(day(1), "08:00"), end: at(day(1), "18:00") });
  await signIn();
  await addHabit(page, { title: "Review", ideal: "15:00", min: 60, max: 60, days: ["Tue"] });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Review")).toHaveLength(1),
  );
  expect(titled(evs, "Review").map(span)).toEqual([`${W} 15:00-16:00`]);
  await page.reload();
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Review").map(span)).toEqual([`${W} 15:00-16:00`]);
  // The next week has room on Tuesday again.
  const next = await cal.events(at(day(7), "00:00"), at(day(14), "00:00"));
  expect(dates(titled(next, "Review"))).toEqual([day(8)]);
});

test("an adaptive habit is free while it has room and turns busy when the calendar fills (rules 21-22, DEF-20)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  await expect(page.locator('[data-habit-title="Lunch"]')).toContainText(
    "Free until time gets short",
  );
  const before = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  for (const e of titled(before, "Lunch")) {
    expect(e.busy).toBe(false);
    expect(e.summary).toBe("○ Lunch");
  }
  // Wednesday fills up: one legal slot is left, so that occurrence turns busy.
  const wed = day(2);
  await cal.addEvent({ title: "Workshop", start: at(wed, "09:00"), end: at(wed, "16:00") });
  const after = await eventually(
    () => week(cal),
    (l) => {
      const w = titled(l, "Lunch").find((e) => local(e.start).startsWith(wed));
      expect(w && span(w)).toBe(`${wed} 16:00-17:00`);
      expect(w?.busy).toBe(true);
      expect(w?.summary).toBe("● Lunch");
    },
  );
  for (const e of titled(after, "Lunch").filter((x) => !local(x.start).startsWith(wed))) {
    expect(e.busy).toBe(false);
  }
  await page.reload();
  await page.waitForTimeout(6000);
  const w = titled(await week(cal), "Lunch").find((e) => local(e.start).startsWith(wed));
  expect(w?.summary).toBe("● Lunch");
});

test("lock and unlock one habit occurrence from the planner (rule 26, LCK-10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Stretch", ideal: "10:00", min: 30, max: 30, days: ["Mon"] });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Stretch").map(span)).toEqual([`${W} 10:00-10:30`]),
  );
  const at0 = titled(placed, "Stretch")[0]?.start ?? 0;
  await openWeek(page);
  await openEvent(page, "Stretch");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  const locked = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Stretch")[0]?.summary).toBe("🔒 Stretch"),
  );
  expect(titled(locked, "Stretch")[0]?.busy).toBe(true);
  // A meeting over the locked occurrence does not move it.
  await cal.addEvent({ title: "Clash", start: at0, end: at0 + 30 * MIN });
  await page.waitForTimeout(6500);
  expect(titled(await week(cal), "Stretch")[0]?.start).toBe(at0);
  await page.reload();
  await openEvent(page, "Stretch");
  await expect(
    page.getByTestId("event-drawer").getByRole("button", { name: "Unlock" }),
  ).toBeVisible();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Unlock" }).click();
  await eventually(
    () => week(cal),
    (l) => {
      const [s] = titled(l, "Stretch");
      expect(s && (s.start >= at0 + 30 * MIN || s.end <= at0)).toBe(true);
      expect(s?.summary.startsWith("🔒")).toBe(false);
    },
  );
});

test("the stats page shows each habit's progress: done and planned occurrences and hours (habit analytics)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Before W the blocker leaves no room: "Remove that day" keeps those days empty.
  const noRoom = "Remove that day" as const;
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60, noRoom });
  await addHabit(page, {
    title: "Walk",
    ideal: "16:00",
    min: 30,
    max: 30,
    days: ["Tue", "Thu"],
    noRoom,
  });
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Lunch")).toHaveLength(5);
      expect(titled(l, "Walk")).toHaveLength(2);
    },
  );
  // The user did Monday's lunch yesterday instead, and moves it there in the calendar.
  const [monday] = titled(evs, "Lunch");
  if (!monday) throw new Error("no Monday lunch");
  const yesterday = addDays(local(Date.now()).slice(0, 10), -1);
  await cal.update(monday.id, { start: at(yesterday, "12:00"), end: at(yesterday, "13:00") });
  await eventually(
    () => cal.events(at(yesterday, "00:00"), at(day(7), "00:00")),
    (l) => expect(managed(l).find((e) => e.id === monday.id)?.summary).toBe("✅ Lunch"),
  );
  await page.goto(`/stats?from=${yesterday}&to=${day(6)}`);
  const lunch = page.locator('[data-habit-progress="Lunch"]');
  const walk = page.locator('[data-habit-progress="Walk"]');
  await expect(lunch).toContainText("1 of 5 done");
  await expect(lunch).toContainText("5 h");
  await expect(walk).toContainText("0 of 2 done");
  await expect(walk).toContainText("1 h");
  await page.reload();
  await expect(lunch).toContainText("1 of 5 done");
  // A range of the test week only: the moved lunch is outside it.
  await page.goto(`/stats?from=${W}&to=${day(6)}`);
  await expect(lunch).toContainText("0 of 4 done");
  await expect(lunch).toContainText("4 h");
});
