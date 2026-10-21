// The weekly report email and its calendar facts
// (docs/specs/analytics-weekly-reports.md rules 1-7, T1, T2, T3).
//
// Ways this can fail, each covered below:
// - the report goes out before or after the first hour of work on the last workday, or twice a week;
// - the last workday comes from a fixed Friday, not from the work hours (T2);
// - the report counts time after the send time (rule 5);
// - the facts of the email differ from the facts the stats page shows for the week;
// - a fact with a zero value shows, or more than 4 facts show;
// - the report is off for a new user, or the opt-out is lost on reload or ignored;
// - only the operator command sends it, not the server's own clock;
// - work tasks or work habits miss solo work, or personal tasks, personal habits or
//   a personal calendar's events miss personal time (rule 6);
// - turning the report on again does not send it again (rule 2);
// - a user without work hours, or whose last workday is out of office, gets no
//   report, or an empty week sends nothing (edge cases 1, 2, 5);
// - work hours changed during the week are ignored, so the report keeps the old send day (edge case 3);
// - a user who never signed in, is deactivated or whose calendar account is
//   disconnected still gets the report (rule 5 decision).
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { addPolicy, copies, week } from "./calendar-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  planNow,
  test,
  ZONE,
} from "./fixtures.ts";
import { addHabit, addTask, book, claimPage, MIN, titled, visitor, W } from "./helpers.ts";
import { outOfOffice } from "./ics.ts";
import { setPassword } from "./radicale-users.ts";
import { scim } from "./scim.ts";
import { directoryRow, rowShows, setGrant } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
const utc = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00Z`).toISOString();
const hm = (m: number) => {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
};

const REPORT = /^Your week/;

async function reportSwitch(page: Page) {
  await page.getByRole("link", { name: "Settings" }).click();
  return page.getByTestId("weekly-report").getByLabel("Weekly report email");
}

test("the weekly report goes out once in the first work hour of the last workday, with the week's totals and the calendar facts of the stats page; the user can turn it off", async ({
  page,
  browser,
  cal,
  app,
  mail,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees need CalDAV here.");
  await blockUntil(cal, W);
  const team = ["ana@tempoloom.test", "ben@tempoloom.test"];
  await cal.addEvent({
    title: "Planning",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:30"),
    attendees: team,
  });
  await cal.addEvent({
    title: "1:1 with Vera",
    start: at(day(1), "14:00"),
    end: at(day(1), "14:30"),
    attendees: ["vera@tempoloom.test"],
  });
  await cal.addEvent({
    title: "Sync",
    start: at(day(3), "10:00"),
    end: at(day(3), "10:30"),
    attendees: team,
  });
  await cal.addEvent({ title: "Write spec", start: at(day(2), "09:00"), end: at(day(2), "11:30") });
  // Friday afternoon, after the send time: not in this week's report (rule 5).
  await cal.addEvent({ title: "Review", start: at(day(4), "14:00"), end: at(day(4), "15:30") });
  await signIn();
  // On for a new user.
  await expect(await reportSwitch(page)).toBeChecked();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  // One hour of personal time on Monday evening.
  await addHabit(page, {
    title: "Evening run",
    ideal: "18:00",
    min: 60,
    max: 60,
    days: ["Mon"],
    hours: "Personal hours",
  });
  // A visitor books 30 minutes through a booking link: the fifth kind of fact.
  await claimPage(page, "weekly");
  const v = await visitor(browser);
  await v.goto("/book/weekly/quick-meeting");
  await book(v, at(day(3), "14:00"), "Bo", "bo@example.com");
  const placed = await eventually(
    () => cal.events(at(W, "00:00"), at(day(5), "00:00")),
    (l) => {
      expect(titled(l, "Evening run")).toHaveLength(1);
      expect(l.filter((e) => e.start === at(day(3), "14:00"))).toHaveLength(1);
      // After the three meetings from the calendar; the booking is Tempoloom's own event.
      expect(titled(l, "Recovery")).toHaveLength(3);
    },
  );
  const breaks = titled(placed, "Recovery").reduce((a, e) => a + (e.end - e.start) / MIN, 0);
  const booked = placed.find((e) => e.start === at(day(3), "14:00"));
  const bookedMinutes = ((booked?.end ?? 0) - (booked?.start ?? 0)) / MIN;
  expect(bookedMinutes).toBeGreaterThan(0);
  // Five facts apply; the first 4 show, so "People met" does not.
  const facts = [
    "Busiest meeting day: Tuesday (2 h)",
    "Longest focus session: 2 h 30 min",
    "Meetings booked through links: 1",
    `Breaks taken: ${hm(breaks)}`,
  ];
  // The stats page shows the same facts for the week.
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(4));
  const shown = page.getByTestId("calendar-facts");
  await expect(shown.locator("li")).toHaveText(facts);

  // Work hours end the week on Friday, 09:00 to 17:00: nothing before 09:00 or from 10:00.
  expect(app.cli("weekly-reports", "--now", iso(day(4), "08:55"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "10:00"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(3), "09:30"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 1 report");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:45"))).toContain("sent 0 reports");
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(4)}`);
  // 2 h 30 min from the calendar, and the booking.
  expect(report.text).toContain(`Meetings: ${hm(150 + bookedMinutes)}\n`);
  // Friday's 14:00 Review is after the send time.
  expect(report.text).toContain("Solo work: 2 h 30 min\n");
  expect(report.text).toContain("Personal time: 1 h\n");
  const listed = report.text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
  expect(listed).toEqual(facts);
  expect(report.html).toContain("Longest focus session: 2 h 30 min");
  expect(report.text).toContain(`/stats?from=${W}&to=${day(4)}`);
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);

  // Opt out: the switch stays off after reload, and next Friday sends nothing.
  await (await reportSwitch(page)).uncheck();
  await expect(page.getByTestId("weekly-report-saved")).toHaveText("Saved");
  await page.reload();
  await expect(
    page.getByTestId("weekly-report").getByLabel("Weekly report email"),
  ).not.toBeChecked();
  expect(app.cli("weekly-reports", "--now", iso(day(11), "09:30"))).toContain("sent 0 reports");
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("with work hours Monday to Thursday 10:00 to 18:00 the weekly report goes out on Thursday between 10:00 and 11:00, and not on Friday", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  const editor = page.locator("#hours");
  for (const d of [1, 2, 3, 4]) {
    const r = editor.getByTestId(`range-work-${d}-0`);
    await r.locator("input").first().fill("10:00");
    await r.locator("input").nth(1).fill("18:00");
  }
  await editor.getByTestId("range-work-5-0").getByRole("button", { name: "−" }).click();
  await page.getByRole("button", { name: "Save work hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(editor.getByTestId("range-work-4-0").locator("input").first()).toHaveValue("10:00");
  await expect(editor.getByTestId("range-work-5-0")).toHaveCount(0);

  expect(app.cli("weekly-reports", "--now", iso(day(3), "09:55"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(3), "11:00"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "10:30"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(3), "10:30"))).toContain("sent 1 report");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "10:30"))).toContain("sent 0 reports");
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(3)}`);
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("the server sends the weekly report by its own clock in the first work hour of Friday", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Write spec", start: at(day(1), "09:00"), end: at(day(1), "10:00") });
  await signIn();
  await expect(await reportSwitch(page)).toBeChecked();
  // The server's clock starts 10 seconds before Friday 09:00, with weekly reports on.
  app.env.TEST_CLOCK_START = new Date(Date.parse(iso(day(4), "09:00")) - 10_000).toISOString();
  app.env.WEEKLY_REPORTS = "on";
  await app.restart();
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(0);
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(4)}`);
  expect(report.text).toContain("Solo work: 1 h\n");
  // Later ticks in the same hour send nothing more.
  await page.waitForTimeout(12_000);
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("the weekly report counts work tasks and work habits as solo work and personal tasks, personal habits and a personal calendar's events as personal time; turned off and on, it goes out, also on an out-of-office Friday", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  test.skip(BACKEND === "google", "A second calendar needs CalDAV here.");
  await blockUntil(cal, W);
  await signIn();
  // Made after sign-in, so that the main calendar stays Work.
  const priv = await cal.newCalendar("Private");
  // A neutral title: no keyword makes it personal, only the calendar's label does.
  await priv.addEvent({ title: "Call", start: at(day(1), "12:00"), end: at(day(1), "13:00") });
  // Edge case 2: the last workday is a full out-of-office day; the report goes out anyway.
  await outOfOffice(cal.calendarId, "Day off", { from: day(4), to: day(5) });
  await addHabit(page, {
    title: "Evening run",
    ideal: "18:00",
    min: 60,
    max: 60,
    days: ["Mon"],
    hours: "Personal hours",
  });
  await page.reload();
  await addHabit(page, { title: "Inbox", ideal: "16:00", min: 30, max: 30, days: ["Tue"] });
  await addTask(page, { title: "Draft plan", minutes: 90, split: false, due: `${day(3)}T17:00` });
  await addTask(page, {
    title: "Pay bills",
    minutes: 60,
    split: false,
    due: `${day(2)}T22:00`,
    hours: "Personal hours",
  });
  // The private calendar is personal: its events count as personal time (rule 6).
  await addPolicy(page, { from: "Private", to: "Work", label: "Personal commitment" });
  const placed = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Evening run")).toHaveLength(1);
      expect(titled(l, "Inbox")).toHaveLength(1);
      expect(titled(l, "Draft plan")).toHaveLength(1);
      expect(titled(l, "Pay bills")).toHaveLength(1);
      expect(copies(l).filter((e) => e.start === at(day(1), "12:00"))).toHaveLength(1);
    },
  );
  // Every item ends before the send time on Friday at 09:30.
  for (const e of ["Inbox", "Draft plan", "Pay bills"].flatMap((t) => titled(placed, t)))
    expect(e.end).toBeLessThanOrEqual(at(day(4), "09:30"));

  // Off, then on again: the switch is on after reload, and the report goes out.
  await (await reportSwitch(page)).uncheck();
  await expect(page.getByTestId("weekly-report-saved")).toHaveText("Saved");
  await page.reload();
  const again = page.getByTestId("weekly-report").getByLabel("Weekly report email");
  await expect(again).not.toBeChecked();
  await again.check();
  await expect(page.getByTestId("weekly-report-saved")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByTestId("weekly-report").getByLabel("Weekly report email")).toBeChecked();

  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 1 report");
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(4)}`);
  // The 90-minute task and the 30-minute work habit; the copy of the personal event is not counted twice.
  expect(report.text).toContain("Solo work: 2 h\n");
  // The personal task, the personal habit and the event of the personal calendar.
  expect(report.text).toContain("Personal time: 3 h\n");
  expect(report.text).toContain("Meetings: 0 min\n");
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("without work hours the weekly report goes out on Friday between 09:00 and 10:00, and an empty week has zero totals", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  const editor = page.locator("#hours");
  for (const d of [1, 2, 3, 4, 5])
    await editor.getByTestId(`range-work-${d}-0`).getByRole("button", { name: "−" }).click();
  await page.getByRole("button", { name: "Save work hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  for (const d of [1, 2, 3, 4, 5])
    await expect(editor.getByTestId(`range-work-${d}-0`)).toHaveCount(0);

  // Edge case 1: Friday at 09:00 home time.
  expect(app.cli("weekly-reports", "--now", iso(day(3), "09:30"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "08:55"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "10:00"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 1 report");
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(4)}`);
  // Edge case 5: zero events give zero totals.
  expect(report.text).toContain("Meetings: 0 min\n");
  expect(report.text).toContain("Solo work: 0 min\n");
  expect(report.text).toContain("Personal time: 0 min\n");
  expect(report.text).toContain("No facts this week.");
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("work hours changed during the week move that week's report to the new last workday (edge case 3)", async ({
  page,
  cal,
  app,
  mail,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Wednesday of the test week, with the default hours (Monday to Friday 09:00 to 17:00): nothing yet.
  expect(app.cli("weekly-reports", "--now", iso(day(2), "09:30"))).toContain("sent 0 reports");
  // The user then ends the week on Thursday, starting at 10:00.
  await page.getByRole("link", { name: "Settings" }).click();
  const editor = page.locator("#hours");
  const thursday = editor.getByTestId("range-work-4-0");
  await thursday.locator("input").first().fill("10:00");
  await editor.getByTestId("range-work-5-0").getByRole("button", { name: "−" }).click();
  await page.getByRole("button", { name: "Save work hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(editor.getByTestId("range-work-5-0")).toHaveCount(0);
  await expect(thursday.locator("input").first()).toHaveValue("10:00");

  // The hours in force at send time decide: Thursday 10:00 to 11:00, and no Friday report.
  expect(app.cli("weekly-reports", "--now", iso(day(3), "09:30"))).toContain("sent 0 reports");
  expect(app.cli("weekly-reports", "--now", iso(day(3), "10:30"))).toContain("sent 1 report");
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 0 reports");
  const report = await mail.message("e2e@tempoloom.test", REPORT);
  expect(report.subject).toBe(`Your week: ${W} to ${day(3)}`);
  expect(await mail.count("e2e@tempoloom.test", REPORT)).toBe(1);
});

test("only users who signed in, are active and have a working calendar account get the weekly report: never signed in, deactivated or disconnected users get none (rule 5)", async ({
  page,
  cal,
  app,
  mail,
  signIn,
  people,
  radicale,
}) => {
  const five = radicale?.users[5];
  if (!radicale || !five) throw new Error("This test needs the CalDAV backend.");
  test.setTimeout(120_000);
  await blockUntil(cal, W);
  await signIn();
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  await page.getByRole("link", { name: "Team", exact: true }).click();
  const directory = page.getByTestId("directory");
  await directory.getByRole("button", { name: "Create SCIM token" }).click();
  const token = (await directory.getByTestId("scim-token").textContent()) ?? "";
  const idp = scim(token);
  // In the directory with a working calendar account through the team's calendar
  // access, but never signed in.
  await setGrant(page, radicale.grant);
  const n = await people(6);
  const never = n.email;
  await idp.create({ userName: never, displayName: "Nemo" });
  await rowShows(page, never, "calendar: attached");
  await expect(directoryRow(page, never)).toContainText("signed in: no");
  const v = await people(4);
  const vId = await idp.create({ userName: v.email, displayName: "Vera" });
  await v.signIn();
  const d = await people(5);
  const pd = await d.signIn();

  // This week: the three users who signed in get it; the one who never did gets none.
  expect(app.cli("weekly-reports", "--now", iso(day(4), "09:30"))).toContain("sent 3 reports");
  // 09:30 UTC: the send hour of the never-signed-in user, whose home time zone is UTC.
  // In Berlin it is 10:30 in winter and 11:30 in summer, after the other users' send hour.
  expect(app.cli("weekly-reports", "--now", utc(day(4), "09:30"))).toContain("sent 0 reports");
  expect((await mail.message(v.email, REPORT)).subject).toBe(`Your week: ${W} to ${day(4)}`);
  expect((await mail.message(d.email, REPORT)).subject).toBe(`Your week: ${W} to ${day(4)}`);
  expect(await mail.count(never, REPORT)).toBe(0);

  try {
    // Vera is deactivated, and the CalDAV server stops taking Dan's stored password.
    expect((await idp.patch(vId, [{ op: "replace", path: "active", value: false }])).status).toBe(
      200,
    );
    await page.reload();
    await expect(directory.locator(`[data-directory="${v.email}"]`)).toContainText("deactivated");
    setPassword(five.username, 5, `new-${Date.now()}`);
    await planNow(pd);
    await pd.getByRole("link", { name: "Account", exact: true }).click();
    await expect
      .poll(
        async () => {
          await pd.reload();
          return pd
            .getByTestId("account-list")
            .locator(`[data-account="${d.email}"]`)
            .getByTestId("account-status")
            .textContent();
        },
        { timeout: 45_000 },
      )
      .toBe("Disconnected");

    // Next week only the admin gets one.
    expect(app.cli("weekly-reports", "--now", iso(day(11), "09:30"))).toContain("sent 1 report");
    expect(app.cli("weekly-reports", "--now", utc(day(11), "09:30"))).toContain("sent 0 reports");
    await expect.poll(() => mail.count("e2e@tempoloom.test", REPORT)).toBe(2);
    expect(await mail.count(v.email, REPORT)).toBe(1);
    expect(await mail.count(d.email, REPORT)).toBe(1);
    expect(await mail.count(never, REPORT)).toBe(0);
  } finally {
    setPassword(five.username, 5, five.password);
  }
});
