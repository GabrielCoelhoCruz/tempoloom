// The task list and task defaults: filters and sort (TSK-60, TSK-61), bulk
// edit (TSK-45), snooze (TSK-24), private visibility (CNT-20, CNT-24), the
// task defaults in Settings (TSK-1 to TSK-3) and tasks made by a click or a
// drag on the planner (TSK-7, AT-T10). docs/specs/planning-tasks.md and
// docs/specs/planning-event-content.md.
//
// Ways it can fail, and the check that catches each:
// - a filter shows a task it should hide, or hides one it should show     -> list contents per filter
// - the sort ignores the chosen order (all three orders differ here)     -> list order per sort
// - a reload drops the filters or the sort                                -> list and fields after reload
// - a bulk edit changes a task that is not selected                       -> the third task keeps its values
// - bulk start, due, priority, done or delete does not reach the calendar -> Radicale events and the database
// - scheduling order ignores the urgency lift of the default mode         -> list order (lifted P3 first)
// - snooze does not move the chunks, or locks them                       -> Radicale time and title marker
// - "1 hour", "3 hours", "Tomorrow" or "Next week" give the wrong time    -> stored start date
// - snooze puts the start after the due date, so later edits fail        -> stored dates, PATCH and bulk responses
// - snooze leaves the locked chunk of a task made on the planner          -> Radicale time and lock marker
// - the shortest or longest chunk default is not used                    -> stored bounds, Radicale chunk lengths
// - a private task writes no CLASS, or a default task writes one         -> CLASS in the raw event
// - a change of visibility on one task does not reach its events         -> CLASS after the change
// - a task default is not used, or changes a task made before            -> stored values of both tasks
// - start delay and due-in are not relative to the creation time          -> stored dates
// - a drag makes a task of the wrong length, at the wrong time, unlocked  -> Radicale event and lock marker
// - a click makes nothing, or the next plan moves the new chunk           -> Radicale after a plan run
// - a task row puts the select box in the wide column, the buttons below -> part boxes in the row
import type { Page } from "@playwright/test";
import { addDays, addLocalDays, utcToLocal, weekdayOf } from "../../src/shared/time.ts";
import { eventProp, rawEvent } from "./automation-list-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, planNow, test, ZONE } from "./fixtures.ts";
import { addTask, allEvents, inHours, MIN, openWeek, titled, W, weekInPlace } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const row = (page: Page, title: string) => page.locator(`[data-task-title="${title}"]`);
// The rows in page order: the next-up queue area (NXT-5), then the task list.
const listed = (page: Page) =>
  page
    .getByTestId("tasks-page")
    .locator("[data-task-title]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-task-title")));

async function waitPlaced(cal: Parameters<typeof allEvents>[0], titles: string[]) {
  return eventually(
    () => allEvents(cal),
    (l) => {
      for (const t of titles) expect(titled(l, t).length, t).toBeGreaterThan(0);
    },
  );
}

test("the task list filters by state, hours set, due date and start date, and sorts by due date, priority or scheduling order (TSK-60, TSK-61)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Due date order: FA, FB, FE, FC (no due date: oldest first). Priority: FB, FC, FA, FE.
  // Scheduling order (next up first, then level): FC, FB, FA, FE.
  // FC is next up, so it shows first, in the next-up queue area, in each sort.
  await addTask(page, { title: "FA", minutes: 60, split: false, level: 3, due: `${day(1)}T17:00` });
  await page.goto("/tasks");
  await addTask(page, {
    title: "FB",
    minutes: 60,
    split: false,
    level: 1,
    due: `${day(4)}T17:00`,
    startAfter: `${day(2)}T09:00`,
  });
  await page.goto("/tasks");
  // Starts after the 3-week window: open, not scheduled.
  await addTask(page, {
    title: "FE",
    minutes: 60,
    split: false,
    level: 4,
    due: "",
    startAfter: `${addDays(W, 35)}T09:00`,
  });
  await page.goto("/tasks");
  await addTask(page, {
    title: "FC",
    minutes: 60,
    split: false,
    level: 2,
    due: "",
    hours: "Personal hours",
    nextUp: true,
  });
  const evs = await waitPlaced(cal, ["FA", "FB", "FC"]);
  expect(titled(evs, "FB")[0]?.start ?? 0).toBeGreaterThanOrEqual(at(day(2), "09:00"));
  expect(titled(evs, "FE")).toHaveLength(0);

  const filters = page.getByTestId("task-filters");
  await expect.poll(() => listed(page)).toEqual(["FC", "FA", "FB", "FE"]);
  await filters.getByLabel("Sort").selectOption({ label: "Priority" });
  await expect.poll(() => listed(page)).toEqual(["FC", "FB", "FA", "FE"]);
  await filters.getByLabel("Sort").selectOption({ label: "Scheduling order" });
  await expect.poll(() => listed(page)).toEqual(["FC", "FB", "FA", "FE"]);

  await page.getByTestId("task-states").getByRole("button", { name: "Scheduled" }).click();
  await expect.poll(() => listed(page)).toEqual(["FC", "FB", "FA"]);
  await page.getByTestId("task-states").getByRole("button", { name: "Open" }).click();
  await expect.poll(() => listed(page)).toEqual(["FC", "FB", "FA", "FE"]);

  await filters.getByLabel("Hours").selectOption({ label: "Personal hours" });
  await expect.poll(() => listed(page)).toEqual(["FC"]);
  await filters.getByLabel("Hours").selectOption({ label: "Any hours" });

  await filters.getByLabel("Due by").fill(day(2));
  await expect.poll(() => listed(page)).toEqual(["FA"]);
  await filters.getByLabel("Due by").fill("");
  await filters.getByLabel("Starts from").fill(day(1));
  await expect.poll(() => listed(page)).toEqual(["FB", "FE"]);

  await page.reload();
  await expect(page.getByTestId("task-filters").getByLabel("Starts from")).toHaveValue(day(1));
  await expect(page.getByTestId("task-filters").getByLabel("Sort")).toHaveValue("scheduling");
  await expect.poll(() => listed(page)).toEqual(["FB", "FE"]);
});

test("scheduling order is the scheduler's order, with the urgency lift of a task short of time before its due date (TSK-61)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // LA is P2. LB is P3 with 7 hours of work and 8 free work hours before its
  // due date, so the default urgency mode lifts it above LA. By priority alone LA comes first.
  await addTask(page, { title: "LA", minutes: 60, split: false, level: 2, due: "" });
  await page.goto("/tasks");
  await addTask(page, {
    title: "LB",
    minutes: 420,
    min: 60,
    max: 120,
    level: 3,
    due: `${W}T17:00`,
  });
  await waitPlaced(cal, ["LA", "LB"]);
  await page.goto("/tasks?sort=scheduling");
  await expect(page.getByTestId("task-filters").getByLabel("Sort")).toHaveValue("scheduling");
  await expect.poll(() => listed(page)).toEqual(["LB", "LA"]);
  await page.getByTestId("task-filters").getByLabel("Sort").selectOption({ label: "Priority" });
  await expect.poll(() => listed(page)).toEqual(["LA", "LB"]);
  await page
    .getByTestId("task-filters")
    .getByLabel("Sort")
    .selectOption({ label: "Scheduling order" });
  await page.reload();
  await expect.poll(() => listed(page)).toEqual(["LB", "LA"]);
});

test("bulk edit sets the start date, due date and priority of the selected tasks, marks them done or deletes them (TSK-45)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  for (const title of ["BK1", "BK2", "BK3"])
    await addTask(page, { title, minutes: 60, split: false, due: "" });
  await waitPlaced(cal, ["BK1", "BK2", "BK3"]);

  const bulk = page.getByTestId("bulk-bar");
  await row(page, "BK1").getByLabel("Select").check();
  await row(page, "BK2").getByLabel("Select").check();
  await expect(bulk).toContainText("2 selected");

  await bulk.getByLabel("Priority").selectOption("4");
  await bulk.getByRole("button", { name: "Set priority" }).click();
  for (const t of ["BK1", "BK2"])
    await expect(row(page, t).getByTestId("task-level")).toHaveText("P4 low");
  await expect(row(page, "BK3").getByTestId("task-level")).toHaveText("P2 high");

  await bulk.getByLabel("Start after").fill(`${day(3)}T09:00`);
  await bulk.getByRole("button", { name: "Set start" }).click();
  await eventually(
    () => allEvents(cal),
    (l) => {
      for (const t of ["BK1", "BK2"])
        expect(titled(l, t)[0]?.start ?? 0, t).toBeGreaterThanOrEqual(at(day(3), "09:00"));
      expect(titled(l, "BK3")[0]?.start ?? Infinity).toBeLessThan(at(day(3), "09:00"));
    },
  );

  await bulk.getByLabel("Due").fill(`${day(4)}T17:00`);
  await bulk.getByRole("button", { name: "Set due" }).click();
  await expect
    .poll(() =>
      app.query<{ title: string; due_at: number | null }>(
        "SELECT title, due_at FROM tasks ORDER BY title",
      ),
    )
    .toEqual([
      { title: "BK1", due_at: at(day(4), "17:00") },
      { title: "BK2", due_at: at(day(4), "17:00") },
      { title: "BK3", due_at: null },
    ]);

  await row(page, "BK2").getByLabel("Select").uncheck();
  await expect(bulk).toContainText("1 selected");
  await bulk.getByRole("button", { name: "Mark done" }).click();
  await expect(row(page, "BK1")).toBeHidden();
  await row(page, "BK2").getByLabel("Select").check();
  await bulk.getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "BK2")).toBeHidden();
  await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "BK1")).toHaveLength(0);
      expect(titled(l, "BK2")).toHaveLength(0);
      expect(titled(l, "BK3")).toHaveLength(1);
    },
  );

  await page.reload();
  await expect(row(page, "BK3").getByTestId("task-level")).toHaveText("P2 high");
  await expect(row(page, "BK1")).toBeHidden();
  await page.getByTestId("task-states").getByRole("button", { name: "Done" }).click();
  await expect(row(page, "BK1").getByTestId("task-state")).toHaveText("done");
  await expect(row(page, "BK2")).toBeHidden();
});

/** The first day after today with work hours (Monday to Friday). */
function nextWorkday(): string {
  let d = addDays(utcToLocal(ZONE, Date.now()).date, 1);
  while (weekdayOf(d) > 5) d = addDays(d, 1);
  return d;
}

/** The first Monday after today, the first day of next week (week start Monday). */
function nextMonday(): string {
  let d = addDays(utcToLocal(ZONE, Date.now()).date, 1);
  while (weekdayOf(d) !== 1) d = addDays(d, 1);
  return d;
}

test("snooze moves a task to a later start and places its chunks again, unlocked (TSK-24)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Snooze", minutes: 60, split: false, due: "" });
  const before = await waitPlaced(cal, ["AT-Snooze"]);
  expect(titled(before, "AT-Snooze")[0]?.start).toBe(at(W, "09:00"));

  const more = row(page, "AT-Snooze").getByTestId("task-more");
  await more.locator("summary").click();
  const startAfter = () =>
    app.query<{ s: number }>("SELECT start_after AS s FROM tasks WHERE title = 'AT-Snooze'")[0]
      ?.s ?? 0;
  // "1 hour" and "3 hours" count from now; each is later than the last choice.
  for (const [choice, hours] of [
    ["1 hour", 1],
    ["3 hours", 3],
  ] as const) {
    const clicked = Date.now();
    await more.getByRole("button", { name: choice, exact: true }).click();
    await expect
      .poll(() => Math.abs(startAfter() - (clicked + hours * 60 * MIN)), { message: choice })
      .toBeLessThan(2 * MIN);
  }
  // Tomorrow: the next day with work hours, at their start (09:00).
  await more.getByRole("button", { name: "Tomorrow", exact: true }).click();
  await expect.poll(startAfter).toBe(at(nextWorkday(), "09:00"));
  await more.getByRole("button", { name: "Next week", exact: true }).click();
  // Next week: its first day, at the start of the task's hours (work hours, 09:00).
  await expect.poll(startAfter).toBe(at(nextMonday(), "09:00"));

  await more.getByLabel("Snooze until").fill(`${day(2)}T13:00`);
  await more.getByRole("button", { name: "Snooze", exact: true }).click();
  const evs = await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "AT-Snooze")).toHaveLength(1);
      expect(titled(l, "AT-Snooze")[0]?.start).toBe(at(day(2), "13:00"));
    },
  );
  expect(titled(evs, "AT-Snooze")[0]?.summary).not.toContain("🔒");
  await expect(row(page, "AT-Snooze").getByTestId("task-start")).toBeVisible();
  await openWeek(page);
  await expect(page.locator(".ev", { hasText: "AT-Snooze" })).not.toHaveClass(/ev-locked/);

  await page.reload();
  await planNow(page);
  const after = await allEvents(cal);
  expect(titled(after, "AT-Snooze").map((e) => [e.id, e.start])).toEqual(
    titled(evs, "AT-Snooze").map((e) => [e.id, e.start]),
  );
});

test("snooze past the due date moves the due date with the start, and the task can still be edited (TSK-24, edge case 6)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Due tomorrow at 08:00: always before next week's first work hour.
  const tomorrow = addDays(utcToLocal(ZONE, Date.now()).date, 1);
  await addTask(page, {
    title: "AT-SnoozeDue",
    minutes: 60,
    split: false,
    due: `${tomorrow}T08:00`,
  });
  const dates = () =>
    app.query<{ s: number; d: number; level: number; visibility: string }>(
      "SELECT start_after AS s, due_at AS d, level, visibility FROM tasks",
    )[0];
  const before = dates();
  const more = row(page, "AT-SnoozeDue").getByTestId("task-more");
  await more.locator("summary").click();
  await more.getByRole("button", { name: "Next week", exact: true }).click();
  const start = at(nextMonday(), "09:00");
  // The whole task moves: the due date keeps its distance from the start.
  await expect
    .poll(() => [dates()?.s, dates()?.d])
    .toEqual([start, start + ((before?.d ?? 0) - (before?.s ?? 0))]);

  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/api/tasks/"),
  );
  await more.getByLabel("Visibility").selectOption({ label: "Private" });
  expect((await saved).ok()).toBe(true);
  await row(page, "AT-SnoozeDue").getByLabel("Select").check();
  const bulk = page.getByTestId("bulk-bar");
  await bulk.getByLabel("Priority").selectOption("4");
  const bulked = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks/bulk",
  );
  await bulk.getByRole("button", { name: "Set priority" }).click();
  expect((await bulked).ok()).toBe(true);
  await expect(row(page, "AT-SnoozeDue").getByTestId("task-level")).toHaveText("P4 low");
  await page.reload();
  await expect(row(page, "AT-SnoozeDue").getByTestId("task-level")).toHaveText("P4 low");
  await expect(row(page, "AT-SnoozeDue").getByTestId("task-private")).toBeVisible();
  expect(dates()).toMatchObject({ level: 4, visibility: "private" });
});

test("snooze moves a task made on the planner: its locked chunk is unlocked and placed again (TSK-24, TSK-7)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openWeek(page);
  await expect(page.getByRole("checkbox", { name: "Preview mode" })).toBeVisible();
  await page.locator(".week-scroll").evaluate((el) => {
    el.scrollTop = 8 * 48;
  });
  const click = await point(page, day(3), 10 * 60);
  await page.mouse.click(click.x, click.y + 2);
  await createHere(page, "AT-PlanSnooze");
  await eventually(
    () => allEvents(cal),
    (l) =>
      expect(titled(l, "AT-PlanSnooze").map((e) => [e.start, e.summary.includes("🔒")])).toEqual([
        [at(day(3), "10:00"), true],
      ]),
  );

  await page.goto("/tasks");
  const more = row(page, "AT-PlanSnooze").getByTestId("task-more");
  await more.locator("summary").click();
  await more.getByLabel("Snooze until").fill(`${day(4)}T13:00`);
  await more.getByRole("button", { name: "Snooze", exact: true }).click();
  const evs = await eventually(
    () => allEvents(cal),
    (l) =>
      expect(titled(l, "AT-PlanSnooze").map((e) => [e.start, e.end - e.start])).toEqual([
        [at(day(4), "13:00"), 60 * MIN],
      ]),
  );
  expect(titled(evs, "AT-PlanSnooze")[0]?.summary).not.toContain("🔒");
  await openWeek(page);
  await expect(page.locator(".ev", { hasText: "AT-PlanSnooze" })).not.toHaveClass(/ev-locked/);
  await page.reload();
  await planNow(page);
  const after = await allEvents(cal);
  expect(titled(after, "AT-PlanSnooze").map((e) => e.start)).toEqual([at(day(4), "13:00")]);
});

test("a private task writes private chunk events; the default comes from task settings and each task can change it (CNT-20, CNT-24)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "This check reads CLASS in the CalDAV event data.");
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-Private",
    minutes: 60,
    split: false,
    due: "",
    visibility: "Private",
  });
  await page.goto("/tasks");
  await addTask(page, { title: "AT-Default", minutes: 60, split: false, due: "" });
  const classOf = async (title: string) => {
    const [e] = titled(await allEvents(cal), title);
    return e ? eventProp(await rawEvent(e.id), "CLASS") : "missing";
  };
  await expect.poll(() => classOf("AT-Private"), { timeout: 45_000 }).toBe("PRIVATE");
  await expect.poll(() => classOf("AT-Default"), { timeout: 45_000 }).toBeNull();

  const more = row(page, "AT-Default").getByTestId("task-more");
  await more.locator("summary").click();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/api/tasks/"),
  );
  await more.getByLabel("Visibility").selectOption({ label: "Private" });
  expect((await saved).ok()).toBe(true);
  await expect.poll(() => classOf("AT-Default"), { timeout: 45_000 }).toBe("PRIVATE");

  await page.getByRole("link", { name: "Settings" }).click();
  await page
    .getByTestId("task-defaults")
    .getByLabel("Visibility")
    .selectOption({ label: "Private" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-NewPrivate" });
  await expect.poll(() => classOf("AT-NewPrivate"), { timeout: 45_000 }).toBe("PRIVATE");

  await page.reload();
  for (const t of ["AT-Private", "AT-Default", "AT-NewPrivate"])
    await expect(row(page, t).getByTestId("task-private")).toBeVisible();
});

test("task defaults in Settings fill new tasks: priority, duration, chunks, hours, start delay, due in and next up; older tasks keep theirs (TSK-1 to TSK-3)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const created0 = Date.now();
  await addTask(page, { title: "AT-Old" });

  await page.getByRole("link", { name: "Settings" }).click();
  const defaults = page.getByTestId("task-defaults");
  const change = async (label: string, value: string, select = false) => {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
    );
    const field = defaults.getByLabel(label);
    if (select) await field.selectOption({ label: value });
    else {
      await field.fill(value);
      await field.blur();
    }
    expect((await saved).ok()).toBe(true);
    await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  };
  await change("Priority", "P3 medium", true);
  await change("Duration (minutes)", "90");
  await change("Split into chunks", "No", true);
  await change("Hours", "Personal hours", true);
  await change("Start delay (minutes)", "120");
  await change("Due in (days)", "5");
  const nextUpSaved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
  );
  await defaults.getByLabel(/Next up/).check();
  expect((await nextUpSaved).ok()).toBe(true);

  await page.reload();
  const d = page.getByTestId("task-defaults");
  await expect(d.getByLabel("Priority")).toHaveValue("3");
  await expect(d.getByLabel("Duration (minutes)")).toHaveValue("90");
  await expect(d.getByLabel("Start delay (minutes)")).toHaveValue("120");
  await expect(d.getByLabel("Due in (days)")).toHaveValue("5");
  await expect(d.getByLabel(/Next up/)).toBeChecked();

  const created = Date.now();
  await addTask(page, { title: "AT-New" });
  const rows = app.query<{
    title: string;
    level: number;
    total_minutes: number;
    min_chunk_minutes: number;
    max_chunk_minutes: number;
    kind: string;
    start_after: number;
    due_at: number;
    next_up_rank: number | null;
  }>(
    `SELECT t.title, t.level, t.total_minutes, t.min_chunk_minutes, t.max_chunk_minutes, h.kind,
       t.start_after, t.due_at, t.next_up_rank
     FROM tasks t JOIN hours_sets h ON h.id = t.hours_set_id ORDER BY t.title`,
  );
  const [newer, older] = [
    rows.find((r) => r.title === "AT-New"),
    rows.find((r) => r.title === "AT-Old"),
  ];
  expect(newer).toMatchObject({
    level: 3,
    total_minutes: 90,
    min_chunk_minutes: 90,
    max_chunk_minutes: 90,
    kind: "personal",
  });
  expect(newer?.next_up_rank).not.toBeNull();
  // Relative to the creation time (TSK-2); allow the time the test took.
  expect(Math.abs((newer?.start_after ?? 0) - (created + 120 * MIN))).toBeLessThan(5 * MIN);
  expect(Math.abs((newer?.due_at ?? 0) - addLocalDays(created, 5, ZONE))).toBeLessThan(5 * MIN);
  // TSK-3: the task made before the change keeps the old defaults.
  expect(older).toMatchObject({ level: 2, total_minutes: 60, kind: "work", next_up_rank: null });
  expect(Math.abs((older?.start_after ?? 0) - created0)).toBeLessThan(5 * MIN);
  expect(Math.abs((older?.due_at ?? 0) - addLocalDays(created0, 3, ZONE))).toBeLessThan(5 * MIN);

  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-New")).toHaveLength(1),
  );
  const [e] = titled(evs, "AT-New");
  expect((e?.end ?? 0) - (e?.start ?? 0)).toBe(90 * MIN);
  expect(inHours(e?.start ?? 0, e?.end ?? 0, "18:00", "22:00")).toBe(true);

  await page.reload();
  await expect(row(page, "AT-New").getByTestId("task-level")).toHaveText("P3 medium");
  await expect(row(page, "AT-New").getByTestId("task-start")).toBeVisible();
  await expect(row(page, "AT-Old").getByTestId("task-level")).toHaveText("P2 high");
});

test("task defaults in Settings: the shortest and longest chunk fill new split tasks (TSK-1 to TSK-3)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  const defaults = page.getByTestId("task-defaults");
  await expect(defaults.getByLabel("Split into chunks")).toHaveValue("yes");
  for (const [label, value] of [
    ["Shortest chunk", "45"],
    ["Longest chunk", "60"],
  ] as const) {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
    );
    const field = defaults.getByLabel(label);
    await field.fill(value);
    await field.blur();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  }
  await page.reload();
  await expect(page.getByTestId("task-defaults").getByLabel("Shortest chunk")).toHaveValue("45");
  await expect(page.getByTestId("task-defaults").getByLabel("Longest chunk")).toHaveValue("60");

  // 180 minutes with chunks of 45 to 60 minutes: the out-of-the-box 30 to 120 would allow one 120-minute chunk.
  await addTask(page, { title: "AT-Chunks", minutes: 180, due: "" });
  expect(
    app.query<{ min_chunk_minutes: number; max_chunk_minutes: number }>(
      "SELECT min_chunk_minutes, max_chunk_minutes FROM tasks WHERE title = 'AT-Chunks'",
    ),
  ).toEqual([{ min_chunk_minutes: 45, max_chunk_minutes: 60 }]);
  const evs = await eventually(
    () => allEvents(cal),
    (l) => {
      const chunks = titled(l, "AT-Chunks");
      expect(chunks.reduce((a, e) => a + (e.end - e.start), 0)).toBe(180 * MIN);
    },
  );
  for (const e of titled(evs, "AT-Chunks")) {
    expect(e.end - e.start).toBeGreaterThanOrEqual(45 * MIN);
    expect(e.end - e.start).toBeLessThanOrEqual(60 * MIN);
  }
});

/** Viewport point of a local time in the planner column of a date, once the week is in place. */
async function point(page: Page, date: string, minute: number) {
  await weekInPlace(page);
  const box = await page.locator(`.day-col[data-date="${date}"]`).boundingBox();
  if (!box) throw new Error(`no column for ${date}`);
  return { x: box.x + box.width / 2, y: box.y + (minute / 60) * 48 };
}

async function createHere(page: Page, title: string) {
  const dialog = page.getByRole("dialog", { name: "Task at this time" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Title").fill(title);
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks/at",
  );
  await dialog.getByRole("button", { name: "Create task" }).click();
  expect((await created).status()).toBe(201);
  await expect(dialog).toBeHidden();
}

test("a drag on the planner makes a locked task of that length there; a click makes one of the default length (TSK-7, AT-T10)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openWeek(page);
  await expect(page.getByRole("checkbox", { name: "Preview mode" })).toBeVisible();
  await page.locator(".week-scroll").evaluate((el) => {
    el.scrollTop = 8 * 48;
  });

  const from = await point(page, day(1), 14 * 60);
  const to = await point(page, day(1), 15 * 60 + 30);
  await page.mouse.move(from.x, from.y + 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y - 2, { steps: 8 });
  await page.mouse.up();
  await createHere(page, "AT-T10");

  const click = await point(page, day(3), 10 * 60);
  await page.mouse.click(click.x, click.y + 2);
  await createHere(page, "AT-Click");

  const evs = await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "AT-T10").map((e) => [e.start, e.end])).toEqual([
        [at(day(1), "14:00"), at(day(1), "15:30")],
      ]);
      expect(titled(l, "AT-Click").map((e) => [e.start, e.end])).toEqual([
        [at(day(3), "10:00"), at(day(3), "11:00")],
      ]);
    },
  );
  for (const t of ["AT-T10", "AT-Click"]) {
    const [e] = titled(evs, t);
    expect(e?.summary, t).toContain("🔒");
    expect(e?.busy, t).toBe(true);
  }
  expect(
    app.query<{ title: string; total_minutes: number }>(
      "SELECT title, total_minutes FROM tasks ORDER BY title",
    ),
  ).toEqual([
    { title: "AT-Click", total_minutes: 60 },
    { title: "AT-T10", total_minutes: 90 },
  ]);
  await expect(page.locator(".ev", { hasText: "AT-Click" })).toHaveClass(/ev-locked/);

  // The next plan keeps both where the user put them.
  await planNow(page);
  await page.reload();
  await expect(page.locator(".ev", { hasText: "AT-Click" })).toHaveClass(/ev-locked/);
  const after = await allEvents(cal);
  for (const t of ["AT-T10", "AT-Click"])
    expect(titled(after, t).map((e) => [e.id, e.start, e.end])).toEqual(
      titled(evs, t).map((e) => [e.id, e.start, e.end]),
    );
});

test("a task row has the select box at its left, the title and details in the middle and the buttons at its right", async ({
  page,
  signIn,
}) => {
  await signIn();
  await addTask(page, { title: "AT-Row", minutes: 60, due: "" });
  const r = row(page, "AT-Row");
  await expect(r.getByTestId("task-state")).toHaveText("scheduled");
  await expect
    .poll(() =>
      r.evaluate((li) => {
        const rect = (el: Element | null | undefined) => {
          if (!el) throw new Error("missing part of the task row");
          return el.getBoundingClientRect();
        };
        const row = rect(li);
        const check = rect(li.querySelector(':scope > input[type="checkbox"]'));
        const body = rect(li.querySelector(":scope > div:not(.actions)"));
        const actions = rect(li.querySelector(":scope > .actions"));
        return {
          checkNarrow: check.width < 30,
          checkAtLeft: check.left - row.left < 30,
          bodyNextToCheck: body.left >= check.right && body.left - check.right < 30,
          actionsRightOfBody: actions.left >= body.right,
          actionsAtRight: row.right - actions.right < 30,
          actionsBesideBody: actions.top < body.bottom,
        };
      }),
    )
    .toEqual({
      checkNarrow: true,
      checkAtLeft: true,
      bodyNextToCheck: true,
      actionsRightOfBody: true,
      actionsAtRight: true,
      actionsBesideBody: true,
    });
});
