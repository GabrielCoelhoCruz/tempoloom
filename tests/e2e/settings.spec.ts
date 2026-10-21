// Settings that change the plan: hours, custom hours, planning window, pause,
// breaks, focus credit, prep buffers and the time zone.
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import {
  addHabit,
  addTask,
  allEvents,
  changeElsewhere,
  inHours,
  MIN,
  titled,
  W,
} from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const settings = (page: import("@playwright/test").Page) =>
  page.getByRole("link", { name: "Settings" }).click();

test("editing work hours moves existing events into the new hours (HRS-1, HRS-7)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addTask(page, { title: "AT-Hours", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Hours")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await settings(page);
  const monday = page.getByTestId("range-work-1-0");
  await monday.locator("input").first().fill("13:00");
  await page.getByRole("button", { name: "Save work hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Hours")[0]?.start ?? 0)).toBe(`${W} 13:00`),
  );
  await page.reload();
  await expect(page.getByTestId("range-work-1-0").locator("input").first()).toHaveValue("13:00");
});

test("a custom hours set can hold a task (HRS-8, HRS-9)", async ({ page, cal, signIn }) => {
  await blockUntil(cal, W);
  await signIn();
  await settings(page);
  await page.getByLabel("New hours set name").fill("Early");
  await page.getByRole("button", { name: "+ Custom hours" }).click();
  const early = page.getByTestId("hours-custom");
  await expect(early).toContainText("Early");
  await early.getByTestId("range-custom-1-0").locator("input").first().fill("07:00");
  await early.getByTestId("range-custom-1-0").locator("input").nth(1).fill("08:00");
  await early.getByRole("button", { name: "Save early" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Early", minutes: 60, split: false, due: "", hours: "Early" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Early")).toHaveLength(1),
  );
  expect(local(titled(evs, "AT-Early")[0]?.start ?? 0)).toBe(`${W} 07:00`);
});

test("a shorter planning window leaves later work unplaced, with the reason (WIN-1, WIN-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await settings(page);
  await page.getByLabel("Plan ahead (weeks)").fill("1");
  await page.getByLabel("Plan ahead (weeks)").press("Tab");
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, {
    title: "AT-Far",
    minutes: 60,
    split: false,
    due: "",
    startAfter: `${day(10)}T09:00`,
  });
  await expect(page.locator('[data-task-title="AT-Far"]').getByTestId("task-issue")).toContainText(
    "planning window",
  );
  expect(titled(await cal.events(Date.now(), at(day(28), "00:00")), "AT-Far")).toHaveLength(0);
});

test("a planning window, task duration or chunk default typed while the page reads the account again is saved (WIN-1, TSK-1)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await settings(page);
  const fields: [label: string, from: string, to: string, body: object, breakMinutes: number][] = [
    ["Plan ahead (weeks)", "3", "5", { schedulingWindowWeeks: 5 }, 5],
    ["Duration (minutes)", "60", "90", { taskDefaults: { minutes: 90 } }, 10],
    ["Shortest chunk", "30", "45", { taskDefaults: { minChunkMinutes: 45 } }, 15],
    ["Longest chunk", "120", "90", { taskDefaults: { maxChunkMinutes: 90 } }, 20],
  ];
  for (const [label, from, to, body, breakMinutes] of fields) {
    const field = page.getByLabel(label);
    await expect(field).toHaveValue(from);
    await field.fill(to);
    // The page draws again before the user leaves the field; the typed value stays.
    await changeElsewhere(page, breakMinutes);
    await expect(field).toHaveValue(to);
    const saved = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/settings" && r.request().method() === "PATCH",
    );
    await field.blur();
    expect((await saved).request().postDataJSON()).toEqual(body);
    await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  }
  await page.reload();
  await expect(page.getByLabel("Plan ahead (weeks)")).toHaveValue("5");
  await expect(page.getByLabel("Duration (minutes)")).toHaveValue("90");
  await expect(page.getByLabel("Shortest chunk")).toHaveValue("45");
  await expect(page.getByLabel("Longest chunk")).toHaveValue("90");
});

test("pausing stops new placements; resuming plans again (pause spec)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await settings(page);
  await page.getByLabel("Planning").selectOption("paused");
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Paused", minutes: 60, split: false, due: "" });
  await page.waitForTimeout(6500);
  expect(titled(await allEvents(cal), "AT-Paused")).toHaveLength(0);
  await settings(page);
  await page.getByLabel("Planning").selectOption("on");
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Paused")).toHaveLength(1),
  );
});

test("a break keeps a gap between task and habit events (buffers-breaks rule 1)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await settings(page);
  await page.getByLabel("Break between tasks and habits").selectOption("15");
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Before", minutes: 60, split: false, due: "", level: 1 });
  await addHabit(page, { title: "Tea", ideal: "10:00", min: 30, max: 30, days: ["Mon"] });
  const evs = await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(titled(l, "Tea")).toHaveLength(1),
  );
  expect(local(titled(evs, "AT-Before")[0]?.start ?? 0)).toBe(`${W} 09:00`);
  expect(local(titled(evs, "Tea")[0]?.start ?? 0)).toBe(`${W} 10:15`);
});

test("work habits count toward focus time; a deleted focus block is not reused (SPEC-FOCUS-01 AT 2, rule 21)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Coding",
    ideal: "09:00",
    min: 120,
    max: 120,
    days: ["Mon", "Tue"],
    level: 4,
  });
  await settings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  const week = () => cal.events(at(W, "00:00"), at(day(7), "00:00"));
  const focusMinutes = (l: Awaited<ReturnType<typeof week>>) =>
    titled(l, "Focus time").reduce((a, e) => a + (e.end - e.start), 0) / MIN;
  const evs = await eventually(week, (l) => expect(focusMinutes(l)).toBe(600 - 240));
  for (const e of titled(evs, "Focus time")) expect(inHours(e.start, e.end)).toBe(true);
  const [block] = titled(evs, "Focus time");
  if (!block) throw new Error("no focus block");
  await cal.remove(block.id);
  await page.waitForTimeout(6500);
  const after = await eventually(week, (l) =>
    expect(titled(l, "Focus time").some((e) => e.id === block.id)).toBe(false),
  );
  for (const e of titled(after, "Focus time")) {
    expect(e.end <= block.start || e.start >= block.end).toBe(true);
  }
});

test("a prep buffer sits before a meeting but not between back-to-back meetings (buffers rules 8-10)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "A service account cannot invite attendees.");
  await blockUntil(cal, W);
  const tue = day(1);
  await cal.addEvent({
    title: "Kickoff",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    attendees: ["a@example.com"],
  });
  await cal.addEvent({
    title: "Follow-up",
    start: at(tue, "15:00"),
    end: at(tue, "16:00"),
    attendees: ["a@example.com"],
  });
  await signIn();
  await settings(page);
  await page.getByRole("button", { name: "Add 15 min prep before meetings" }).click();
  const evs = await eventually(
    () => cal.events(at(tue, "00:00"), at(day(2), "00:00")),
    (l) => expect(titled(l, "Prep")).toHaveLength(1),
  );
  expect(local(titled(evs, "Prep")[0]?.start ?? 0)).toBe(`${tue} 13:45`);
});

test("changing the time zone moves the work day (timezones spec, HRS-13)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await settings(page);
  await page.getByLabel("Time zone").fill("America/New_York");
  await page.getByLabel("Time zone").press("Tab");
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await addTask(page, { title: "AT-Zone", minutes: 60, split: false, due: "" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-Zone")).toHaveLength(1),
  );
  // 09:00 in New York, shown in Berlin time (the offset depends on both DST dates).
  expect(local(titled(evs, "AT-Zone")[0]?.start ?? 0)).toBe(
    local(localToUtc("America/New_York", W, 9 * 60)),
  );
});
