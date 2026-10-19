// Task flows of the current reference: the New task form with "create
// another", suggestions-only placement, the Suggested now and At risk lists,
// the next-up task, tasks suggested in focus time, and work blocks on
// request as a preview (docs/specs/planning-tasks.md TSK-5, TSK-6, TSK-70;
// docs/specs/planning-next-up.md NXT-20, NXT-30 to NXT-33, NXT-50;
// docs/specs/platform-current-version.md rule 9, T1).
//
// Ways it can fail, and the check that catches each:
// - the form closes with "create another" on, or stays open with it off  -> dialog visible / hidden
// - the next task keeps the last title                                    -> empty title after save
// - the key C opens nothing, or opens the form while the user types        -> dialog after "c" / not
// - tasks made in a row are not all placed                                 -> Radicale events
// - suggestions mode keeps chunk events, or chunks never come back         -> Radicale before/after
// - a task that starts later is suggested; an open one is missing          -> Suggested now contents
// - the lists ignore scheduler order (P1 before P4)                        -> list order
// - At risk misses a past-due task or one due within 48 hours              -> At risk contents
// - a done task stays in the lists                                         -> lists after Done
// - the next-up task ignores the chunk in progress                         -> next up after a move
// - focus time shows no suggestions, or tasks still get events            -> drawer list, Radicale
// - Block time writes before Apply, or Discard writes anything             -> Radicale empty
// - a moved preview block is applied at its old time                       -> Radicale times
// - applied blocks are not locked, so the next plan deletes them           -> lock marker after plan
// - a reload loses the mode, the lists or the blocks                       -> reload checks
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { toLocalInput } from "../../src/web/lib/format.ts";
import { blockUntil, eventually, expect, planNow, test, ZONE } from "./fixtures.ts";
import { addTask, allEvents, MIN, openEvent, openWeek, titled, W } from "./helpers.ts";
import { alwaysHours, chooseSetting } from "./s3-helpers.ts";

const day = (n: number) => addDays(W, n);

const setPlacement = (
  page: Page,
  mode: "Task events in my calendar" | "Suggestions only (no task events)",
) => chooseSetting(page, "Task placement", mode);

async function openTasksPanel(page: Page) {
  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByTestId("now-bar").getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByTestId("tasks-panel")).toBeVisible();
}

const listed = (page: Page, list: "suggested-now" | "at-risk") =>
  page.getByTestId(list).locator("[data-task-title]");

test("the New task form keeps open for the next task with Create another, and closes without it (TSK-5, TSK-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await expect(page.getByTestId("planner")).toBeVisible();
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New task" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Create another").check();
  for (const title of ["AT-CA1", "AT-CA2"]) {
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Split into chunks").selectOption("no");
    await dialog.getByRole("button", { name: "Add task" }).click();
    await expect(dialog.getByTestId("created")).toContainText(title);
    await expect(dialog.getByLabel("Title")).toHaveValue("");
  }
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Create another").uncheck();
  await dialog.getByLabel("Title").fill("AT-CA3");
  await dialog.getByRole("button", { name: "Add task" }).click();
  await expect(dialog).toBeHidden();

  // The nav button opens the same form; typing "c" in a field does not.
  await page.getByRole("link", { name: "Tasks" }).click();
  await page.getByTestId("task-form").getByLabel("Title").pressSequentially("acc");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New task" })).toBeHidden();

  await eventually(
    () => allEvents(cal),
    (l) => {
      for (const t of ["AT-CA1", "AT-CA2", "AT-CA3"]) {
        expect(titled(l, t)).toHaveLength(1);
        expect((titled(l, t)[0]?.end ?? 0) - (titled(l, t)[0]?.start ?? 0)).toBe(60 * MIN);
      }
    },
  );
  await page.reload();
  for (const t of ["AT-CA1", "AT-CA2", "AT-CA3"])
    await expect(page.locator(`[data-task-title="${t}"]`)).toBeVisible();
});

test("suggestions-only mode removes task events and lists tasks as Suggested now and At risk (TSK-70, NXT-30 to NXT-33)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const now = Date.now();
  // The form keeps the last values, so each task sets its own priority and dates.
  await addTask(page, { title: "AT-S1 low", minutes: 60, split: false, level: 4, due: "" });
  await addTask(page, { title: "AT-S2 top", minutes: 60, split: false, level: 1, due: "" });
  await addTask(page, {
    title: "AT-S4 soon",
    minutes: 60,
    split: false,
    level: 2,
    due: toLocalInput(ZONE, now + 24 * 60 * MIN),
  });
  await addTask(page, {
    title: "AT-S5 overdue",
    minutes: 60,
    split: false,
    level: 2,
    startAfter: toLocalInput(ZONE, now - 3 * 24 * 60 * MIN),
    due: toLocalInput(ZONE, now - 24 * 60 * MIN),
  });
  await addTask(page, {
    title: "AT-S3 later",
    minutes: 60,
    split: false,
    level: 2,
    due: "",
    startAfter: `${day(4)}T10:00`,
  });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-S")).toHaveLength(5),
  );

  await setPlacement(page, "Suggestions only (no task events)");
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-S")).toHaveLength(0),
  );
  await openTasksPanel(page);
  await expect(listed(page, "suggested-now")).toHaveText([
    /AT-S2 top/,
    /AT-S5 overdue/,
    /AT-S4 soon/,
    /AT-S1 low/,
  ]);
  await expect(listed(page, "at-risk")).toHaveText([/AT-S5 overdue/, /AT-S4 soon/]);
  await expect(page.getByTestId("now-bar").getByTestId("next-up")).toContainText("AT-S2 top");

  await page.getByRole("link", { name: "Tasks" }).click();
  await page
    .locator('[data-task-title="AT-S5 overdue"]')
    .getByRole("button", { name: "Done" })
    .click();
  await expect(page.locator('[data-task-title="AT-S5 overdue"]')).toBeHidden();
  await page.reload();
  await openTasksPanel(page);
  await expect(listed(page, "suggested-now")).toHaveText([/AT-S2 top/, /AT-S4 soon/, /AT-S1 low/]);
  await expect(listed(page, "at-risk")).toHaveText([/AT-S4 soon/]);
  await planNow(page);
  expect(titled(await allEvents(cal), "AT-S")).toHaveLength(0);

  await setPlacement(page, "Task events in my calendar");
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-S")).toHaveLength(4),
  );
});

test("the next-up task is the one in progress, else the earliest chunk, else scheduler order (NXT-20)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await alwaysHours(page);
  await addTask(page, {
    title: "AT-NX top",
    minutes: 60,
    split: false,
    level: 1,
    due: "",
    hours: "AT-Always",
  });
  await addTask(page, {
    title: "AT-NX low",
    minutes: 60,
    split: false,
    level: 3,
    due: "",
    hours: "AT-Always",
  });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-NX")).toHaveLength(2),
  );
  await page.getByRole("link", { name: "Planner" }).click();
  const nextUp = page.getByTestId("now-bar").getByTestId("next-up");
  await expect(nextUp).toContainText("AT-NX top");

  // The user starts the P3 task early in the calendar: it is now in progress.
  const [low] = titled(evs, "AT-NX low");
  if (!low) throw new Error("no chunk");
  const start = Math.floor(Date.now() / MIN) * MIN - 10 * MIN;
  await cal.update(low.id, { start, end: start + 60 * MIN });
  // The moved chunk has started, so it keeps its title; the P1 chunk moves out of its way.
  await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "AT-NX low")[0]?.start).toBe(start);
      expect(titled(l, "AT-NX top")[0]?.start).toBeGreaterThanOrEqual(start + 60 * MIN);
    },
  );
  await expect(nextUp).toContainText("AT-NX low");
  await page.reload();
  await expect(nextUp).toContainText("AT-NX low");

  await page.getByRole("link", { name: "Tasks" }).click();
  await page.locator('[data-task-title="AT-NX low"]').getByRole("button", { name: "Done" }).click();
  await page.getByRole("link", { name: "Planner" }).click();
  await expect(nextUp).toContainText("AT-NX top");
});

test("in suggestions mode, focus time lists the tasks to work on and tasks get no events (platform-current-version T1)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await setPlacement(page, "Suggestions only (no task events)");
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, {
    title: "Quarterly report",
    minutes: 180,
    due: `${day(4)}T17:00`,
  });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "Focus time").length).toBeGreaterThan(1),
  );
  expect(titled(await allEvents(cal), "Quarterly report")).toHaveLength(0);
  await openWeek(page);
  await openEvent(page, "Focus time");
  await expect(
    page.getByTestId("focus-suggestions").locator('[data-task-title="Quarterly report"]'),
  ).toBeVisible();
  await page.reload();
  await openEvent(page, "Focus time");
  await expect(
    page.getByTestId("focus-suggestions").locator('[data-task-title="Quarterly report"]'),
  ).toBeVisible();
  await planNow(page);
  expect(titled(await allEvents(cal), "Quarterly report")).toHaveLength(0);
});

test("Block time proposes work blocks as a preview; Discard writes nothing, a moved block and Apply write locked events (NXT-50)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await setPlacement(page, "Suggestions only (no task events)");
  await addTask(page, { title: "AT-WB", minutes: 120, min: 60, max: 60, due: "" });
  await openWeek(page);
  const preview = page.getByTestId("block-preview");
  const blockTime = async () => {
    await page.getByTestId("now-bar").getByRole("button", { name: "Tasks" }).click();
    await page
      .getByTestId("suggested-now")
      .locator('[data-task-title="AT-WB"]')
      .getByRole("button", { name: "Block time" })
      .click();
    await expect(preview).toContainText("2 work blocks for AT-WB");
    await expect(page.locator(".ev-preview")).toHaveCount(2);
  };
  await blockTime();
  await planNow(page);
  expect(titled(await allEvents(cal), "AT-WB")).toHaveLength(0);
  await preview.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".ev-preview")).toHaveCount(0);
  await planNow(page);
  expect(titled(await allEvents(cal), "AT-WB")).toHaveLength(0);

  // Change one block by dragging it 4 hours later, then apply.
  await blockTime();
  const first = page.locator(".ev-preview").first();
  const before = Number(await first.getAttribute("data-start"));
  const b = await first.boundingBox();
  if (!b) throw new Error("no box");
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 96, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 192, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(`.ev-preview[data-start="${before + 240 * MIN}"]`)).toHaveCount(1);
  const starts = (
    await page
      .locator(".ev-preview")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-start")))
  ).map(Number);
  await preview.getByRole("button", { name: "Apply" }).click();
  await expect(preview).toBeHidden();
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-WB")).toHaveLength(2),
  );
  expect(
    titled(evs, "AT-WB")
      .map((e) => e.start)
      .sort(),
  ).toEqual([...starts].sort());
  for (const e of titled(evs, "AT-WB")) {
    expect(e.summary.startsWith("🔒")).toBe(true);
    expect(e.busy).toBe(true);
    expect(e.end - e.start).toBe(60 * MIN);
  }
  await planNow(page);
  await page.reload();
  await expect(page.locator(".ev-task.ev-locked", { hasText: "AT-WB" })).toHaveCount(2);
  expect(
    titled(await allEvents(cal), "AT-WB")
      .map((e) => e.start)
      .sort(),
  ).toEqual([...starts].sort());
});
