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
import type { Locator, Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { openSettings } from "./calendar-helpers.ts";
import type { AppServer, CalendarDriver } from "./fixtures.ts";
import { at, BACKEND, eventually, expect, local, test, ZONE } from "./fixtures.ts";
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

const FIVE = 5 * MIN;
const floor5 = (t: number) => Math.floor(t / FIVE) * FIVE;
/** The server clock, read through the API. */
const serverNow = (page: Page) =>
  page.evaluate(() =>
    fetch("/api/now")
      .then((r) => r.json())
      .then((b: { now: number }) => b.now),
  );

/**
 * Sets the server clock to `t` right before a click on Start and returns the
 * starts that Start may give: `t` and the time after the click, rounded down
 * to 5 minutes. The two are the same unless the click took minutes. The
 * button must show first: the restart must not cut the load of the page part
 * that holds it.
 */
async function startAt(page: Page, app: AppServer, t: number, button: Locator) {
  await expect(button).toBeVisible();
  await clockAt(app, t);
  await button.click();
  return [floor5(t), floor5(await serverNow(page))];
}

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
  let row = await taskRow(page, "AT-P1");
  const starts = await startAt(
    page,
    app,
    at(D, "09:03"),
    row.getByRole("button", { name: "Start now" }),
  );
  const [started] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        expect(titled(l, "AT-P1")).toHaveLength(1);
        expect(starts).toContain(titled(l, "AT-P1")[0]?.start);
      },
    ),
    "AT-P1",
  );
  const s0 = started?.start ?? 0;
  expect(started?.end).toBe(s0 + 60 * MIN);
  row = await taskRow(page, "AT-P1");
  await expect(row.getByTestId("task-started")).toBeVisible();
  // The next plan run keeps it there.
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  expect(titled(await dayEvents(cal), "AT-P1").map((e) => [e.start, e.end])).toEqual([
    [s0, s0 + 60 * MIN],
  ]);

  // Stop at 09:40: the chunk ends then, and the other 20 minutes go later.
  await clockAt(app, at(D, "09:40"));
  row = await taskRow(page, "AT-P1");
  await row.getByRole("button", { name: "End now" }).click();
  const evs = await eventually(
    () => dayEvents(cal),
    (l) => {
      const [first, rest] = titled(l, "AT-P1");
      expect(titled(l, "AT-P1")).toHaveLength(2);
      expect(first?.start).toBe(s0);
      expect(first?.end).toBeGreaterThanOrEqual(at(D, "09:40"));
      expect(first?.end).toBeLessThanOrEqual(at(D, "09:42"));
      expect(rest?.start).toBeGreaterThanOrEqual(first?.end ?? 0);
      expect((rest?.end ?? 0) - (rest?.start ?? 0)).toBe(
        60 * MIN - ((first?.end ?? 0) - (first?.start ?? 0)),
      );
    },
  );
  const worked = ((titled(evs, "AT-P1")[0]?.end ?? 0) - s0) / MIN;
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
  row = await taskRow(page, "AT-P5");
  const starts = await startAt(
    page,
    app,
    (moved?.start ?? 0) + 7 * MIN,
    row.getByRole("button", { name: "Start now" }),
  );
  expect(starts[0]).toBe((moved?.start ?? 0) + 5 * MIN);
  const start =
    titled(
      await eventually(
        () => dayEvents(cal),
        (l) => {
          const [ev] = titled(l, "AT-P5");
          expect(titled(l, "AT-P5")).toHaveLength(1);
          expect(starts).toContain(ev?.start);
          expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(15 * MIN);
        },
      ),
      "AT-P5",
    )[0]?.start ?? 0;

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
  await openWeek(page, W);
  await openEvent(page, "AT-H5");
  const habitStarts = await startAt(
    page,
    app,
    (habit?.start ?? 0) + 7 * MIN,
    page.getByTestId("event-drawer").getByRole("button", { name: "Start now" }),
  );
  const habitStart =
    titled(
      await eventually(
        () => dayEvents(cal),
        (l) => {
          const [h] = titled(l, "AT-H5");
          expect(titled(l, "AT-H5")).toHaveLength(1);
          expect(habitStarts).toContain(h?.start);
          expect((h?.end ?? 0) - (h?.start ?? 0)).toBe(15 * MIN);
        },
      ),
      "AT-H5",
    )[0]?.start ?? 0;
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
  const starts = await startAt(
    page,
    app,
    at(D, "10:02"),
    row.getByRole("button", { name: "Start now" }),
  );
  const [chunk] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        expect(titled(l, "AT-Edge")).toHaveLength(1);
        expect(starts).toContain(titled(l, "AT-Edge")[0]?.start);
        expect(titled(l, "AT-Edge")[0]?.end).toBe(at(D, "10:30"));
      },
    ),
    "AT-Edge",
  );
  const edgeStart = chunk?.start ?? 0;
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
  expect(titled(await dayEvents(cal), "AT-Edge").map((e) => [e.start, e.end])).toEqual([
    [edgeStart, at(D, "10:30")],
  ]);

  // Stop 3 minutes after the start: the chunk goes and all its time returns.
  row = await taskRow(page, "AT-Edge");
  await clockAt(app, edgeStart + 3 * MIN);
  await row.getByRole("button", { name: "End now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Edge")).toEqual([]),
  );
  row = await taskRow(page, "AT-Edge");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");
  await expect(row.getByTestId("task-started")).toHaveCount(0);
});

/** Locks or unlocks one event in the planner's details panel and waits for the save. */
async function toggleLock(page: Page, app: AppServer, title: string, locked: boolean) {
  await openWeek(page, W);
  await openEvent(page, title);
  await page
    .getByTestId("event-drawer")
    .getByRole("button", { name: locked ? "Lock" : "Unlock", exact: true })
    .click();
  await expect
    .poll(() =>
      app.query<{ locked: number }>(
        "SELECT locked FROM managed_events WHERE title LIKE ?",
        `%${title}%`,
      ),
    )
    .toEqual([{ locked: locked ? 1 : 0 }]);
}

test("manual start mode: a chunk the user locked or dragged that ends without Start still moves later that day (PRG-3)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "11:50"));
  await signIn();
  await alwaysHours(page);
  await chooseSetting(page, "Start mode", "Count only after I press Start");
  for (const [title, from] of [
    ["AT-Locked", "12:00"],
    ["AT-Dragged", "13:00"],
  ] as const)
    await addTask(page, {
      title,
      minutes: 15,
      split: false,
      due: "",
      hours: "AT-Always",
      startAfter: `${D}T${from}`,
    });
  await eventually(
    () => dayEvents(cal),
    (l) => {
      expect(times(l, "AT-Locked")).toEqual([`${D} 12:00-12:15`]);
      expect(times(l, "AT-Dragged")).toEqual([`${D} 13:00-13:15`]);
    },
  );

  // The user locks one chunk and drags the other 30 minutes earlier (the drag locks it too).
  await toggleLock(page, app, "AT-Locked", true);
  // Let the plan run after the lock end, so no live reload redraws the week during the drag.
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  await openWeek(page, W);
  // The now bar shows last; once it is there the week no longer shifts under the mouse.
  await expect(page.getByTestId("next-up")).toBeVisible();
  const box = page.locator(".ev-task", { hasText: "AT-Dragged" }).first();
  await box.hover({ position: { x: 10, y: 5 } });
  const b = await box.boundingBox();
  if (!b) throw new Error("no box");
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 5 - 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 5 - 24, { steps: 4 });
  const move = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/move"),
  );
  await page.mouse.up();
  expect((await move).ok()).toBe(true);
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Dragged")).toEqual([`${D} 12:30-12:45`]),
  );
  expect(
    app.query<{ locked: number }>(
      "SELECT locked FROM managed_events WHERE title LIKE '%AT-Dragged%'",
    ),
  ).toEqual([{ locked: 1 }]);

  // 12:50: both ended and nobody pressed Start, so neither counts. Both move later that day.
  await clockAt(app, at(D, "12:50"));
  await eventually(
    () => dayEvents(cal),
    (l) => {
      for (const title of ["AT-Locked", "AT-Dragged"]) {
        const [ev] = titled(l, title);
        expect(titled(l, title)).toHaveLength(1);
        expect(ev?.start).toBeGreaterThanOrEqual(at(D, "12:50"));
        expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(15 * MIN);
      }
    },
  );
  for (const title of ["AT-Locked", "AT-Dragged"]) {
    const row = await taskRow(page, title);
    await expect(row.getByTestId("task-state")).toHaveText("scheduled");
    await expect(row.getByTestId("task-left")).toHaveText("15 min left");
  }
});

test("Unlock on a started chunk or on logged work that ended keeps it as done work, and its event stays (PRG-1, PRG-3, PRG-20)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:50"));
  await signIn();
  await alwaysHours(page);
  await chooseSetting(page, "Start mode", "Count only after I press Start");
  await addTask(page, {
    title: "AT-Begun",
    minutes: 15,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await addTask(page, {
    title: "AT-Logged",
    minutes: 30,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T14:00`,
  });
  await eventually(
    () => dayEvents(cal),
    (l) => {
      expect(times(l, "AT-Begun")).toEqual([`${D} 09:00-09:15`]);
      expect(times(l, "AT-Logged")).toEqual([`${D} 14:00-14:30`]);
    },
  );

  // The user logs all 30 minutes of AT-Logged at 08:00: its future chunk goes.
  await openWeek(page, W);
  await page.getByRole("button", { name: "Log work" }).click();
  const form = page.getByTestId("log-work");
  await form.getByLabel("Start").fill(`${D}T08:00`);
  await form.getByLabel("Work on").selectOption({ label: "AT-Logged" });
  await form.getByLabel("Minutes").fill("30");
  await form.getByRole("button", { name: "Log work" }).click();
  await expect(form).toBeHidden();
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Logged")).toEqual([`${D} 08:00-08:30`]),
  );

  // The user presses Start during AT-Begun.
  let row = await taskRow(page, "AT-Begun");
  await clockAt(app, at(D, "09:02"));
  await row.getByRole("button", { name: "Start now" }).click();
  row = await taskRow(page, "AT-Begun");
  await expect(row.getByTestId("task-started")).toBeVisible();

  // After its end both count as done work. The user unlocks both in the planner.
  await clockAt(app, at(D, "09:30"));
  for (const title of ["AT-Begun", "AT-Logged"]) {
    row = await taskRow(page, title);
    await expect(row.getByTestId("task-state")).toHaveText("time-used");
  }
  await toggleLock(page, app, "AT-Begun", false);
  await toggleLock(page, app, "AT-Logged", false);
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));

  // They stay done work, at their times.
  const l = await dayEvents(cal);
  expect(times(l, "AT-Begun")).toEqual([`${D} 09:00-09:15`]);
  expect(times(l, "AT-Logged")).toEqual([`${D} 08:00-08:30`]);
  for (const title of ["AT-Begun", "AT-Logged"]) {
    row = await taskRow(page, title);
    await expect(row.getByTestId("task-state")).toHaveText("time-used");
    await expect(row.getByTestId("task-left")).toHaveText("0 min left");
  }
});

test("manual start mode: a chunk that ended without Start is work left in the task list, the Tasks panel and its title (PRG-3)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "09:50"));
  await signIn();
  await alwaysHours(page);
  await chooseSetting(page, "Start mode", "Count only after I press Start");
  await addTask(page, {
    title: "AT-Unstarted",
    minutes: 15,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T10:00`,
  });
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Unstarted")).toEqual([`${D} 10:00-10:15`]),
  );
  // A locked chunk stays in suggestions mode, and no new chunk is placed, so it cannot move.
  await toggleLock(page, app, "AT-Unstarted", true);
  await chooseSetting(page, "Task placement", "Suggestions only (no task events)");
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  expect(times(await dayEvents(cal), "AT-Unstarted")).toEqual([`${D} 10:00-10:15`]);

  // 10:20: it ended and nobody pressed Start. Every view counts its 15 minutes as left.
  await clockAt(app, at(D, "10:20"));
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  const row = await taskRow(page, "AT-Unstarted");
  await expect(row.getByTestId("task-left")).toHaveText("15 min left");
  await expect(row.getByTestId("task-state")).toHaveText("unscheduled");
  await openWeek(page, W);
  await page.getByTestId("now-bar").getByRole("button", { name: "Tasks" }).click();
  await expect(
    page.getByTestId("suggested-now").locator('[data-task-title="AT-Unstarted"]'),
  ).toBeVisible();
  const [ev] = titled(await dayEvents(cal), "AT-Unstarted");
  expect(ev?.summary).not.toContain("✅");
});

test("two Start requests at once make one chunk, and an early Stop is in the change log (edge cases 1 and 4)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "10:00"));
  await signIn();
  await chooseSetting(page, "Task placement", "Suggestions only (no task events)");
  await addTask(page, { title: "AT-Twice", minutes: 60, split: false, due: "" });
  const [task] = app.query<{ id: string }>("SELECT id FROM tasks WHERE title = 'AT-Twice'");
  const id = task?.id ?? "";

  // Two Start requests at the same time, as from two fast clicks or two tabs.
  const statuses = await page.evaluate(
    (id) =>
      Promise.all(
        [0, 1].map(() => fetch(`/api/tasks/${id}/start`, { method: "POST" }).then((r) => r.status)),
      ),
    id,
  );
  expect(statuses).toEqual([200, 200]);
  const [chunk] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => expect(titled(l, "AT-Twice")).toHaveLength(1),
    ),
    "AT-Twice",
  );
  await page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }));
  expect(titled(await dayEvents(cal), "AT-Twice")).toHaveLength(1);
  expect(
    app.query<{ n: number }>("SELECT COUNT(*) AS n FROM managed_events WHERE source_id = ?", id),
  ).toEqual([{ n: 1 }]);

  // Stop 2 minutes after the start removes the chunk, and the change log has the delete.
  const row = await taskRow(page, "AT-Twice");
  await clockAt(app, (chunk?.start ?? 0) + 2 * MIN);
  await row.getByRole("button", { name: "End now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) => expect(titled(l, "AT-Twice")).toHaveLength(0),
  );
  await expect
    .poll(() =>
      app.query<{ action: string; reason: string }>(
        "SELECT action, reason FROM change_log WHERE event_id = ? ORDER BY id",
        chunk?.id ?? "",
      ),
    )
    .toContainEqual({ action: "delete", reason: "stopped" });
});

test("Start now and End now in the planner move a task chunk to now and end it now (PRG-10, PRG-11, PRG-13)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  // The browser shows End now only during the chunk, so its clock follows the server's.
  await page.clock.install({ time: new Date(at(D, "08:00")) });
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-Planner",
    minutes: 60,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T14:00`,
  });
  await eventually(
    () => dayEvents(cal),
    (l) => expect(times(l, "AT-Planner")).toEqual([`${D} 14:00-15:00`]),
  );

  await openWeek(page, W);
  await openEvent(page, "AT-Planner");
  const starts = await startAt(
    page,
    app,
    at(D, "09:03"),
    page.getByTestId("event-drawer").getByRole("button", { name: "Start now" }),
  );
  expect(starts[0]).toBe(at(D, "09:00"));
  const [started] = titled(
    await eventually(
      () => dayEvents(cal),
      (l) => {
        expect(titled(l, "AT-Planner")).toHaveLength(1);
        expect(starts).toContain(titled(l, "AT-Planner")[0]?.start);
      },
    ),
    "AT-Planner",
  );
  const s0 = started?.start ?? 0;
  expect(started?.end).toBe(s0 + 60 * MIN);

  // End now at 09:40 in the planner: the chunk ends then, and the rest is placed later.
  await clockAt(app, at(D, "09:40"));
  await page.clock.setSystemTime(new Date(at(D, "09:40")));
  await openWeek(page, W);
  await openEvent(page, "AT-Planner");
  await page.getByTestId("event-drawer").getByRole("button", { name: "End now" }).click();
  await eventually(
    () => dayEvents(cal),
    (l) => {
      const [first, rest] = titled(l, "AT-Planner");
      expect(titled(l, "AT-Planner")).toHaveLength(2);
      expect(first?.start).toBe(s0);
      expect(first?.end).toBeGreaterThanOrEqual(at(D, "09:40"));
      expect(first?.end).toBeLessThanOrEqual(at(D, "09:42"));
      expect(rest?.start).toBeGreaterThanOrEqual(first?.end ?? 0);
      expect((rest?.end ?? 0) - (rest?.start ?? 0)).toBe(
        60 * MIN - ((first?.end ?? 0) - (first?.start ?? 0)),
      );
    },
  );
  await page.reload();
  expect(titled(await dayEvents(cal), "AT-Planner")).toHaveLength(2);
});

test("logged work goes to the task calendar of the task's hours set, and a drag over a past time sets its start and length (PRG-21, PRG-22)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The test adds a second CalDAV calendar.");
  await clockAt(app, at(D, "12:00"));
  await page.clock.install({ time: new Date(at(D, "12:00")) });
  await signIn();
  const tasks = await cal.newCalendar("Tasks");
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Tasks");
  await page.reload();
  const pick = page.getByTestId("hours-personal").getByLabel("Calendar for task chunks");
  await pick.selectOption({ label: "Tasks" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Home", minutes: 120, due: "", hours: "Personal hours" });
  await addTask(page, { title: "AT-Office", minutes: 120, due: "", hours: "Work hours" });

  const yesterday = addDays(D, -1);
  const dragLog = async (title: string, from: number, to: number) => {
    await openWeek(page, W);
    await expect(page.getByTestId("next-up")).toBeVisible();
    await expect(page.locator(".ev", { hasText: "AT-Home" }).first()).toBeVisible();
    // Positions inside the day column: Playwright scrolls each one into view.
    const col = page.locator(`.day-col[data-date="${yesterday}"]`);
    const y = (h: number) => ({ position: { x: 20, y: h * 48 + 4 } });
    await col.hover(y(from));
    await page.mouse.down();
    await col.hover(y((from + to) / 2));
    await col.hover(y(to));
    await page.mouse.up();
    const form = page.getByTestId("log-work");
    await expect(form.getByLabel("Start")).toHaveValue(
      `${yesterday}T${String(from).padStart(2, "0")}:00`,
    );
    await expect(form.getByLabel("Minutes")).toHaveValue(String((to - from) * 60));
    await form.getByLabel("Work on").selectOption({ label: title });
    await form.getByRole("button", { name: "Log work" }).click();
    await expect(form).toBeHidden();
  };
  // A drag from 10:00 to 11:00 yesterday logs 60 minutes of AT-Home.
  await dragLog("AT-Home", 10, 11);
  await dragLog("AT-Office", 13, 14);

  const day = (c: CalendarDriver) => dayEvents(c, yesterday);
  await eventually(
    () => day(tasks),
    (l) => expect(times(l, "AT-Home")).toEqual([`${yesterday} 10:00-11:00`]),
  );
  await eventually(
    () => day(cal),
    (l) => expect(times(l, "AT-Office")).toEqual([`${yesterday} 13:00-14:00`]),
  );
  expect(times(await day(cal), "AT-Home")).toEqual([]);
  expect(times(await day(tasks), "AT-Office")).toEqual([]);
  const row = await taskRow(page, "AT-Home");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");
});
