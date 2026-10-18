// Team policies: the policy model, scope from directory attributes, company
// focus time and buffer policies, and their reports (docs/specs/teams-policies.md
// rules 1-13, edge cases 1 and 5, T1 and T2; focus-time.md rules 26-28;
// buffers-automation.md rules 19-21).
//
// Ways it can fail, and the check that catches each:
// - a member can create or change a policy                         -> 403 checks, no form
// - a policy reaches members outside its scope                     -> C's calendar stays empty
// - members in scope get no automation, or one with the wrong goal -> B's focus total
// - the automation is not marked as coming from a team policy      -> settings list after reload
// - an attribute change does not move the policy (no admin action) -> C after the SCIM patch
// - on overlap the broader policy wins                             -> department beats whole team
// - a member without the attribute matches a department policy     -> the admin gets whole-team goal
// - a member's own goal is lost, or reset by a new admin goal      -> B keeps 6 h after the edit
// - a disabled policy keeps its automations                        -> fallback to the broad policy
// - buffers ignore the meeting type, or land outside the scope     -> prep and follow-up checks
// - the daily break is missing or not marked                       -> habit list after reload
// - reports show a single person's value or wrong numbers          -> report cells after reload
// Every check reads the calendar of the person (Radicale) and the UI after a reload.
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { titled, W } from "./helpers.ts";
import {
  cell,
  createPolicy,
  editPolicy,
  minutesIn,
  openPolicies,
  openReport,
  provisioned,
  setDepartment,
} from "./policy-helpers.ts";

test.skip(BACKEND === "google", "Team policy E2E uses several CalDAV users.");

const focus = (cal: Parameters<typeof minutesIn>[0]) => minutesIn(cal, W, "Focus time");

test("a focus policy by department gives members in scope a focus goal from the policy; a directory change moves it (T1, T2; rules 1-4, 9, 11)", async ({
  page,
  cal,
  signIn,
  people,
}) => {
  await blockUntil(cal, W);
  const { idp, members } = await provisioned(page, signIn, people, [
    { n: 3, department: "Engineering" },
    { n: 4, department: "Sales" },
  ]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];
  await blockUntil(b.person.cal, W);
  await blockUntil(c.person.cal, W);

  // Rule 1: only admins manage policies.
  await openPolicies(c.page);
  await expect(c.page.getByTestId("policy-form")).toHaveCount(0);
  const refused = await c.page.evaluate(async () => {
    const r = await fetch("/api/policies", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "focus_time", name: "x", goal: { weeklyGoalMinutes: 60 } }),
    });
    return r.status;
  });
  expect(refused).toBe(403);

  await createPolicy(page, {
    type: "Focus time",
    name: "Engineering focus",
    scope: { attribute: "department", value: "Engineering" },
    weeklyGoalHours: 8,
  });

  await eventually(
    () => focus(b.person.cal),
    (m) => expect(m).toBe(480),
  );
  expect(await focus(c.person.cal)).toBe(0);
  const evs = await b.person.cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
  for (const e of titled(evs, "Focus time")) {
    const [, from] = local(e.start).split(" ");
    const [, to] = local(e.end).split(" ");
    expect((from ?? "") >= "09:00" && (to ?? "") <= "17:00").toBe(true);
    expect(e.busy).toBe(true);
  }

  // The automation list marks it as coming from the policy (outputs).
  await b.page.getByRole("link", { name: "Settings" }).click();
  await b.page.reload();
  const bFocus = b.page.locator('[data-focus-title="Focus time"]');
  await expect(bFocus).toContainText("8 h per week");
  await expect(bFocus).toContainText("From team policy: Engineering focus");
  await expect(bFocus.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await c.page.getByRole("link", { name: "Settings" }).click();
  await c.page.reload();
  await expect(c.page.locator("[data-focus-title]")).toHaveCount(0);

  // The member sees the policy that applies to them.
  await openPolicies(b.page);
  await expect(b.page.locator('[data-my-policy="Engineering focus"]')).toContainText("8 h");
  await openPolicies(c.page);
  await expect(c.page.locator("[data-my-policy]")).toHaveCount(0);

  // T2: the directory moves C to Engineering; no admin action.
  await setDepartment(idp, c.scimId, "Engineering");
  await eventually(
    () => focus(c.person.cal),
    (m) => expect(m).toBe(480),
  );
  await c.page.getByRole("link", { name: "Settings" }).click();
  await c.page.reload();
  await expect(c.page.locator('[data-focus-title="Focus time"]')).toContainText(
    "From team policy: Engineering focus",
  );

  // Rule 11: the report shows group averages against the goal, and no names.
  const report = await openReport(page, "Engineering focus");
  await expect(report.getByTestId("report-members")).toHaveText("2 members in scope");
  await expect(cell(report, "goalHours", W)).toHaveText("8.0");
  await expect(cell(report, "focusScheduledHours", W)).toHaveText("8.0");
  await expect(cell(report, "meetingHours", W)).toHaveText("0.0");
  await page.reload();
  const again = page.getByTestId("policy-report");
  await expect(cell(again, "focusScheduledHours", W)).toHaveText("8.0");
  await expect(again).not.toContainText(b.person.email);
  await expect(again).not.toContainText(c.person.email);
  await expect(again.locator("th.baseline")).toHaveCount(4);
});

test("the narrower policy wins; members personalize their goal and keep it when the admin changes the policy; disabling falls back (rules 5, 7, 9; edge cases 1, 5)", async ({
  page,
  cal,
  signIn,
  people,
}) => {
  await blockUntil(cal, W);
  const { members } = await provisioned(page, signIn, people, [
    { n: 3, department: "Engineering" },
    { n: 4, department: "Engineering" },
  ]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];
  await blockUntil(b.person.cal, W);
  await blockUntil(c.person.cal, W);

  await createPolicy(page, { type: "Focus time", name: "Company focus", weeklyGoalHours: 4 });
  await createPolicy(page, {
    type: "Focus time",
    name: "Engineering focus",
    scope: { attribute: "department", value: "Engineering" },
    weeklyGoalHours: 8,
  });
  // The department policy is narrower than the whole team; the admin has no department.
  await eventually(
    () => focus(b.person.cal),
    (m) => expect(m).toBe(480),
  );
  await eventually(
    () => focus(c.person.cal),
    (m) => expect(m).toBe(480),
  );
  await eventually(
    () => focus(cal),
    (m) => expect(m).toBe(240),
  );

  // B personalizes the goal (rule 9).
  await openPolicies(b.page);
  const mine = b.page.locator('[data-my-policy="Engineering focus"]');
  await mine.getByLabel("My weekly goal (hours)").fill("6");
  await mine.getByRole("button", { name: "Save goal" }).click();
  await eventually(
    () => focus(b.person.cal),
    (m) => expect(m).toBe(360),
  );
  await b.page.reload();
  await expect(b.page.locator('[data-my-policy="Engineering focus"]')).toContainText(
    "personalized",
  );
  await expect(
    b.page.locator('[data-my-policy="Engineering focus"]').getByLabel("My weekly goal (hours)"),
  ).toHaveValue("6");

  // A new admin goal reaches C but keeps B's own value (open question 8).
  await editPolicy(page, "Engineering focus", { weeklyGoalHours: 10 });
  await eventually(
    () => focus(c.person.cal),
    (m) => expect(m).toBe(600),
  );
  expect(await focus(b.person.cal)).toBe(360);
  const report = await openReport(page, "Engineering focus");
  await expect(cell(report, "goalHours", W)).toHaveText("8.0");

  // Disabling the department policy falls back to the whole-team policy.
  await editPolicy(page, "Engineering focus", { enabled: false });
  await eventually(
    () => focus(c.person.cal),
    (m) => expect(m).toBe(240),
  );
  await eventually(
    () => focus(b.person.cal),
    (m) => expect(m).toBe(240),
  );
  await b.page.getByRole("link", { name: "Settings" }).click();
  await b.page.reload();
  await expect(b.page.locator('[data-focus-title="Focus time"]')).toContainText(
    "From team policy: Company focus",
  );
});

test("a buffer policy gives members in scope prep and follow-up buffers by meeting type and a daily break (rules 12, 13; buffers-automation.md rules 19-21)", async ({
  page,
  signIn,
  people,
}) => {
  const { members } = await provisioned(page, signIn, people, [
    { n: 3, department: "Engineering" },
    { n: 4, department: "Sales" },
  ]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];
  const tue = addDays(W, 1);
  const wed = addDays(W, 2);
  for (const m of [b, c]) {
    await blockUntil(m.person.cal, W);
    await m.person.cal.addEvent({
      title: "1:1 Sam",
      start: at(tue, "14:00"),
      end: at(tue, "15:00"),
      attendees: ["sam@tempoloom.test"],
    });
    await m.person.cal.addEvent({
      title: "Client call",
      start: at(wed, "10:00"),
      end: at(wed, "11:00"),
      attendees: ["client@example.com"],
    });
    await m.person.cal.addEvent({
      title: "Team sync",
      start: at(wed, "15:00"),
      end: at(wed, "16:00"),
      attendees: ["sam@tempoloom.test", "kim@tempoloom.test"],
    });
  }

  await createPolicy(page, {
    type: "Buffers",
    name: "Engineering buffers",
    scope: { attribute: "department", value: "Engineering" },
    dailyBreak: 30,
    prep: { type: "One-on-one", minutes: 15 },
    followUp: { type: "External meeting", minutes: 10 },
  });

  const week = (m: (typeof members)[0]) =>
    m.person.cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
  const evs = await eventually(
    () => week(b),
    (l) => {
      expect(titled(l, "Prep: one-on-one")).toHaveLength(1);
      expect(titled(l, "Follow-up: external meeting")).toHaveLength(1);
      expect(titled(l, "Break")).toHaveLength(5);
    },
  );
  const [prep] = titled(evs, "Prep: one-on-one");
  const [follow] = titled(evs, "Follow-up: external meeting");
  expect(local(prep?.start ?? 0)).toBe(`${tue} 13:45`);
  expect(local(prep?.end ?? 0)).toBe(`${tue} 14:00`);
  expect(local(follow?.start ?? 0)).toBe(`${wed} 11:00`);
  expect(local(follow?.end ?? 0)).toBe(`${wed} 11:10`);
  for (const e of titled(evs, "Break")) {
    expect(e.end - e.start).toBe(30 * 60_000);
    const [, from] = local(e.start).split(" ");
    const [, to] = local(e.end).split(" ");
    expect((from ?? "") >= "09:00" && (to ?? "") <= "17:00").toBe(true);
  }
  // No buffer before the team meeting: it is not a one-on-one.
  expect(titled(evs, "Prep").filter((e) => local(e.end) === `${wed} 15:00`)).toHaveLength(0);
  // C is in Sales: nothing.
  const cEvents = await week(c);
  expect(titled(cEvents, "Prep")).toHaveLength(0);
  expect(titled(cEvents, "Follow-up")).toHaveLength(0);
  expect(titled(cEvents, "Break")).toHaveLength(0);

  await b.page.getByRole("link", { name: "Settings" }).click();
  await b.page.reload();
  const buffers = b.page.getByTestId("buffer-list");
  await expect(buffers.locator('[data-buffer-title="Prep: one-on-one"]')).toContainText(
    "From team policy: Engineering buffers",
  );
  await expect(buffers.locator('[data-buffer-title="Follow-up: external meeting"]')).toContainText(
    "From team policy: Engineering buffers",
  );
  await b.page.getByRole("link", { name: "Habits" }).click();
  await expect(b.page.locator('[data-habit-title="Break"]')).toContainText(
    "From team policy: Engineering buffers",
  );

  // Rule 13: coverage is the share of meetings of the policy's types that got a buffer.
  const report = await openReport(page, "Engineering buffers");
  await expect(cell(report, "bufferCoveragePercent", W)).toHaveText("100");
  await page.reload();
  await expect(cell(page.getByTestId("policy-report"), "bufferCoveragePercent", W)).toHaveText(
    "100",
  );
});
