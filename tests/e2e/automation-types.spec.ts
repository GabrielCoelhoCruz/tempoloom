// The six automation types in one list (docs/specs/automations-overview.md
// rules 6-13, row 299): habits, focus time, buffers and flexible meetings
// with the meeting overload (focus-time.md rules 11-16) and the meeting checks
// (automations-meeting-quality.md rules 1-2, 11).
//
// Ways this can fail, and the test that catches each:
// - A meeting overload or a meeting check is missing from the list, or sits in
//   the wrong place: the overload outside P4, a check in a priority group
//   (groups test).
// - The overload can change its priority or be dropped on another group; a
//   check can be ranked or dragged into a group (groups test).
// - The type filter has no choice for the new types, shows other types with
//   them, or forgets the choice on reload (groups test).
// - A built-in check offers Remove, though every user keeps it (groups test,
//   built-in check test).
// - The overload's Edit does not open its own editor with its values, or the
//   saved edit does not change its events or is lost on reload (overload test).
// - Turning the overload off keeps its focus events; on does not bring them
//   back; the state is lost on reload (overload test).
// - The rank of the overload in P4 is not saved, or the scheduler ignores it:
//   the focus automation ranked first must get the free time first (overload
//   test).
// - Remove of the overload runs without a confirm, or keeps its future focus
//   events (overload test).
// - Turning a built-in check off in the list keeps its issues in the Issues
//   tab or keeps it on in the meeting checks page; on does not bring the issue
//   back; a check that is off by default cannot be turned on; the state is lost
//   on reload (built-in check test).
// - A company check is missing from the list or shows no lock, or a lock
//   glyph that needs an emoji font; a member can change or remove it; the
//   admin's off or remove in the list does not reach the members (company
//   check test).

import type { Page } from "@playwright/test";
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import { day, invite, minutesOf, openSettings, span, week } from "./automation-helpers.ts";
import {
  automation,
  create,
  group,
  names,
  openAutomations,
  save,
} from "./automation-list-helpers.ts";
import { at, BACKEND, blockUntil, EMAIL, expect, test, ZONE } from "./fixtures.ts";
import { addHabit, expectLockIcon, titled, W } from "./helpers.ts";
import { issue, openChecks, openIssues, putMeeting } from "./meeting-helpers.ts";
import { teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "These scenarios use invitations and CalDAV meeting answers.");

const LONG = { timeout: 60_000 };
const CHECKS = [
  "Overlapping commitments",
  "Attendee declined or not free",
  "Unanswered invitations",
  "Missing video link",
  "Agenda drafts",
];
const quality = (page: Page) => page.getByTestId("automation-quality");
const typeFilter = (page: Page) => page.getByLabel("Type", { exact: true });

/** Adds a meeting overload in the Settings page with a daily meeting limit. */
async function addOverload(page: Page, title: string, dailyHours: number, minBlock = 30) {
  await openSettings(page);
  const form = page.getByTestId("overload-form");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Daily meeting limit (hours)").fill(String(dailyHours));
  await form.getByLabel("Shortest focus block (minutes)").fill(String(minBlock));
  await form.getByRole("button", { name: "Add meeting overload" }).click();
  await expect(page.locator(`[data-overload-title="${title}"]`)).toBeVisible();
}

test("the list shows all six types: meeting overload pinned to P4, meeting checks in Meeting quality with no priority and no Remove; the type filter covers every type after a reload (rules 6-11; row 299)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Read", ideal: "09:00", min: 30, max: 30, level: 2 });
  await page.getByRole("link", { name: "Meetings" }).click();
  const meeting = page.getByTestId("meeting-form");
  await meeting.getByLabel("Title").fill("Sync");
  await meeting.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Sync"]')).toBeVisible();
  const buffer = await create(page, "Buffer");
  await buffer.getByLabel("Title").fill("Prep");
  await buffer.getByLabel("Side").selectOption({ label: "Before" });
  await buffer.getByLabel("Before the event (minutes)").fill("15");
  await buffer.getByLabel("Which events").selectOption({ label: "Meetings with other people" });
  await buffer.getByLabel("Priority").selectOption({ label: "P3 medium" });
  await save(buffer);
  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("Deep work");
  await focus.getByLabel("Weekly goal (hours)").fill("2");
  await save(focus);
  await addOverload(page, "Meeting cap", 2);

  await openAutomations(page);
  const groups = async () => ({
    1: await names(group(page, 1)),
    2: await names(group(page, 2)),
    3: await names(group(page, 3)),
    4: await names(group(page, 4)),
    quality: await names(quality(page)),
  });
  // At one rank, the meeting overload comes before focus time: the scheduler's order.
  const expected = {
    1: [],
    2: ["Sync", "Read"],
    3: ["Prep"],
    4: ["Meeting cap", "Deep work"],
    quality: CHECKS,
  };
  await expect.poll(groups).toEqual(expected);
  await expect(quality(page).getByRole("heading")).toHaveText("Meeting quality");
  await expect(automation(page, "Meeting cap")).toContainText("Meeting overload");
  await expect(automation(page, "Meeting cap").getByLabel("Priority")).toBeDisabled();
  await expect(
    automation(page, "Meeting cap").getByRole("button", { name: "Remove" }),
  ).toBeVisible();
  await expect(automation(page, "Missing video link")).toContainText("Meeting check");
  // Agenda drafts are off for a new user (meeting quality rule 1, library entry 4).
  await expect(automation(page, "Agenda drafts")).toContainText("Off");
  await expect(automation(page, "Missing video link")).not.toContainText("Off");
  for (const name of CHECKS) {
    const entry = automation(page, name);
    await expect(entry.getByRole("link", { name: "Edit" })).toBeVisible();
    await expect(entry.getByRole("button", { name: /^Turn (off|on)$/ })).toBeVisible();
    await expect(entry.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(entry.getByLabel("Priority")).toHaveCount(0);
  }

  // Rule 8: the overload stays in P4; rule 9: a check joins no priority group.
  await automation(page, "Meeting cap").dragTo(group(page, 1));
  await automation(page, "Missing video link").dragTo(group(page, 2));
  await expect.poll(groups).toEqual(expected);

  // Rule 10: the filter has every type, and keeps the choice after a reload.
  await expect(typeFilter(page).locator("option")).toHaveText([
    "All types",
    "Habits",
    "Focus time",
    "Buffers",
    "Flexible meetings",
    "Meeting overloads",
    "Meeting checks",
  ]);
  await typeFilter(page).selectOption({ label: "Meeting overloads" });
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(["Meeting cap"]);
  await page.reload();
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(["Meeting cap"]);
  await typeFilter(page).selectOption({ label: "Meeting checks" });
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(CHECKS);
  await page.reload();
  await expect(typeFilter(page)).toHaveValue("meeting_check");
  await expect.poll(() => names(page.getByTestId("automations-page"))).toEqual(CHECKS);
  await expect.poll(() => names(group(page, 4))).toEqual([]);
  await typeFilter(page).selectOption({ label: "All types" });
  await expect.poll(groups).toEqual(expected);

  // Edit of a check opens the meeting checks page.
  await automation(page, "Missing video link").getByRole("link", { name: "Edit" }).click();
  await expect(page.getByTestId("checks-page")).toBeVisible();
});

test("a meeting overload's list entry opens its editor, ranks against focus time in P4, turns it off and on, and removes it, each with its effect on the calendar (rules 8, 11-15; focus-time rules 12, 29)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  // Two accepted meeting hours on Tuesday; an own event leaves a 45-minute gap at 11:00.
  await invite(cal, "Planning", tue, "09:00", "10:00", "ACCEPTED");
  await invite(cal, "Design review", tue, "10:00", "11:00", "ACCEPTED");
  await cal.addEvent({ title: "Errand", start: at(tue, "11:45"), end: at(tue, "12:00") });
  await signIn();
  await addOverload(page, "Meeting cap", 2, 30);
  await expect
    .poll(async () => titled(await week(cal), "Meeting cap").map(span), LONG)
    .toEqual([`${tue} 11:00-11:45`, `${tue} 12:00-17:00`]);

  // Edit opens the overload's own form with its values; the saved change replans.
  await openAutomations(page);
  await automation(page, "Meeting cap").getByRole("link", { name: "Edit" }).click();
  const form = page.getByTestId("overload-form");
  await expect(form.getByLabel("Title")).toHaveValue("Meeting cap");
  await expect(form.getByLabel("Daily meeting limit (hours)")).toHaveValue("2");
  await expect(form.getByLabel("Shortest focus block (minutes)")).toHaveValue("30");
  await form.getByLabel("Title").fill("Meeting limit");
  await form.getByLabel("Shortest focus block (minutes)").fill("60");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator('[data-overload-title="Meeting limit"]')).toContainText(
    "blocks of 1 h or more",
  );
  await expect(form.getByRole("button", { name: "Add meeting overload" })).toBeVisible();
  await expect
    .poll(async () => {
      const evs = await week(cal);
      return [titled(evs, "Meeting limit").map(span), titled(evs, "Meeting cap").length];
    }, LONG)
    .toEqual([[`${tue} 12:00-17:00`], 0]);
  await page.reload();
  await expect(page.locator('[data-overload-title="Meeting limit"]')).toContainText(
    "blocks of 1 h or more",
  );
  await openAutomations(page);
  await automation(page, "Meeting limit").getByRole("link", { name: "Edit" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("Meeting limit");
  await expect(form.getByLabel("Shortest focus block (minutes)")).toHaveValue("60");

  // Rule 12: off deletes its future focus events and keeps the settings; on brings them back.
  await openAutomations(page);
  await automation(page, "Meeting limit").getByRole("button", { name: "Turn off" }).click();
  await expect(automation(page, "Meeting limit")).toContainText("Off");
  await expect.poll(async () => titled(await week(cal), "Meeting limit").length, LONG).toBe(0);
  await page.reload();
  await expect(automation(page, "Meeting limit")).toContainText("Off");
  await automation(page, "Meeting limit").getByRole("button", { name: "Turn on" }).click();
  await expect(automation(page, "Meeting limit")).not.toContainText("Off");
  await expect
    .poll(async () => titled(await week(cal), "Meeting limit").map(span), LONG)
    .toEqual([`${tue} 12:00-17:00`]);

  // Rank: at first the overload goes first, so its Tuesday focus time meets the
  // 2-hour goal of "Deep work" in this week (counted time) and the goal adds none here.
  const focus = await create(page, "Focus time");
  await focus.getByLabel("Title").fill("Deep work");
  await focus.getByLabel("Weekly goal (hours)").fill("2");
  await save(focus);
  await expect.poll(() => names(group(page, 4))).toEqual(["Meeting limit", "Deep work"]);
  await expect
    .poll(async () => minutesOf(titled(await week(cal, day(7)), "Deep work")), LONG)
    .toBe(120);
  expect(titled(await week(cal), "Deep work")).toEqual([]);
  // Ranked above the overload, "Deep work" takes its 2 hours first; the overload keeps the rest.
  await automation(page, "Deep work").dragTo(automation(page, "Meeting limit"));
  await expect.poll(() => names(group(page, 4))).toEqual(["Deep work", "Meeting limit"]);
  await expect
    .poll(async () => {
      const evs = await week(cal);
      return [
        minutesOf(titled(evs, "Deep work")),
        titled(evs, "Meeting limit").every((e) => span(e).startsWith(tue)),
        titled(evs, "Meeting limit").length > 0,
      ];
    }, LONG)
    .toEqual([120, true, true]);
  await page.reload();
  await expect.poll(() => names(group(page, 4))).toEqual(["Deep work", "Meeting limit"]);
  await expect(automation(page, "Meeting limit").getByLabel("Priority")).toBeDisabled();

  // Rule 13: remove asks first, then deletes the overload and its future focus events.
  await automation(page, "Meeting limit").getByRole("button", { name: "Remove" }).click();
  const confirm = automation(page, "Meeting limit").getByRole("alertdialog");
  await expect(confirm).toContainText("Remove Meeting limit and its future events?");
  await confirm.getByRole("button", { name: "Yes, remove" }).click();
  await expect(automation(page, "Meeting limit")).toHaveCount(0);
  await expect.poll(async () => titled(await week(cal), "Meeting limit").length, LONG).toBe(0);
  await page.reload();
  await expect.poll(() => names(group(page, 4))).toEqual(["Deep work"]);
  await openSettings(page);
  await expect(page.getByTestId("overload-section")).toBeVisible();
  await expect(page.locator('[data-overload-title="Meeting limit"]')).toHaveCount(0);
});

test("a built-in meeting check turns off and on from the list: its issues leave and return in the Issues tab, the meeting checks page follows, and a check that is off by default turns on (meeting quality rules 1-2; rules 9, 11)", async ({
  page,
  cal,
  signIn,
}) => {
  const t1 = addDays(utcToLocal(ZONE, Date.now()).date, 1);
  await signIn();
  // A meeting the user organizes, with a guest, no video link and no description.
  await putMeeting(cal.calendarId, {
    title: "Kickoff",
    start: at(t1, "11:00"),
    end: at(t1, "11:30"),
    organizer: EMAIL,
    attendees: [{ email: "dana@example.com", answer: "ACCEPTED" }],
  });
  await openIssues(page);
  await expect(issue(page, "video_link", "Kickoff")).toBeVisible(LONG);

  await openAutomations(page);
  await automation(page, "Missing video link").getByRole("button", { name: "Turn off" }).click();
  await expect(automation(page, "Missing video link")).toContainText("Off");
  await openIssues(page);
  await expect(page.getByTestId("checks-issues")).toContainText("No open issues");
  await openChecks(page);
  const form = page.getByTestId("checks-form");
  await expect(form.getByLabel("Missing video link")).not.toBeChecked();
  await expect(form.getByLabel("Unanswered invitations")).toBeChecked();
  await page.reload();
  await expect(form.getByLabel("Missing video link")).not.toBeChecked();
  await openAutomations(page);
  await expect(automation(page, "Missing video link")).toContainText("Off");
  await expect(
    automation(page, "Missing video link").getByRole("button", { name: "Remove" }),
  ).toHaveCount(0);

  await automation(page, "Missing video link").getByRole("button", { name: "Turn on" }).click();
  await expect(automation(page, "Missing video link")).not.toContainText("Off");
  // Agenda drafts start off; on, the meeting without a description gets its issue.
  await automation(page, "Agenda drafts").getByRole("button", { name: "Turn on" }).click();
  await expect(automation(page, "Agenda drafts")).not.toContainText("Off");
  await openIssues(page);
  await expect(issue(page, "video_link", "Kickoff")).toBeVisible(LONG);
  await expect(issue(page, "agenda", "Kickoff")).toBeVisible(LONG);
  await page.reload();
  await page.getByRole("tab", { name: /^Issues/ }).click();
  await expect(issue(page, "video_link", "Kickoff")).toBeVisible(LONG);
  await expect(issue(page, "agenda", "Kickoff")).toBeVisible();
  await openChecks(page);
  await expect(form.getByLabel("Missing video link")).toBeChecked();
  await expect(form.getByLabel("Agenda drafts")).toBeChecked();
});

test("a company check shows locked in the Meeting quality section: the admin turns it off and removes it from the list, a member gets no actions and sees each change (meeting quality rule 11; rules 9, 11, 13)", async ({
  page,
  signIn,
  colleague,
  mail,
}) => {
  const member = await teamOfTwo(page, signIn, colleague, mail);
  await openChecks(page);
  const add = page.getByTestId("company-check-form");
  await add.getByLabel("Name").fill("Agenda for big meetings");
  await add.getByLabel("At least this many attendees").fill("5");
  await add.getByLabel("Description is empty").check();
  await add.getByRole("button", { name: "Add company check" }).click();
  await expect(page.locator('[data-company-check="Agenda for big meetings"]')).toBeVisible();

  const name = "Agenda for big meetings";
  await openAutomations(page);
  await expect.poll(() => names(quality(page))).toEqual([...CHECKS, name]);
  const admin = automation(page, name);
  await expect(admin).toContainText("Company check");
  await expectLockIcon(admin);
  await expect(admin.getByRole("button", { name: "Turn off" })).toBeVisible();
  await expect(admin.getByRole("button", { name: "Remove" })).toBeVisible();

  await openAutomations(member);
  await expect.poll(() => names(quality(member))).toEqual([...CHECKS, name]);
  const locked = automation(member, name);
  await expectLockIcon(locked);
  await expect(locked.getByRole("button")).toHaveCount(0);
  await expect(locked.getByRole("link")).toHaveCount(0);

  // The admin turns it off in the list: the member's checks page and list follow.
  await admin.getByRole("button", { name: "Turn off" }).click();
  await expect(admin).toContainText("Off");
  await openChecks(member);
  const row = member.locator(`[data-company-check="${name}"]`);
  await expect(row.getByRole("checkbox")).not.toBeChecked();
  await openAutomations(member);
  await expect(locked).toContainText("Off");
  await page.reload();
  await expect(admin).toContainText("Off");

  // Remove asks first and removes it for every member.
  await admin.getByRole("button", { name: "Remove" }).click();
  const confirm = admin.getByRole("alertdialog");
  await expect(confirm).toContainText(`Remove ${name} for every team member?`);
  await confirm.getByRole("button", { name: "Yes, remove" }).click();
  await expect(admin).toHaveCount(0);
  await expect.poll(() => names(quality(page))).toEqual(CHECKS);
  await member.reload();
  await expect.poll(() => names(quality(member))).toEqual(CHECKS);
  await openChecks(member);
  await expect(member.getByTestId("company-checks")).toContainText("No company checks.");
  await openChecks(page);
  await expect(page.getByTestId("company-checks")).toContainText("No company checks.");
});
