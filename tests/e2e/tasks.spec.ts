// Tasks: defaults, priority, dates, next up, free/busy status, notes, hours
// and the reasons shown for work that cannot be placed.
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, allEvents, inHours, MIN, openWeek, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);

test("a task with only a title gets P2, a due date in 3 days and work-hour chunks (TSK-1, AT-T3)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const created = Date.now();
  await addTask(page, { title: "AT-T3" });
  const row = page.locator('[data-task-title="AT-T3"]');
  await expect(row.getByTestId("task-level")).toHaveText("P2 high");
  const evs = await eventually(
    () => allEvents(cal),
    (list) =>
      expect(titled(list, "AT-T3").reduce((a, e) => a + (e.end - e.start), 0)).toBe(60 * MIN),
  );
  for (const e of titled(evs, "AT-T3")) expect(inHours(e.start, e.end)).toBe(true);
  await expect(page.locator('[data-task-title="AT-T3"]').getByTestId("task-due")).toBeVisible();
  const [stored] = app.query<{ due_at: number; level: number }>(
    "SELECT due_at, level FROM tasks WHERE title = 'AT-T3'",
  );
  // The form proposes now + 3 days when it opens; allow the time the test took.
  expect(Math.abs((stored?.due_at ?? 0) - (created + 3 * 86_400_000))).toBeLessThan(5 * MIN);
  await page.reload();
  await expect(page.locator('[data-task-title="AT-T3"]').getByTestId("task-level")).toHaveText(
    "P2 high",
  );
});

test("a P1 task takes the first free slot ahead of a P4 task, and due dates order one level (PRI-1, PRI-4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-P4 low", minutes: 60, split: false, level: 4, due: "" });
  await addTask(page, { title: "AT-P1 urgent", minutes: 60, split: false, level: 1, due: "" });
  await addTask(page, {
    title: "AT-P2 later",
    minutes: 60,
    split: false,
    level: 2,
    due: `${day(4)}T17:00`,
  });
  await addTask(page, {
    title: "AT-P2 sooner",
    minutes: 60,
    split: false,
    level: 2,
    due: `${day(1)}T17:00`,
  });
  const evs = await eventually(
    () => allEvents(cal),
    (list) => expect(titled(list, "AT-P").length).toBe(4),
  );
  const order = titled(evs, "AT-P").map((e) => e.summary.replace(/^\S+ /, ""));
  expect(order).toEqual(["AT-P1 urgent", "AT-P2 sooner", "AT-P2 later", "AT-P4 low"]);
  expect(local(titled(evs, "AT-P1")[0]?.start ?? 0)).toBe(`${W} 09:00`);
});

test("start after delays the first chunk (TSK-15)", async ({ page, cal, signIn }) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-Start",
    minutes: 60,
    split: false,
    due: "",
    startAfter: `${day(2)}T14:00`,
  });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Start")).toHaveLength(1),
  );
  expect(local(titled(evs, "AT-Start")[0]?.start ?? 0)).toBe(`${day(2)} 14:00`);
});

test("a next-up task goes before other tasks of any level (PRI-6, SCH-67)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Normal P1", minutes: 60, split: false, level: 1, due: "" });
  await addTask(page, {
    title: "AT-Now P4",
    minutes: 60,
    split: false,
    level: 4,
    due: "",
    nextUp: true,
  });
  await expect(page.locator('[data-task-title="AT-Now P4"]')).toContainText("next up");
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-N")).toHaveLength(2),
  );
  expect(local(titled(evs, "AT-Now")[0]?.start ?? 0)).toBe(`${W} 09:00`);
  expect(local(titled(evs, "AT-Normal")[0]?.start ?? 0)).toBe(`${W} 10:00`);
});

test("work that misses its due date goes late, turns busy and shows why (TSK-21, DEF-12, CNT-1)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Offsite", start: at(W, "09:00"), end: at(W, "17:00") });
  await signIn();
  await addTask(page, { title: "AT-Late", minutes: 60, split: false, due: `${W}T17:00` });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Late")).toHaveLength(1),
  );
  const [chunk] = titled(evs, "AT-Late");
  expect(local(chunk?.start ?? 0)).toBe(`${day(1)} 09:00`);
  expect(chunk?.busy).toBe(true);
  expect(chunk?.summary).toBe("● AT-Late");
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.locator('[data-task-title="AT-Late"]').getByTestId("task-issue")).toContainText(
    "after the due date",
  );
});

test("a chunk with room to spare stays free; the last chance turns busy (DEF-10, DEF-11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Roomy", minutes: 60, split: false, due: `${day(4)}T17:00` });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Roomy")).toHaveLength(1),
  );
  const [chunk] = titled(evs, "AT-Roomy");
  expect(chunk?.busy).toBe(false);
  expect(chunk?.summary).toBe("○ AT-Roomy");
  // Fill the rest of the week: the chunk becomes the only way and turns busy.
  for (let i = 0; i < 5; i++) {
    const d = day(i);
    if (local(chunk?.start ?? 0).startsWith(d)) {
      await cal.addEvent({ title: "Busy", start: at(d, "10:00"), end: at(d, "17:00") });
    } else {
      await cal.addEvent({ title: "Busy", start: at(d, "09:00"), end: at(d, "17:00") });
    }
  }
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Roomy")[0]?.busy).toBe(true),
  );
  await openWeek(page);
  await expect(page.locator(".ev-task", { hasText: "AT-Roomy" })).not.toHaveClass(/ev-free/);
});

test("add time places more work and reopens a done task; filters show each state (TSK-30, TSK-41)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-More", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-More")).toHaveLength(1),
  );
  const row = page.locator('[data-task-title="AT-More"]');
  await expect(row.getByTestId("task-state")).toHaveText("scheduled");
  await row.getByRole("button", { name: "Done" }).click();
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-More")).toHaveLength(0),
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const doneRow = page.locator('[data-task-title="AT-More"]');
  await expect(doneRow.getByTestId("task-state")).toHaveText("done");
  await doneRow.getByRole("button", { name: "+30 min" }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.locator('[data-task-title="AT-More"]')).toBeVisible();
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-More").reduce((a, e) => a + (e.end - e.start), 0)).toBe(90 * MIN),
  );
  expect(titled(evs, "AT-More").length).toBeGreaterThan(0);
});

test("a chunk too long for any hours range is not placed and shows the reason (SCH-116)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Huge", minutes: 600, split: false, due: "" });
  await expect(page.locator('[data-task-title="AT-Huge"]').getByTestId("task-issue")).toContainText(
    "longer than any range",
  );
  await expect(page.locator('[data-task-title="AT-Huge"]').getByTestId("task-state")).toHaveText(
    "unscheduled",
  );
  expect(titled(await allEvents(cal), "AT-Huge")).toHaveLength(0);
  await openWeek(page);
  await page.getByTestId("issues").locator("summary").click();
  await expect(page.getByTestId("issues")).toContainText("longer than any range");
});

test("task notes go into the event description (CNT-10)", async ({ page, cal, signIn }) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-Notes",
    minutes: 30,
    split: false,
    due: "",
    notes: "Outline: intro, data, close",
  });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Notes")).toHaveLength(1),
  );
  expect(titled(evs, "AT-Notes")[0]?.description).toContain("Outline: intro, data, close");
});

test("a task on personal hours is placed in the evening (HRS-1)", async ({ page, cal, signIn }) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, {
    title: "AT-Evening",
    minutes: 60,
    split: false,
    due: "",
    hours: "Personal hours",
  });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Evening")).toHaveLength(1),
  );
  const [e] = titled(evs, "AT-Evening");
  expect(inHours(e?.start ?? 0, e?.end ?? 0, "18:00", "22:00")).toBe(true);
});

test("a title typed while the last task is still being planned is kept", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Tasks" }).click();
  // Hold the plan run that follows the save until the next title is typed.
  let release = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  let holding: () => void = () => {};
  const reached = new Promise<void>((r) => {
    holding = r;
  });
  await page.route("**/api/planner/sync", async (route) => {
    holding();
    await held;
    await route.continue();
  });
  const form = page.getByTestId("task-form");
  await form.getByLabel("Title").fill("AT-First");
  await form.getByRole("button", { name: "Add task" }).click();
  await reached;
  await form.getByLabel("Title").fill("AT-Second");
  const done = page.waitForResponse((r) => r.url().includes("/api/planner/sync"));
  release();
  await done;
  await expect(page.locator('[data-task-title="AT-First"]')).toBeVisible();
  await expect(form.getByLabel("Title")).toHaveValue("AT-Second");
  await page.unroute("**/api/planner/sync");
});
