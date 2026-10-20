// The priorities page and the planner priorities view
// (docs/specs/planning-priorities.md PRI-51 to PRI-53; planning-next-up.md NXT-6).
//
// Ways this can fail, and the test that catches each:
// - A drag to another column or level changes the board but not the stored
//   level, or the scheduler does not follow it (both tests: the dragged P4
//   task must take the first slot from the P2 task).
// - The level menu saves nothing (both tests read the stored level).
// - The kind or hours filter shows other items; the column width is lost on
//   reload (page test).
// - The priorities page has no next-up action (page test: the queued P2 task
//   must go before the P1 task).
// - The planner view does not group by level and then by kind, the search
//   shows other items, or Edit opens nothing that saves (planner view test).
// - A level change moves a locked chunk (lock test).
// - The edit form edits only some fields, or cannot save a total that is not
//   a multiple of 15 minutes; an unknown id shows the create form with no
//   message (edit form test).
import type { Locator, Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addHabit, addTask, allEvents, openWeek, titled, W } from "./helpers.ts";

const titles = (area: Locator) =>
  area
    .locator('[data-testid="priority-item"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));
const item = (area: Locator | Page, name: string) =>
  area.locator(`[data-testid="priority-item"][data-name="${name}"]`);
/** The title of an item: a drag starts there, not on its level menu. */
const handle = (area: Locator | Page, name: string) =>
  item(area, name).getByText(name, { exact: true });

/** Waits for the save that `act` starts, and for the plan run after it. */
async function saved(page: Page, path: RegExp, act: () => Promise<unknown>) {
  const done = page.waitForResponse(
    (r) => r.request().method() === "POST" && path.test(new URL(r.url()).pathname),
  );
  const planned = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/planner/sync",
    { timeout: 60_000 },
  );
  await act();
  expect((await done).ok()).toBe(true);
  expect((await planned).ok()).toBe(true);
}

async function calendarOrder(
  cal: Parameters<typeof allEvents>[0],
  text: string,
  expected: string[],
) {
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, text).map((e) => e.summary.replace(/^\S+ /, ""))).toEqual(expected),
  );
  return local(titled(evs, text)[0]?.start ?? 0);
}

test("the priorities page shows P1 to P4 columns; a drag or the level menu changes the level, with kind and hours filters and a column width (PRI-51, PRI-52, NXT-6)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "PR-High", level: 2 });
  await addTask(page, { ...task, title: "PR-Low", level: 4 });
  await addTask(page, { ...task, title: "PE-Evening", level: 3, hours: "Personal hours" });
  await addHabit(page, { title: "PH-Walk", ideal: "13:00", min: 30, max: 30, level: 3 });
  expect(await calendarOrder(cal, "PR-", ["PR-High", "PR-Low"])).toBe(`${W} 09:00`);

  await page.getByRole("link", { name: "Priorities" }).click();
  const column = (level: number) =>
    page.locator(`[data-testid="priority-column"][data-level="${level}"]`);
  await expect(column(1)).toContainText("P1");
  await expect.poll(() => titles(column(2))).toEqual(["PR-High"]);
  await expect.poll(() => titles(column(3))).toEqual(["PH-Walk", "PE-Evening"]);
  await expect.poll(() => titles(column(4))).toEqual(["PR-Low"]);
  await expect(item(page, "PH-Walk")).toContainText("Habit");
  await expect(item(page, "PR-Low")).toContainText("Task");

  // PRI-51: a drag to the P1 column makes the task P1; it takes the first slot.
  await saved(page, /^\/api\/priorities$/, () => handle(page, "PR-Low").dragTo(column(1)));
  await expect.poll(() => titles(column(1))).toEqual(["PR-Low"]);
  expect(await calendarOrder(cal, "PR-", ["PR-Low", "PR-High"])).toBe(`${W} 09:00`);

  // PRI-51: the level menu on an item.
  await saved(page, /^\/api\/priorities$/, () =>
    item(page, "PH-Walk").getByLabel("Priority").selectOption({ label: "P1 critical" }),
  );
  await expect.poll(() => titles(column(1))).toEqual(["PH-Walk", "PR-Low"]);
  await expect
    .poll(() => app.query("SELECT level FROM habits WHERE title = 'PH-Walk'"))
    .toEqual([{ level: 1 }]);

  // PRI-52: filter by kind and by hours set.
  const board = page.getByTestId("priorities-page");
  await page.getByLabel("Kind").selectOption({ label: "Habits" });
  await expect.poll(() => titles(board)).toEqual(["PH-Walk"]);
  await page.getByLabel("Kind").selectOption({ label: "All kinds" });
  await page.getByLabel("Hours", { exact: true }).selectOption({ label: "Personal hours" });
  await expect.poll(() => titles(board)).toEqual(["PE-Evening"]);
  await page.getByLabel("Hours", { exact: true }).selectOption({ label: "All hours" });
  await expect.poll(() => titles(board)).toEqual(["PH-Walk", "PR-Low", "PR-High", "PE-Evening"]);

  // PRI-52: the column width; it stays after a reload, as does the new level.
  await expect(column(1)).toHaveCSS("width", "260px");
  await page.getByLabel("Column width").selectOption({ label: "Wide" });
  await expect(column(1)).toHaveCSS("width", "360px");
  await page.reload();
  await expect(column(1)).toHaveCSS("width", "360px");
  await expect.poll(() => titles(column(1))).toEqual(["PH-Walk", "PR-Low"]);
  await expect.poll(() => titles(column(4))).toEqual([]);

  // NXT-6: the next-up action on the priorities page; the P2 task goes first.
  await saved(page, /^\/api\/tasks\/[^/]+\/queue$/, () =>
    item(page, "PR-High").getByRole("button", { name: "Add to next up" }).click(),
  );
  await expect(item(page, "PR-High")).toContainText("next up");
  expect(await calendarOrder(cal, "PR-", ["PR-High", "PR-Low"])).toBe(`${W} 09:00`);
});

test("the planner priorities view groups items by level and kind, with a level menu, drag and drop, search and edit (PRI-53)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "PV-Other", level: 2 });
  await addTask(page, { ...task, title: "PV-Task", level: 4 });
  await addHabit(page, { title: "PVH-Habit", ideal: "13:00", min: 30, max: 30, level: 4 });
  expect(await calendarOrder(cal, "PV-", ["PV-Other", "PV-Task"])).toBe(`${W} 09:00`);

  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByTestId("now-bar").getByRole("button", { name: "Priorities" }).click();
  const panel = page.getByTestId("priorities-panel");
  const level = (l: number) => panel.locator(`[data-testid="priority-level"][data-level="${l}"]`);
  const kind = (l: number, k: string) =>
    level(l).locator(`[data-testid="priority-kind"][data-kind="${k}"]`);
  await expect(kind(4, "task")).toContainText("Tasks");
  await expect.poll(() => titles(kind(4, "task"))).toEqual(["PV-Task"]);
  await expect.poll(() => titles(kind(4, "habit"))).toEqual(["PVH-Habit"]);
  await expect.poll(() => titles(kind(2, "task"))).toEqual(["PV-Other"]);
  await expect(kind(4, "habit")).toContainText("Habits");

  // The search box keeps the matching items only.
  await panel.getByLabel("Search").fill("pv-t");
  await expect.poll(() => titles(panel)).toEqual(["PV-Task"]);
  await panel.getByLabel("Search").fill("");
  await expect.poll(() => titles(panel)).toEqual(["PV-Other", "PVH-Habit", "PV-Task"]);

  // Drag and drop to another level: the task becomes P1 and takes the first slot.
  await saved(page, /^\/api\/priorities$/, () => handle(panel, "PV-Task").dragTo(level(1)));
  await expect.poll(() => titles(kind(1, "task"))).toEqual(["PV-Task"]);
  expect(await calendarOrder(cal, "PV-", ["PV-Task", "PV-Other"])).toBe(`${W} 09:00`);

  // The level menu.
  await saved(page, /^\/api\/priorities$/, () =>
    item(panel, "PVH-Habit").getByLabel("Priority").selectOption({ label: "P2 high" }),
  );
  await expect.poll(() => titles(kind(2, "habit"))).toEqual(["PVH-Habit"]);
  await expect
    .poll(() => app.query("SELECT level FROM habits WHERE title = 'PVH-Habit'"))
    .toEqual([{ level: 2 }]);

  await page.reload();
  await page.getByTestId("now-bar").getByRole("button", { name: "Priorities" }).click();
  await expect.poll(() => titles(kind(1, "task"))).toEqual(["PV-Task"]);

  // Edit opens the item's form; the edit saves.
  await item(panel, "PV-Task").getByRole("link", { name: "Edit" }).click();
  const form = page.getByTestId("task-edit");
  await expect(form.getByLabel("Title")).toHaveValue("PV-Task");
  await form.getByLabel("Duration (minutes)").fill("90");
  await form.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(() => app.query("SELECT total_minutes, level FROM tasks WHERE title = 'PV-Task'"))
    .toEqual([{ total_minutes: 90, level: 1 }]);
  await eventually(
    () => allEvents(cal),
    (l) => {
      const [ev] = titled(l, "PV-Task");
      expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(90 * 60_000);
    },
  );
});

test("a level change on the priorities page leaves a locked task chunk in place (NXT-4, PRI-13)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "PL-Other", level: 2 });
  await addTask(page, { ...task, title: "PL-Locked", level: 3 });
  expect(await calendarOrder(cal, "PL-", ["PL-Other", "PL-Locked"])).toBe(`${W} 09:00`);
  // A move in the calendar locks the chunk there (CED-1).
  const tue = addDays(W, 1);
  const [chunk] = titled(await allEvents(cal), "PL-Locked");
  if (!chunk) throw new Error("no chunk");
  await cal.update(chunk.id, { start: at(tue, "15:00"), end: at(tue, "16:00") });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "PL-Locked")[0]?.summary).toBe("🔒 PL-Locked"),
  );

  await page.getByRole("link", { name: "Priorities" }).click();
  // Down: every open task is placed again. Up: the locked task would want 09:00.
  await saved(page, /^\/api\/priorities$/, () =>
    item(page, "PL-Other").getByLabel("Priority").selectOption({ label: "P4 low" }),
  );
  await saved(page, /^\/api\/priorities$/, () =>
    item(page, "PL-Locked").getByLabel("Priority").selectOption({ label: "P1 critical" }),
  );
  const evs = titled(await allEvents(cal), "PL-");
  expect(evs.map((e) => `${e.summary} ${local(e.start)}`)).toEqual([
    `○ PL-Other ${W} 09:00`,
    `🔒 PL-Locked ${tue} 15:00`,
  ]);
  await openWeek(page);
  await expect(page.locator(".ev-task.ev-locked", { hasText: "PL-Locked" })).toBeVisible();
});

test("the task edit form edits every field and saves a total that is not a multiple of 15 minutes (PRI-50, PRI-53)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // A default of 50 minutes gives a task whose total is not a multiple of 15.
  await page.evaluate(async () => {
    const json = { "content-type": "application/json" };
    const s = await fetch("/api/settings", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ taskDefaults: { minutes: 50, splitUp: false } }),
    });
    if (!s.ok) throw new Error(await s.text());
    const t = await fetch("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "PF-Odd", dueAt: null }),
    });
    if (!t.ok) throw new Error(await t.text());
    await fetch("/api/planner/sync", { method: "POST" });
  });
  const [{ id }] = app.query<{ id: string }>("SELECT id FROM tasks WHERE title = 'PF-Odd'") as [
    { id: string },
  ];
  await eventually(
    () => allEvents(cal),
    (l) => {
      const [ev] = titled(l, "PF-Odd");
      expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(50 * 60_000);
    },
  );

  await page.goto(`/tasks?edit=${id}`);
  const form = page.getByTestId("task-edit");
  await expect(form.getByLabel("Title")).toHaveValue("PF-Odd");
  await expect(form.getByLabel("Duration (minutes)")).toHaveValue("50");
  await expect(form.getByLabel("Split into chunks")).toHaveValue("no");
  await form.getByLabel("Title").fill("PF-Renamed");
  await form.getByLabel("Notes").fill("PF notes");
  await form.getByLabel("Priority").selectOption("3");
  await form.getByLabel("Due").fill(`${addDays(W, 4)}T17:00`);
  await form.getByLabel("Hours").selectOption({ label: "Personal hours" });
  await form.getByLabel("Color").selectOption({ label: "Calendar color" });
  await form.getByLabel(/Next up/).check();
  const patched = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/tasks/${id}`,
  );
  const queued = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === `/api/tasks/${id}/queue`,
  );
  await form.getByRole("button", { name: "Save" }).click();
  expect((await patched).ok()).toBe(true);
  expect((await queued).ok()).toBe(true);
  await expect(form).toBeHidden();
  await expect
    .poll(() =>
      app.query(
        `SELECT t.title, t.notes, t.level, t.total_minutes, t.color, t.next_up_rank, h.kind
         FROM tasks t JOIN hours_sets h ON h.id = t.hours_set_id WHERE t.id = ?`,
        id,
      ),
    )
    .toEqual([
      {
        title: "PF-Renamed",
        notes: "PF notes",
        level: 3,
        total_minutes: 50,
        color: "calendar_default",
        next_up_rank: 0,
        kind: "personal",
      },
    ]);
  await eventually(
    () => allEvents(cal),
    (l) => {
      const [ev] = titled(l, "PF-Renamed");
      expect((ev?.end ?? 0) - (ev?.start ?? 0)).toBe(50 * 60_000);
    },
  );

  // Reload: the edit form shows the saved values.
  await page.goto(`/tasks?edit=${id}`);
  await expect(form.getByLabel("Title")).toHaveValue("PF-Renamed");
  await expect(form.getByLabel("Notes")).toHaveValue("PF notes");
  await expect(form.getByLabel("Due")).toHaveValue(`${addDays(W, 4)}T17:00`);
  await expect(form.getByLabel("Hours")).toHaveValue(/.+/);
  await expect(form.getByLabel(/Next up/)).toBeChecked();

  // An id that is not an open task shows a message, not a silent create form.
  await page.goto("/tasks?edit=no-such-task");
  await expect(page.getByTestId("edit-missing")).toBeVisible();
});
