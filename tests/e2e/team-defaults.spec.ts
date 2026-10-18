// Team defaults for new members (docs/specs/teams-settings-templates.md rules
// 3-11, focus-time.md rules 25, 27): habit templates, default hours and the
// team focus time template.
//
// Ways it can fail, and the test that catches each:
// - default hours do not reach a person who joins after the admin saves them  -> hours
// - default hours change members who were already in the team                -> hours
// - a later change of a default changes members who joined before it          -> hours
// - the member's habits ignore the copied hours (Friday still used)            -> hours
// - default meeting hours are not copied                                       -> hours
// - turning the focus recommendation off leaves a goal or shows it again       -> hours
// - a new member sees no habit templates while joining (onboarding)            -> focus
// - the focus recommendation is missing for a new member, or ignores the
//   member's change of the weekly goal                                         -> focus
// - an accepted recommendation does not become an ordinary focus goal that
//   places focus events                                                        -> focus
// - an existing member sees the recommendation                                 -> focus
// - the onboarding step comes back after the member closes it                  -> focus
// - team habit templates are missing from an existing member's habits page     -> templates
// - adding a template does not create a habit, or creates it with other fields -> templates
// - editing a template changes habits already made from it (edge case 1)       -> templates
// - a deleted template stays listed, or deletes the habit (edge case 2)        -> templates
// - a member who is not an admin can manage templates                          -> templates
// Every test reloads the pages and reads the calendar again.
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
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, titled, W } from "./helpers.ts";
import { invite, joinLink, openTeam, teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Team E2E uses several CalDAV users.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof week>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);
const settings = (p: Page) => p.getByRole("link", { name: "Settings" }).click();
const focusSection = (p: Page) =>
  p.locator("section", { has: p.getByRole("heading", { name: "Focus time" }) });

/** Sets the given weekdays of an hours editor to one range and removes the others' ranges. */
async function setHours(
  editor: Locator,
  kind: string,
  range: [string, string],
  days: number[],
  removed: number[],
) {
  for (const d of days) {
    const r = editor.getByTestId(`range-${kind}-${d}-0`);
    await r.locator("input").first().fill(range[0]);
    await r.locator("input").nth(1).fill(range[1]);
  }
  for (const d of removed)
    await editor.getByTestId(`range-${kind}-${d}-0`).getByRole("button", { name: "−" }).click();
}

interface Template {
  title: string;
  ideal: string;
  minutes: number;
  days: ("Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun")[];
  hours?: "Work hours" | "Personal hours";
}

async function addTemplate(p: Page, t: Template) {
  await openTeam(p);
  const form = p.getByTestId("template-form");
  await form.getByLabel("Title").fill(t.title);
  await form.getByLabel("Ideal time").fill(t.ideal);
  await form.getByLabel("Duration (minutes)").fill(String(t.minutes));
  if (t.hours) await form.getByLabel("Hours").selectOption({ label: t.hours });
  for (const d of t.days) await form.getByLabel(d, { exact: true }).check();
  await form.getByRole("button", { name: "Add template" }).click();
  await expect(
    p.getByTestId("team-defaults").locator(`[data-template="${t.title}"]`),
  ).toBeVisible();
}

async function saveFocusTemplate(p: Page, hours: number) {
  await openTeam(p);
  const form = p.getByTestId("focus-template");
  await form.getByLabel("Weekly goal (hours)").fill(String(hours));
  await form.getByRole("button", { name: "Save focus template" }).click();
  await expect(p.getByTestId("defaults-message")).toHaveText("Focus template saved.");
}

/** A person who signs up from the invitation link and joins: a new member. */
async function newMember(
  page: Page,
  person: { email: string; signIn: (path?: string) => Promise<Page> },
  mail: { message(to: string, s: RegExp): Promise<{ text: string }> },
): Promise<Page> {
  await invite(page, [person.email]);
  const link = joinLink((await mail.message(person.email, /invited you/)).text);
  const p = await person.signIn(new URL(link).pathname);
  await p.getByRole("button", { name: "Join team" }).click();
  await expect(p.getByTestId("team-page")).toBeVisible();
  return p;
}

test("default work and meeting hours go to people who join after the admin saves them; existing members and later changes keep their hours (rules 6, 7, 9, 10, 11; T1)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const c = await people(3);
  for (const x of [colleague.cal, c.cal]) await blockUntil(x, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addHabit(pb, { title: "Standup", ideal: "09:00", min: 15, max: 15 });

  await openTeam(page);
  const defaults = page.getByTestId("team-defaults");
  await defaults.getByRole("button", { name: "Set default work hours" }).click();
  await setHours(defaults, "team-work", ["10:00", "16:00"], [1, 2, 3, 4], [5]);
  await defaults.getByRole("button", { name: "Save default work hours" }).click();
  await expect(page.getByTestId("defaults-message")).toHaveText("Default work hours saved.");
  await defaults.getByRole("button", { name: "Set default meeting hours" }).click();
  await setHours(defaults, "team-meeting", ["13:00", "15:00"], [1, 2, 3, 4], [5]);
  await defaults.getByRole("button", { name: "Save default meeting hours" }).click();
  await expect(page.getByTestId("defaults-message")).toHaveText("Default meeting hours saved.");
  await saveFocusTemplate(page, 4);

  const pc = await newMember(page, c, mail);
  await addHabit(pc, { title: "Check-in", ideal: "10:00", min: 30, max: 30 });
  await eventually(
    () => week(c.cal),
    (l) => expect(starts(l, "Check-in")).toEqual([0, 1, 2, 3].map((d) => `${day(d)} 10:00-10:30`)),
  );
  // The member who was there first keeps 09:00 to 17:00 on all five days.
  expect(starts(await week(colleague.cal), "Standup")).toEqual(
    [0, 1, 2, 3, 4].map((d) => `${day(d)} 09:00-09:15`),
  );

  // The new member turns the focus recommendation off: no goal, no prompt again.
  await settings(pc);
  const rec = pc.getByTestId("focus-recommendation");
  await expect(rec).toContainText("4 h");
  await rec.getByRole("button", { name: "Turn off" }).click();
  await expect(rec).toHaveCount(0);
  await pc.reload();
  await expect(pc.getByTestId("focus-recommendation")).toHaveCount(0);
  await expect(pc.getByRole("button", { name: /Protect 10 hours/ })).toBeVisible();

  // A later change of the default reaches nobody who already joined.
  await openTeam(page);
  await defaults.getByTestId("range-team-work-1-0").locator("input").first().fill("08:00");
  await defaults.getByRole("button", { name: "Save default work hours" }).click();
  await expect(page.getByTestId("defaults-message")).toHaveText("Default work hours saved.");

  await pc.reload();
  const work1 = pc.getByTestId("range-work-1-0").locator("input");
  await expect(work1.first()).toHaveValue("10:00");
  await expect(work1.nth(1)).toHaveValue("16:00");
  await expect(pc.getByTestId("range-work-5-0")).toHaveCount(0);
  const meeting1 = pc.getByTestId("range-meeting-1-0").locator("input");
  await expect(meeting1.first()).toHaveValue("13:00");
  await expect(meeting1.nth(1)).toHaveValue("15:00");
  await settings(pb);
  await expect(pb.getByTestId("range-work-1-0").locator("input").first()).toHaveValue("09:00");
  await expect(pb.getByTestId("range-work-5-0")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("range-team-work-1-0").locator("input").first()).toHaveValue(
    "08:00",
  );
  expect(starts(await week(c.cal), "Check-in")).toEqual(
    [0, 1, 2, 3].map((d) => `${day(d)} 10:00-10:30`),
  );
});

test("a new member sees the team's habit templates while joining and takes the focus recommendation with a changed goal; existing members see none (rules 4, 8, 9; T2)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const c = await people(3);
  for (const x of [colleague.cal, c.cal]) await blockUntil(x, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addTemplate(page, {
    title: "Evening walk",
    ideal: "18:00",
    minutes: 30,
    days: ["Mon"],
    hours: "Personal hours",
  });
  await saveFocusTemplate(page, 6);

  const pc = await newMember(page, c, mail);
  const welcome = pc.getByTestId("onboarding");
  await expect(welcome).toContainText("Welcome to e2e's team");
  await expect(welcome).toContainText("6 h of focus time per week");
  const walk = welcome.locator('[data-template="Evening walk"]');
  await walk.getByRole("button", { name: "Add" }).click();
  await expect(walk).toContainText("Added");
  await welcome.getByRole("button", { name: "Done" }).click();
  await expect(pc.getByTestId("onboarding")).toHaveCount(0);

  await settings(pc);
  const rec = pc.getByTestId("focus-recommendation");
  await expect(rec).toContainText("Your team recommends 6 h of focus time per week");
  await expect(rec.getByLabel("Weekly goal (hours)")).toHaveValue("6");
  await rec.getByLabel("Weekly goal (hours)").fill("5");
  await rec.getByRole("button", { name: "Accept" }).click();
  await expect(rec).toHaveCount(0);

  const focusMinutes = (l: Awaited<ReturnType<typeof week>>) =>
    titled(l, "Focus time").reduce((a, e) => a + (e.end - e.start) / 60_000, 0);
  await eventually(
    () => week(c.cal),
    (l) => {
      expect(focusMinutes(l)).toBe(300);
      expect(starts(l, "Evening walk")).toEqual([`${W} 18:00-18:30`]);
    },
  );

  await pc.reload();
  await expect(pc.getByTestId("focus-recommendation")).toHaveCount(0);
  await expect(focusSection(pc)).toContainText("5 h per week");
  await openTeam(pc);
  await expect(pc.getByTestId("onboarding")).toHaveCount(0);

  // The member who was there before the template gets no recommendation and no focus events.
  await settings(pb);
  await expect(pb.getByRole("heading", { name: "Focus time" })).toBeVisible();
  await expect(pb.getByTestId("focus-recommendation")).toHaveCount(0);
  await pb.reload();
  await expect(pb.getByTestId("focus-recommendation")).toHaveCount(0);
  expect(titled(await week(colleague.cal), "Focus time")).toEqual([]);
  expect(focusMinutes(await week(c.cal))).toBe(300);
});

test("team habit templates show at the top of every member's habits page; edits and deletes never change habits made from them; only admins manage them (rules 3, 5; edge cases 1, 2; T3)", async ({
  page,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(colleague.cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addTemplate(page, { title: "Weekly planning", ideal: "09:00", minutes: 60, days: ["Mon"] });
  await addTemplate(page, {
    title: "Weekly status report",
    ideal: "16:00",
    minutes: 30,
    days: ["Fri"],
  });

  await pb.getByRole("link", { name: "Habits" }).click();
  const recommended = pb.getByTestId("team-templates");
  await expect(recommended.locator("[data-template]")).toHaveCount(2);
  const planning = recommended.locator('[data-template="Weekly planning"]');
  await expect(planning).toContainText("1 h");
  await planning.getByRole("button", { name: "Add" }).click();
  await expect(planning).toContainText("Added");
  await expect(pb.locator('[data-habit-title="Weekly planning"]')).toBeVisible();
  await eventually(
    () => week(colleague.cal),
    (l) => expect(starts(l, "Weekly planning")).toEqual([`${W} 09:00-10:00`]),
  );

  // The admin shortens one template and deletes the other.
  await openTeam(page);
  const defaults = page.getByTestId("team-defaults");
  await defaults
    .locator('[data-template="Weekly planning"]')
    .getByRole("button", { name: "Edit" })
    .click();
  await page.getByTestId("template-form").getByLabel("Duration (minutes)").fill("30");
  await page.getByTestId("template-form").getByRole("button", { name: "Save template" }).click();
  await expect(defaults.locator('[data-template="Weekly planning"]')).toContainText("30 min");
  await defaults
    .locator('[data-template="Weekly status report"]')
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(defaults.locator('[data-template="Weekly status report"]')).toHaveCount(0);

  await pb.reload();
  await expect(recommended.locator("[data-template]")).toHaveCount(1);
  await expect(planning).toContainText("30 min");
  await expect(pb.locator('[data-habit-title="Weekly planning"]')).toContainText("1 h");
  await planNow(pb);
  expect(starts(await week(colleague.cal), "Weekly planning")).toEqual([`${W} 09:00-10:00`]);

  // A member who is not an admin cannot manage templates.
  await openTeam(pb);
  await expect(pb.getByTestId("team-defaults")).toHaveCount(0);
  const status = await pb.evaluate(() =>
    fetch("/api/team/habit-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Sneaky",
        idealTime: "10:00",
        minutes: 30,
        days: null,
        level: 3,
        hours: "work",
      }),
    }).then((r) => r.status),
  );
  expect(status).toBe(403);
  await page.reload();
  await expect(page.getByTestId("team-defaults").locator("[data-template]")).toHaveCount(1);
});
