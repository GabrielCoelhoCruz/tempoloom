// Restart and the time-used action (docs/specs/planning-task-progress.md
// PRG-12, PRG-13, PRG-40 to PRG-44; acceptance tests 6 and 7).
// The server clock is set (TEST_CLOCK_START) to days in the test week W, so a
// chunk can begin and end, and days can pass, inside the test.
//
// Ways it can fail, and the check that catches each:
// - Restart leaves the running chunk at its start (as Start does)       -> 09:15, then 09:30
// - Restart does not round down to 5 minutes, or cuts the chunk         -> 09:15 to 10:15
// - Restart makes a second event, or the next plan run moves it back    -> one event after a run
// - "Nothing" closes or refills a time-used task                        -> open, no new event
// - an action runs before the wait days end                             -> open after 2 days
// - a new action skips tasks that were time-used before the change      -> done after 3 days
// - mark-done changes the events                                        -> event at its time
// - re-add adds nothing, or adds the current total instead of the first -> 60, then 60 again
// - manual start mode shows the setting, or the action still runs       -> hidden; still open
// - Restart skips manual mode, or moves an ended chunk                   -> 09:20; 409
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import type { AppServer, CalendarDriver } from "./fixtures.ts";
import { at, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addTask, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";
import { alwaysHours } from "./s3-helpers.ts";

/** Wednesday of the test week. */
const D = addDays(W, 2);
const DAY = 24 * 60 * MIN;

/** Restarts the server with its clock at `t`. */
async function clockAt(app: AppServer, t: number): Promise<void> {
  app.env.TEST_CLOCK_START = new Date(t).toISOString();
  await app.restart();
}

/** Runs the plan now and waits for its end. */
const planRun = (page: Page) =>
  page.evaluate(() => fetch("/api/planner/sync", { method: "POST" }).then((r) => r.status));

const weekEvents = (cal: CalendarDriver) =>
  cal.events(at(W, "00:00"), localToUtc(ZONE, addDays(W, 7), 0));
const times = (l: Awaited<ReturnType<CalendarDriver["events"]>>, title: string) =>
  titled(l, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

async function taskRow(page: Page, title: string, state: "Open" | "Done" = "Open") {
  await page.reload();
  await page.getByRole("link", { name: "Tasks" }).click();
  await page.getByTestId("task-filter").getByRole("button", { name: state }).click();
  return page.locator(`[data-task-title="${title}"]`);
}

/** Changes one Settings field and waits for its save. */
async function setting(page: Page, change: () => Promise<void>) {
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH" && r.ok(),
  );
  await change();
  await saved;
}

async function timeUsedAction(page: Page, action: string, days?: number) {
  await page.getByRole("link", { name: "Settings" }).click();
  await setting(page, () =>
    page
      .getByLabel("When a task's time is used")
      .selectOption({ label: action })
      .then(() => undefined),
  );
  if (days === undefined) return;
  const wait = page.getByLabel("Days to wait");
  await setting(page, async () => {
    await wait.fill(String(days));
    await wait.press("Tab");
  });
}

test("Restart moves the running chunk to now, rounded down to 5 minutes, with its length, in the task list and the planner (PRG-12, PRG-13)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await page.clock.install({ time: new Date(at(D, "08:00")) });
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-Restart",
    minutes: 60,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-Restart")).toEqual([`${D} 09:00-10:00`]),
  );

  // 09:17: the chunk runs. Start (auto mode) does not move a running chunk (edge case 2).
  await clockAt(app, at(D, "09:17"));
  await page.clock.setSystemTime(new Date(at(D, "09:17")));
  let row = await taskRow(page, "AT-Restart");
  await expect(row.getByTestId("task-started")).toBeVisible();
  const started = page.waitForResponse((r) => r.url().endsWith("/start") && r.ok());
  await row.getByRole("button", { name: "Start now" }).click();
  await started;
  await planRun(page);
  expect(times(await weekEvents(cal), "AT-Restart")).toEqual([`${D} 09:00-10:00`]);

  // Restart in the task list: the chunk starts at 09:15 and keeps its 60 minutes.
  row = await taskRow(page, "AT-Restart");
  await row.getByRole("button", { name: "Restart" }).click();
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-Restart")).toEqual([`${D} 09:15-10:15`]),
  );
  await planRun(page);
  expect(times(await weekEvents(cal), "AT-Restart")).toEqual([`${D} 09:15-10:15`]);
  row = await taskRow(page, "AT-Restart");
  await expect(row.getByTestId("task-started")).toBeVisible();
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");

  // 09:33: Restart in the planner moves it to 09:30.
  await clockAt(app, at(D, "09:33"));
  await page.clock.setSystemTime(new Date(at(D, "09:33")));
  await openWeek(page, W);
  await openEvent(page, "AT-Restart");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Restart" }).click();
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-Restart")).toEqual([`${D} 09:30-10:30`]),
  );
  await page.reload();
  await planRun(page);
  const l = await weekEvents(cal);
  expect(times(l, "AT-Restart")).toEqual([`${D} 09:30-10:30`]);
  expect(titled(l, "AT-Restart")[0]?.summary).toContain("🔒");
});

test("Restart in manual start mode moves the started chunk to now, and Restart with no running chunk is refused (PRG-12)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await signIn();
  await alwaysHours(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await setting(page, () =>
    page
      .getByLabel("Start mode")
      .selectOption({ label: "Count only after I press Start" })
      .then(() => undefined),
  );
  await addTask(page, {
    title: "AT-RestartM",
    minutes: 30,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-RestartM")).toEqual([`${D} 09:00-09:30`]),
  );
  // Start at 09:12 (manual mode) moves it to 09:10; Restart at 09:22 moves it to 09:20.
  await clockAt(app, at(D, "09:12"));
  let row = await taskRow(page, "AT-RestartM");
  await row.getByRole("button", { name: "Start now" }).click();
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-RestartM")).toEqual([`${D} 09:10-09:40`]),
  );
  await clockAt(app, at(D, "09:22"));
  row = await taskRow(page, "AT-RestartM");
  await row.getByRole("button", { name: "Restart" }).click();
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-RestartM")).toEqual([`${D} 09:20-09:50`]),
  );
  // 10:00: the chunk ended, so Restart has nothing to move.
  await clockAt(app, at(D, "10:00"));
  row = await taskRow(page, "AT-RestartM");
  await expect(row.getByRole("button", { name: "Restart" })).toBeHidden();
  const [task] = app.query<{ id: string }>("SELECT id FROM tasks WHERE title = 'AT-RestartM'");
  const status = await page.evaluate(
    (id) => fetch(`/api/tasks/${id}/restart`, { method: "POST" }).then((r) => r.status),
    task?.id ?? "",
  );
  expect(status).toBe(409);
  expect(times(await weekEvents(cal), "AT-RestartM")).toEqual([`${D} 09:20-09:50`]);
});

test("time-used action: Nothing keeps a time-used task open after the wait; Mark done waits the days, also for a task already time-used, and changes no event (PRG-40, PRG-42, PRG-43; AT 6)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-MarkDone",
    minutes: 15,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-MarkDone")).toEqual([`${D} 09:00-09:15`]),
  );

  // 09:30: the chunk passed (auto mode), so the task is time-used.
  await clockAt(app, at(D, "09:30"));
  await planRun(page);
  let row = await taskRow(page, "AT-MarkDone");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");

  // Two days later: the defaults are "Nothing" and 3 days.
  await clockAt(app, at(D, "09:30") + 2 * DAY);
  await page.reload();
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByLabel("When a task's time is used")).toHaveValue("nothing");
  await expect(page.getByLabel("Days to wait")).toHaveValue("3");

  // Mark done after the default 3 days: 2 days in time-used are not enough.
  await timeUsedAction(page, "Mark it done");
  await planRun(page);
  row = await taskRow(page, "AT-MarkDone");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");

  // Back to "Nothing": after the wait ends, and a day later, the task stays open (PRG-40).
  await timeUsedAction(page, "Nothing (it stays open)");
  for (const t of [3 * DAY + 60 * MIN, 4 * DAY]) {
    await clockAt(app, at(D, "09:15") + t);
    await planRun(page);
    row = await taskRow(page, "AT-MarkDone");
    await expect(row.getByTestId("task-state")).toHaveText("time-used");
  }
  expect(app.query("SELECT status FROM tasks WHERE title = 'AT-MarkDone'")).toEqual([
    { status: "open" },
  ]);

  // "Mark it done" for a task already past the wait: it goes under Done (PRG-42, PRG-43).
  await page.reload();
  await timeUsedAction(page, "Mark it done");
  await planRun(page);
  await expect
    .poll(() => app.query("SELECT status FROM tasks WHERE title = 'AT-MarkDone'"))
    .toEqual([{ status: "done" }]);
  row = await taskRow(page, "AT-MarkDone");
  await expect(row).toHaveCount(0);
  row = await taskRow(page, "AT-MarkDone", "Done");
  await expect(row).toBeVisible();
  // No event changed: the past chunk stays at its time.
  const l = await weekEvents(cal);
  expect(times(l, "AT-MarkDone")).toEqual([`${D} 09:00-09:15`]);
  expect(titled(l, "AT-MarkDone")[0]?.summary).toContain("✅");
});

test("time-used action: Add the time again adds the first total after the wait days, and the scheduler places it (PRG-41; AT 7)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await signIn();
  await alwaysHours(page);
  await timeUsedAction(page, "Add the time again", 1);
  await addTask(page, {
    title: "AT-P7",
    minutes: 60,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-P7")).toEqual([`${D} 09:00-10:00`]),
  );

  // 10:30: time-used; the wait of 1 day has not passed, so nothing is added.
  await clockAt(app, at(D, "10:30"));
  await planRun(page);
  let row = await taskRow(page, "AT-P7");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");
  expect(times(await weekEvents(cal), "AT-P7")).toEqual([`${D} 09:00-10:00`]);

  // 1 day and 1 hour after the end: 60 new minutes, placed in the future.
  const t1 = at(D, "10:00") + DAY + 60 * MIN;
  await clockAt(app, t1);
  await planRun(page);
  const future = (l: Awaited<ReturnType<CalendarDriver["events"]>>, from: number) =>
    titled(l, "AT-P7")
      .filter((e) => e.start >= from)
      .reduce((a, e) => a + (e.end - e.start) / MIN, 0);
  await eventually(
    () => weekEvents(cal),
    (l) => expect(future(l, t1)).toBe(60),
  );
  row = await taskRow(page, "AT-P7");
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");

  // The new hour passes, and a day later the first total (60), not 120, comes again.
  const [next] = titled(await weekEvents(cal), "AT-P7").filter((e) => e.start >= t1);
  const t2 = (next?.end ?? 0) + DAY + 60 * MIN;
  await clockAt(app, t2);
  await planRun(page);
  await eventually(
    () => weekEvents(cal),
    (l) => expect(future(l, t2)).toBe(60),
  );
  row = await taskRow(page, "AT-P7");
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await expect(row.getByTestId("task-left")).toHaveText("1 h left");
});

test("time-used action: manual start mode hides the setting, and the action has no effect (PRG-44)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await clockAt(app, at(D, "08:00"));
  await signIn();
  await alwaysHours(page);
  await timeUsedAction(page, "Mark it done", 1);
  await setting(page, () =>
    page
      .getByLabel("Start mode")
      .selectOption({ label: "Count only after I press Start" })
      .then(() => undefined),
  );
  await expect(page.getByLabel("When a task's time is used")).toBeHidden();
  await expect(page.getByLabel("Days to wait")).toBeHidden();
  await page.reload();
  await expect(page.getByLabel("Start mode")).toHaveValue("manual");
  await expect(page.getByLabel("When a task's time is used")).toBeHidden();

  await addTask(page, {
    title: "AT-Manual",
    minutes: 15,
    split: false,
    due: "",
    hours: "AT-Always",
    startAfter: `${D}T09:00`,
  });
  await eventually(
    () => weekEvents(cal),
    (l) => expect(times(l, "AT-Manual")).toEqual([`${D} 09:00-09:15`]),
  );
  // Start during the chunk, so it counts as done work in manual mode.
  await clockAt(app, at(D, "09:00"));
  let row = await taskRow(page, "AT-Manual");
  const started = page.waitForResponse((r) => r.url().endsWith("/start") && r.ok());
  await row.getByRole("button", { name: "Start now" }).click();
  await started;
  await clockAt(app, at(D, "09:30"));
  row = await taskRow(page, "AT-Manual");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");

  // Two days later the saved "Mark it done" after 1 day still does nothing.
  await clockAt(app, at(D, "09:30") + 2 * DAY);
  await planRun(page);
  row = await taskRow(page, "AT-Manual");
  await expect(row.getByTestId("task-state")).toHaveText("time-used");
  expect(app.query("SELECT status FROM tasks WHERE title = 'AT-Manual'")).toEqual([
    { status: "open" },
  ]);
});
