// Organization analytics (docs/specs/analytics-organization.md; figures as in
// analytics-personal-stats.md; fragmented time from teams-policies.md rule 21;
// hourly cost from tools-meeting-cost-calculator.md). Six Radicale users form
// one team; the test plays the identity provider and pushes their directory
// attributes over SCIM.
//
// Ways it can fail, and the check that catches each:
// - grouping by department, manager line or person puts people in the
//   wrong group, or the manager line leaves out indirect reports          -> group values and people counts
// - a group or filter with fewer than 3 people shows values               -> "fewer than 3 people" (rule 10, T2)
// - a custom directory attribute is not offered as a filter               -> site filter listed after reload
// - a metric uses the wrong rule: meeting type split, daily load per
//   workday, focus hours and session length, fragmented time, free time,
//   deep work score, meeting cost with per-department salaries            -> exact values for Engineering
// - salary settings are not kept                                          -> values after reload
// - the week-over-week trend compares the wrong weeks                     -> change column of a 2-week range
// - a range older than 12 weeks is accepted                               -> message, previous range kept
// - the CSV export does not match the page                                -> downloaded rows = page values
// - a member who is not an admin can read organization analytics          -> access message and 403
// - opening reports changes a calendar                                    -> events before = events after
// - a future range leaves out planned breaks or travel                    -> next-week breaks and travel
// - an analytics-only member's calendar is changed by the scheduler,
//   or the member drops out of the reports                                -> no managed event; still counted
import { readFile } from "node:fs/promises";
import { addDays } from "../../src/shared/time.ts";
import {
  CLIENT,
  directory,
  lastWeek,
  meet,
  openStats,
  snapshot,
  synced,
  today,
} from "./analytics-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  managed,
  planNow,
  test,
} from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Organization analytics E2E uses several CalDAV users.");

test("organization analytics group last week by department, manager line and person, filter by custom attributes, score focus and fragmentation, cost meetings, trend week over week and export CSV for admins only (rules 1-10, 12; T1-T4)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
}) => {
  test.setTimeout(300_000);
  const P = lastWeek();
  const d = (n: number) => addDays(P, n);
  const [p3, p4, p5, p6] = [await people(3), await people(4), await people(5), await people(6)];
  const E2 = colleague.email;
  // Engineering: e2e2 10 h of meetings, e2e3 6 h, e2e4 8 h.
  await meet(colleague.cal, d(0), "09:00", "11:00", "Sprint planning", [p3.email, p4.email]);
  await meet(colleague.cal, d(0), "11:30", "12:00", "Check-in", [p3.email]);
  await meet(colleague.cal, d(1), "09:00", "12:00", "Client call", [CLIENT]);
  await meet(colleague.cal, d(2), "09:00", "12:00", "Client call", [CLIENT]);
  await meet(colleague.cal, d(3), "09:00", "10:30", "Client call", [CLIENT]);
  await meet(colleague.cal, d(4), "09:00", "12:00", "Design doc");
  await meet(p3.cal, d(0), "09:00", "11:00", "Sprint planning", [E2, p4.email]);
  await meet(p3.cal, d(0), "11:30", "12:00", "Check-in", [E2]);
  await meet(p3.cal, d(1), "13:00", "16:30", "Client call", [CLIENT]);
  await meet(p3.cal, d(2), "09:00", "10:00", "Email");
  await meet(p3.cal, d(2), "10:30", "11:30", "Code review");
  await meet(p4.cal, d(0), "09:00", "11:00", "Sprint planning", [E2, p3.email]);
  await meet(p4.cal, d(1), "09:00", "15:00", "Client workshop", [CLIENT]);
  await meet(p4.cal, d(3), "13:00", "15:00", "Prototype");
  // Sales: e2e 12 h, e2e5 9 h, e2e6 6 h, and e2e6 2 h in the week before.
  for (const n of [0, 1, 2]) {
    await meet(cal, d(n), "09:00", "13:00", "Customer meeting", [CLIENT]);
    await meet(p5.cal, d(n), "13:00", "16:00", "Customer meeting", [CLIENT]);
  }
  await meet(p6.cal, d(3), "09:00", "12:00", "Customer meeting", [CLIENT]);
  await meet(p6.cal, d(4), "09:00", "12:00", "Customer meeting", [CLIENT]);
  await meet(p6.cal, d(-4), "09:00", "11:00", "Customer meeting", [CLIENT]);

  await signIn();
  await colleague.signIn();
  const pe3 = await p3.signIn();
  for (const p of [p4, p5, p6]) await p.signIn();
  const idp = await directory(page);
  const m = await idp.create({ userName: EMAIL, department: "Sales" });
  const lead = await idp.create({
    userName: E2,
    department: "Engineering",
    managerId: m,
    custom: { site: "Lisbon" },
  });
  await idp.create({ userName: p3.email, department: "Engineering", managerId: lead });
  await idp.create({ userName: p4.email, department: "Engineering", managerId: lead });
  await idp.create({
    userName: p5.email,
    department: "Sales",
    managerId: m,
    custom: { site: "Lisbon" },
  });
  await idp.create({ userName: p6.email, department: "Sales", managerId: m });
  await synced(app, [EMAIL, E2, p3.email, p4.email, p5.email, p6.email]);
  const before = await snapshot(cal, at(d(-7), "00:00"), at(d(7), "00:00"));

  await openStats(page, "Organization");
  await expect(page).toHaveURL(/\/stats\/organization/);
  const report = page.getByTestId("org-analytics");
  await report.getByRole("button", { name: "Last week" }).click();

  // Hourly cost: 96000 / 1920 = 50 by default, 192000 / 1920 = 100 in Engineering.
  const costs = report.getByTestId("meeting-cost-settings");
  await costs.getByLabel("Default annual salary").fill("96000");
  await costs.getByLabel("Annual salary in Engineering").fill("192000");
  await costs.getByRole("button", { name: "Save salaries" }).click();
  await expect(costs.getByTestId("salaries-saved")).toBeVisible();

  await report.getByLabel("Group by").selectOption({ label: "Department" });
  await page.reload();
  await expect(costs.getByLabel("Annual salary in Engineering")).toHaveValue("192000");
  const cell = (group: string, metric: string, period = 0) =>
    report.locator(`[data-group="${group}"] [data-metric="${metric}"] [data-period="${period}"]`);
  const group = (label: string) => report.locator(`[data-group="${label}"]`);
  await expect(group("Engineering").getByTestId("people")).toHaveText("3 people");
  // T1 with the privacy guard: means per person.
  await expect(cell("Engineering", "meetings")).toHaveText("8 h");
  await expect(cell("Sales", "meetings")).toHaveText("9 h");
  // Meeting type split, daily load per workday (2 h, 1 h 12 min, 1 h 36 min).
  await expect(cell("Engineering", "oneOnOne")).toHaveText("20 min");
  await expect(cell("Engineering", "teamMeetings")).toHaveText("2 h");
  await expect(cell("Engineering", "externalMeetings")).toHaveText("5 h 40 min");
  await expect(cell("Engineering", "dailyMeetingLoad")).toHaveText("1 h 36 min");
  // Focus: solo work 3 h, 2 h (two 1 h sessions), 2 h; deep work 3 h, 0, 2 h; 4 sessions.
  await expect(cell("Engineering", "focus")).toHaveText("2 h 20 min");
  await expect(cell("Engineering", "deepWork")).toHaveText("1 h 40 min");
  await expect(cell("Engineering", "focusSession")).toHaveText("1 h 45 min");
  // Fragmented time: 30 min, 60 min and 0 min in 5 workdays each.
  await expect(cell("Engineering", "fragmented")).toHaveText("6 min");
  await expect(cell("Engineering", "free")).toHaveText("29 h 40 min");
  await expect(cell("Engineering", "travel")).toHaveText("0 min");
  // Score: 25 x (0.8 + 14/15 + 87/89 + (1 - 1.5/89)) = 92.35.
  await expect(cell("Engineering", "score")).toHaveText("92");
  await expect(report.getByTestId("benchmark")).toHaveText(
    "Industry benchmark: no benchmark data yet.",
  );
  await expect(cell("Engineering", "cost")).toHaveText("$2,400");
  await expect(cell("Sales", "cost")).toHaveText("$1,350");

  // CSV export of the department report (T3).
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    report.getByRole("link", { name: "Export CSV" }).click(),
  ]);
  const rows = (await readFile(await download.path(), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split(","));
  const head = rows[0] ?? [];
  const col = (row: string[] | undefined, name: string) => row?.[head.indexOf(name)];
  expect(head.slice(0, 4)).toEqual(["department", "people", "period_start", "period_end"]);
  expect(rows).toHaveLength(3);
  const eng = rows.find((r) => r[0] === "Engineering");
  const sales = rows.find((r) => r[0] === "Sales");
  expect([col(eng, "people"), col(eng, "period_start"), col(eng, "period_end")]).toEqual([
    "3",
    P,
    d(6),
  ]);
  expect(col(eng, "meeting_hours_per_person_week")).toBe("8.00");
  expect(col(eng, "focus_hours_per_person_week")).toBe("2.33");
  expect(col(eng, "fragmented_minutes_per_person_workday")).toBe("6.00");
  expect(col(eng, "deep_work_score")).toBe("92");
  expect(col(eng, "meeting_cost_usd")).toBe("2400");
  expect(col(sales, "meeting_hours_per_person_week")).toBe("9.00");
  expect(col(sales, "meeting_cost_usd")).toBe("1350");

  // Company level: 51 h over 6 people; cost 2400 + 1350.
  await report.getByLabel("Group by").selectOption({ label: "Company" });
  await expect(cell("Company", "meetings")).toHaveText("8 h 30 min");
  await expect(cell("Company", "cost")).toHaveText("$3,750");

  // Manager line: e2e's line holds direct and indirect reports; small lines show no values.
  await report.getByLabel("Group by").selectOption({ label: "Manager line" });
  await page.reload();
  await expect(group("e2e").getByTestId("people")).toHaveText("5 people");
  await expect(cell("e2e", "meetings")).toHaveText("7 h 48 min");
  await expect(group("e2e2")).toContainText("Fewer than 3 people: no values.");
  await expect(group("No manager")).toContainText("Fewer than 3 people: no values.");

  // Person level, for admins.
  await report.getByLabel("Group by").selectOption({ label: "Person" });
  await expect(
    report.locator(`[data-group*="${E2}"] [data-metric="meetings"] [data-period="0"]`),
  ).toHaveText("10 h");

  // Filters from directory attributes, custom ones included (T2).
  await report.getByLabel("Group by").selectOption({ label: "Company" });
  await report.getByLabel("Filter by site").selectOption("Lisbon");
  await page.reload();
  await expect(report.getByLabel("Filter by site")).toHaveValue("Lisbon");
  await expect(group("Company")).toContainText("Fewer than 3 people: no values.");
  await report.getByLabel("Filter by site").selectOption("");
  await report.getByLabel("Filter by department").selectOption("Engineering");
  await expect(cell("Company", "meetings")).toHaveText("8 h");
  await report.getByLabel("Filter by department").selectOption("");

  // Week over week: the week before last had 2 h over 6 people.
  await report.getByLabel("From").fill(d(-7));
  await expect(cell("Company", "meetings", 1)).toHaveText("8 h 30 min");
  await page.reload();
  await expect(cell("Company", "meetings", 0)).toHaveText("20 min");
  await expect(cell("Company", "meetings", 1)).toHaveText("8 h 30 min");
  await expect(
    report.locator('[data-group="Company"] [data-metric="meetings"] [data-testid="change"]'),
  ).toHaveText("+8 h 10 min");

  // History limit: 12 weeks.
  await report.getByLabel("From").fill(addDays(today(), -91));
  await expect(report.getByRole("alert")).toHaveText("The earliest start is 12 weeks ago.");
  await page.reload();
  await expect(report.getByLabel("From")).toHaveValue(d(-7));

  // T4: a member who is not an admin.
  await openStats(pe3, "Organization");
  const denied = pe3.getByTestId("org-analytics");
  await expect(denied).toContainText("Organization analytics are for team admins.");
  await pe3.reload();
  await expect(denied).toContainText("Organization analytics are for team admins.");
  const status = await pe3.evaluate(
    async (q) => (await fetch(`/api/analytics/org?${q}`)).status,
    `from=${P}&to=${d(6)}`,
  );
  expect(status).toBe(403);

  expect(await snapshot(cal, at(d(-7), "00:00"), at(d(7), "00:00"))).toEqual(before);
});

test("a future range counts planned breaks and travel; an analytics-only member is counted but the scheduler never changes their calendar (rules 1, 8; open question 4)", async ({
  page,
  app,
  cal,
  signIn,
  people,
}) => {
  const [p5, p6] = [await people(5), await people(6)];
  await blockUntil(p5.cal, W);
  await blockUntil(p6.cal, W);
  await meet(cal, addDays(W, 1), "10:00", "11:00", "Customer meeting", [CLIENT]);
  await meet(p5.cal, addDays(W, 2), "08:00", "09:00", "Commute to the client");

  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  const pe5 = await p5.signIn();
  const pe6 = await p6.signIn();
  const idp = await directory(page);
  for (const email of [EMAIL, p5.email, p6.email]) await idp.create({ userName: email });

  // The admin gives e2e6 an analytics-only seat.
  await openStats(page, "Organization");
  const report = page.getByTestId("org-analytics");
  const seat = report.locator(`[data-seat="${p6.email}"]`).getByLabel("Analytics only");
  await seat.check();
  await expect(report.getByTestId("seats-saved")).toBeVisible();
  await page.reload();
  await expect(seat).toBeChecked();

  // e2e6's task is never placed; e2e5's task is.
  await addTask(pe6, { title: "AT-Analytics-only", minutes: 120, split: false, due: "" });
  await addTask(pe5, { title: "AT-Scheduled", minutes: 120, split: false, due: "" });
  await eventually(
    () => allEvents(p5.cal),
    (l) => expect(titled(l, "AT-Scheduled")).toHaveLength(1),
  );
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "Recovery")).toHaveLength(1),
  );
  await planNow(pe6);
  expect(managed(await allEvents(p6.cal))).toEqual([]);
  await openStats(pe6, "Team stats");
  await expect(pe6.getByTestId("analytics-only")).toHaveText(
    "Your seat is analytics only: your calendar counts in team analytics, and the scheduler does not change it.",
  );

  // Next week: e2e 1 h meeting and 15 min recovery; e2e5 a 2 h task and 1 h commute; e2e6 nothing.
  await synced(app, [EMAIL, p5.email, p6.email]);
  await report.getByLabel("From").fill(W);
  await report.getByLabel("To").fill(addDays(W, 6));
  await page.reload();
  const cell = (metric: string) =>
    report.locator(`[data-group="Company"] [data-metric="${metric}"] [data-period="0"]`);
  await expect(report.locator('[data-group="Company"]').getByTestId("people")).toHaveText(
    "3 people",
  );
  await expect(cell("meetings")).toHaveText("20 min");
  await expect(cell("breaks")).toHaveText("5 min");
  await expect(cell("travel")).toHaveText("20 min");
  await expect(cell("focus")).toHaveText("40 min");
  // Free work time: 38 h 45 min, 38 h and 40 h.
  await expect(cell("free")).toHaveText("38 h 55 min");
  await planNow(pe6);
  expect(managed(await allEvents(p6.cal))).toEqual([]);
});
