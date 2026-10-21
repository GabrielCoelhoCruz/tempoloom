// Out of office, vacation and company holidays
// (docs/specs/events-out-of-office.md). CalDAV has no event type for time
// away: Outlook-style clients mark it with X-MICROSOFT-CDO-BUSYSTATUS:OOF, and
// Tempoloom reads that as the out-of-office type.
//
// Ways this can fail, each covered below:
// - an out-of-office event does not block habits, or shows no away category;
// - stats put all away time under vacation, or split it at the wrong length
//   (8 hours or more is vacation, shorter is a personal commitment);
// - #tl_free in the title of an out-of-office event does not open it to habits
//   and tasks;
// - a habit that keeps conflicts gets a conflict on time away, as it does on
//   plain busy time (rules 2, 12: away occurrences are skipped);
// - an accepted or maybe busy holiday invitation does not block, or an
//   unanswered one or a free holiday does;
// - a holiday sent only to a mailing list blocks before the user answers.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, openWeek, titled, W } from "./helpers.ts";
import { invitation, outOfOffice } from "./ics.ts";

test.skip(BACKEND === "google", "Out-of-office and invitations are written as raw CalDAV objects.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const lunchDays = (l: Awaited<ReturnType<typeof week>>) =>
  titled(l, "Lunch").map((e) => local(e.start));

async function expectCategory(page: Page, text: string, shown: string) {
  await page.locator(".ev-external", { hasText: text }).first().click();
  const drawer = page.getByTestId("event-drawer");
  await expect(drawer.locator(".status").nth(1)).toContainText(shown);
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
}

async function openStats(page: Page) {
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
}

test("out-of-office time blocks habits and tasks and counts as vacation from 8 hours, else as a personal commitment; #tl_free in its title lets habits and tasks back (events-out-of-office rules 1, 6, 7; AT 3-5)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const thursday = await outOfOffice(cal.calendarId, "OOO", {
    start: at(day(3), "09:00"),
    end: at(day(3), "17:00"),
  });
  await outOfOffice(cal.calendarId, "Dentist away", {
    start: at(day(4), "11:00"),
    end: at(day(4), "13:00"),
  });
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  // A task that can only go on Thursday's away time.
  const thursdayOnly = { minutes: 60, split: false, startAfter: `${day(3)}T09:00` };
  await addTask(page, { title: "AT-Blocked", ...thursdayOnly, due: `${day(3)}T17:00` });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(4),
  );
  await planNow(page);
  const onThursday = (l: Awaited<ReturnType<typeof week>>, title: string) =>
    titled(l, title).filter((e) => local(e.start).startsWith(day(3)));
  expect(onThursday(await week(cal), "AT-Blocked")).toEqual([]);
  const lunches = lunchDays(placed);
  expect(lunches.slice(0, 3)).toEqual([`${W} 12:00`, `${day(1)} 12:00`, `${day(2)} 12:00`]);
  // Friday's lunch is outside the two hours away.
  const friday = titled(placed, "Lunch")[3];
  expect(local(friday?.start ?? 0).slice(0, 10)).toBe(day(4));
  expect(
    (friday?.end ?? 0) <= at(day(4), "11:00") || (friday?.start ?? 0) >= at(day(4), "13:00"),
  ).toBe(true);

  const checks = async () => {
    await openWeek(page);
    await expectCategory(page, "OOO", "Vacation");
    await expectCategory(page, "Dentist away", "Personal commitment");
    await openStats(page);
    const cats = page.getByTestId("cat-breakdown");
    await expect(cats.getByTestId("cat-vacation")).toHaveText("8 h");
    await expect(cats.getByTestId("cat-personal_commitment")).toHaveText("2 h");
  };
  await checks();
  await page.reload();
  await checks();

  // The user adds #tl_free to the title: others still see time away, habits come back.
  await outOfOffice(
    cal.calendarId,
    "OOO #tl_free",
    { start: at(day(3), "09:00"), end: at(day(3), "17:00") },
    thursday,
  );
  const back = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  expect(lunchDays(back)[3]).toBe(`${day(3)} 12:00`);
  // A task made now can use Thursday too (the scheduler keeps placements that
  // are still valid, so a new task shows the rule).
  await addTask(page, { title: "AT-Free", ...thursdayOnly, due: `${day(3)}T17:00` });
  const withTask = await eventually(
    () => week(cal),
    (l) => expect(onThursday(l, "AT-Free")).toHaveLength(1),
  );
  expect(onThursday(withTask, "Lunch")).toHaveLength(1);
  const ooo = back.find((e) => e.summary === "OOO #tl_free");
  expect(ooo?.busy).toBe(true);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(5);
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "AT-Free" })).toHaveCount(1);
  await expectCategory(page, "OOO #tl_free", "Vacation");
});

test("a habit that keeps conflicts is skipped on time away and kept as a conflict on plain busy time (events-out-of-office rules 2, 12)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Tuesday: a plain busy event over the whole workday. Wednesday: out of office.
  await cal.addEvent({ title: "Workshop", start: at(day(1), "09:00"), end: at(day(1), "17:00") });
  await outOfOffice(cal.calendarId, "OOO", {
    start: at(day(2), "09:00"),
    end: at(day(2), "17:00"),
  });
  await signIn();
  await addHabit(page, {
    title: "Lunch",
    ideal: "12:00",
    min: 60,
    max: 60,
    noRoom: "Keep and mark the conflict",
  });
  const expected = (l: Awaited<ReturnType<typeof week>>) => {
    const lunch = titled(l, "Lunch");
    expect(lunch.map((e) => `${e.summary} ${local(e.start)}`)).toEqual([
      `○ Lunch ${W} 12:00`,
      `⚠️ Lunch ${day(1)} 12:00`,
      `○ Lunch ${day(3)} 12:00`,
      `○ Lunch ${day(4)} 12:00`,
    ]);
  };
  await eventually(() => week(cal), expected);
  await page.reload();
  await planNow(page);
  expected(await week(cal));
  await openWeek(page);
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(4);
});

test("a company holiday blocks the day once the user answers yes or maybe to its invitation; an unanswered one and a free holiday do not (events-out-of-office rules 9-10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const holiday = (d: string, answer: "ACCEPTED" | "TENTATIVE" | "NEEDS-ACTION") =>
    invitation(cal.calendarId, {
      title: "Company holiday",
      description: "Office closed.",
      span: { from: d, to: addDays(d, 1) },
      organizer: "hr@tempoloom.test",
      attendees: [
        { email: EMAIL, answer },
        { email: "all@tempoloom.test", answer: "NEEDS-ACTION" },
      ],
    });
  await holiday(day(1), "ACCEPTED");
  const wednesday = await holiday(day(2), "NEEDS-ACTION");
  await cal.addAllDay(day(3), "Public holiday", false);
  await holiday(day(4), "TENTATIVE");
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(3),
  );
  // Tuesday (yes) and Friday (maybe) are away; Wednesday (no answer) and the free Thursday are not.
  expect(lunchDays(placed)).toEqual([`${W} 12:00`, `${day(2)} 12:00`, `${day(3)} 12:00`]);

  // The user says yes to Wednesday's holiday in their calendar app.
  await invitation(
    cal.calendarId,
    {
      title: "Company holiday",
      description: "Office closed.",
      span: { from: day(2), to: day(3) },
      organizer: "hr@tempoloom.test",
      attendees: [
        { email: EMAIL, answer: "ACCEPTED" },
        { email: "all@tempoloom.test", answer: "NEEDS-ACTION" },
      ],
    },
    wednesday,
  );
  const after = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(2),
  );
  expect(lunchDays(after)).toEqual([`${W} 12:00`, `${day(3)} 12:00`]);
  await openWeek(page);
  await page.reload();
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(2);
});

test("a company holiday sent only to a mailing list does not block until the user answers yes; then it blocks the day (events-out-of-office rule 10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const holiday = {
    title: "Company holiday",
    description: "Office closed.",
    span: { from: day(1), to: day(2) },
    organizer: "hr@tempoloom.test",
  };
  // The invitation lists only the mailing list, not the user.
  const id = await invitation(cal.calendarId, {
    ...holiday,
    attendees: [{ email: "all@tempoloom.test", answer: "NEEDS-ACTION" }],
  });
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const before = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(5),
  );
  expect(lunchDays(before)).toContain(`${day(1)} 12:00`);

  // The user says yes in their calendar app, which adds the user's own attendee line.
  await invitation(
    cal.calendarId,
    {
      ...holiday,
      attendees: [
        { email: "all@tempoloom.test", answer: "NEEDS-ACTION" },
        { email: EMAIL, answer: "ACCEPTED" },
      ],
    },
    id,
  );
  const after = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(4),
  );
  expect(lunchDays(after)).not.toContain(`${day(1)} 12:00`);
  await openWeek(page);
  await page.reload();
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(4);
});
