// Flexible meeting rules (docs/specs/meetings-flexible.md, rows 324-356 of
// docs/parity.md): hours modes and time zones, optional users, frequency,
// start date, priority and rank, focus order, adaptive defense, event
// settings, description, many meetings, and stats.
//
// Ways this can fail, and the test that catches each:
// - a colleague's hours are read in the organizer's zone, an optional user
//   still limits the time, "my hours only" still reads the colleague's
//   hours, or item-specific hours are cut by meeting hours           -> hours
// - monthly or every-N periods place on the wrong days, or every-2-weeks
//   flips from one run to the next                                   -> frequency
// - a P1 meeting does not move a P3 habit, a P4 meeting loses to focus
//   time, or adaptive defense stays free when locked or tight        -> priority
// - a rank or priority change in the automation list, or an hours
//   change, does not place the occurrences again                     -> order
// - visibility, reminders, calendar, description or start date do not
//   reach every occurrence, or the list loses them after reload       -> settings
// - a limit stops new meetings, or stats count meetings as buffers    -> many
// Every test reloads and reads the calendar again.
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import {
  alarms,
  automation,
  eventProp,
  fillEventSettings,
  group,
  names,
  openAutomations,
  rawEvent,
} from "./automation-list-helpers.ts";
import { accountRow, addCalDavAccount } from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import {
  addHabit,
  addLink,
  book,
  claimPage,
  openEvent,
  openWeek,
  titled,
  visitor,
  W,
} from "./helpers.ts";
import { putMeeting } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Meeting rule E2E uses CalDAV users and event data.");

const day = (n: number) => addDays(W, n);
const range = (cal: CalendarDriver, days = 14) =>
  cal.events(at(W, "00:00"), at(day(days), "00:00"));
type Evs = Awaited<ReturnType<typeof range>>;
const starts = (evs: Evs, title: string) =>
  titled(evs, title)
    .map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)
    .sort();
const hm = (t: number) => local(t).slice(11);

interface Form {
  title: string;
  guests: string;
  optional?: string;
  idealTime?: string;
  days?: string[];
  every?: string;
  custom?: { n: number; unit: "Days" | "Weeks" | "Months" };
  dayOfMonth?: number;
  nthWeekday?: { nth: string; weekday: string };
  hours?: "Everyone's meeting hours" | "My meeting hours only" | "Item-specific hours";
  itemHours?: { days: string[]; from: string; to: string };
  level?: 1 | 2 | 3 | 4;
  starting?: string;
  description?: string;
  location?: string;
  defense?: "Free until time gets short" | "Always busy" | "Always free";
}

/** Fills the meeting form; `save` false leaves it unsaved. */
async function fillMeeting(page: Page, m: Form, save = true) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(m.title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(m.guests);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  if (m.optional) await form.getByLabel("Optional guests (comma list)").fill(m.optional);
  if (m.idealTime) await form.getByLabel("Ideal time").fill(m.idealTime);
  if (m.every) await form.getByLabel("How often").selectOption({ label: m.every });
  if (m.custom) {
    await form.getByLabel("How often").selectOption({ label: "Custom" });
    await form.getByLabel("Repeat every").fill(String(m.custom.n));
    await form.getByLabel("Unit").selectOption({ label: m.custom.unit });
  }
  if (m.dayOfMonth) await form.getByLabel("Day of the month").fill(String(m.dayOfMonth));
  if (m.nthWeekday) {
    await form.getByLabel("Or on the").selectOption({ label: m.nthWeekday.nth });
    await form.getByLabel("Weekday").selectOption({ label: m.nthWeekday.weekday });
  }
  if (m.days) {
    const ideal = form.locator("fieldset.days");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
      await ideal.getByLabel(d, { exact: true }).setChecked(m.days.includes(d));
  }
  if (m.hours) await form.locator('select[name="hoursMode"]').selectOption({ label: m.hours });
  if (m.itemHours) {
    const item = form.getByTestId("item-hours");
    for (const d of m.itemHours.days) await item.getByLabel(d, { exact: true }).check();
    await item.getByLabel("From").fill(m.itemHours.from);
    await item.getByLabel("To").fill(m.itemHours.to);
  }
  if (m.level) await form.getByLabel("Priority").selectOption(String(m.level));
  if (m.starting) await form.getByLabel("Starting").fill(m.starting);
  if (m.description) await form.getByLabel("Description").fill(m.description);
  if (m.location) await form.getByLabel("Location").fill(m.location);
  if (m.defense) await form.getByLabel("Show as").selectOption({ label: m.defense });
  if (!save) return form;
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator(`[data-meeting-title="${m.title}"]`)).toBeVisible();
  return form;
}

const row = (page: Page, title: string) => page.locator(`[data-meeting-title="${title}"]`);

test("a colleague's hours count in the colleague's time zone, an optional user does not count, my hours only and item-specific hours replace everyone's hours (rules 11, 21, 35; edge case 1)", async ({
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
  await other.reload();
  await expect(other.getByLabel("Time zone")).toHaveValue("America/New_York");
  // Busy all Tuesday morning, in Berlin time.
  await colleague.cal.addEvent({
    title: "Errands",
    start: at(day(1), "09:00"),
    end: at(day(1), "12:00"),
  });
  await signIn();

  await fillMeeting(page, { title: "Common", guests: colleague.email });
  await fillMeeting(page, {
    title: "Optional",
    guests: "dana@example.com",
    optional: colleague.email,
    idealTime: "10:00",
  });
  await fillMeeting(page, {
    title: "Mine",
    guests: colleague.email,
    idealTime: "12:00",
    hours: "My meeting hours only",
  });
  await fillMeeting(page, {
    title: "Early",
    guests: "dana@example.com",
    idealTime: "10:00",
    hours: "Item-specific hours",
    itemHours: { days: ["Tue", "Thu"], from: "07:00", to: "08:00" },
  });

  // 09:00 in New York, as Berlin time on each Tuesday (both zones change clocks on other dates).
  const ny = (d: string) => localToUtc("America/New_York", d, 9 * 60);
  const expected = {
    Common: [
      `${local(ny(day(1)))}-${hm(ny(day(1)) + 30 * 60_000)}`,
      `${local(ny(day(8)))}-${hm(ny(day(8)) + 30 * 60_000)}`,
    ],
    Optional: [`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`],
    Mine: [`${day(1)} 12:00-12:30`, `${day(8)} 12:00-12:30`],
    // Nearest the ideal 10:00 inside 07:00 to 08:00.
    Early: [`${day(1)} 07:30-08:00`, `${day(8)} 07:30-08:00`],
  };
  const check = (l: Evs) => {
    for (const [title, times] of Object.entries(expected))
      expect(starts(l, title), title).toEqual(times);
  };
  const placed = await eventually(() => range(cal), check);
  // The New York hours start after the Berlin morning: the common time is the afternoon.
  expect(Number(hm(ny(day(1))).slice(0, 2))).toBeGreaterThanOrEqual(13);
  const optional = titled(placed, "Optional")[0];
  expect(await cal.guests(optional?.id ?? "")).toEqual([
    { email: "dana@example.com", optional: false },
    { email: colleague.email, optional: true },
  ]);

  await page.reload();
  await expect(row(page, "Early").getByTestId("meeting-settings")).toContainText(
    "Item-specific hours: Tue, Thu 07:00–08:00",
  );
  await expect(row(page, "Mine").getByTestId("meeting-settings")).toContainText(
    "My meeting hours only",
  );
  await expect(row(page, "Optional").getByTestId("meeting-attendees")).toContainText("(optional)");
  check(await range(cal));

  // MEET-02 rule 5: the colleague's new meeting hours (from 10:00 New York time)
  // place the organizer's meeting again.
  await other.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await other.getByTestId(`range-meeting-${d}-0`).locator("input").first().fill("10:00");
  }
  await other.getByRole("button", { name: "Save meeting hours" }).click();
  await expect(other.getByTestId("settings-message")).toHaveText("Saved");
  const ny10 = (d: string) => localToUtc("America/New_York", d, 10 * 60);
  const moved = (l: Evs) =>
    expect(starts(l, "Common")).toEqual(
      [day(1), day(8)].map((d) => `${local(ny10(d))}-${hm(ny10(d) + 30 * 60_000)}`),
    );
  await eventually(() => range(cal), moved);
  await page.reload();
  moved(await range(cal));
});

test("frequency: every day, every 3 days, every month on a day or an Nth weekday, every 2 months, and every 2 weeks from a start date (concepts frequency; rule 10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Plan 12 weeks ahead, so the window holds three months of one ideal day.
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Plan ahead (weeks)").fill("12");
  await page.getByLabel("Plan ahead (weeks)").blur();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const monthDay = Number(day(2).slice(8));
  // The same Wednesday as the Nth Wednesday of its month.
  const nth = ["first", "second", "third", "fourth", "fifth"][Math.ceil(monthDay / 7) - 1] ?? "";

  await fillMeeting(page, {
    title: "Daily",
    guests: "dana@example.com",
    idealTime: "09:00",
    every: "Every day",
  });
  await fillMeeting(page, {
    title: "Third",
    guests: "dana@example.com",
    idealTime: "11:00",
    custom: { n: 3, unit: "Days" },
    starting: W,
  });
  await fillMeeting(page, {
    title: "Monthly",
    guests: "dana@example.com",
    idealTime: "13:00",
    every: "Every month",
    dayOfMonth: monthDay,
  });
  await fillMeeting(page, {
    title: "Bimonthly",
    guests: "dana@example.com",
    idealTime: "14:00",
    custom: { n: 2, unit: "Months" },
    dayOfMonth: monthDay,
    starting: day(2),
  });
  await fillMeeting(page, {
    title: "Weekday",
    guests: "dana@example.com",
    idealTime: "16:00",
    every: "Every month",
    nthWeekday: { nth, weekday: "Wednesday" },
  });
  await fillMeeting(page, {
    title: "Fortnight",
    guests: "dana@example.com",
    idealTime: "15:00",
    custom: { n: 2, unit: "Weeks" },
    days: ["Thu"],
    starting: W,
  });

  const check = (l: Evs) => {
    // Every work day of both weeks (meeting hours are Monday to Friday).
    expect(starts(l, "Daily")).toEqual(
      [0, 1, 2, 3, 4, 7, 8, 9, 10, 11].map((n) => `${day(n)} 09:00-09:30`),
    );
    // Periods of 3 days from Monday: Mon, Thu, then Sun (no hours: the next
    // day of that period), then Wed; the next one starts on a Saturday and
    // lands on the Monday after the checked range.
    expect(starts(l, "Third")).toEqual([0, 3, 7, 9].map((n) => `${day(n)} 11:00-11:30`));
    // Only on the chosen day of the month.
    const monthly = titled(l, "Monthly");
    expect(monthly.length).toBeGreaterThanOrEqual(1);
    expect(local(monthly[0]?.start ?? 0)).toBe(`${day(2)} 13:00`);
    for (const e of monthly) expect(Number(local(e.start).slice(8, 10))).toBe(monthDay);
    expect(starts(l, "Fortnight")).toEqual([`${day(3)} 15:00-15:30`]);
    expect(starts(l, "Weekday")[0]).toBe(`${day(2)} 16:00-16:30`);
  };
  // Every month: three ideal days in the window; every 2 months: the first and the third.
  const months = (l: Evs) => {
    const dates = (title: string) => titled(l, title).map((e) => local(e.start).slice(0, 10));
    const monthly = dates("Monthly");
    expect(monthly).toHaveLength(3);
    expect(monthly[0]).toBe(day(2));
    expect(dates("Bimonthly")).toEqual([monthly[0], monthly[2]]);
    for (const e of titled(l, "Bimonthly")) expect(hm(e.start)).toBe("14:00");
  };
  await eventually(() => range(cal), check);
  await eventually(() => range(cal, 85), months);

  await page.reload();
  await expect(row(page, "Third")).toContainText("every 3 days");
  await expect(row(page, "Monthly")).toContainText(`every month, ideally on day ${monthDay}`);
  await expect(row(page, "Fortnight")).toContainText("every 2 weeks, ideally Thu");
  await expect(row(page, "Daily")).toContainText("every day");
  await expect(row(page, "Bimonthly")).toContainText(`every 2 months, ideally on day ${monthDay}`);
  await expect(row(page, "Weekday")).toContainText(`every month, ideally on the ${nth} Wednesday`);
  check(await range(cal));
  months(await range(cal, 85));
});

test("priority: a P1 meeting moves a P3 habit, a P4 meeting goes before focus time, and adaptive defense turns busy when the day is tight or the occurrence is locked (rules 14-15, 23-25, 30)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // A new meeting is P2 by default.
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(page.getByTestId("meeting-form").getByLabel("Priority")).toHaveValue("2");

  await addHabit(page, { title: "Review", ideal: "10:00", min: 60, max: 60, level: 3 });
  await page.getByTestId("create-menu").locator("summary").click();
  await page
    .getByTestId("create-menu")
    .getByRole("link", { name: "Focus time", exact: true })
    .click();
  const focus = page.getByTestId("automation-form");
  await focus.getByLabel("Title").fill("Deep");
  await focus.getByLabel("Weekly goal (hours)").fill("40");
  await focus.getByLabel("Daily maximum (hours)").fill("8");
  await focus.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("automations-page")).toBeVisible();
  const covers = (l: Evs, title: string, t: number) =>
    titled(l, title).some((e) => e.start <= t && e.end > t);
  // Before any meeting: the habit has Tuesday 10:00 and focus fills Tuesday 14:00.
  await eventually(
    () => range(cal, 7),
    (l) => {
      expect(starts(l, "Review")).toContain(`${day(1)} 10:00-11:00`);
      expect(covers(l, "Deep", at(day(1), "14:00"))).toBe(true);
    },
  );

  // Thursday has one free half hour only.
  await cal.addEvent({ title: "Busy", start: at(day(3), "09:00"), end: at(day(3), "12:00") });
  await cal.addEvent({ title: "Busy", start: at(day(3), "12:30"), end: at(day(3), "17:00") });
  await fillMeeting(page, {
    title: "Sync",
    guests: "dana@example.com",
    idealTime: "10:00",
    level: 1,
  });
  await fillMeeting(page, {
    title: "Late",
    guests: "dana@example.com",
    idealTime: "14:00",
    level: 4,
  });
  // A P4 meeting does not take the P3 habit's time.
  await fillMeeting(page, {
    title: "Low",
    guests: "dana@example.com",
    idealTime: "10:00",
    days: ["Wed"],
    level: 4,
  });
  await fillMeeting(page, {
    title: "Tight",
    guests: "dana@example.com",
    idealTime: "10:00",
    days: ["Thu"],
    level: 1,
  });

  const check = (l: Evs) => {
    expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
    expect(starts(l, "Late")).toEqual([`${day(1)} 14:00-14:30`, `${day(8)} 14:00-14:30`]);
    expect(starts(l, "Tight")).toEqual([`${day(3)} 12:00-12:30`, `${day(10)} 10:00-10:30`]);
    expect(starts(l, "Low")).toEqual([`${day(2)} 09:30-10:00`, `${day(9)} 09:30-10:00`]);
    expect(starts(l, "Review")).toContain(`${day(2)} 10:00-11:00`);
    // The P1 meeting took the P3 habit's time: the habit moved.
    expect(covers(l, "Review", at(day(1), "10:00"))).toBe(false);
    expect(titled(l, "Review").some((e) => local(e.start).startsWith(day(1)))).toBe(true);
    // Focus time keeps away from both meetings.
    for (const t of ["10:00", "14:00"]) expect(covers(l, "Deep", at(day(1), t))).toBe(false);
    const busy = (title: string, d: number) =>
      titled(l, title).find((e) => local(e.start).startsWith(day(d)))?.busy;
    // Adaptive: free while other time is left that day; busy when it is the last slot.
    expect(busy("Sync", 8)).toBe(false);
    expect(busy("Tight", 3)).toBe(true);
    expect(busy("Tight", 10)).toBe(false);
  };
  await eventually(() => range(cal), check);

  // A locked occurrence turns busy.
  await openWeek(page, day(7));
  await openEvent(page, "Sync");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(
    () => range(cal),
    (l) => {
      const locked = titled(l, "Sync").find((e) => local(e.start).startsWith(day(8)));
      expect(locked?.summary).toBe("🔒 Sync");
      expect(locked?.busy).toBe(true);
      expect(local(locked?.start ?? 0)).toBe(`${day(8)} 10:00`);
    },
  );
  await page.reload();
  const l = await range(cal);
  expect(starts(l, "Sync")).toEqual([`${day(1)} 10:00-10:30`, `${day(8)} 10:00-10:30`]);
  expect(starts(l, "Late")).toEqual([`${day(1)} 14:00-14:30`, `${day(8)} 14:00-14:30`]);
});

test("rank and priority come from the automation list: a drag swaps two meetings that want one slot and another drag changes the priority; an hours change and an edit of the rules place them again (rules 23, 33; edge case 9; MEET-02 rules 4-5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await fillMeeting(page, { title: "Alpha", guests: "dana@example.com", idealTime: "09:00" });
  await fillMeeting(page, { title: "Beta", guests: "dana@example.com", idealTime: "09:00" });
  const tue = (l: Evs, title: string) =>
    titled(l, title)
      .filter((e) => local(e.start).startsWith(day(1)))
      .map((e) => hm(e.start));
  await eventually(
    () => range(cal, 7),
    (l) => {
      expect(tue(l, "Alpha")).toEqual(["09:00"]);
      expect(tue(l, "Beta")).toEqual(["09:30"]);
    },
  );

  // Beta goes above Alpha in P2: Beta gets the ideal time.
  await openAutomations(page);
  await automation(page, "Beta").dragTo(automation(page, "Alpha"));
  await expect.poll(() => names(group(page, 2))).toEqual(["Beta", "Alpha"]);
  await eventually(
    () => range(cal, 7),
    (l) => {
      expect(tue(l, "Beta")).toEqual(["09:00"]);
      expect(tue(l, "Alpha")).toEqual(["09:30"]);
    },
  );

  // Alpha goes to P1: it wins the slot again.
  await automation(page, "Alpha").dragTo(group(page, 1));
  await expect.poll(() => names(group(page, 1))).toEqual(["Alpha"]);
  await eventually(
    () => range(cal, 7),
    (l) => {
      expect(tue(l, "Alpha")).toEqual(["09:00"]);
      expect(tue(l, "Beta")).toEqual(["09:30"]);
    },
  );
  await page.reload();
  await expect.poll(() => names(group(page, 1))).toEqual(["Alpha"]);
  await expect.poll(() => names(group(page, 2))).toEqual(["Beta"]);
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(
    page.locator("section", { has: page.getByRole("heading", { name: "P1 critical" }) }),
  ).toContainText("Alpha");

  // Meeting hours from 13:00: both meetings are placed again inside them.
  await page.getByRole("link", { name: "Settings" }).click();
  for (const d of [1, 2, 3, 4, 5]) {
    await page.getByTestId(`range-meeting-${d}-0`).locator("input").first().fill("13:00");
  }
  await page.getByRole("button", { name: "Save meeting hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const after = (l: Evs) => {
    expect(starts(l, "Alpha")).toEqual([`${day(1)} 13:00-13:30`, `${day(8)} 13:00-13:30`]);
    expect(starts(l, "Beta")).toEqual([`${day(1)} 13:30-14:00`, `${day(8)} 13:30-14:00`]);
  };
  await eventually(() => range(cal), after);
  await page.reload();
  after(await range(cal));

  // MEET-02 rule 4: an edit of the rules (ideal day and time, duration, start
  // date) places the meeting again; a later start date pauses it until then.
  await page.getByRole("link", { name: "Meetings" }).click();
  await row(page, "Alpha").getByRole("button", { name: "Edit" }).click();
  const form = page.getByTestId("meeting-form");
  await expect(form.getByLabel("Title")).toHaveValue("Alpha");
  await expect(form.getByLabel("Priority")).toHaveValue("1");
  await form.getByLabel("Ideal time").fill("15:00");
  await form.getByLabel("Duration (minutes)").fill("60");
  await form.getByLabel("Starting").fill(day(7));
  const days = form.locator("fieldset.days");
  await days.getByLabel("Tue", { exact: true }).uncheck();
  await days.getByLabel("Thu", { exact: true }).check();
  await form.getByRole("button", { name: "Save meeting" }).click();
  await expect(row(page, "Alpha")).toContainText("every week, ideally Thu at 15:00 · 1 h");
  const edited = (l: Evs) => {
    expect(starts(l, "Alpha")).toEqual([`${day(10)} 15:00-16:00`]);
    expect(starts(l, "Beta")).toEqual([`${day(1)} 13:30-14:00`, `${day(8)} 13:30-14:00`]);
  };
  await eventually(() => range(cal), edited);
  await page.reload();
  await expect(row(page, "Alpha").getByTestId("meeting-settings")).toContainText(
    `starting ${day(7)}`,
  );
  edited(await range(cal));
});

test("event settings, description and start date reach every occurrence, on the main calendar of another account (concepts visibility, reminders, targetCalendar, startDate; rules 9, 38)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  const second = await people(3);
  await blockUntil(second.cal, W);
  await signIn();
  await addCalDavAccount(page, {
    ...(radicale.users[3] ?? radicale.colleague),
    email: second.email,
  });
  await expect(accountRow(page, second.email)).toBeVisible();

  const agenda = "**Agenda**\n- Budget\n- Hiring";
  const form = await fillMeeting(
    page,
    {
      title: "Board",
      guests: "dana@example.com",
      idealTime: "10:00",
      starting: day(7),
      description: agenda,
      location: "Room 4",
      defense: "Always busy",
    },
    false,
  );
  await fillEventSettings(form, {
    visibility: "Private",
    reminders: 15,
    calendar: `Work (${second.email})`,
  });
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(row(page, "Board")).toBeVisible();

  const check = async () => {
    // Rule 9: nothing before the start date; then 10:00 each week inside the window.
    const l = await range(second.cal, 21);
    const board = titled(l, "Board");
    expect(local(board[0]?.start ?? 0)).toBe(`${day(8)} 10:00`);
    for (const e of board) {
      expect(local(e.start) >= day(7)).toBe(true);
      expect(`${hm(e.start)}-${hm(e.end)}`).toBe("10:00-10:30");
    }
    expect(titled(await range(cal, 21), "Board")).toEqual([]);
    for (const e of titled(l, "Board")) {
      expect(e.description).toContain(agenda);
      expect(e.location).toBe("Room 4");
      // Always busy, even weeks ahead where the default (adaptive) writes free.
      expect(e.busy).toBe(true);
      const ics = await rawEvent(e.id);
      expect(eventProp(ics, "CLASS")).toBe("PRIVATE");
      expect(alarms(ics)).toEqual(["-PT15M"]);
      // The account that owns the calendar organizes; the guest is the only attendee.
      const mails = (name: string) =>
        [...ics.matchAll(new RegExp(`^${name}[^:\\r\\n]*:mailto:(.+)$`, "gim"))].map((m) =>
          (m[1] ?? "").trim().toLowerCase(),
        );
      expect(mails("ORGANIZER")).toEqual([second.email.toLowerCase()]);
      expect(mails("ATTENDEE")).toEqual(["dana@example.com"]);
    }
  };
  await expect
    .poll(
      async () => {
        try {
          await check();
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await page.reload();
  await expect(row(page, "Board").getByTestId("meeting-settings")).toContainText(
    `starting ${day(7)} · private · reminder 15 min before · own calendar`,
  );
  await check();
  // The calendar is fixed after creation: the edit form shows it and does not change it.
  await row(page, "Board").getByRole("button", { name: "Edit" }).click();
  const calendar = page.getByTestId("meeting-form").getByLabel("Calendar", { exact: true });
  await expect(calendar).toBeDisabled();
  await expect(calendar.locator("option:checked")).toHaveText(`Work (${second.email})`);
  await page.getByTestId("meeting-form").getByRole("button", { name: "Cancel" }).click();
  // CNT-12: the planner's details panel shows the agenda as markdown.
  await openWeek(page, day(7));
  await openEvent(page, "Board");
  const notes = page.getByTestId("event-drawer").getByTestId("event-notes");
  await expect(notes.locator("strong")).toHaveText("Agenda");
  await expect(notes.locator("li")).toHaveText(["Budget", "Hiring"]);
});

test("adaptive defense writes busy within 12 hours and free later; always busy and always free keep their value (rules 30-31)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  // Today and the next days, all day: the meeting can sit in the next hours.
  const soon = Date.now() + 2 * 3_600_000;
  const l0 = local(soon);
  const minute = Math.ceil((Number(l0.slice(11, 13)) * 60 + Number(l0.slice(14, 16))) / 15) * 15;
  const ideal = `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const allDay = {
    days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    from: "00:00",
    to: "00:00",
  };
  for (const [title, defense] of [
    ["Adaptive", "Free until time gets short"],
    ["Busy", "Always busy"],
    ["Open", "Always free"],
  ] as const) {
    await fillMeeting(page, {
      title,
      guests: "dana@example.com",
      idealTime: ideal,
      every: "Every day",
      hours: "Item-specific hours",
      itemHours: allDay,
      defense,
    });
  }
  const now = Date.now();
  const next = (l: Evs, title: string) =>
    titled(l, title).filter((e) => e.end > now && e.start < now + 4 * 86_400_000);
  const check = (l: Evs) => {
    for (const title of ["Adaptive", "Busy", "Open"]) {
      // One soon (inside 12 hours) and later ones (more than 12 hours ahead).
      expect(
        next(l, title).some((e) => e.start - now < 12 * 3_600_000),
        title,
      ).toBe(true);
      expect(
        next(l, title).some((e) => e.start - now > 13 * 3_600_000),
        title,
      ).toBe(true);
    }
    for (const e of next(l, "Adaptive"))
      expect(e.busy, local(e.start)).toBe(e.start - now < 12 * 3_600_000);
    for (const e of next(l, "Busy")) expect(e.busy).toBe(true);
    for (const e of next(l, "Open")) expect(e.busy).toBe(false);
  };
  const read = () => cal.events(now - 3_600_000, now + 4 * 86_400_000);
  await eventually(read, check);
  await page.reload();
  await expect(row(page, "Open")).toContainText("Always free");
  check(await read());
});

test("a series every 3 weeks fills the form as custom every 3 weeks, keeps its instances when saved, cannot take a monthly frequency or a start date when added, and shows its frequency read-only when edited, where other ideal days move its instances (rules 1, 10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const series = await putMeeting(cal.calendarId, {
    title: "Triweekly",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
    rrule: "FREQ=WEEKLY;INTERVAL=3;COUNT=4",
  });
  await signIn();
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  const pick = form.getByLabel("From an existing meeting");
  await expect(pick.locator("option", { hasText: "Triweekly" })).toHaveCount(1, {
    timeout: 60_000,
  });
  // A new meeting offers every month; a series does not, nor a start date of its own.
  const often = form.getByLabel("How often");
  await expect(often.locator("option", { hasText: "Every month" })).toHaveCount(1);
  await expect(form.getByLabel("Starting")).toBeVisible();
  await pick.selectOption({ label: "Triweekly" });
  const seriesOnly = async () => {
    await expect(often.locator("option", { hasText: "Every month" })).toHaveCount(0);
    await expect(often.locator("option", { hasText: "Every day" })).toHaveCount(1);
    await expect(form.getByLabel("Unit").locator("option")).toHaveText(["Weeks"]);
    await expect(form.getByLabel("Starting")).toHaveCount(0);
  };
  await expect(form.getByLabel("How often")).toHaveValue("custom");
  await expect(form.getByLabel("Repeat every")).toHaveValue("3");
  await expect(form.getByLabel("Unit")).toHaveValue("weeks");
  await expect(form.getByLabel("Tue", { exact: true })).toBeChecked();
  await seriesOnly();

  // A series repeats daily or every N weeks: the API refuses a monthly frequency for it.
  const refused = await page.evaluate(async (title) => {
    const list = (await (await fetch("/api/meetings/series")).json()) as {
      series: { title: string; calendarId: string; seriesId: string }[];
    };
    const s = list.series.find((x) => x.title === title);
    const res = await fetch("/api/meetings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        attendees: [{ email: "dana@example.com" }],
        frequency: { period: "monthly", dayOfMonth: 1 },
        idealTime: "10:00",
        durationMinutes: 30,
        series: { calendarId: s?.calendarId, seriesId: s?.seriesId },
      }),
    });
    return res.status;
  }, "Triweekly");
  expect(refused).toBe(400);

  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(row(page, "Triweekly")).toContainText("every 3 weeks, ideally Tue");
  // The instances keep their time and stay instances of the series: each one
  // falls in a period of the meeting, counted from the series' first instance.
  await eventually(
    () => range(cal, 28),
    (l) => {
      const mine = titled(l, "Triweekly");
      expect(mine.map((e) => local(e.start))).toEqual([`${day(1)} 10:00`, `${day(22)} 10:00`]);
      expect(mine.every((e) => e.recurringId === series)).toBe(true);
      expect(mine.every((e) => (e.privateProps.tl_meeting ?? "") !== "")).toBe(true);
    },
  );
  await page.reload();
  await expect(row(page, "Triweekly")).toContainText("every 3 weeks, ideally Tue");
  // The edit form of the adopted series shows its frequency read-only: it comes from the calendar.
  await row(page, "Triweekly").getByRole("button", { name: "Edit" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("Triweekly");
  for (const [label, value] of [
    ["How often", "Custom"],
    ["Repeat every", "3"],
    ["Unit", "Weeks"],
  ]) {
    await expect(form.getByLabel(label as string)).toHaveValue(value as string);
    await expect(form.getByLabel(label as string)).not.toBeEditable();
  }
  await expect(form.getByLabel("Starting")).toHaveCount(0);
  // Other ideal days stay editable: the instances move inside the series, and none is deleted.
  await form.getByLabel("Tue", { exact: true }).uncheck();
  await form.getByLabel("Thu", { exact: true }).check();
  await form.getByRole("button", { name: "Save meeting" }).click();
  await expect(row(page, "Triweekly")).toContainText("every 3 weeks, ideally Thu");
  await eventually(
    () => range(cal, 28),
    (l) => {
      const mine = titled(l, "Triweekly");
      // This week's instance moves to Thursday; the one three weeks on stays an instance.
      expect(mine.map((e) => local(e.start))[0]).toBe(`${day(3)} 10:00`);
      expect(mine).toHaveLength(2);
      expect(mine.every((e) => e.recurringId === series)).toBe(true);
    },
  );
});

test("no limit on meetings per organizer, and stats count flexible meetings as one-to-one or group time next to booked meetings (rule 36; analytics summary)", async ({
  page,
  cal,
  signIn,
  browser,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const titles = Array.from({ length: 12 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`);
  for (const [i, title] of titles.entries()) {
    await fillMeeting(page, {
      title,
      // M01 is a group meeting; the others are one-to-ones.
      guests: i === 0 ? "dana@example.com, eli@example.com" : "dana@example.com",
      idealTime: `${String(9 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`,
    });
  }
  const week = await eventually(
    () => range(cal, 7),
    (l) => {
      for (const t of titles) expect(titled(l, t), t).toHaveLength(1);
    },
  );
  await page.reload();
  await expect(page.getByTestId("meeting-row")).toHaveCount(12);
  for (const t of titles) expect(titled(await range(cal, 7), t)).toHaveLength(1);

  // One booked meeting through a link, Monday 16:00 to 16:30.
  await claimPage(page, "rules");
  await addLink(page, { title: "Intro" });
  const v = await visitor(browser);
  await v.goto("/book/rules/intro");
  await book(v, at(W, "16:00"), "Visitor", "visitor@example.com");
  await eventually(
    () => range(cal, 7),
    (l) =>
      expect(l.filter((e) => e.summary.startsWith("Intro")).map((e) => local(e.start))).toEqual([
        `${W} 16:00`,
      ]),
  );

  const minutes = (title: string) =>
    titled(week, title).reduce((a, e) => a + (e.end - e.start) / 60_000, 0);
  expect(minutes("M01")).toBe(30);
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
  // 11 one-to-ones of 30 minutes; 1 group meeting of 30 minutes; 1 booking of 30 minutes.
  await expect(page.getByTestId("stat-oneOnOne")).toHaveText("5 h 30 min");
  await expect(page.getByTestId("stat-groupMeetings")).toHaveText("30 min");
  await expect(page.getByTestId("stat-bookedMeetings")).toHaveText("30 min");
  await page.reload();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
  await expect(page.getByTestId("stat-oneOnOne")).toHaveText("5 h 30 min");
});
