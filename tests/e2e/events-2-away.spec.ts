// Out of office, vacation and company holidays
// (docs/specs/events-out-of-office.md). CalDAV has no event type for time
// away: Outlook-style clients mark it with X-MICROSOFT-CDO-BUSYSTATUS:OOF, and
// Tempoloom reads that as the out-of-office type.
//
// Ways this can fail, each covered below:
// - an out-of-office event does not block habits, or shows no away category;
// - stats put all away time under vacation, or split it at the wrong length
//   (8 hours or more is vacation, shorter is a personal commitment);
// - #tl_free in the title of an out-of-office event does not open it to habits;
// - an accepted busy holiday invitation does not block, or an unanswered one
//   or a free holiday does.
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
  test,
} from "./fixtures.ts";
import { addHabit, openWeek, titled, W } from "./helpers.ts";
import { invitation, outOfOffice } from "./ics.ts";

test.skip(BACKEND === "google", "Out-of-office and invitations are written as raw CalDAV objects.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const lunchDays = (l: Awaited<ReturnType<typeof week>>) =>
  titled(l, "Lunch").map((e) => local(e.start));

async function category(page: Page, text: string): Promise<string> {
  await page.locator(".ev-external", { hasText: text }).first().click();
  const drawer = page.getByTestId("event-drawer");
  const status = (await drawer.locator(".status").nth(1).textContent()) ?? "";
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  return status;
}

async function openStats(page: Page) {
  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
}

test("out-of-office time blocks habits and counts as vacation from 8 hours, else as a personal commitment; #tl_free in its title lets habits back (events-out-of-office rules 1, 6, 7; AT 3-5)", async ({
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
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(4),
  );
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
    expect(await category(page, "OOO")).toContain("Vacation");
    expect(await category(page, "Dentist away")).toContain("Personal commitment");
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
  const ooo = back.find((e) => e.summary === "OOO #tl_free");
  expect(ooo?.busy).toBe(true);
  await page.reload();
  await openWeek(page);
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(5);
  expect(await category(page, "OOO #tl_free")).toContain("Vacation");
});

test("a company holiday blocks the day once the user accepts its invitation; an unanswered one and a free holiday do not (events-out-of-office rules 9-10)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const holiday = (d: string, answer: "ACCEPTED" | "NEEDS-ACTION") =>
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
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const placed = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(4),
  );
  expect(lunchDays(placed)).toEqual([
    `${W} 12:00`,
    `${day(2)} 12:00`,
    `${day(3)} 12:00`,
    `${day(4)} 12:00`,
  ]);

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
    (l) => expect(titled(l, "Lunch")).toHaveLength(3),
  );
  expect(lunchDays(after)).toEqual([`${W} 12:00`, `${day(3)} 12:00`, `${day(4)} 12:00`]);
  await openWeek(page);
  await page.reload();
  await expect(page.locator(".ev:not(.ev-external)", { hasText: "Lunch" })).toHaveCount(3);
});
