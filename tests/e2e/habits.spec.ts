// Habits: days, defense modes, notes, skip, calendar deletes and moves,
// turning off, deleting, conflicts, keywords and start dates.
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addHabit, type allEvents, openEvent, openWeek, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const weekOf = (cal: Parameters<typeof allEvents>[0]) =>
  cal.events(at(W, "00:00"), at(day(7), "00:00"));
const days = (evs: Awaited<ReturnType<typeof weekOf>>, text: string) =>
  titled(evs, text).map((e) => local(e.start).slice(0, 10));

test("a weekly habit uses its days, its notes, and always-busy defense (SPEC-HABITS-01 rules 9-25)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Review",
    ideal: "15:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Tue", "Thu"],
    defense: "Always busy",
    notes: "Inbox zero, then plan tomorrow",
  });
  await expect(page.locator('[data-habit-title="Review"]')).toContainText("P2 high");
  await expect(page.locator('[data-habit-title="Review"]')).toContainText("Tue, Thu");
  const evs = await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Review")).toHaveLength(2),
  );
  expect(days(evs, "Review")).toEqual([day(1), day(3)]);
  for (const e of titled(evs, "Review")) {
    expect(local(e.start).slice(11)).toBe("15:00");
    expect(e.busy).toBe(true);
    expect(e.summary).toBe("● Review");
    expect(e.description).toContain("Inbox zero, then plan tomorrow");
  }
  await page.reload();
  await expect(page.locator('[data-habit-title="Review"]')).toContainText("Always busy");
});

test("an always-free habit stays transparent (DEF-21)", async ({ page, cal, signIn }) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Walk", ideal: "16:00", min: 30, max: 30, defense: "Always free" });
  const evs = await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Walk")).toHaveLength(5),
  );
  for (const e of titled(evs, "Walk")) {
    expect(e.busy).toBe(false);
    expect(e.summary).toBe("○ Walk");
  }
});

test("skip removes one day; a calendar delete finds another time; a calendar move locks (rules 26-31, CED-24)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const evs = await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  // Skip Monday from the planner.
  await openWeek(page);
  await page.locator(".ev-habit", { hasText: "Lunch" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name: "Skip this day" }).click();
  // Delete Wednesday's event in the calendar: Tempoloom finds another time that day.
  const wed = titled(evs, "Lunch").find((e) => local(e.start).startsWith(day(2)));
  if (!wed) throw new Error("no Wednesday lunch");
  await cal.remove(wed.id);
  // Move Friday's event in the calendar: it locks at the new time.
  const fri = titled(evs, "Lunch").find((e) => local(e.start).startsWith(day(4)));
  if (!fri) throw new Error("no Friday lunch");
  await cal.update(fri.id, { start: at(day(4), "14:00"), end: at(day(4), "15:00") });
  const after = await eventually(
    () => weekOf(cal),
    (l) => {
      const byDay = new Map(titled(l, "Lunch").map((e) => [local(e.start).slice(0, 10), e]));
      expect(byDay.has(W)).toBe(false);
      const w = byDay.get(day(2));
      expect(w && local(w.start).slice(11) !== "12:00").toBe(true);
      expect(byDay.get(day(4))?.summary).toBe("🔒 Lunch");
    },
  );
  expect(days(after, "Lunch")).toEqual([day(1), day(2), day(3), day(4)]);
  await page.reload();
  await page.waitForTimeout(6000);
  expect(days(await weekOf(cal), "Lunch")).toEqual([day(1), day(2), day(3), day(4)]);
});

test("turning a habit off removes its future events, on brings them back, delete removes it (rules 34-36)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Stretch", ideal: "10:00", min: 15, max: 15 });
  await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Stretch")).toHaveLength(5),
  );
  const row = page.locator('[data-habit-title="Stretch"]');
  await row.getByRole("button", { name: "Turn off" }).click();
  await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Stretch")).toHaveLength(0),
  );
  await expect(row).toContainText("off");
  await row.getByRole("button", { name: "Turn on" }).click();
  await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Stretch")).toHaveLength(5),
  );
  await row.getByRole("button", { name: "Delete" }).click();
  await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Stretch")).toHaveLength(0),
  );
  await page.reload();
  await expect(page.locator('[data-habit-title="Stretch"]')).toHaveCount(0);
});

test("with no room, one habit is kept as a marked conflict and another is removed (rule 17, CNT conflict marker)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Workshop", start: at(day(3), "09:00"), end: at(day(3), "17:00") });
  await signIn();
  await addHabit(page, {
    title: "Keep me",
    ideal: "12:00",
    min: 30,
    max: 30,
    noRoom: "Keep and mark the conflict",
  });
  await addHabit(page, {
    title: "Drop me",
    ideal: "13:00",
    min: 30,
    max: 30,
    noRoom: "Remove that day",
  });
  const evs = await eventually(
    () => weekOf(cal),
    (l) => {
      expect(titled(l, "Keep me")).toHaveLength(5);
      expect(titled(l, "Drop me")).toHaveLength(4);
    },
  );
  const thu = titled(evs, "Keep me").find((e) => local(e.start).startsWith(day(3)));
  expect(thu?.summary).toBe("⚠️ Keep me");
  expect(days(evs, "Drop me")).not.toContain(day(3));
  await openWeek(page);
  await page.getByTestId("issues").locator("summary").click();
  await expect(page.getByTestId("issues")).toContainText("conflict");
});

test("keywords skip days with a matching event; a start date delays the first day (rules 16, 35)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Team Lunch", start: at(day(2), "12:30"), end: at(day(2), "13:30") });
  await signIn();
  await addHabit(page, {
    title: "Solo lunch",
    ideal: "12:00",
    min: 30,
    max: 60,
    skipWords: "lunch",
    starting: day(1),
  });
  const evs = await eventually(
    () => weekOf(cal),
    (l) => expect(titled(l, "Solo lunch")).toHaveLength(3),
  );
  expect(days(evs, "Solo lunch")).toEqual([day(1), day(3), day(4)]);
  await openWeek(page);
  await openEvent(page, "Solo lunch");
  await expect(page.getByTestId("event-drawer")).toContainText("habit");
});
