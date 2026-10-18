// Team out-of-office calendars (docs/specs/teams-ooo-calendar.md, SPEC-TEAMS-03)
// on Radicale: e2e2 may change events in e2e's "shared-*" calendars, e2e3 may
// only read them. Out-of-office events carry X-MICROSOFT-CDO-BUSYSTATUS:OOF.
//
// Ways it can fail, and the test that catches each:
// - a read-only person, or a person outside the team, becomes a participant   -> participants
// - the owner (full access) is missing from the participants                  -> participants
// - a teammate with write access who joins later is not enrolled              -> participants
// - an absence that existed before the person joined is never copied          -> participants
// - a full-day absence is copied as a timed event, or on the wrong date       -> participants
// - a moved absence leaves the old copy or adds a second one                  -> participants
// - a deleted absence leaves its copy                                          -> participants
// - a read-only person's absence is copied                                    -> participants
// - a partial-day absence is not copied with its exact times                  -> partial
// - after the switch to all-day display, new partial absences keep exact times,
//   or existing copies are rewritten (edge case 6)                            -> partial
// - an all-day busy event is copied while the setting is off (edge case 7)     -> partial
// - an all-day busy event made after the setting is on is not copied           -> partial
// - a person in two out-of-office calendars gets a copy in only one           -> partial
// - the person's own managed events stay on the time away                     -> partial
// - admin settings are lost after a reload                                    -> partial, members
// - a member cannot add a calendar while the team allows it                   -> members
// - a member can still add a calendar after the admin switches it off         -> members
// Every test reloads the team page and reads the shared calendar again.
import type { Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
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
import { addHabit, titled, W } from "./helpers.ts";
import { allDayBusy, outOfOffice } from "./ics.ts";
import { accept, invite, joinLink, openTeam, teamOfTwo } from "./team-helpers.ts";

test.skip(
  BACKEND === "google",
  "Out-of-office E2E uses several CalDAV users and shared calendars.",
);

const day = (n: number) => addDays(W, n);

/** Copies on a shared calendar in the test week, as "<title>: <start> to <end>[ (all day)]". */
async function copies(shared: CalendarDriver): Promise<string[]> {
  const evs = await shared.events(at(W, "00:00"), at(day(7), "00:00"));
  return evs
    .filter((e: ProviderEvent) => e.summary.endsWith("out of office"))
    .sort((a, b) => a.start - b.start)
    .map(
      (e) => `${e.summary}: ${local(e.start)} to ${local(e.end)}${e.allDay ? " (all day)" : ""}`,
    );
}

async function addCalendar(p: Page, name: string, calendar: string) {
  await openTeam(p);
  const section = p.getByTestId("ooo");
  await section.getByRole("button", { name: "Add a calendar" }).click();
  const form = p.getByTestId("ooo-form");
  await form.getByLabel("Name").fill(name);
  await form.getByLabel("Shared calendar").selectOption({ label: calendar });
  await form.getByRole("button", { name: "Create" }).click();
  await expect(section.locator(`[data-ooo="${name}"]`)).toBeVisible();
}

const participants = (p: Page, name: string) =>
  p.locator(`[data-ooo="${name}"]`).getByTestId("participants");

test("participants come from write access to the shared calendar; a teammate who joins later is enrolled; a full-day absence is copied and follows moves and deletes (rules 2, 4, 6, 7, 10, 13, 14; T1, T2, T4, T5)", async ({
  page,
  cal,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const c = await people(3);
  await signIn();
  const pc = await c.signIn();
  await invite(page, [c.email]);
  await accept(pc, joinLink((await mail.message(c.email, /invited you/)).text));
  const shared = await cal.newCalendar("Shared");
  // C (read-only on Shared) is away on Monday; B is away on Wednesday before joining.
  await outOfOffice(c.cal.calendarId, "OOO", { from: day(0), to: day(1) });
  const away = await outOfOffice(colleague.cal.calendarId, "Vacation", {
    from: day(2),
    to: day(3),
  });

  await addCalendar(page, "Team OOO", "Shared");
  const row = page.locator('[data-ooo="Team OOO"]');
  await expect(row).toContainText("Owner: e2e");
  await expect(row).toContainText("Calendar: Shared");
  await expect(participants(page, "Team OOO")).toContainText(EMAIL);
  await expect(participants(page, "Team OOO")).not.toContainText(c.email);

  // B has write access and joins later: enrolled without any setup.
  const pb = await colleague.signIn();
  await invite(page, [colleague.email]);
  await accept(pb, joinLink((await mail.message(colleague.email, /invited you/)).text));
  await eventually(
    () => copies(shared),
    (l) => expect(l).toEqual([`e2e2 out of office: ${day(2)} 00:00 to ${day(3)} 00:00 (all day)`]),
    60_000,
  );
  await page.reload();
  await expect(participants(page, "Team OOO")).toContainText(colleague.email);
  await expect(participants(page, "Team OOO")).toContainText(EMAIL);
  await expect(participants(page, "Team OOO")).not.toContainText(c.email);

  // B moves the absence to Tuesday, then deletes it.
  await outOfOffice(colleague.cal.calendarId, "Vacation", { from: day(1), to: day(2) }, away);
  await eventually(
    () => copies(shared),
    (l) => expect(l).toEqual([`e2e2 out of office: ${day(1)} 00:00 to ${day(2)} 00:00 (all day)`]),
  );
  await colleague.cal.remove(away);
  await eventually(
    () => copies(shared),
    (l) => expect(l).toEqual([]),
  );

  await page.reload();
  await expect(participants(page, "Team OOO")).toContainText(colleague.email);
  await expect(participants(page, "Team OOO")).not.toContainText(c.email);
  expect(await copies(shared)).toEqual([]);
});

test("partial-day absences keep exact times until the admin switches to all-day; all-day busy events count only from the switch on; two calendars get a copy each; the person's managed events move off the time away (rules 9, 11, 12, 16; edge cases 4, 6, 7; T3, T6)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(colleague.cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addHabit(pb, { title: "Review", ideal: "14:30", min: 30, max: 30 });
  const team = await cal.newCalendar("Shared-team");
  const leads = await cal.newCalendar("Shared-leads");
  await addCalendar(page, "Team OOO", "Shared-team");
  await addCalendar(page, "Leads OOO", "Shared-leads");

  // While all-day busy events do not count: a dentist appointment, then 14:00 to 16:00 away.
  await allDayBusy(colleague.cal.calendarId, "Dentist", day(1));
  await outOfOffice(colleague.cal.calendarId, "Doctor", {
    start: at(day(3), "14:00"),
    end: at(day(3), "16:00"),
  });
  const thursday = `e2e2 out of office: ${day(3)} 14:00 to ${day(3)} 16:00`;
  for (const shared of [team, leads]) {
    await eventually(
      () => copies(shared),
      (l) => expect(l).toEqual([thursday]),
      60_000,
    );
  }
  // B's own habit leaves the time away on Thursday and stays at 14:30 on other days.
  await eventually(
    () => colleague.cal.events(at(day(2), "00:00"), at(day(4), "00:00")),
    (l) =>
      expect(titled(l, "Review").map((e) => local(e.start))).toEqual([
        `${day(2)} 14:30`,
        `${day(3)} 13:30`,
      ]),
  );

  await openTeam(page);
  const form = page.getByTestId("ooo-settings");
  await form.getByLabel("Count all-day busy events as time away").check();
  await form.getByLabel("Partial-day time away").selectOption({ label: "As all-day events" });
  await form.getByRole("button", { name: "Save out-of-office settings" }).click();
  await expect(form.getByTestId("ooo-saved")).toBeVisible();

  await outOfOffice(colleague.cal.calendarId, "Errand", {
    start: at(day(4), "10:00"),
    end: at(day(4), "11:00"),
  });
  await allDayBusy(colleague.cal.calendarId, "Conference", day(0));
  const expected = [
    `e2e2 out of office: ${day(0)} 00:00 to ${day(1)} 00:00 (all day)`,
    thursday,
    `e2e2 out of office: ${day(4)} 00:00 to ${day(5)} 00:00 (all day)`,
  ];
  for (const shared of [team, leads]) {
    await eventually(
      () => copies(shared),
      (l) => expect(l).toEqual(expected),
      60_000,
    );
  }

  await page.reload();
  await expect(form.getByLabel("Count all-day busy events as time away")).toBeChecked();
  await expect(form.getByLabel("Partial-day time away")).toHaveValue("all_day");
  for (const shared of [team, leads]) expect(await copies(shared)).toEqual(expected);
});

test("members add out-of-office calendars while the team allows it; after an admin switches it off only admins can (rules 1-3; T7)", async ({
  page,
  signIn,
  colleague,
  mail,
}) => {
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await colleague.cal.newCalendar("Away");
  await addCalendar(pb, "My OOO", "Away");
  await expect(pb.locator('[data-ooo="My OOO"]')).toContainText("Owner: e2e2");
  await expect(participants(pb, "My OOO")).toContainText(colleague.email);

  await openTeam(page);
  const form = page.getByTestId("ooo-settings");
  await expect(form.getByLabel("Members can add out-of-office calendars")).toBeChecked();
  await form.getByLabel("Members can add out-of-office calendars").uncheck();
  await form.getByRole("button", { name: "Save out-of-office settings" }).click();
  await expect(form.getByTestId("ooo-saved")).toBeVisible();

  await pb.reload();
  await expect(pb.locator('[data-ooo="My OOO"]')).toBeVisible();
  await expect(pb.getByTestId("ooo").getByRole("button", { name: "Add a calendar" })).toHaveCount(
    0,
  );
  const status = await pb.evaluate(() =>
    fetch("/api/team/ooo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Sneaky", calendarId: "x" }),
    }).then((r) => r.status),
  );
  expect(status).toBe(403);
  await page.reload();
  await expect(
    page.getByTestId("ooo").getByRole("button", { name: "Add a calendar" }),
  ).toBeVisible();
  await expect(form.getByLabel("Members can add out-of-office calendars")).not.toBeChecked();
});
