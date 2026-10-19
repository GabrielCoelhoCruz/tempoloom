// Library entries end to end (docs/specs/automations-library.md, entries table):
// each entry opens the form of its kind with its preset, and saving it gives a
// working automation of that kind on the calendar.
//
// Ways this can fail, each covered below:
// - a preset value differs from the entries table (time, length, days, priority, hours);
// - Lunch ignores its 11:30 to 14:00 window and goes before 11:30 when 12:15 is taken;
// - the wrap-up time is fixed instead of the last 30 min of the user's work hours;
// - the focus entries place focus outside their 09:00 to 12:00 window, or lose it on edit;
// - a buffer entry anchors on the wrong events (small meetings, solo events, internal
//   meetings, external meetings without an address);
// - a flexible meeting entry repeats at the wrong period, or saves without guests;
// - the priority link cannot offer time held by P3 and P4 items;
// - a mirroring entry copies more than busy time, or copies a copy back.
import type { Locator, Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addHabit, claimPage, slot, titled, visitor, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const spans = (evs: Awaited<ReturnType<typeof week>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const entry = (page: Page, name: string) => page.locator(`[data-entry="${name}"]`);
const automation = (page: Page, name: string) =>
  page.locator(`[data-testid="automation"][data-name="${name}"]`);
const BERLIN = "Hauptstrasse 1, 10115 Berlin, Germany";

async function openLibrary(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
}

/** Opens the entry's form from the library. */
async function use(page: Page, name: string): Promise<void> {
  await openLibrary(page);
  await entry(page, name).getByRole("button", { name: "Use" }).click();
}

/** The checked weekday names of a form's day boxes. */
const checkedDays = (scope: Locator, name: string) =>
  scope
    .locator(`input[name="${name}"]:checked`)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));

async function habitPreset(
  page: Page,
  name: string,
  p: { ideal: string; minutes: number; level: number; days: string[]; hours: string },
): Promise<Locator> {
  await use(page, name);
  const form = page.getByTestId("habit-form");
  await expect(form.getByLabel("Title")).toHaveValue(name);
  await expect(form.getByLabel("Ideal time")).toHaveValue(p.ideal);
  await expect(form.getByLabel("Shortest (minutes)")).toHaveValue(String(p.minutes));
  await expect(form.getByLabel("Longest (minutes)")).toHaveValue(String(p.minutes));
  await expect(form.getByLabel("Priority")).toHaveValue(String(p.level));
  await expect(form.getByLabel("Hours").locator("option:checked")).toHaveText(p.hours);
  expect(await checkedDays(form, "days")).toEqual(p.days);
  return form;
}

async function addFromForm(page: Page, form: Locator, name: string): Promise<void> {
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator(`[data-habit-title="${name}"]`)).toBeVisible();
}

async function expectAdded(page: Page, names: string[]): Promise<void> {
  await openLibrary(page);
  for (const n of names) await expect(entry(page, n)).toContainText("Added");
  await page.reload();
  for (const n of names) await expect(entry(page, n)).toContainText("Added");
}

async function saveShared(page: Page): Promise<void> {
  await page.getByTestId("automation-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("automations-page")).toBeVisible();
}

async function turnOff(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name: "Automations" }).click();
  await automation(page, name).getByRole("button", { name: "Turn off" }).click();
  await expect(automation(page, name)).toContainText("off");
}

test("library habit entries 11, 35, 36, 43, 45, 46 add habits with their presets: wrap-up at the end of work hours, Lunch inside 11:30 to 14:00", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Tuesday 12:15 to 13:00 is taken: without its window Lunch would go to 11:15.
  await cal.addEvent({ title: "Dentist", start: at(day(1), "12:15"), end: at(day(1), "13:00") });
  await signIn();
  // Work hours end at 17:30 on each workday, so the wrap-up's ideal time is 17:00.
  await page.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await page.getByTestId(`range-work-${d}-0`).locator("input").nth(1).fill("17:30");
  }
  await page.getByRole("button", { name: "Save work hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  const wrap = await habitPreset(page, "End-of-day wrap-up", {
    ideal: "17:00",
    minutes: 30,
    level: 3,
    days: [],
    hours: "Work hours",
  });
  await addFromForm(page, wrap, "End-of-day wrap-up");
  const plan = await habitPreset(page, "Weekly planning", {
    ideal: "09:00",
    minutes: 60,
    level: 3,
    days: ["1"],
    hours: "Work hours",
  });
  await addFromForm(page, plan, "Weekly planning");
  const writing = await habitPreset(page, "Weekly writing time", {
    ideal: "10:00",
    minutes: 60,
    level: 3,
    days: ["1", "3", "5"],
    hours: "Work hours",
  });
  await addFromForm(page, writing, "Weekly writing time");
  const reading = await habitPreset(page, "Weekly reading time", {
    ideal: "15:00",
    minutes: 45,
    level: 4,
    days: ["2", "4"],
    hours: "Work hours",
  });
  await addFromForm(page, reading, "Weekly reading time");
  const lunch = await habitPreset(page, "Lunch", {
    ideal: "12:00",
    minutes: 60,
    level: 3,
    days: [],
    hours: "Item-specific hours",
  });
  const window = lunch.getByTestId("item-hours");
  expect(await checkedDays(window, "itemDays")).toEqual(["1", "2", "3", "4", "5"]);
  await expect(window.getByLabel("From")).toHaveValue("11:30");
  await expect(window.getByLabel("To")).toHaveValue("14:00");
  await addFromForm(page, lunch, "Lunch");
  await expect(page.locator('[data-habit-title="Lunch"]')).toContainText(
    "Item-specific hours: Mon, Tue, Wed, Thu, Fri 11:30–14:00",
  );
  const meditation = await habitPreset(page, "Meditation", {
    ideal: "18:00",
    minutes: 15,
    level: 3,
    days: [],
    hours: "Personal hours",
  });
  await addFromForm(page, meditation, "Meditation");

  await eventually(
    () => week(cal),
    (l) => {
      const workdays = [0, 1, 2, 3, 4];
      expect(spans(l, "End-of-day wrap-up")).toEqual(workdays.map((d) => `${day(d)} 17:00-17:30`));
      expect(spans(l, "Weekly planning")).toEqual([`${W} 09:00-10:00`]);
      expect(spans(l, "Weekly writing time")).toEqual(
        [0, 2, 4].map((d) => `${day(d)} 10:00-11:00`),
      );
      expect(spans(l, "Weekly reading time")).toEqual([1, 3].map((d) => `${day(d)} 15:00-15:45`));
      expect(spans(l, "Lunch")).toEqual(
        workdays.map((d) => `${day(d)} ${d === 1 ? "13:00-14:00" : "12:00-13:00"}`),
      );
      expect(spans(l, "Meditation")).toEqual(
        [0, 1, 2, 3, 4, 5, 6].map((d) => `${day(d)} 18:00-18:15`),
      );
    },
  );
  await expectAdded(page, [
    "End-of-day wrap-up",
    "Weekly planning",
    "Weekly writing time",
    "Weekly reading time",
    "Lunch",
    "Meditation",
  ]);
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Lunch"]')).toContainText(
    "Item-specific hours: Mon, Tue, Wed, Thu, Fri 11:30–14:00",
  );
});

test("library habit entries 40, 41, 42, 44 add habits with their presets: walk, exercise in personal hours, coding at P2, email at P4", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const coding = await habitPreset(page, "Coding time", {
    ideal: "09:00",
    minutes: 120,
    level: 2,
    days: ["1", "2", "3", "4"],
    hours: "Work hours",
  });
  await addFromForm(page, coding, "Coding time");
  const walk = await habitPreset(page, "Daily walk", {
    ideal: "12:30",
    minutes: 30,
    level: 3,
    days: [],
    hours: "Work hours",
  });
  await addFromForm(page, walk, "Daily walk");
  const email = await habitPreset(page, "Email catch-up", {
    ideal: "16:00",
    minutes: 30,
    level: 4,
    days: [],
    hours: "Work hours",
  });
  await addFromForm(page, email, "Email catch-up");
  const exercise = await habitPreset(page, "Exercise", {
    ideal: "18:00",
    minutes: 60,
    level: 3,
    days: ["1", "3", "5"],
    hours: "Personal hours",
  });
  await addFromForm(page, exercise, "Exercise");

  await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "Coding time")).toEqual([0, 1, 2, 3].map((d) => `${day(d)} 09:00-11:00`));
      expect(spans(l, "Daily walk")).toEqual([0, 1, 2, 3, 4].map((d) => `${day(d)} 12:30-13:00`));
      expect(spans(l, "Email catch-up")).toEqual(
        [0, 1, 2, 3, 4].map((d) => `${day(d)} 16:00-16:30`),
      );
      expect(spans(l, "Exercise")).toEqual([0, 2, 4].map((d) => `${day(d)} 18:00-19:00`));
    },
  );
  await expectAdded(page, ["Coding time", "Daily walk", "Email catch-up", "Exercise"]);
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="Coding time"]')).toContainText("P2");
  await expect(page.locator('[data-habit-title="Email catch-up"]')).toContainText("P4");
});

test("library buffer entries 1, 10, 19 add buffers after large meetings, around flights and after long meetings only", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with many attendees need CalDAV here.");
  await blockUntil(cal, W);
  const people = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@tempoloom.test`);
  await cal.addEvent({
    title: "All hands",
    start: at(W, "10:00"),
    end: at(W, "10:45"),
    attendees: people(6),
  });
  await cal.addEvent({
    title: "Small sync",
    start: at(W, "14:00"),
    end: at(W, "14:30"),
    attendees: people(2),
  });
  await cal.addEvent({
    title: "Flight LH 400",
    start: at(day(1), "13:00"),
    end: at(day(1), "15:00"),
  });
  await cal.addEvent({
    title: "Planning",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
    attendees: people(2),
  });
  await cal.addEvent({ title: "Solo deep", start: at(day(2), "14:00"), end: at(day(2), "15:00") });
  // The boundary of entry 19: exactly 60 minutes with exactly one other person.
  await cal.addEvent({
    title: "Pair review",
    start: at(day(3), "10:00"),
    end: at(day(3), "11:00"),
    attendees: people(1),
  });
  await cal.addEvent({
    title: "Quick chat",
    start: at(day(2), "16:00"),
    end: at(day(2), "16:30"),
    attendees: people(2),
  });
  await signIn();
  const form = page.getByTestId("automation-form");

  await use(page, "Recovery after large meetings");
  await expect(form.getByLabel("Title")).toHaveValue("Recovery after large meetings");
  await expect(form.getByLabel("Priority")).toHaveValue("3");
  await expect(form.getByLabel("Side")).toHaveValue("after");
  await expect(form.getByLabel("After the event (minutes)")).toHaveValue("15");
  await expect(form.getByLabel("Show as")).toHaveValue("busy");
  await saveShared(page);

  await use(page, "Airport travel time");
  await expect(form.getByLabel("Side")).toHaveValue("both");
  await expect(form.getByLabel("Before the event (minutes)")).toHaveValue("120");
  await expect(form.getByLabel("After the event (minutes)")).toHaveValue("60");
  await expect(form.getByLabel("Which events")).toHaveValue("flight");
  await saveShared(page);

  await use(page, "Break after long meetings");
  await expect(form.getByLabel("Side")).toHaveValue("after");
  await expect(form.getByLabel("After the event (minutes)")).toHaveValue("10");
  await saveShared(page);

  const placed = await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "Recovery after large meetings")).toEqual([`${W} 10:45-11:00`]);
      expect(spans(l, "Airport travel time")).toEqual([
        `${day(1)} 11:00-13:00`,
        `${day(1)} 15:00-16:00`,
      ]);
      expect(spans(l, "Break after long meetings")).toEqual([
        `${day(2)} 11:00-11:10`,
        `${day(3)} 11:00-11:10`,
      ]);
    },
  );
  expect(titled(placed, "Recovery after large meetings")[0]?.busy).toBe(true);
  await expectAdded(page, [
    "Recovery after large meetings",
    "Airport travel time",
    "Break after long meetings",
  ]);
});

test("library buffer entries 28, 29, 30 anchor on external meetings: travel only at an address, prep before, debrief after", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees need CalDAV here.");
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Client visit",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["client@example.com"],
    location: BERLIN,
  });
  await cal.addEvent({
    title: "Team offsite",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
    attendees: ["ana@tempoloom.test"],
    location: BERLIN,
  });
  await cal.addEvent({
    title: "Client call",
    start: at(day(3), "14:00"),
    end: at(day(3), "14:30"),
    attendees: ["client@example.com"],
  });
  await signIn();
  const form = page.getByTestId("automation-form");

  await use(page, "Travel for external meetings");
  await expect(form.getByLabel("Side")).toHaveValue("both");
  await expect(form.getByLabel("Before the event (minutes)")).toHaveValue("30");
  await expect(form.getByLabel("After the event (minutes)")).toHaveValue("30");
  await saveShared(page);
  await eventually(
    () => week(cal),
    (l) =>
      expect(spans(l, "Travel for external meetings")).toEqual([
        `${day(1)} 09:30-10:00`,
        `${day(1)} 11:00-11:30`,
      ]),
  );
  await turnOff(page, "Travel for external meetings");

  await use(page, "Focus before customer meetings");
  await expect(form.getByLabel("Priority")).toHaveValue("2");
  await expect(form.getByLabel("Side")).toHaveValue("before");
  await expect(form.getByLabel("Before the event (minutes)")).toHaveValue("30");
  await expect(form.getByLabel("Which events")).toHaveValue("external");
  await saveShared(page);
  await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "Travel for external meetings")).toEqual([]);
      expect(spans(l, "Focus before customer meetings")).toEqual([
        `${day(1)} 09:30-10:00`,
        `${day(3)} 13:30-14:00`,
      ]);
    },
  );
  await turnOff(page, "Focus before customer meetings");

  await use(page, "Sales call prep and debrief");
  await expect(form.getByLabel("Side")).toHaveValue("both");
  await expect(form.getByLabel("Before the event (minutes)")).toHaveValue("10");
  await expect(form.getByLabel("After the event (minutes)")).toHaveValue("10");
  await expect(form.getByLabel("Which events")).toHaveValue("external");
  await saveShared(page);
  await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "Focus before customer meetings")).toEqual([]);
      expect(spans(l, "Sales call prep and debrief")).toEqual([
        `${day(1)} 09:50-10:00`,
        `${day(1)} 11:00-11:10`,
        `${day(3)} 13:50-14:00`,
        `${day(3)} 14:30-14:40`,
      ]);
    },
  );
  await expectAdded(page, [
    "Travel for external meetings",
    "Focus before customer meetings",
    "Sales call prep and debrief",
  ]);
});

test("library focus entries 7 and 23 place their weekly goal inside the 09:00 to 12:00 window, and the window stays on edit", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const form = page.getByTestId("automation-form");
  const inWindow = (evs: Awaited<ReturnType<typeof week>>, title: string) => {
    const blocks = titled(evs, title);
    const minutes = blocks.reduce((a, e) => a + (e.end - e.start) / 60_000, 0);
    const outside = blocks.filter(
      (e) => local(e.start).slice(11) < "09:00" || local(e.end).slice(11) > "12:00",
    );
    return { minutes, outside: outside.length };
  };

  await use(page, "Executive weekly focus");
  await expect(form.getByLabel("Weekly goal (hours)")).toHaveValue("8");
  await expect(form.getByLabel("Hours").locator("option:checked")).toHaveText(
    "Item-specific hours",
  );
  const window = form.getByTestId("item-hours");
  expect(await checkedDays(window, "itemDays")).toEqual(["1", "2", "3", "4", "5"]);
  await expect(window.getByLabel("From")).toHaveValue("09:00");
  await expect(window.getByLabel("To")).toHaveValue("12:00");
  await saveShared(page);
  await eventually(
    () => week(cal),
    (l) => expect(inWindow(l, "Executive weekly focus")).toEqual({ minutes: 480, outside: 0 }),
  );
  // The window is stored: the edit form shows it after a reload.
  await page.reload();
  await automation(page, "Executive weekly focus").getByRole("link", { name: "Edit" }).click();
  await expect(form.getByLabel("Hours").locator("option:checked")).toHaveText(
    "Item-specific hours",
  );
  await expect(form.getByTestId("item-hours").getByLabel("From")).toHaveValue("09:00");
  await expect(form.getByTestId("item-hours").getByLabel("To")).toHaveValue("12:00");
  await turnOff(page, "Executive weekly focus");

  await use(page, "Peak-energy focus");
  await expect(form.getByLabel("Weekly goal (hours)")).toHaveValue("10");
  await expect(form.getByTestId("item-hours").getByLabel("From")).toHaveValue("09:00");
  await expect(form.getByTestId("item-hours").getByLabel("To")).toHaveValue("12:00");
  await saveShared(page);
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Executive weekly focus")).toHaveLength(0);
      expect(inWindow(l, "Peak-energy focus")).toEqual({ minutes: 600, outside: 0 });
    },
  );
  await expectAdded(page, ["Executive weekly focus", "Peak-energy focus"]);
});

test("focus time keeps item-specific hours of several ranges when the form saves other fields", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Two ranges on Monday and another on Wednesday: more than the form's one range shows.
  const hours = {
    "1": [
      [540, 600],
      [780, 840],
    ],
    "3": [[600, 720]],
  };
  await page.evaluate(
    (itemHours) =>
      fetch("/api/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Split focus", weeklyGoalMinutes: 120, itemHours }),
      }).then((r) => r.json()),
    hours,
  );
  await page.getByRole("link", { name: "Automations" }).click();
  await automation(page, "Split focus").getByRole("link", { name: "Edit" }).click();
  const form = page.getByTestId("automation-form");
  await expect(form.getByTestId("item-hours-note")).toContainText("more than one range");
  await form.getByLabel("Weekly goal (hours)").fill("3");
  await saveShared(page);
  const stored = () =>
    page.evaluate(() =>
      fetch("/api/focus")
        .then((r) => r.json())
        .then(
          (b: { focus: { title: string; weekly_goal_minutes: number; item_hours: string }[] }) =>
            b.focus.find((f) => f.title === "Split focus"),
        ),
    );
  await expect.poll(async () => (await stored())?.weekly_goal_minutes).toBe(180);
  expect(JSON.parse((await stored())?.item_hours ?? "null")).toEqual(hours);
});

test("library entries 32, 34 and 37: flexible meetings repeat at their period with the guests, and the priority link offers time over P3 and P4 habits", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const meeting = page.getByTestId("meeting-form");
  const twoWeeks = () => cal.events(at(W, "00:00"), at(day(14), "00:00"));

  await use(page, "Recurring client meetings");
  await expect(meeting.getByLabel("Title")).toHaveValue("Recurring client meetings");
  await expect(meeting.getByLabel("How often")).toHaveValue("2");
  await expect(meeting.getByLabel("Duration (minutes)")).toHaveValue("30");
  await expect(meeting.getByLabel("Priority")).toHaveValue("2");
  // The form asks for at least one guest (edge case 3).
  const guests = meeting.getByLabel("Guests (comma list)", { exact: true });
  await expect(guests).toHaveAttribute("required", "");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  expect(await guests.evaluate((i) => (i as HTMLInputElement).validity.valueMissing)).toBe(true);
  await guests.fill("client@example.com");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Recurring client meetings"]')).toBeVisible();

  await use(page, "One-on-ones");
  await expect(meeting.getByLabel("How often")).toHaveValue("1");
  await expect(meeting.getByLabel("Duration (minutes)")).toHaveValue("30");
  await expect(meeting.getByLabel("Priority")).toHaveValue("2");
  await guests.fill("vera@tempoloom.test");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="One-on-ones"]')).toBeVisible();

  const placed = await eventually(twoWeeks, (l) => {
    // Every 2 weeks: one occurrence in two weeks; weekly: two, 7 days apart.
    expect(titled(l, "Recurring client meetings")).toHaveLength(1);
    const oneOnOnes = titled(l, "One-on-ones").map((e) => local(e.start).slice(0, 10));
    expect(oneOnOnes).toHaveLength(2);
    expect(addDays(oneOnOnes[0] ?? "", 7)).toBe(oneOnOnes[1]);
    for (const e of [...titled(l, "Recurring client meetings"), ...titled(l, "One-on-ones")]) {
      expect(e.end - e.start).toBe(30 * 60_000);
    }
  });
  const client = titled(placed, "Recurring client meetings")[0];
  const oneOnOne = titled(placed, "One-on-ones")[0];
  expect(await cal.guests(client?.id ?? "")).toEqual([
    { email: "client@example.com", optional: false },
  ]);
  expect(await cal.guests(oneOnOne?.id ?? "")).toEqual([
    { email: "vera@tempoloom.test", optional: false },
  ]);

  // The priority link (P2) offers time that P3 and P4 habits hold.
  await addHabit(page, {
    title: "P3 hold",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 3,
    days: ["Thu"],
    defense: "Always busy",
  });
  await page.reload(); // a blank habit form, without Thursday checked
  await addHabit(page, {
    title: "P4 hold",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 4,
    days: ["Fri"],
    defense: "Always busy",
  });
  await eventually(
    () => week(cal),
    (l) => {
      expect(spans(l, "P3 hold")).toEqual([`${day(3)} 09:00-10:00`]);
      expect(spans(l, "P4 hold")).toEqual([`${day(4)} 09:00-10:00`]);
    },
  );
  await claimPage(page, "lib-prio");
  await use(page, "Priority booking link");
  const link = page.getByTestId("link-form");
  await expect(link.getByLabel("Title")).toHaveValue("Priority booking link");
  await expect(link.getByLabel(/Durations/)).toHaveValue("30");
  await expect(link.getByLabel("Priority")).toHaveValue("2");
  await link.getByRole("button", { name: "Add link" }).click();
  await expect(page.locator('[data-link-title="Priority booking link"]').first()).toBeVisible();
  const v = await visitor(browser);
  await v.goto("/book/lib-prio/priority-booking-link");
  await expect(slot(v, at(day(3), "09:00"))).toBeVisible();
  await expect(slot(v, at(day(4), "09:00"))).toBeVisible();
  // The P3 starter link is held back by the P3 habit.
  await v.goto("/book/lib-prio/quick-meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(day(3), "09:00"))).toHaveCount(0);

  await page.reload();
  await expectAdded(page, ["Recurring client meetings", "One-on-ones", "Priority booking link"]);
});

test("library mirroring entries 38 and 39 copy busy time only between job calendars, both ways, never copying a copy", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Mirroring E2E uses CalDAV calendars.");
  await blockUntil(cal, W);
  await signIn();
  // With one calendar the entry explains what it needs (edge case 2).
  await use(page, "Mirror calendars after a merger or role change");
  await expect(page.getByTestId("mirror-needs-two")).toContainText(
    "Mirroring needs two connected calendars",
  );
  const oldJob = await cal.newCalendar("Old job");
  const second = await cal.newCalendar("Second job");
  await oldJob.addEvent({ title: "Old review", start: at(W, "10:00"), end: at(W, "11:00") });
  await second.addEvent({ title: "Gig", start: at(day(1), "15:00"), end: at(day(1), "16:00") });
  await cal.addEvent({
    title: "New standup",
    start: at(day(2), "09:00"),
    end: at(day(2), "09:30"),
  });
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Second job");
  await expect(page.getByTestId("mirror-needs-two")).toHaveCount(0);

  const mirrorForm = page.getByTestId("mirror-form");
  const addPolicy = async (from: string, to: string) => {
    await expect(mirrorForm.getByLabel("Copies show")).toHaveValue("busy_only");
    await mirrorForm.getByLabel("Copy events from").selectOption({ label: from });
    await mirrorForm.getByLabel("To").selectOption({ label: to });
    await mirrorForm.getByRole("button", { name: "Add mirroring" }).click();
    await expect(page.getByTestId("mirror-list")).toContainText(`${from} → ${to}`);
  };
  // Entry 38: two ways between the old and the new work calendar.
  await addPolicy("Old job", "Work");
  await addPolicy("Work", "Old job");
  // Entry 39: each job calendar into each other one.
  await use(page, "Mirror calendars across several jobs");
  await addPolicy("Second job", "Work");
  await addPolicy("Work", "Second job");
  await addPolicy("Second job", "Old job");
  await addPolicy("Old job", "Second job");

  const copies = (l: Awaited<ReturnType<typeof week>>) =>
    l
      .filter((e) => e.privateProps.tl_key?.startsWith("mirror:"))
      .map((e) => `${e.summary} ${local(e.start)}`)
      .sort();
  const originals = [`${W} 10:00`, `${day(1)} 15:00`, `${day(2)} 09:00`];
  // Each calendar gets a "Busy" copy of the two others' events and nothing more.
  for (const [c, own] of [
    [cal, `${day(2)} 09:00`],
    [oldJob, `${W} 10:00`],
    [second, `${day(1)} 15:00`],
  ] as const) {
    await eventually(
      () => week(c),
      (l) => expect(copies(l)).toEqual(originals.filter((o) => o !== own).map((o) => `Busy ${o}`)),
    );
  }
  const work = await week(cal);
  expect(work.filter((e) => e.summary.includes("Old review") || e.summary.includes("Gig"))).toEqual(
    [],
  );
  await page.reload();
  await expect(page.getByTestId("mirror-list")).toContainText("Old job → Second job");
  await expectAdded(page, [
    "Mirror calendars after a merger or role change",
    "Mirror calendars across several jobs",
  ]);
});
