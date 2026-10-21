// Flexible meetings, part C (docs/specs/meetings-flexible.md rules 6-7, 11, 18;
// meetings-flexible-rescheduling.md rules 16, 19-20, 26, 34): the availability
// map, hours for one guest, the cadence after a move, the reschedule action,
// a 1:1 guest's actions, the priority boost and the skipped periods.
//
// Ways this can fail, and the test that catches each:
// - the map shows a guest's hours in the guest's zone, or the overlap
//   ignores a guest, or hours set for one guest do not reach placement -> map
// - the next occurrence stays at its ideal time close after a late one -> cadence
// - reschedule keeps the current time, leaves the day or the period,
//   or locks the occurrence                                            -> reschedule
// - a 1:1 guest cannot act, or a group guest can                       -> guest
// - a boost never comes, stays after a held period, or changes the
//   stored priority; skipped days are not listed or stay once placed   -> boost
// Every test reloads and reads the calendar again.
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, openEvent, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Meeting E2E uses two CalDAV users.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
type Evs = Awaited<ReturnType<typeof twoWeeks>>;
const starts = (evs: Evs, title: string) =>
  titled(evs, title)
    .map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)
    .sort();
const hm = (t: number) => local(t).slice(11);
const iso = (date: string, hhmm: string) => new Date(at(date, hhmm)).toISOString();
const row = (page: Page, title: string) => page.locator(`[data-meeting-title="${title}"]`);

interface Form {
  title: string;
  guests: string;
  idealTime?: string;
  days?: string[];
  every?: string;
  level?: 1 | 2 | 3 | 4;
  remove?: boolean;
  noticeHours?: number;
}

async function fillMeeting(page: Page, m: Form) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(m.guests);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  if (m.idealTime) await form.getByLabel("Ideal time").fill(m.idealTime);
  if (m.every) await form.getByLabel("How often").selectOption({ label: m.every });
  if (m.days) {
    const ideal = form.locator("fieldset.days");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
      await ideal.getByLabel(d, { exact: true }).setChecked(m.days.includes(d));
  }
  if (m.level) await form.getByLabel("Priority").selectOption(String(m.level));
  if (m.noticeHours !== undefined)
    await form.getByLabel("Move notice (hours)").fill(String(m.noticeHours));
  if (m.remove)
    await form
      .getByLabel("When there is no time")
      .selectOption({ label: "Remove it for that period" });
  return form;
}

async function addMeeting(page: Page, m: Form) {
  const form = await fillMeeting(page, m);
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(row(page, m.title)).toBeVisible();
}

test("the availability map shows each guest's meeting hours in my time zone and the overlap; hours I set for one guest replace theirs in the map and in placement (rules 6-7, 11)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  // The colleague works in New York: meeting hours 09:00 to 17:00 there.
  const other = await colleague.signIn();
  await other.getByRole("link", { name: "Settings" }).click();
  await other.getByLabel("Time zone").fill("America/New_York");
  await other.getByLabel("Time zone").blur();
  await expect(other.getByTestId("settings-message")).toHaveText("Saved");
  await signIn();

  const form = await fillMeeting(page, {
    title: "Map",
    guests: `${colleague.email}, dana@example.com`,
    days: ["Tue"],
  });
  const map = form.getByTestId("availability-map");
  await expect(map).toBeVisible();
  // The map shows one week; each time is that week's Berlin time.
  const week = (await map.getAttribute("data-week")) ?? "";
  const tue = addDays(week, 1);
  const ny = (minute: number) => hm(localToUtc("America/New_York", tue, minute));
  const tueRow = map.locator('[data-day="2"]');
  await expect(tueRow.locator('[data-person="you"]')).toHaveText("09:00–17:00");
  await expect(tueRow.locator(`[data-person="${colleague.email}"]`)).toHaveText(
    `${ny(540)}–${ny(1020)}`,
  );
  await expect(tueRow.locator('[data-person="dana@example.com"]')).toHaveText("unknown");
  await expect(tueRow.locator('[data-person="overlap"]')).toHaveText(`${ny(540)}–17:00`);
  await expect(map.locator('[data-day="6"] [data-person="overlap"]')).toHaveText("none");
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(row(page, "Map")).toBeVisible();

  // Without hours set for the colleague: the first common time on Tuesday.
  const nyAt = (d: string, minute: number) => localToUtc("America/New_York", d, minute);
  const at9 = [day(1), day(8)].map((d) => `${local(nyAt(d, 540))}-${hm(nyAt(d, 570))}`);
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Map")).toEqual(at9),
  );

  // The organizer sets 06:00 to 17:00 New York time for the colleague (rule 7).
  await row(page, "Map").getByRole("button", { name: "Edit" }).click();
  const hours = form.locator(`[data-testid="attendee-hours"][data-email="${colleague.email}"]`);
  await hours.getByLabel(`Set hours for ${colleague.email}`).check();
  await hours.getByLabel("From").fill("06:00");
  await hours.getByLabel("To").fill("17:00");
  await expect(tueRow.locator(`[data-person="${colleague.email}"]`)).toHaveText(
    `${ny(360)}–${ny(1020)}`,
  );
  await expect(tueRow.locator('[data-person="overlap"]')).toHaveText(`${ny(360)}–17:00`);
  await form.getByRole("button", { name: "Save meeting" }).click();
  const at6 = [day(1), day(8)].map((d) => {
    // Nearest the ideal 10:00 Berlin inside the new overlap.
    const start = Math.max(at(d, "10:00"), nyAt(d, 360));
    return `${local(start)}-${hm(start + 30 * 60_000)}`;
  });
  expect(at6).not.toEqual(at9);
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Map")).toEqual(at6),
  );

  await page.reload();
  const saved = row(page, "Map");
  await expect(saved.getByTestId("meeting-attendees")).toContainText(
    `${colleague.email}: Tempoloom user, America/New_York · hours set by you: Mon, Tue, Wed, Thu, Fri 06:00–17:00`,
  );
  await expect(
    saved.locator(`[data-testid="availability-map"] [data-day="2"] [data-person="overlap"]`),
  ).toHaveText(`${ny(360)}–17:00`);
  await saved.getByRole("button", { name: "Edit" }).click();
  await expect(hours.getByLabel(`Set hours for ${colleague.email}`)).toBeChecked();
  await expect(hours.getByLabel("From")).toHaveValue("06:00");
  expect(starts(await twoWeeks(cal), "Map")).toEqual(at6);
});

test("cadence: after an occurrence moves late in its week, the next one keeps at least half a week away instead of its ideal day (rule 18)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, {
    title: "Cadence",
    guests: "dana@example.com",
    days: ["Mon"],
    idealTime: "10:00",
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Cadence")).toEqual([`${W} 10:00-10:30`, `${day(7)} 10:00-10:30`]),
  );

  // Monday to Thursday of week W are full: this week's occurrence goes to Friday.
  for (const d of [0, 1, 2, 3])
    await cal.addEvent({ title: "Offsite", start: at(day(d), "08:00"), end: at(day(d), "18:00") });
  // Next Monday 10:00 would be 3 days after Friday 10:00, less than half a week:
  // the occurrence goes to the nearest day that keeps the distance.
  const expected = [`${day(4)} 10:00-10:30`, `${day(8)} 10:00-10:30`];
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Cadence")).toEqual(expected),
  );
  await planNow(page);
  await page.reload();
  await expect(row(page, "Cadence")).toBeVisible();
  expect(starts(await twoWeeks(cal), "Cadence")).toEqual(expected);
});

test("the reschedule action moves an occurrence to another time the same day or to another day of its period, never its current time, and leaves it unlocked (MEET-02 rule 19)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, { title: "Resched", guests: "dana@example.com", days: ["Tue"] });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Resched")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );

  // Same day: the nearest other start on Tuesday.
  await openWeek(page);
  await openEvent(page, "Resched");
  const drawer = page.getByTestId("event-drawer");
  await drawer.getByRole("button", { name: "Reschedule: same day" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Resched")).toEqual([`${day(1)} 09:30-10:00`, `${day(8)} 10:00-10:30`]),
  );

  // Another day: Tuesday is out; the nearest day at the ideal time.
  await openWeek(page);
  await openEvent(page, "Resched");
  await drawer.getByRole("button", { name: "Reschedule: another day" }).click();
  const expected = [`${W} 10:00-10:30`, `${day(8)} 10:00-10:30`];
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Resched")).toEqual(expected),
  );
  const moved = titled(await twoWeeks(cal), "Resched").find((e) => local(e.start).startsWith(W));
  expect(moved?.summary).not.toContain("🔒");

  await planNow(page);
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  const r = row(page, "Resched");
  await expect(r.getByTestId("meeting-occurrences")).not.toContainText("locked");
  await expect(r.locator('[data-testid="change"][data-reason="manualMove"]')).toHaveCount(2);
  expect(starts(await twoWeeks(cal), "Resched")).toEqual(expected);

  // Unlocked: a conflict at the new time places it again, at the ideal Tuesday 10:00
  // (a locked occurrence would stay).
  await cal.addEvent({ title: "Dentist", start: at(W, "09:00"), end: at(W, "11:00") });
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "Resched")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );
});

test("after a Friday occurrence, a reschedule to another day that is less than half a week later stays where I put it, also after the next plan (MEET-02 rule 19)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Week W: Monday to Thursday are full, so W's occurrence goes to Friday. Next week:
  // Wednesday to Friday are full; Monday 10:00 is too close to Friday (rule 18), so Tuesday.
  for (const d of [0, 1, 2, 3, 9, 10, 11])
    await cal.addEvent({ title: "Offsite", start: at(day(d), "08:00"), end: at(day(d), "18:00") });
  await addMeeting(page, {
    title: "After Friday",
    guests: "dana@example.com",
    days: ["Mon"],
    idealTime: "10:00",
  });
  await eventually(
    () => twoWeeks(cal),
    (l) =>
      expect(starts(l, "After Friday")).toEqual([`${day(4)} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );

  // Another day: Tuesday is out, Monday is the only other day with room.
  await openWeek(page, day(7));
  await openEvent(page, "After Friday");
  await page
    .getByTestId("event-drawer")
    .getByRole("button", { name: "Reschedule: another day" })
    .click();
  const expected = [`${day(4)} 10:00-10:30`, `${day(7)} 10:00-10:30`];
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "After Friday")).toEqual(expected),
  );
  // The plans after the move keep it: the cadence does not undo a move by hand.
  await planNow(page);
  await planNow(page);
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  const r = row(page, "After Friday");
  await expect(r.locator('[data-testid="change"][data-reason="manualMove"]')).toHaveCount(1);
  await expect(r.locator('[data-testid="change"][data-reason="conflict"]')).toHaveCount(0);
  expect(starts(await twoWeeks(cal), "After Friday")).toEqual(expected);
});

test("in a 1:1 the guest reschedules or skips an occurrence from the guest's planner; a guest of a group meeting gets no such action (MEET-02 rules 20, 26)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const other = await colleague.signIn();
  await signIn();
  await addMeeting(page, { title: "One on one", guests: colleague.email, days: ["Tue"] });
  await addMeeting(page, {
    title: "Team",
    guests: `${colleague.email}, dana@example.com`,
    days: ["Tue"],
    idealTime: "14:00",
  });
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(starts(l, "One on one")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
      expect(starts(l, "Team")).toEqual([`${day(1)} 14:00-14:30`, `${day(8)} 14:00-14:30`]);
    },
  );

  // The guest's planner shows both; only the 1:1 has the actions, and no lock.
  await openWeek(other);
  await openEvent(other, "Team");
  const drawer = other.getByTestId("event-drawer");
  await expect(drawer).toContainText("Only the organizer can change a group meeting.");
  await expect(drawer.getByRole("button", { name: /Reschedule|Skip this time|Lock/ })).toHaveCount(
    0,
  );
  await drawer.getByRole("button", { name: "Close" }).click();
  await openEvent(other, "One on one");
  await expect(drawer.getByRole("button", { name: "Lock" })).toHaveCount(0);
  await drawer.getByRole("button", { name: "Reschedule: another day" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "One on one")).toEqual([`${W} 10:00-10:30`, `${day(8)} 10:00-10:30`]),
  );

  // Skip next week's from the guest's planner.
  await openWeek(other, day(7));
  await openEvent(other, "One on one");
  await drawer.getByRole("button", { name: "Skip this time" }).click();
  await eventually(
    () => twoWeeks(cal),
    (l) => expect(starts(l, "One on one")).toEqual([`${W} 10:00-10:30`]),
  );
  await planNow(page);
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  const log = row(page, "One on one").getByTestId("meeting-changes");
  await expect(log.locator('[data-reason="manualMove"]')).toContainText(colleague.email);
  await expect(log.locator('[data-reason="manualSkip"]')).toContainText(colleague.email);
  await openWeek(other);
  await expect(other.locator(".ev", { hasText: "One on one" })).toHaveCount(1);
  expect(starts(await twoWeeks(cal), "One on one")).toEqual([`${W} 10:00-10:30`]);
  expect(starts(await twoWeeks(cal), "Team")).toEqual([
    `${day(1)} 14:00-14:30`,
    `${day(8)} 14:00-14:30`,
  ]);
});

test("a daily meeting lists the days skipped for lack of time; after a missed day the next day uses one level higher and takes the time of a habit at that level, and the boost ends once a day is held (MEET-02 rules 16, 34)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  // Monday W, 06:00.
  app.env.TEST_CLOCK_START = iso(W, "06:00");
  await app.restart();
  await blockUntil(cal, W);
  await signIn();
  // Monday to Wednesday leave only 16:00 to 17:00, where a P2 habit sits.
  for (const d of [0, 1, 2])
    await cal.addEvent({ title: "Busy", start: at(day(d), "08:00"), end: at(day(d), "16:00") });
  await addHabit(page, {
    title: "Deep work",
    ideal: "16:00",
    min: 60,
    max: 60,
    level: 2,
    noRoom: "Remove that day",
  });
  const habitDays = (l: Evs) => starts(l, "Deep work").filter((x) => x < `${day(3)}`);
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(3), "00:00")),
    (l) =>
      expect(habitDays(l)).toEqual([
        `${W} 16:00-17:00`,
        `${day(1)} 16:00-17:00`,
        `${day(2)} 16:00-17:00`,
      ]),
  );
  await addMeeting(page, {
    title: "Daily",
    guests: "dana@example.com",
    every: "Every day",
    level: 3,
    remove: true,
  });
  const days = (l: Evs) => starts(l, "Daily").filter((x) => x < `${day(5)}`);
  const week = () => cal.events(at(W, "00:00"), at(day(5), "00:00"));
  await eventually(week, (l) =>
    expect(days(l)).toEqual([`${day(3)} 10:00-10:30`, `${day(4)} 10:00-10:30`]),
  );
  const r = row(page, "Daily");
  const skipped = r.getByTestId("skipped-periods");
  const noTime = "higher-priority items take all free time";
  await expect(skipped.locator("li")).toHaveText([
    `${W}: ${noTime}`,
    `${day(1)}: ${noTime}`,
    `${day(2)}: ${noTime}`,
  ]);
  await expect(r.getByTestId("meeting-boost")).toHaveCount(0);

  // Tuesday 06:00: Monday ended with no time, so Tuesday uses P2. A P2 meeting goes
  // before a P2 habit (meetings-flexible.md rule 23), so it takes the habit's time;
  // at its stored P3 it would not.
  app.env.TEST_CLOCK_START = iso(day(1), "06:00");
  await app.restart();
  await eventually(week, (l) => {
    expect(days(l)).toEqual([
      `${day(1)} 16:00-16:30`,
      `${day(3)} 10:00-10:30`,
      `${day(4)} 10:00-10:30`,
    ]);
    expect(habitDays(l)).toEqual([`${W} 16:00-17:00`, `${day(2)} 16:00-17:00`]);
  });
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(r.getByTestId("meeting-boost")).toHaveText(
    `Priority boost: ${day(1)} uses P2 after 1 missed period`,
  );
  // The stored priority stays P3; Tuesday got a time, so it leaves the skipped list.
  await expect(page.locator("section", { hasText: "P3 medium" }).locator(r)).toBeVisible();
  await expect(skipped.locator("li")).toHaveText([`${W}: ${noTime}`, `${day(2)}: ${noTime}`]);

  // Wednesday 06:00: Tuesday was held, so the boost ends and Wednesday stays without time.
  app.env.TEST_CLOCK_START = iso(day(2), "06:00");
  await app.restart();
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(r).toBeVisible();
  await expect(r.getByTestId("meeting-boost")).toHaveCount(0);
  await expect(skipped.locator("li")).toHaveText([`${W}: ${noTime}`, `${day(2)}: ${noTime}`]);
  expect(days(await week())).toEqual([
    `${day(1)} 16:00-16:30`,
    `${day(3)} 10:00-10:30`,
    `${day(4)} 10:00-10:30`,
  ]);
});

test("a daily meeting kept in conflict counts each day it stayed in conflict as missed: after two such days it uses P1 and takes a P1 habit's time, and the boost ends once a day is held (MEET-02 rule 16)", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  // Monday W, 06:00.
  app.env.TEST_CLOCK_START = iso(W, "06:00");
  await app.restart();
  await blockUntil(cal, W);
  await signIn();
  // Monday and Tuesday are full; Wednesday leaves only 16:00 to 17:00, where a P1 habit sits.
  for (const d of [0, 1])
    await cal.addEvent({ title: "Busy", start: at(day(d), "08:00"), end: at(day(d), "18:00") });
  await cal.addEvent({ title: "Busy", start: at(day(2), "08:00"), end: at(day(2), "16:00") });
  await addHabit(page, {
    title: "Deep work",
    ideal: "16:00",
    min: 60,
    max: 60,
    level: 1,
    noRoom: "Remove that day",
  });
  const wed = () => cal.events(at(day(2), "00:00"), at(day(3), "00:00"));
  await eventually(wed, (l) => expect(starts(l, "Deep work")).toEqual([`${day(2)} 16:00-17:00`]));
  // The default rule keeps an occurrence with no time at its ideal time, in conflict.
  // No move notice, so Wednesday's occurrence can move on Wednesday morning (rule 8).
  await addMeeting(page, {
    title: "Standup",
    guests: "dana@example.com",
    every: "Every day",
    level: 3,
    noticeHours: 0,
  });
  const days = (l: Evs) => starts(l, "Standup").filter((x) => x < `${day(5)}`);
  const week = () => cal.events(at(W, "00:00"), at(day(5), "00:00"));
  const kept = [0, 1, 2, 3, 4].map((d) => `${day(d)} 10:00-10:30`);
  await eventually(week, (l) => expect(days(l)).toEqual(kept));
  const r = row(page, "Standup");
  await expect(r.getByTestId("meeting-boost")).toHaveCount(0);
  // Kept in conflict is not removed: the skipped list is for removed periods only.
  await expect(r.getByTestId("skipped-periods")).toHaveCount(0);

  // Tuesday 06:00: Monday ended in conflict, so Tuesday uses P2 (still full).
  app.env.TEST_CLOCK_START = iso(day(1), "06:00");
  await app.restart();
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(r.getByTestId("meeting-boost")).toHaveText(
    `Priority boost: ${day(1)} uses P2 after 1 missed period`,
  );
  expect(days(await week())).toEqual(kept);

  // Wednesday 06:00: two days in conflict in a row, so Wednesday uses P1. A P1 meeting
  // goes before a P1 habit (rule 23); at P2 it would not get the habit's time.
  app.env.TEST_CLOCK_START = iso(day(2), "06:00");
  await app.restart();
  await eventually(week, (l) => {
    expect(days(l)).toEqual([
      `${W} 10:00-10:30`,
      `${day(1)} 10:00-10:30`,
      `${day(2)} 16:00-16:30`,
      `${day(3)} 10:00-10:30`,
      `${day(4)} 10:00-10:30`,
    ]);
    expect(starts(l, "Deep work").filter((x) => x.startsWith(day(2)))).toEqual([]);
  });
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(r.getByTestId("meeting-boost")).toHaveText(
    `Priority boost: ${day(2)} uses P1 after 2 missed periods`,
  );
  await expect(page.locator("section", { hasText: "P3 medium" }).locator(r)).toBeVisible();

  // Thursday 06:00: Wednesday was held, so the boost ends.
  app.env.TEST_CLOCK_START = iso(day(3), "06:00");
  await app.restart();
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(r).toBeVisible();
  await expect(r.getByTestId("meeting-boost")).toHaveCount(0);
  expect(starts(await wed(), "Standup")).toEqual([`${day(2)} 16:00-16:30`]);
});
