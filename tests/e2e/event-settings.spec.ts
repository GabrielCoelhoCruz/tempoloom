// Event settings of habits, focus time and buffers, and calendar reminders of
// every managed event kind (docs/specs/habits-automation.md concepts,
// focus-time.md concepts, buffers-automation.md concepts, buffers-travel.md
// outputs, planning-notifications.md reminders, planning-event-content.md
// visibility, events-categories-and-colors.md rule 9).
//
// Ways this can fail, and the test that catches each:
// - An event setting is saved but never reaches the calendar: emoji, category,
//   color, visibility, location, reminders (habit test, focus test, kinds test).
// - The emoji goes before the state marker, or the marker is lost (habit test).
// - The item color does not override the category color, or the category does
//   not change the color (habit test).
// - Events go to the main calendar instead of the chosen one, or the calendar
//   can change after creation (habit test, focus test).
// - An edit of the settings does not rewrite future events, or the form shows
//   other values after a reload (habit test, focus test, kinds test).
// - A focus rename keeps the old title on its events (focus test).
// - A kind gets the wrong default reminders or visibility: task chunks, habits
//   and flexible meetings on, recovery buffers and focus off, travel buffers on
//   and public (kinds test).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  alarms,
  create,
  edit,
  eventProp,
  fillEventSettings,
  rawEvent,
  save,
} from "./automation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  planNow,
  test,
} from "./fixtures.ts";
import { addTask, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "These checks read the CalDAV event data (VALARM, CLASS, COLOR).");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
type Evs = Awaited<ReturnType<typeof week>>;
const minutes = (evs: Evs) => evs.reduce((a, e) => a + (e.end - e.start) / 60_000, 0);

/** Adds a second calendar after sign-in, so the main calendar stays the main one. */
async function secondCalendar(page: Page, cal: CalendarDriver, name: string) {
  const other = await cal.newCalendar(name);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(name);
  return other;
}

test("a habit puts its emoji, category, color, visibility, location and reminders on every event, on the calendar chosen at creation (habits concepts; NTF-14; CNT-21; colors rule 9)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const yoga = await secondCalendar(page, cal, "Yoga");

  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Lunch");
  await form.getByLabel("Ideal time").fill("12:00");
  await form.getByLabel("Shortest (minutes)").fill("60");
  await form.getByLabel("Longest (minutes)").fill("60");
  await fillEventSettings(form, {
    emoji: "🍱",
    category: "Personal",
    visibility: "Private",
    reminders: 30,
    calendar: "Yoga",
    location: "Cafe Rosa, Main St 1, Springfield",
  });
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Lunch"]')).toBeVisible();

  await form.getByLabel("Title").fill("Stretch");
  await form.getByLabel("Ideal time").fill("16:00");
  await form.getByLabel("Shortest (minutes)").fill("30");
  await form.getByLabel("Longest (minutes)").fill("30");
  await fillEventSettings(form, { color: "Tomato", visibility: "Public", reminders: "None" });
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Stretch"]')).toBeVisible();

  const lunch = await eventually(
    () => week(yoga),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  expect(titled(await week(cal), "Lunch")).toHaveLength(0);
  for (const e of titled(lunch, "Lunch")) {
    expect(e.summary).toBe("○ 🍱 Lunch");
    // Category personal paints with the personal color (Grape, 3) even in work hours.
    expect(e.colorId).toBe("3");
    expect(e.location).toBe("Cafe Rosa, Main St 1, Springfield");
  }
  const lunchIcs = await rawEvent(titled(lunch, "Lunch")[0]?.id ?? "");
  expect(eventProp(lunchIcs, "CLASS")).toBe("PRIVATE");
  expect(alarms(lunchIcs)).toEqual(["-PT30M"]);

  const stretch = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Stretch")).toHaveLength(5),
  );
  for (const e of titled(stretch, "Stretch")) {
    expect(e.summary).toBe("○ Stretch");
    // The habit color overrides the category color (solo work, Sage 2).
    expect(e.colorId).toBe("11");
  }
  const stretchIcs = await rawEvent(titled(stretch, "Stretch")[0]?.id ?? "");
  expect(eventProp(stretchIcs, "CLASS")).toBe("PUBLIC");
  expect(alarms(stretchIcs)).toEqual([]);

  // The shared form shows the saved settings; the calendar is fixed after creation.
  let shared = await edit(page, "Lunch");
  await expect(shared.getByLabel("Emoji")).toHaveValue("🍱");
  await expect(shared.getByLabel("Category")).toHaveValue("personal");
  await expect(shared.getByLabel("Visibility")).toHaveValue("private");
  await expect(shared.getByLabel("Reminders")).toHaveValue("custom");
  await expect(shared.getByLabel("Remind me (minutes)")).toHaveValue("30");
  await expect(shared.getByLabel("Location")).toHaveValue("Cafe Rosa, Main St 1, Springfield");
  const calendar = shared.getByLabel("Calendar", { exact: true });
  await expect(calendar).toBeDisabled();
  await expect(calendar.locator("option:checked")).toHaveText("Yoga");
  await fillEventSettings(shared, { category: "Work", reminders: "Calendar default" });
  await save(shared);
  const edited = await eventually(
    () => week(yoga),
    (l) => {
      expect(titled(l, "Lunch")).toHaveLength(5);
      for (const e of titled(l, "Lunch")) expect(e.colorId).toBe("2");
    },
  );
  // On CalDAV, "calendar default" is one alert 10 minutes before (Tempoloom decision, NTF-10).
  expect(alarms(await rawEvent(titled(edited, "Lunch")[0]?.id ?? ""))).toEqual(["-PT10M"]);

  await page.reload();
  shared = await edit(page, "Lunch");
  await expect(shared.getByLabel("Category")).toHaveValue("work");
  await expect(shared.getByLabel("Reminders")).toHaveValue("default");
  await expect(shared.getByLabel("Visibility")).toHaveValue("private");
});

test("a focus automation writes its title, emoji, description, visibility, reminders and calendar, and a rename renames its events (focus concepts; E-0070)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const zen = await secondCalendar(page, cal, "Zen");
  const form = await create(page, "Focus time");
  await form.getByLabel("Title").fill("Deep work");
  await fillEventSettings(form, {
    emoji: "🎯",
    description: "Phone off",
    visibility: "Private",
    reminders: 5,
    calendar: "Zen",
  });
  await form.getByLabel("Weekly goal (hours)").fill("3");
  await form.getByLabel("Shortest block (minutes)").fill("60");
  await form.getByLabel("Longest block (minutes)").fill("120");
  await save(form);

  const evs = await eventually(
    () => week(zen),
    (l) => expect(minutes(titled(l, "Deep work"))).toBe(180),
  );
  expect(titled(await week(cal), "Deep work")).toHaveLength(0);
  for (const e of titled(evs, "Deep work")) {
    expect(e.summary).toBe("🎯 Deep work");
    expect(e.description).toContain("Phone off");
  }
  const ics = await rawEvent(titled(evs, "Deep work")[0]?.id ?? "");
  expect(eventProp(ics, "CLASS")).toBe("PRIVATE");
  expect(alarms(ics)).toEqual(["-PT5M"]);

  // E-0070: a new name tells the automations apart on the calendar.
  const renamed = await edit(page, "Deep work");
  await renamed.getByLabel("Title").fill("Writing");
  await save(renamed);
  await eventually(
    () => week(zen),
    (l) => {
      expect(minutes(titled(l, "Writing"))).toBe(180);
      expect(titled(l, "Deep work")).toHaveLength(0);
      for (const e of titled(l, "Writing")) expect(e.summary).toBe("🎯 Writing");
    },
  );
  await page.reload();
  const again = await edit(page, "Writing");
  await expect(again.getByLabel("Description")).toHaveValue("Phone off");
  await expect(again.getByLabel("Calendar", { exact: true })).toBeDisabled();
  await expect(again.getByLabel("Weekly goal (hours)")).toHaveValue("3");
});

test("each managed event kind starts with its reminders and visibility, and a buffer's can change (NTF table, NTF-10, NTF-14; buffers reminders and visibility; travel outputs)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Customer call",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["ana@example.com"],
  });
  await cal.addEvent({
    title: "Client visit",
    start: at(day(2), "14:00"),
    end: at(day(2), "15:00"),
    location: "1 Oak Ave, Springfield, IL 62701",
  });
  await signIn();
  await addTask(page, { title: "AT-Rem", minutes: 60, split: false, due: "" });
  await page.getByRole("link", { name: "Habits" }).click();
  const habit = page.getByTestId("habit-form");
  await habit.getByLabel("Title").fill("Plan");
  await habit.getByLabel("Ideal time").fill("09:00");
  await habit.getByLabel("Shortest (minutes)").fill("30");
  await habit.getByLabel("Longest (minutes)").fill("30");
  await habit.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Plan"]')).toBeVisible();
  await page.getByRole("link", { name: "Meetings" }).click();
  const meeting = page.getByTestId("meeting-form");
  await meeting.getByLabel("Title").fill("Sync");
  await meeting.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Sync"]')).toBeVisible();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();

  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "AT-Rem")).toHaveLength(1);
      expect(titled(l, "Plan")).toHaveLength(5);
      expect(titled(l, "Sync")).toHaveLength(1);
      expect(titled(l, "Recovery")).toHaveLength(1);
      expect(titled(l, "Travel")).toHaveLength(2);
      expect(titled(l, "Focus time").length).toBeGreaterThan(0);
    },
  );
  const first = async (text: string) => rawEvent(titled(evs, text)[0]?.id ?? "");
  for (const text of ["AT-Rem", "Plan", "Sync"]) {
    const ics = await first(text);
    expect(alarms(ics), text).toEqual(["-PT10M"]);
    expect(eventProp(ics, "CLASS"), text).toBeNull();
  }
  const recovery = await first("Recovery");
  expect(alarms(recovery)).toEqual([]);
  expect(eventProp(recovery, "CLASS")).toBeNull();
  for (const e of titled(evs, "Travel")) {
    expect(e.summary).toBe("🚌 Travel");
    const ics = await rawEvent(e.id);
    expect(alarms(ics)).toEqual(["-PT10M"]);
    expect(eventProp(ics, "CLASS")).toBe("PUBLIC");
  }
  const focus = await first("Focus time");
  expect(alarms(focus)).toEqual([]);
  expect(eventProp(focus, "CLASS")).toBe("PUBLIC");

  const rec = await edit(page, "Recovery");
  await expect(rec.getByLabel("Reminders")).toHaveValue("none");
  await fillEventSettings(rec, { reminders: 5, visibility: "Private" });
  await save(rec);
  const travel = await edit(page, "Travel");
  await expect(travel.getByLabel("Visibility")).toHaveValue("public");
  await fillEventSettings(travel, { reminders: "None" });
  await save(travel);
  await eventually(
    async () => {
      const l = await week(cal);
      return Promise.all(
        [...titled(l, "Recovery"), ...titled(l, "Travel")].map(async (e) => ({
          title: e.summary,
          ics: await rawEvent(e.id),
        })),
      );
    },
    (list) => {
      expect(list).toHaveLength(3);
      for (const { title, ics } of list) {
        if (title.includes("Recovery")) {
          expect(alarms(ics)).toEqual(["-PT5M"]);
          expect(eventProp(ics, "CLASS")).toBe("PRIVATE");
        } else {
          expect(alarms(ics)).toEqual([]);
          expect(eventProp(ics, "CLASS")).toBe("PUBLIC");
        }
      }
    },
  );
  await page.reload();
  const shown = await edit(page, "Recovery");
  await expect(shown.getByLabel("Reminders")).toHaveValue("custom");
  await expect(shown.getByLabel("Remind me (minutes)")).toHaveValue("5");
  await expect(shown.getByLabel("Visibility")).toHaveValue("private");
});

test("a task color overrides the category color of its chunks, in every plan run (colors rule 9)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Tasks" }).click();
  const form = page.getByTestId("task-form");
  await form.getByLabel("Color").selectOption({ label: "Tomato" });
  await addTask(page, { title: "AT-Red", minutes: 60, split: false, due: "" });
  await form.getByLabel("Color").selectOption({ label: "Category color" });
  await addTask(page, { title: "AT-Plain", minutes: 60, split: false, due: "" });
  const colors = (l: Evs) => ({
    red: titled(l, "AT-Red").map((e) => e.colorId),
    plain: titled(l, "AT-Plain").map((e) => e.colorId),
  });
  // Solo work is Sage (2) by default.
  await eventually(
    () => week(cal),
    (l) => expect(colors(l)).toEqual({ red: ["11"], plain: ["2"] }),
  );
  await page.reload();
  await planNow(page);
  expect(colors(await week(cal))).toEqual({ red: ["11"], plain: ["2"] });
});

test("a habit's category decides its stats group and whether it counts toward focus time (habits concepts: category)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // A personal habit inside work hours.
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Gym");
  await form.getByLabel("Ideal time").fill("10:00");
  await form.getByLabel("Shortest (minutes)").fill("60");
  await form.getByLabel("Longest (minutes)").fill("60");
  await fillEventSettings(form, { category: "Personal" });
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Gym"]')).toBeVisible();
  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("Focus");
  await focus.getByLabel("Weekly goal (hours)").fill("5");
  await focus.getByLabel("Daily maximum (hours)").fill("1");
  await focus.getByLabel("Shortest block (minutes)").fill("60");
  await focus.getByLabel("Longest block (minutes)").fill("60");
  await save(focus);
  const focusMinutes = (l: Evs) => minutes(titled(l, "Focus"));
  // The personal habit does not count: each day gets its hour of focus.
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Gym")).toHaveLength(5);
      expect(focusMinutes(l)).toBe(300);
    },
  );
  const stats = async (group: "personalHabits" | "workHabits") => {
    await page.getByRole("link", { name: "Stats" }).click();
    await page.getByLabel("From").fill(W);
    await page.getByLabel("To").fill(addDays(W, 6));
    await expect(page.getByTestId(`stat-${group}`)).toHaveText("5 h");
  };
  await stats("personalHabits");

  // As a work habit it fills the daily focus maximum itself.
  const gym = await edit(page, "Gym");
  await fillEventSettings(gym, { category: "Work" });
  await save(gym);
  await eventually(
    () => week(cal),
    (l) => expect(focusMinutes(l)).toBe(0),
  );
  await stats("workHabits");
  await page.reload();
  await expect(page.getByTestId("stat-workHabits")).toHaveText("5 h");
});
