// Task progress: start mode, Start and Stop, past chunks as done work, and
// logged work (docs/specs/planning-task-progress.md PRG-1 to PRG-5, PRG-10,
// PRG-11, PRG-20 to PRG-22; habits-automation.md rules 32 and 33).
// The server clock is set (TEST_CLOCK_START) to days in the test week W, so a
// chunk can begin and end inside the test at any real time of day.
//
// Ways it can fail, and the check that catches each:
// - Start leaves the chunk at its planned time, or makes a second event   -> one event at 09:00
// - Start does not round down to 5 minutes, or cuts the chunk             -> 09:00 to 10:00
// - Stop leaves the chunk to its planned end, or loses the rest          -> end at stop; rest later
// - a passed chunk does not count as done work (auto mode)               -> time-used, event stays
// - a shortened past chunk keeps its old minutes                         -> new chunk with the cut
// - manual mode counts an unstarted chunk, or leaves it in the past      -> moved later that day
// - Start during a chunk in manual mode does not move its start          -> start at now (5 min)
// - start mode skips habit events                                       -> habit moved, then Start
// - logged work is not a past event, or does not reduce the remaining    -> past event; 1 h left
// - logged work can be in the future                                      -> form error
// - logged work over the remaining time leaves future chunks              -> time-used, none left
// - Start with no chunk does nothing, or runs into a busy event           -> 10:00 to 10:30, locked
// - Start on a running chunk moves it (auto mode)                        -> still 10:00
// - Stop right after the start leaves a stub                              -> no event
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import type { AppServer, CalendarDriver } from "./fixtures.ts";
import { at, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addHabit, addTask, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";
import { alwaysHours, chooseSetting } from "./s3-helpers.ts";

/** Wednesday of the test week. */
const D = addDays(W, 2);

/** Restarts the server with its clock at `t`. */
async function clockAt(app: AppServer, t: number): Promise<void> {
  app.env.TEST_CLOCK_START = new Date(t).toISOString();
  await app.restart();
}

const dayEvents = (cal: CalendarDriver, date = D) =>
  cal.events(at(date, "00:00"), localToUtc(ZONE, addDays(date, 1), 0));
const times = (l: Awaited<ReturnType<CalendarDriver["events"]>>, title: string) =>
  titled(l, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

async function taskRow(page: Page, title: string) {
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  const row = page.locator(`[data-task-title="${title}"]`);
  await expect(row).toBeVisible();
  return row;
}

test("Start moves the first chunk to now and Stop ends it now; the rest is placed later (PRG-10, PRG-11)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-P1",
    minutes: 60,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T14:00`,
  });
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-P1")).toEqual([`${D} 14:00-15:00`]),
  );

  // Start at 09:03: the chunk begins at 09:00 and keeps its 60 minutes.
  await clockAt(app, at(D, "09:03"));
  let row = await taskRow(page, "AT-P1");
  await row.getByRole("button", { name: "Start now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-P1")).toEqual([`${D} 09:00-10:00`]),
  );
  row = await taskRow(page, "AT-P1");
  await expect(row.getByTestId("task-started")).toBeVisible();
  // The next plan run keeps it there.
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  expect(times(await dayEvents(cal), "AT-P1")).toEqual([`${D} 09:00-10:00`]);

  // Stop at 09:40: the chunk ends then, and the other 20 minutes go later.
  await clockAt(app, at(D, "09:40"));
  row = await taskRow(page, "AT-P1");
  await row.getByRole("button", { name: "End now" }).click();
  const evs = await eventually(
    () => dayEvents(cal),
    (l) => {
      const [first, rest] = titled(l, "AT-P1");
      expect(titled(l, "AT-P1")).toHaveLength(2);
      expect(first?.start).toBe(at(D, "09:00"));
      expect(first?.end).toBeGreaterThanOrEqual(at(D, "09:40"));
      expect(first?.end).toBeLessThanOrEqual(at(D, "09:42"));
      expect(rest?.start).toBeGreaterThanOrEqual(first?.end ?? 0);
      expect((rest?.end ?? 0) - (rest?.start ?? 0)).toBe(
        60 * MIN - ((first?.end ?? 0) - (first?.start ?? 0)),
      );
    },
  );
  const worked = ((titled(evs, "AT-P1")[0]?.end ?? 0) - at(D, "09:00")) / MIN;
  row = await taskRow(page, "AT-P1");
  await expect(row.getByTestId("task-left")).toHaveText(`${60 - worked} min left`);
});

test("a chunk whose time passed counts as done work, and shortening it in the calendar returns the cut minutes (PRG-1, PRG-2)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "11:50"));
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-P4",
    minutes: 30,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T12:00`,
  });
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-P4")).toEqual([`${D} 12:00-12:30`]),
  );

  // Auto mode (the default): the chunk ends, so its 30 minutes are done work.
  await clockAt(app, at(D, "12:35"));
  let row = await taskRow(page, "AT-P4");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");
  await expect(row.getByTestId("task-left")).toHaveText("0 min left");
  const [ended] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        expect(times(l, "AT-P4")).toEqual([`${D} 12:00-12:30`]);
        expect(titled(l, "AT-P4")[0]?.summary).toContain("✅");
      },
    ),
    "AT-P4",
  );

  // The user shortens the past chunk to 10 minutes: 20 minutes go back to the plan.
  await cal.update(ended?.id ?? "", {
    start: at(D, "12:00"),
    end: at(D, "12:10"),
    summary: ended?.summary ?? "",
  });
  await eventually(
    () => dayEvents(cal),
    (l) => {
      const [past, next] = titled(l, "AT-P4");
      expect(titled(l, "AT-P4")).toHaveLength(2);
      expect(local(past?.end ?? 0)).toBe(`${D} 12:10`);
      expect(next?.start).toBeGreaterThanOrEqual(at(D, "12:35"));
      expect((next?.end ?? 0) - (next?.start ?? 0)).toBe(20 * MIN);
    },
  );
  row = await taskRow(page, "AT-P4");
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-left")).toHaveText("20 min left");
});

test("manual start mode moves an unstarted chunk or habit event later that day, and Start moves a running one to now (PRG-1, PRG-3 to PRG-5)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "11:50"));
  await signIn();
  await alwaysHours(page);
  await chooseSetting(page, "Start mode", "Count only after I press Start");
  await page.reload();
  await expect(page.getByLabel("Start mode")).toHaveValue("manual");
  await addTask(page, {
    title: "AT-P5",
    minutes: 15,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T12:00`,
  });
  await addHabit(page, { title: "AT-H5", ideal: "13:00", min: 15, max: 15, hours: "AT-Always" });
  await eventually(
    () => dayEvents(cal),
    (l) => {
      expect(times(l, "AT-P5")).toEqual([`${D} 12:00-12:15`]);
      expect(times(l, "AT-H5")).toEqual([`${D} 13:00-13:15`]);
    },
  );

  // 12:20: the chunk ended and nobody pressed Start. It moves later the same day.
  await clockAt(app, at(D, "12:20"));
  const [moved] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        const [ev] = titled(l, "AT-P5");
        expect(titled(l, "AT-P5")).toHaveLength(1);
        expect(ev?.start).toBeGreaterThanOrEqual(at(D, "12:20"));
        expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(15 * MIN);
      },
    ),
    "AT-P5",
  );
  let row = await taskRow(page, "AT-P5");
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-left")).toHaveText("15 min left");

  // 7 minutes into the moved chunk the user presses Start: it starts 5 minutes in (rounded down).
  const start = (moved?.start ?? 0) + 5 * MIN;
  await clockAt(app, (moved?.start ?? 0) + 7 * MIN);
  row = await taskRow(page, "AT-P5");
  await row.getByRole("button", { name: "Start now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) =>
      expect(titled(l, "AT-P5").map((e) => [e.start, e.end])).toEqual([[start, start + 15 * MIN]]),
  );

  // 13:20: the started chunk ended and counts; the habit event ended unstarted and moves.
  await clockAt(app, at(D, "13:20"));
  row = await taskRow(page, "AT-P5");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");
  const [habit] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        expect(titled(l, "AT-P5").map((e) => [e.start, e.end])).toEqual([
          [start, start + 15 * MIN],
        ]);
        const [h] = titled(l, "AT-H5");
        expect(titled(l, "AT-H5")).toHaveLength(1);
        expect(h?.start).toBeGreaterThanOrEqual(at(D, "13:20"));
      },
    ),
    "AT-H5",
  );

  // Start on the running habit event moves its start to now, rounded down.
  const habitStart = (habit?.start ?? 0) + 5 * MIN;
  await clockAt(app, (habit?.start ?? 0) + 7 * MIN);
  await openWeek(page, W);
  await openEvent(page, "AT-H5");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Start now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) =>
      expect(titled(l, "AT-H5").map((e) => [e.start, e.end])).toEqual([
        [habitStart, habitStart + 15 * MIN],
      ]),
  );
  // After its end it stays: it was started, so it is done.
  await clockAt(app, habitStart + 20 * MIN);
  await openWeek(page, W);
  await openEvent(page, "AT-H5");
  await expect(page.getByTestId("occurrence-done")).toBeVisible();
  expect(titled(await dayEvents(cal), "AT-H5").map((e) => e.start)).toEqual([habitStart]);
});

test("logging past work in the planner writes a past event for a task or a habit and reduces the remaining work (PRG-20 to PRG-22; habits rule 32)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "12:00"));
  await page.clock.install({ time: new Date(at(D, "12:00")) });
  await signIn();
  await addTask(page, { title: "AT-P3", minutes: 120, min: 60, max: 120, due: "" });
  await addHabit(page, { title: "AT-Read", ideal: "09:00", min: 30, max: 30 });
  const future = (l: Awaited<ReturnType<CalendarDriver["events"]>>) =>
    titled(l, "AT-P3")
      .filter((e) => e.start >= at(D, "12:00"))
      .reduce((a, e) => a + e.end - e.start, 0);
  const week = () => cal.events(at(W, "00:00"), at(addDays(W, 21), "00:00"));
  await eventually(week, (l) => expect(future(l)).toBe(120 * MIN));

  // Click on yesterday 15:00 in the planner and log 60 minutes of AT-P3.
  const yesterday = addDays(D, -1);
  await openWeek(page, W);
  const logAt = async (date: string, hour: number) => {
    // Scroll the hour into view, then click on the empty day column there.
    await page
      .locator(".week-scroll")
      .evaluate((el, top) => el.scrollTo(0, top), Math.max(0, hour * 48 - 96));
    await page
      .locator(`.day-col[data-date="${date}"]`)
      .click({ position: { x: 20, y: hour * 48 + 4 } });
    const form = page.getByTestId("log-work");
    await expect(form).toBeVisible();
    return form;
  };
  let form = await logAt(yesterday, 15);
  await expect(form.getByLabel("Start")).toHaveValue(`${yesterday}T15:00`);
  await form.getByLabel("Work on").selectOption({ label: "AT-P3" });
  await form.getByLabel("Minutes").fill("60");
  await form.getByRole("button", { name: "Log work" }).click();
  await expect(form).toBeHidden();
  await eventually(week, (l) => {
    expect(times(l, "AT-P3").filter((t) => t.startsWith(yesterday))).toEqual([
      `${yesterday} 15:00-16:00`,
    ]);
    expect(future(l)).toBe(60 * MIN);
  });
  const row = await taskRow(page, "AT-P3");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");

  // Edge case 5: more work than is left uses the task's time; its future chunks go.
  await openWeek(page, W);
  await page.getByRole("button", { name: "Log work" }).click();
  form = page.getByTestId("log-work");
  await form.getByLabel("Start").fill(`${yesterday}T10:00`);
  await form.getByLabel("Work on").selectOption({ label: "AT-P3" });
  await form.getByLabel("Minutes").fill("90");
  await form.getByRole("button", { name: "Log work" }).click();
  await expect(form).toBeHidden();
  await eventually(week, (l) => expect(future(l)).toBe(0));
  const used = await taskRow(page, "AT-P3");
  await expect(used.getByTestId("task-state")).toHaveText("time-used");
  await expect(used.getByTestId("task-left")).toHaveText("0 min left");

  // A habit: 30 minutes yesterday at 09:00.
  await openWeek(page, W);
  form = await logAt(yesterday, 9);
  await form.getByLabel("Work on").selectOption({ label: "AT-Read (habit)" });
  await form.getByLabel("Minutes").fill("30");
  await form.getByRole("button", { name: "Log work" }).click();
  await expect(form).toBeHidden();
  await eventually(
    () => dayEvents(cal, yesterday),
    (l) => expect(times(l, "AT-Read")).toEqual([`${yesterday} 09:00-09:30`]),
  );
  await page.reload();
  await expect(page.locator(".ev", { hasText: "AT-Read" }).first()).toBeVisible();
  await openEvent(page, "AT-Read");
  await expect(page.getByTestId("event-drawer")).toContainText("habit · busy · locked");

  // Work in the future cannot be logged.
  await page.getByTestId("event-drawer").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Log work" }).click();
  form = page.getByTestId("log-work");
  await form.getByLabel("Start").fill(`${D}T15:00`);
  await form.getByLabel("Work on").selectOption({ label: "AT-P3" });
  await form.getByLabel("Minutes").fill("30");
  await form.getByRole("button", { name: "Log work" }).click();
  await expect(form.getByTestId("log-error")).toContainText("past");
  expect(times(await dayEvents(cal), "AT-P3").filter((t) => t.includes("15:00-15:30"))).toEqual([]);
});

test("Start with no chunk makes one from now up to the next busy event, Start on a running chunk changes nothing, and an early Stop removes it (edge cases 1 to 4)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "10:02"));
  await signIn();
  // Suggestions only: the task has no chunk, so Start must make one.
  await chooseSetting(page, "Task placement", "Suggestions only (no task events)");
  await cal.addEvent({ title: "Client call", start: at(D, "10:30"), end: at(D, "11:00") });
  await addTask(page, { title: "AT-Edge", minutes: 60, split: false, due: "" });
  expect(times(await dayEvents(cal), "AT-Edge")).toEqual([]);

  let row = await taskRow(page, "AT-Edge");
  await row.getByRole("button", { name: "Start now" }).click();
  const [chunk] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => expect(times(l, "AT-Edge")).toEqual([`${D} 10:00-10:30`]),
    ),
    "AT-Edge",
  );
  expect(chunk?.summary).toContain("🔒");
  row = await taskRow(page, "AT-Edge");
  await expect(row.getByTestId("task-started")).toBeVisible();

  // Start again on the running chunk: auto mode keeps it.
  const again = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/start"),
  );
  await row.getByRole("button", { name: "Start now" }).click();
  expect((await again).ok()).toBe(true);
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  expect(times(await dayEvents(cal), "AT-Edge")).toEqual([`${D} 10:00-10:30`]);

  // Stop 3 minutes after the start: the chunk goes and all its time returns.
  await clockAt(app, at(D, "10:03"));
  row = await taskRow(page, "AT-Edge");
  await row.getByRole("button", { name: "End now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Edge")).toEqual([]),
  );
  row = await taskRow(page, "AT-Edge");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");
  await expect(row.getByTestId("task-started")).toHaveCount(0);
});
