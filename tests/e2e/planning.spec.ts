// End-to-end: sign-in, tasks, user edits in the calendar, habits, buffers and
// focus time, against a real calendar. Scenario names cite the spec they prove.
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  eventually,
  expect,
  local,
  managed,
  planNow,
  test,
  testWeek,
} from "./fixtures.ts";

const MIN = 60_000;
const W = testWeek();
const windowFrom = () => Date.now() - 3_600_000;
const windowTo = () => at(addDays(W, 21), "00:00");
const titled = (
  events: Awaited<ReturnType<import("./fixtures.ts").CalendarDriver["events"]>>,
  text: string,
) =>
  managed(events)
    .filter((e) => e.summary.includes(text))
    .sort((a, b) => a.start - b.start);
const inWorkHours = (t0: number, t1: number) => {
  const [d0, h0] = local(t0).split(" ");
  const [d1, h1] = local(t1).split(" ");
  return d0 === d1 && (h0 ?? "") >= "09:00" && (h1 ?? "") <= "17:00";
};

async function addTask(
  page: import("@playwright/test").Page,
  t: { title: string; minutes: number; min?: number; max?: number; split?: boolean },
) {
  await page.getByRole("link", { name: "Tasks" }).click();
  const form = page.getByTestId("task-form");
  await form.getByLabel("Title").fill(t.title);
  await form.getByLabel("Duration (minutes)").fill(String(t.minutes));
  await form.getByLabel("Due").fill("");
  if (t.split === false) await form.getByLabel("Split into chunks").selectOption("no");
  if (t.min) await form.getByLabel("Shortest chunk").fill(String(t.min));
  if (t.max) await form.getByLabel("Longest chunk").fill(String(t.max));
  await form.getByRole("button", { name: "Add task" }).click();
  await expect(page.locator(`[data-task-title="${t.title}"]`)).toBeVisible();
}

test("signs in with CalDAV, rejects a wrong password, and keeps the session (SPEC-ACCT-02)", async ({
  page,
  app,
  radicale,
  cal,
}) => {
  test.skip(BACKEND !== "caldav", "This scenario tests the CalDAV sign-in form.");
  if (!radicale) throw new Error("No CalDAV server");
  expect(cal.calendarId).toContain("/work-");
  await page.goto(app.baseUrl);
  const form = page.getByTestId("caldav-form");
  await form.getByLabel("CalDAV server URL").fill(radicale.url);
  await form.getByLabel("User name", { exact: true }).fill(radicale.username);
  await form.getByLabel("Password", { exact: true }).fill("not-the-password");
  await form.getByLabel(/^Email/).fill("e2e@tempoloom.test");
  await form.getByRole("button", { name: /sign in with caldav/i }).click();
  await expect(form.getByRole("alert")).toHaveText(/rejected/);
  await form.getByLabel("Password", { exact: true }).fill(radicale.password);
  await form.getByRole("button", { name: /sign in with caldav/i }).click();
  await expect(page.getByTestId("user-email")).toHaveText("e2e@tempoloom.test");
  await page.reload();
  await expect(page.getByTestId("user-email")).toHaveText("e2e@tempoloom.test");
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Work");
});

test("places a split task in work hours and keeps it after reload and restart (SPEC-PLANNING-01 AT 1)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-T1 Report", minutes: 180, min: 60, max: 120 });
  const chunks = await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) =>
      expect(titled(evs, "AT-T1 Report").reduce((a, e) => a + (e.end - e.start), 0)).toBe(
        180 * MIN,
      ),
  );
  const placed = titled(chunks, "AT-T1 Report");
  for (const c of placed) {
    expect((c.end - c.start) / MIN).toBeGreaterThanOrEqual(60);
    expect((c.end - c.start) / MIN).toBeLessThanOrEqual(120);
    expect(inWorkHours(c.start, c.end)).toBe(true);
    expect(c.start).toBeGreaterThanOrEqual(at(W, "09:00"));
  }
  for (let i = 1; i < placed.length; i++) {
    expect((placed[i]?.start ?? 0) - (placed[i - 1]?.end ?? 0)).toBeGreaterThanOrEqual(15 * MIN);
  }
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(
    page.locator('[data-task-title="AT-T1 Report"] [data-testid="task-state"]'),
  ).toHaveText("scheduled");

  // Reload and restart: same events, same ids, no duplicates.
  await page.reload();
  await expect(page.locator('[data-task-title="AT-T1 Report"]')).toBeVisible();
  await app.restart();
  await planNow(page);
  const after = titled(await cal.events(windowFrom(), windowTo()), "AT-T1 Report");
  expect(after.map((e) => [e.id, e.start, e.end])).toEqual(
    placed.map((e) => [e.id, e.start, e.end]),
  );
});

test("moves a chunk away from a new meeting and never touches the meeting (SCH-1, SCH-55)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-S16", minutes: 60, split: false });
  const [first] = titled(
    await eventually(
      () => cal.events(windowFrom(), windowTo()),
      (evs) => expect(titled(evs, "AT-S16")).toHaveLength(1),
    ),
    "AT-S16",
  );
  if (!first) throw new Error("no chunk");
  const meeting = await cal.addEvent({
    title: "Customer call",
    start: first.start,
    end: first.end,
  });
  const moved = await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) => {
      const [c] = titled(evs, "AT-S16");
      expect(c && (c.end <= first.start || c.start >= first.end)).toBe(true);
    },
  );
  const [chunk] = titled(moved, "AT-S16");
  expect(chunk?.id).toBe(first.id);
  const call = moved.find((e) => e.id === meeting);
  expect(call && [call.start, call.end, call.summary]).toEqual([
    first.start,
    first.end,
    "Customer call",
  ]);
});

test("a drag in the planner moves the chunk and locks it there (CED-50, LCK-2)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Drag", minutes: 60, split: false });
  const [chunk] = titled(
    await eventually(
      () => cal.events(windowFrom(), windowTo()),
      (evs) => expect(titled(evs, "AT-Drag")).toHaveLength(1),
    ),
    "AT-Drag",
  );
  if (!chunk) throw new Error("no chunk");
  await page.getByRole("link", { name: "Planner" }).click();
  while (!(await page.getByTestId("week-label").innerText()).includes(W)) {
    await page.getByRole("button", { name: "Next week" }).click();
  }
  const box = page.locator(".ev-task", { hasText: "AT-Drag" }).first();
  await expect(box).toBeVisible();
  const b = await box.boundingBox();
  if (!b) throw new Error("no box");
  // 48 px per hour: drag down 2 hours.
  await page.mouse.move(b.x + b.width / 2, b.y + 5);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 48, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + 5 + 96, { steps: 4 });
  await page.mouse.up();
  const target = chunk.start + 2 * 60 * MIN;
  const after = await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) => expect(titled(evs, "AT-Drag")[0]?.start).toBe(target),
  );
  const [lockedChunk] = titled(after, "AT-Drag");
  expect(lockedChunk?.summary.startsWith("🔒")).toBe(true);
  expect(lockedChunk?.busy).toBe(true);
  // A meeting over the locked chunk does not move it (LCK-6).
  await cal.addEvent({ title: "Overlap", start: target, end: target + 30 * MIN });
  await planNow(page);
  await page.waitForTimeout(6000);
  expect(titled(await cal.events(windowFrom(), windowTo()), "AT-Drag")[0]?.start).toBe(target);
});

test("mark done removes future chunks; delete removes the task (TSK-40, TSK-42)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Done", minutes: 120, min: 60, max: 60 });
  await addTask(page, { title: "AT-Delete", minutes: 60, split: false });
  await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) => {
      expect(titled(evs, "AT-Done")).toHaveLength(2);
      expect(titled(evs, "AT-Delete")).toHaveLength(1);
    },
  );
  await page.locator('[data-task-title="AT-Done"]').getByRole("button", { name: "Done" }).click();
  await page
    .locator('[data-task-title="AT-Delete"]')
    .getByRole("button", { name: "Delete" })
    .click();
  await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) => {
      expect(titled(evs, "AT-Done")).toHaveLength(0);
      expect(titled(evs, "AT-Delete")).toHaveLength(0);
    },
  );
  await page.reload();
  await expect(page.locator('[data-task-title="AT-Delete"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('[data-task-title="AT-Done"]')).toBeVisible();
});

test("deleting a chunk in the calendar places the work again later (CED-20, CED-23)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Later", minutes: 60, split: false });
  const [chunk] = titled(
    await eventually(
      () => cal.events(windowFrom(), windowTo()),
      (evs) => expect(titled(evs, "AT-Later")).toHaveLength(1),
    ),
    "AT-Later",
  );
  if (!chunk) throw new Error("no chunk");
  await cal.remove(chunk.id);
  const after = await eventually(
    () => cal.events(windowFrom(), windowTo()),
    (evs) => {
      const [c] = titled(evs, "AT-Later");
      expect(c).toBeDefined();
      expect(local(c?.start ?? 0).slice(0, 10) > local(chunk.start).slice(0, 10)).toBe(true);
    },
  );
  expect(titled(after, "AT-Later")).toHaveLength(1);
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.locator('[data-task-title="AT-Later"]')).toBeVisible();
});

test("a habit sits at its ideal time each weekday and moves when blocked (SPEC-HABITS-01 AT 1, 2)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Lunch");
  await form.getByLabel("Ideal time").fill("12:00");
  await form.getByLabel("Shortest (minutes)").fill("30");
  await form.getByLabel("Longest (minutes)").fill("60");
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.getByTestId("habit-row")).toContainText("Lunch");
  const week = await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 5), "00:00")),
    (evs) => expect(titled(evs, "Lunch")).toHaveLength(5),
  );
  for (const e of titled(week, "Lunch")) expect(local(e.start).slice(11)).toBe("12:00");
  const wed = addDays(W, 2);
  await cal.addEvent({ title: "Offsite", start: at(wed, "11:00"), end: at(wed, "13:00") });
  await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 5), "00:00")),
    (evs) => {
      const wedLunch = titled(evs, "Lunch").find((e) => local(e.start).startsWith(wed));
      expect(wedLunch && local(wedLunch.start).slice(11)).toBe("13:00");
    },
  );
});

test("a recovery buffer follows a meeting with attendees (SPEC-BUFFERS-01)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = addDays(W, 1);
  const meeting = await cal.addEvent({
    title: "Team sync",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: ["colleague@example.com"],
  });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  const evs = await eventually(
    () => cal.events(at(tue, "00:00"), at(addDays(tue, 1), "00:00")),
    (list) => expect(titled(list, "Recovery")).toHaveLength(1),
  );
  const [buffer] = titled(evs, "Recovery");
  expect([local(buffer?.start ?? 0), local(buffer?.end ?? 0)]).toEqual([
    `${tue} 11:00`,
    `${tue} 11:15`,
  ]);
  // The buffer follows its anchor (buffer spec AT 2).
  await cal.update(meeting, { start: at(tue, "14:00"), end: at(tue, "15:00") });
  await eventually(
    () => cal.events(at(tue, "00:00"), at(addDays(tue, 1), "00:00")),
    (list) => {
      const [b] = titled(list, "Recovery");
      expect(b && local(b.start)).toBe(`${tue} 15:00`);
    },
  );
});

test("focus time fills the weekly goal within daily limits (SPEC-FOCUS-01 AT 1)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  const evs = await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00")),
    (list) =>
      expect(titled(list, "Focus time").reduce((a, e) => a + (e.end - e.start), 0)).toBe(600 * MIN),
  );
  const perDay = new Map<string, number>();
  for (const e of titled(evs, "Focus time")) {
    expect(e.busy).toBe(true);
    expect(inWorkHours(e.start, e.end)).toBe(true);
    const d = local(e.start).slice(0, 10);
    perDay.set(d, (perDay.get(d) ?? 0) + (e.end - e.start) / MIN);
  }
  for (const m of perDay.values()) expect(m).toBeLessThanOrEqual(240);
});
