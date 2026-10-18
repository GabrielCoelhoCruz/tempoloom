// Meeting agenda policy: detection, reminders with a draft from the meeting
// type's template, the "adjust" proposal, auto-decline at a lead time, agenda
// templates and the agenda report (docs/specs/teams-policies.md rules 14-20,
// T3, T4).
//
// Ways it can fail, and the check that catches each:
// - an invitation without an agenda is not declined at the lead time    -> PARTSTAT=DECLINED
// - an invitation is declined before the lead time                      -> the later one stays
// - an invitation with an agenda is declined                            -> it stays unanswered
// - the decline is not written to the member's calendar                 -> Radicale read
// - "remind" changes the meeting or the RSVP                            -> time and answer stay
// - no reminder, or a reminder for a meeting that has an agenda         -> reminder list
// - the draft ignores the meeting type or the admin's custom template   -> draft text per type
// - adding the agenda does not reach the calendar, or the reminder stays -> description, reload
// - a dismissed reminder comes back                                      -> reload
// - "adjust" shortens without the organizer's consent, or not at all    -> end time before/after
// - a member can change templates                                        -> 403 check
// - the report counts declined meetings as attended, or shows names      -> report cells
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, eventually, expect, local, test } from "./fixtures.ts";
import { W } from "./helpers.ts";
import {
  cell,
  createPolicy,
  editPolicy,
  openPolicies,
  openReport,
  provisioned,
} from "./policy-helpers.ts";

test.skip(BACKEND === "google", "Agenda policy E2E uses several CalDAV users.");

const tue = addDays(W, 1);
const wed = addDays(W, 2);
const thu = addDays(W, 3);

test("auto-decline declines invitations without an agenda at the lead time and keeps the others (T3; rules 14, 17)", async ({
  page,
  signIn,
  people,
}) => {
  const { members } = await provisioned(page, signIn, people, [{ n: 3 }]);
  const [b] = members as [(typeof members)[0]];
  const vendor = await b.person.cal.addInvite({
    title: "Vendor sync",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    answer: "NEEDS-ACTION",
  });
  const roadmap = await b.person.cal.addInvite({
    title: "Roadmap review",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    answer: "NEEDS-ACTION",
    description: "1. Roadmap\n2. Risks",
  });
  const later = await b.person.cal.addInvite({
    title: "Later sync",
    start: at(addDays(W, 8), "10:00"),
    end: at(addDays(W, 8), "11:00"),
    answer: "NEEDS-ACTION",
  });
  // The lead time reaches the end of Tuesday of week W, not Tuesday a week later.
  const leadHours = Math.ceil((at(wed, "00:00") - Date.now()) / 3_600_000);

  await createPolicy(page, {
    type: "Meeting agendas",
    name: "Agendas",
    strictness: "Auto-decline",
    leadHours,
  });

  const answers = async () => {
    const evs = await b.person.cal.events(at(W, "00:00"), at(addDays(W, 14), "00:00"));
    const of = (id: string) => evs.find((e) => e.id === id)?.selfResponse;
    return { vendor: of(vendor), roadmap: of(roadmap), later: of(later) };
  };
  await eventually(answers, (a) => expect(a.vendor).toBe("declined"));
  // A few more sync cycles must not change the others.
  await b.page.waitForTimeout(12_000);
  expect(await answers()).toEqual({
    vendor: "declined",
    roadmap: "needsAction",
    later: "needsAction",
  });

  await openPolicies(b.page);
  await b.page.reload();
  const declined = b.page.getByTestId("agenda-declines");
  await expect(declined.locator('[data-declined="Vendor sync"]')).toContainText("no agenda");
  await expect(declined.locator("[data-declined]")).toHaveCount(1);

  // Rule 20: the report counts meetings members attend; the declined one is not one.
  // Two members are in scope (the admin has no meetings): values are per-member averages.
  const report = await openReport(page, "Agendas");
  await expect(report.getByTestId("report-members")).toHaveText("2 members in scope");
  await expect(cell(report, "meetings", W)).toHaveText("0.5");
  await expect(cell(report, "withAgendaPercent", W)).toHaveText("100");
  await expect(cell(report, "declined", W)).toHaveText("0.5");
  await expect(cell(report, "averageMeetingMinutes", W)).toHaveText("60");
  await page.reload();
  await expect(cell(page.getByTestId("policy-report"), "declined", W)).toHaveText("0.5");
  await expect(page.getByTestId("policy-report")).not.toContainText(b.person.email);
});

test("remind lists meetings without an agenda with a draft from the type's template; adjust proposes a shorter meeting (T4; rules 15, 16, 18, 19)", async ({
  page,
  signIn,
  people,
}) => {
  const { members } = await provisioned(page, signIn, people, [{ n: 3 }, { n: 4 }]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];

  // Rule 19: the admin replaces the one-on-one template; the others stay built in.
  await openPolicies(page);
  const templates = page.getByTestId("agenda-templates");
  await templates.getByLabel("One-on-one template").fill("1. Wins\n2. Blockers\n3. Next steps");
  await templates.getByRole("button", { name: "Save templates" }).click();
  await expect(templates.getByTestId("templates-saved")).toBeVisible();
  const refused = await b.page.evaluate(async () => {
    const r = await fetch("/api/policies/templates", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templates: { one_on_one: "x" } }),
    });
    return r.status;
  });
  expect(refused).toBe(403);

  const plan = await b.person.cal.addEvent({
    title: "Plan with C",
    start: at(tue, "11:00"),
    end: at(tue, "12:00"),
    attendees: [c.person.email],
  });
  await b.person.cal.addEvent({
    title: "Team sync",
    start: at(wed, "09:00"),
    end: at(wed, "10:00"),
    attendees: [c.person.email, "kim@tempoloom.test"],
  });
  await b.person.cal.addEvent({
    title: "Prepared",
    start: at(wed, "13:00"),
    end: at(wed, "14:00"),
    attendees: [c.person.email],
    description: "Topics: hiring plan",
  });

  await createPolicy(page, { type: "Meeting agendas", name: "Agendas", strictness: "Remind" });

  await openPolicies(b.page);
  const reminders = b.page.getByTestId("agenda-reminders");
  await eventually(
    async () => {
      await b.page.reload();
      return reminders.locator("[data-reminder]").count();
    },
    (n) => expect(n).toBe(2),
  );
  const planReminder = reminders.locator('[data-reminder="Plan with C"]');
  await expect(planReminder.getByLabel("Draft agenda")).toHaveValue(
    "1. Wins\n2. Blockers\n3. Next steps",
  );
  await expect(planReminder).toContainText("No AI draft");
  await expect(
    reminders.locator('[data-reminder="Team sync"]').getByLabel("Draft agenda"),
  ).toHaveValue(/^1\. Goal of this meeting/);
  await expect(reminders.locator('[data-reminder="Prepared"]')).toHaveCount(0);
  await expect(planReminder.getByRole("button", { name: "Shorten" })).toHaveCount(0);

  // "remind" changes nothing on the calendar.
  const before = (await b.person.cal.events(at(tue, "00:00"), at(wed, "00:00"))).find(
    (e) => e.id === plan,
  );
  expect(local(before?.start ?? 0)).toBe(`${tue} 11:00`);
  expect(local(before?.end ?? 0)).toBe(`${tue} 12:00`);
  expect(before?.description).toBe("");

  // The organizer adds the drafted agenda; it reaches the calendar and the reminder goes.
  await planReminder.getByRole("button", { name: "Add agenda to meeting" }).click();
  await expect(planReminder).toHaveCount(0);
  const after = (await b.person.cal.events(at(tue, "00:00"), at(wed, "00:00"))).find(
    (e) => e.id === plan,
  );
  expect(after?.description).toContain("1. Wins\n2. Blockers\n3. Next steps");
  expect(local(after?.start ?? 0)).toBe(`${tue} 11:00`);
  await reminders
    .locator('[data-reminder="Team sync"]')
    .getByRole("button", { name: "Dismiss" })
    .click();
  await expect(reminders.locator("[data-reminder]")).toHaveCount(0);
  await b.page.waitForTimeout(8_000);
  await b.page.reload();
  await expect(b.page.getByTestId("agenda-reminders").locator("[data-reminder]")).toHaveCount(0);

  // Rule 16: "adjust" proposes to shorten; nothing changes until the organizer applies it.
  await editPolicy(page, "Agendas", { strictness: "Adjust" });
  const review = await b.person.cal.addEvent({
    title: "Long review",
    start: at(thu, "13:00"),
    end: at(thu, "14:00"),
    attendees: [c.person.email],
  });
  const reviewReminder = b.page
    .getByTestId("agenda-reminders")
    .locator('[data-reminder="Long review"]');
  await eventually(
    async () => {
      await b.page.reload();
      return reviewReminder.count();
    },
    (n) => expect(n).toBe(1),
  );
  await expect(reviewReminder).toContainText("Proposed: shorten to 30 minutes");
  const unchanged = (
    await b.person.cal.events(at(thu, "00:00"), at(addDays(thu, 1), "00:00"))
  ).find((e) => e.id === review);
  expect(local(unchanged?.end ?? 0)).toBe(`${thu} 14:00`);
  await reviewReminder.getByRole("button", { name: "Shorten" }).click();
  await expect(reviewReminder.getByRole("button", { name: "Shorten" })).toHaveCount(0);
  const shortened = (
    await b.person.cal.events(at(thu, "00:00"), at(addDays(thu, 1), "00:00"))
  ).find((e) => e.id === review);
  expect(local(shortened?.start ?? 0)).toBe(`${thu} 13:00`);
  expect(local(shortened?.end ?? 0)).toBe(`${thu} 13:30`);
  await b.page.reload();
  await expect(
    b.page.getByTestId("agenda-reminders").locator('[data-reminder="Long review"]'),
  ).toContainText("Shortened to 30 minutes");
});
