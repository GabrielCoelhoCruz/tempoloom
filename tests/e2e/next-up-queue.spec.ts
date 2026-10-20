// The next-up queue (docs/specs/planning-next-up.md NXT-2, NXT-3, NXT-5,
// NXT-6, NXT-9 to NXT-11): rank by drag and drop, add and remove with the
// arrows or by drag and drop, on the tasks page and in the planner tasks panel.
//
// Ways this can fail, and the test that catches each:
// - A drag changes the list but not the stored rank, or the scheduler keeps
//   the old placement (rank test: the calendar order must swap).
// - A new queue entry does not go last (rank test: the first order).
// - The arrows or a drag into the queue area do not add the task, or the
//   scheduler ignores the new entry (add and remove test: the P4 task must
//   take the first slot from the P1 task).
// - The down arrow or a drag out of the queue area keeps the task in the
//   queue (add and remove test: the P1 task takes the first slot back).
// - Done keeps the task in the queue, so add time brings it back queued
//   (add and remove test).
// - The planner tasks panel has no add action (panel test).
// - An up arrow places every open task again, so a task that the user did not
//   touch leaves the slot it kept (SCH-88) for an earlier one (sticky test).
import type { Page } from "@playwright/test";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

const queue = (page: Page) => page.getByTestId("next-up-queue");
const rest = (page: Page) => page.getByTestId("task-list");
const row = (page: Page, title: string) => page.locator(`[data-task-title="${title}"]`);
const names = (area: ReturnType<typeof queue>) =>
  area
    .locator("[data-task-title]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-task-title")));

/** Waits for the queue save that `act` starts, and for the plan run after it. */
async function saveQueue(page: Page, act: () => Promise<unknown>) {
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/api\/tasks\/[^/]+\/queue$/.test(new URL(r.url()).pathname),
  );
  const planned = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/planner/sync",
    { timeout: 60_000 },
  );
  await act();
  expect((await saved).ok()).toBe(true);
  expect((await planned).ok()).toBe(true);
}

/** The titles of the managed events that hold `text`, in time order, and the first start. */
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

test("dragging a task inside the next-up queue changes its rank, and the scheduler places the queue in the new order (NXT-2, NXT-3, NXT-9)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, level: 2, due: "", nextUp: true } as const;
  await addTask(page, { ...task, title: "Q-First" });
  await addTask(page, { ...task, title: "Q-Second" });
  // NXT-9: a new entry gets the last rank.
  await expect.poll(() => names(queue(page))).toEqual(["Q-First", "Q-Second"]);
  expect(await calendarOrder(cal, "Q-", ["Q-First", "Q-Second"])).toBe(`${W} 09:00`);

  // NXT-2: drop the second entry on the first one; it takes its rank.
  await saveQueue(page, () => row(page, "Q-Second").dragTo(row(page, "Q-First")));
  await expect.poll(() => names(queue(page))).toEqual(["Q-Second", "Q-First"]);
  // NXT-3: the new first entry gets the earliest time.
  expect(await calendarOrder(cal, "Q-", ["Q-Second", "Q-First"])).toBe(`${W} 09:00`);

  await page.reload();
  await expect.poll(() => names(queue(page))).toEqual(["Q-Second", "Q-First"]);
});

test("the up and down arrows and drag and drop add a task to the next-up queue and take it out (NXT-5, NXT-10, NXT-11)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "QA-Urgent", level: 1 });
  await addTask(page, { ...task, title: "QA-Low", level: 4 });
  expect(await calendarOrder(cal, "QA-", ["QA-Urgent", "QA-Low"])).toBe(`${W} 09:00`);
  // NXT-5: the queue area is at the top of the task list, with a dashed outline.
  await expect(queue(page)).toHaveCSS("border-top-style", "dashed");
  await expect.poll(() => names(queue(page))).toEqual([]);

  // The up arrow adds; the queue task goes before the P1 task.
  await saveQueue(page, () =>
    row(page, "QA-Low").getByRole("button", { name: "Add to next up" }).click(),
  );
  await expect.poll(() => names(queue(page))).toEqual(["QA-Low"]);
  expect(await calendarOrder(cal, "QA-", ["QA-Low", "QA-Urgent"])).toBe(`${W} 09:00`);

  // NXT-10: the down arrow takes it out; priority order is back.
  await saveQueue(page, () =>
    row(page, "QA-Low").getByRole("button", { name: "Remove from next up" }).click(),
  );
  await expect.poll(() => names(queue(page))).toEqual([]);
  await expect.poll(() => names(rest(page))).toEqual(["QA-Urgent", "QA-Low"]);
  expect(await calendarOrder(cal, "QA-", ["QA-Urgent", "QA-Low"])).toBe(`${W} 09:00`);

  // NXT-5 and NXT-10 by drag and drop: into the queue area, then out of it.
  await saveQueue(page, () => row(page, "QA-Low").dragTo(queue(page)));
  await expect.poll(() => names(queue(page))).toEqual(["QA-Low"]);
  expect(await calendarOrder(cal, "QA-", ["QA-Low", "QA-Urgent"])).toBe(`${W} 09:00`);
  await page.reload();
  await expect.poll(() => names(queue(page))).toEqual(["QA-Low"]);
  await saveQueue(page, () => row(page, "QA-Low").dragTo(rest(page)));
  await expect.poll(() => names(queue(page))).toEqual([]);
  expect(await calendarOrder(cal, "QA-", ["QA-Urgent", "QA-Low"])).toBe(`${W} 09:00`);

  // NXT-11: marking a queue task done takes it out of the queue for good.
  await saveQueue(page, () =>
    row(page, "QA-Urgent").getByRole("button", { name: "Add to next up" }).click(),
  );
  await expect.poll(() => names(queue(page))).toEqual(["QA-Urgent"]);
  await row(page, "QA-Urgent").getByRole("button", { name: "Done" }).click();
  await expect(row(page, "QA-Urgent")).toBeHidden();
  await expect
    .poll(() => app.query("SELECT next_up_rank FROM tasks WHERE title = 'QA-Urgent'"))
    .toEqual([{ next_up_rank: null }]);
  // Add time reopens the task (TSK-41); it comes back outside the queue.
  const filter = page.getByTestId("task-filter");
  await filter.getByRole("button", { name: "Done" }).click();
  await row(page, "QA-Urgent").getByRole("button", { name: "+30 min" }).click();
  await expect
    .poll(() => app.query("SELECT status FROM tasks WHERE title = 'QA-Urgent'"))
    .toEqual([{ status: "open" }]);
  await filter.getByRole("button", { name: "Open" }).click();
  await expect(row(page, "QA-Urgent")).toBeVisible();
  await expect.poll(() => names(queue(page))).toEqual([]);
});

test("the planner tasks panel adds a task to the next-up queue with its up arrow (NXT-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "QP-Urgent", level: 1 });
  await addTask(page, { ...task, title: "QP-Low", level: 4 });
  expect(await calendarOrder(cal, "QP-", ["QP-Urgent", "QP-Low"])).toBe(`${W} 09:00`);

  await page.getByRole("link", { name: "Planner" }).click();
  await page.getByTestId("now-bar").getByRole("button", { name: "Tasks" }).click();
  const panel = page.getByTestId("tasks-panel");
  const suggested = panel.getByTestId("suggested-now").locator("[data-task-title]");
  await expect(suggested).toHaveText([/QP-Urgent/, /QP-Low/]);
  await saveQueue(page, () =>
    panel
      .getByTestId("suggested-now")
      .locator('[data-task-title="QP-Low"]')
      .getByRole("button", { name: "Add to next up" })
      .click(),
  );
  await expect(suggested).toHaveText([/QP-Low/, /QP-Urgent/]);
  await expect(
    panel.locator('[data-task-title="QP-Low"]').getByRole("button", { name: "Add to next up" }),
  ).toHaveCount(0);
  expect(await calendarOrder(cal, "QP-", ["QP-Low", "QP-Urgent"])).toBe(`${W} 09:00`);

  await page.getByRole("link", { name: "Tasks" }).click();
  await expect.poll(() => names(queue(page))).toEqual(["QP-Low"]);
});

test("an up arrow click moves only the task it adds to the next-up queue; other tasks keep their events (SCH-88, NXT-5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday 09:00 to 12:00 is busy while QS-Kept is placed, so it gets 12:00.
  const busy = await cal.addEvent({ title: "QS-Busy", start: at(W, "09:00"), end: at(W, "12:00") });
  await signIn();
  const task = { minutes: 60, split: false, due: "" } as const;
  await addTask(page, { ...task, title: "QS-Kept", level: 2 });
  expect(await calendarOrder(cal, "QS-Kept", ["QS-Kept"])).toBe(`${W} 12:00`);
  // The morning is free again; QS-Kept keeps its slot (no rule change), and a
  // new task takes the free 09:00. A fresh placement of QS-Kept would take 09:00.
  await cal.remove(busy);
  await addTask(page, { ...task, title: "QS-Up", level: 4 });
  const before = await eventually(
    () => allEvents(cal),
    (l) =>
      expect(
        titled(l, "QS-").map((e) => `${e.summary.replace(/^\S+ /, "")} ${local(e.start)}`),
      ).toEqual([`QS-Up ${W} 09:00`, `QS-Kept ${W} 12:00`]),
  );
  const kept = titled(before, "QS-Kept")[0];

  await saveQueue(page, () =>
    row(page, "QS-Up").getByRole("button", { name: "Add to next up" }).click(),
  );
  await expect.poll(() => names(queue(page))).toEqual(["QS-Up"]);
  const after = titled(await allEvents(cal), "QS-");
  expect(after.map((e) => `${e.summary.replace(/^\S+ /, "")} ${local(e.start)}`)).toEqual([
    `QS-Up ${W} 09:00`,
    `QS-Kept ${W} 12:00`,
  ]);
  expect(titled(after, "QS-Kept")[0]?.id).toBe(kept?.id);
  await page.reload();
  await expect.poll(() => names(queue(page))).toEqual(["QS-Up"]);
});
