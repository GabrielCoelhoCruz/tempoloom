// Organization analytics cover people who never signed in, through the
// organization calendar access (docs/specs/analytics-organization.md rules
// 13-15, T1; admin-sso-provisioning.md rules 12, 17).
//
// Ways it can fail, and the check that catches each:
// - a provisioned person whose calendar the grant attached is left out of
//   the averages, or counted as zero                           -> Sales: 3 people, 10 h
// - reading the calendar for analytics writes to it or plans   -> no managed events
// - the person counts as signed in or uses a seat              -> directory row
// - the numbers do not survive a reload                         -> values after reload
import { addDays } from "../../src/shared/time.ts";
import { CLIENT, directory, lastWeek, meet, openStats, synced } from "./analytics-helpers.ts";
import { BACKEND, EMAIL, expect, managed, test } from "./fixtures.ts";
import { openTeam } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Organization coverage E2E uses several CalDAV users.");

test("organization analytics count a provisioned person who never signed in, through the calendar access, without writing to their calendar (rules 13-15; T1)", async ({
  page,
  app,
  cal,
  signIn,
  colleague,
  people,
  radicale,
}) => {
  if (!radicale) throw new Error("needs Radicale");
  const P = lastWeek();
  const d = (n: number) => addDays(P, n);
  const [p3, p4, p5, p6] = [await people(3), await people(4), await people(5), await people(6)];
  // Engineering: e2e2 10 h, e2e3 6 h, e2e6 8 h. Sales: e2e 10 h, e2e4 12 h, and
  // e2e5 8 h, who never signs in.
  const hours: [typeof cal, string, string][] = [
    [colleague.cal, "09:00", "14:00"],
    [p3.cal, "09:00", "12:00"],
    [p6.cal, "09:00", "13:00"],
    [cal, "09:00", "14:00"],
    [p4.cal, "09:00", "15:00"],
    [p5.cal, "09:00", "13:00"],
  ];
  for (const [c, from, to] of hours) {
    await meet(c, d(1), from, to, "Customer call", [CLIENT]);
    await meet(c, d(3), from, to, "Customer call", [CLIENT]);
  }

  await signIn();
  for (const p of [colleague, p3, p4, p6]) await p.signIn();
  const idp = await directory(page);
  for (const [email, department] of [
    [EMAIL, "Sales"],
    [colleague.email, "Engineering"],
    [p3.email, "Engineering"],
    [p6.email, "Engineering"],
    [p4.email, "Sales"],
  ] as const) {
    await idp.create({ userName: email, department });
  }

  // Calendar access for the team, then e2e5 arrives from the directory.
  await openTeam(page);
  const grant = page.getByTestId("calendar-grant");
  await grant.getByLabel("CalDAV server URL").fill(radicale.grant.url);
  await grant.getByLabel("User name").fill(radicale.grant.username);
  await grant.getByLabel("Password").fill(radicale.grant.password);
  await grant.getByRole("button", { name: "Save calendar access" }).click();
  await expect(grant.getByTestId("grant-saved")).toBeVisible();
  await idp.create({ userName: p5.email, department: "Sales" });
  const row = page.getByTestId("directory").locator(`[data-directory="${p5.email}"]`);
  await expect(async () => {
    await page.reload();
    await expect(row).toContainText("calendar: attached (2 events read", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(row).toContainText("signed in: no");
  await expect(row).toContainText("seat: none");
  await synced(app, [EMAIL, colleague.email, p3.email, p4.email, p6.email]);

  await openStats(page, "Organization");
  const report = page.getByTestId("org-analytics");
  await report.getByRole("button", { name: "Last week" }).click();
  await report.getByLabel("Group by").selectOption({ label: "Department" });
  const group = (label: string) => report.locator(`[data-group="${label}"]`);
  const meetings = (label: string) =>
    group(label).locator('[data-metric="meetings"] [data-period="0"]');
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await expect(group("Sales").getByTestId("people")).toHaveText("3 people");
    await expect(meetings("Sales")).toHaveText("10 h");
    await expect(group("Engineering").getByTestId("people")).toHaveText("3 people");
    await expect(meetings("Engineering")).toHaveText("8 h");
  }

  // Analytics read e2e5's calendar; nothing was written to it.
  const events = await p5.cal.events(Date.now() - 21 * 86_400_000, Date.now() + 21 * 86_400_000);
  expect(events.map((e) => e.summary)).toEqual(["Customer call", "Customer call"]);
  expect(managed(events)).toHaveLength(0);
});
