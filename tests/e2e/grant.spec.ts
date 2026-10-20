// Organization calendar access for CalDAV, paced provisioning and the admin
// provisioning API (docs/specs/admin-sso-provisioning.md rules 10, 12, 14-18,
// T3, T4; analytics-organization.md rules 13-15; teams-membership.md rule 26).
// An admin enters a CalDAV account that can read every person's calendars
// (Radicale user e2egrant). Provisioning then attaches each person's calendar
// read-only, with no action from that person.
//
// Ways it can fail, and the check that catches each:
// - the grant password goes back to the page, or the grant is lost on reload -> reload checks
// - a member can set the grant or use the provisioning API (rule 18)         -> 403 checks
// - without a grant, provisioning fails or claims a calendar (rules 14, 15)  -> "calendar: none"
// - a grant saved later does not reach people provisioned before it         -> W attached
// - removing the grant leaves calendars attached, or drops a person's own    -> W and V after removal
// - provisioning does not attach the calendar, or does not read its events
//   (rule 12, T3)                                                            -> "calendar: attached", count
// - Tempoloom writes to a person's calendar before first sign-in             -> calendar and managed rows
// - a person who never signed in is read in real time, or never read again
//   (rule 17; analytics-organization.md rule 13)                             -> count before and after refresh
// - after first sign-in the person is not read in real time (rule 17)        -> count after sign-in
// - a provisioned person uses a seat before first sign-in (rule 16)          -> seat bar
// - a large import creates everyone at once instead of at a paced rate
//   (rule 10)                                                                 -> creation times
// - imported people lose their attributes or land outside the team           -> directory rows, roles
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, EMAIL, expect, managed, test } from "./fixtures.ts";
import { allEvents, W } from "./helpers.ts";
import { scim } from "./scim.ts";
import {
  openTeam,
  role,
  directoryRow as row,
  rowShows,
  setGrant,
  teamOfTwo,
} from "./team-helpers.ts";

test.skip(BACKEND === "google", "Calendar grant E2E uses several CalDAV users.");

test("Calendar access attaches each provisioned person's calendar read-only, reads it on a slow cycle until first sign-in and in real time after it, and writes nothing before it (rules 12, 14-17; T3, T4)", async ({
  page,
  app,
  signIn,
  people,
  radicale,
}) => {
  if (!radicale) throw new Error("needs Radicale");
  // The refresh period for people who never signed in is 24 hours; 30 seconds here.
  app.env.GRANT_REFRESH_SECONDS = "30";
  await app.restart();
  await signIn();
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  await openTeam(page);
  await page.getByTestId("directory").getByRole("button", { name: "Create SCIM token" }).click();
  const idp = scim((await page.getByTestId("scim-token").textContent()) ?? "");

  // Without calendar access, W is provisioned with no calendar (rules 14, 15; T4).
  const w = await people(6);
  await idp.create({ userName: w.email, department: "Sales" });
  await rowShows(page, w.email, "calendar: none");

  // Calendar access; the people provisioned before it get their calendar too.
  await setGrant(page, radicale.grant);
  await page.reload();
  const grant = page.getByTestId("calendar-grant");
  await expect(grant.getByLabel("CalDAV server URL")).toHaveValue(radicale.grant.url);
  await expect(grant.getByLabel("User name")).toHaveValue(radicale.grant.username);
  await expect(grant.getByLabel("Password")).toHaveValue("");
  await expect(grant.getByTestId("grant-state")).toHaveText("A password is saved.");
  await rowShows(page, w.email, "calendar: attached (0 events read");

  // V is provisioned with two events on their calendar; Tempoloom reads them.
  const v = await people(4);
  await v.cal.addEvent({ title: "Budget review", start: at(W, "10:00"), end: at(W, "11:00") });
  await v.cal.addEvent({
    title: "Forecast",
    start: at(addDays(W, 1), "14:00"),
    end: at(addDays(W, 1), "15:00"),
  });
  await idp.create({ userName: v.email, displayName: "Vera", department: "Finance" });
  await rowShows(page, v.email, "calendar: attached (2 events read");
  await expect(row(page, v.email)).toContainText("department: Finance");
  await expect(row(page, v.email)).toContainText("signed in: no");
  await expect(row(page, v.email)).toContainText("seat: none");
  await expect(page.getByTestId("seat-bar")).toHaveText("1 of 5 seats used, 4 left");
  const firstRead = await row(page, v.email).getByTestId("last-read").textContent();

  // Before first sign-in, a change is read on the slow cycle, not on each sync.
  await v.cal.addEvent({
    title: "Late addition",
    start: at(addDays(W, 2), "09:00"),
    end: at(addDays(W, 2), "10:00"),
  });
  await page.waitForTimeout(12_000);
  await page.reload();
  await expect(row(page, v.email)).toContainText("calendar: attached (2 events read");
  await rowShows(page, v.email, "calendar: attached (3 events read", 45_000);
  await expect(row(page, v.email).getByTestId("last-read")).not.toHaveText(firstRead ?? "");

  // Tempoloom wrote nothing on V's calendar and planned nothing for V.
  const events = await allEvents(v.cal);
  expect(events.map((e) => e.summary).sort()).toEqual([
    "Budget review",
    "Forecast",
    "Late addition",
  ]);
  expect(managed(events)).toHaveLength(0);
  expect(
    app.query<{ n: number }>(
      "SELECT count(*) AS n FROM managed_events m JOIN users u ON u.id = m.user_id WHERE u.email = ?",
      v.email,
    )[0]?.n,
  ).toBe(0);

  // After first sign-in, V's calendar is read in real time.
  await v.signIn();
  await rowShows(page, v.email, "signed in: yes");
  await expect(row(page, v.email)).toContainText("seat: used");
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 5 seats used, 3 left");
  await v.cal.addEvent({
    title: "After sign-in",
    start: at(addDays(W, 3), "09:00"),
    end: at(addDays(W, 3), "10:00"),
  });
  await rowShows(page, v.email, "calendar: attached (4 events read", 20_000);

  // Removing calendar access detaches what it attached; V's own connection stays.
  await grant.getByRole("button", { name: "Remove calendar access" }).click();
  await page.reload();
  await expect(grant.getByLabel("User name")).toHaveValue("");
  await expect(row(page, w.email)).toContainText("calendar: none");
  await expect(row(page, v.email)).toContainText("calendar: attached (4 events read");
});

test("The admin provisioning API adds a large import at a paced rate, with attributes and calendars through the grant; only team admins can use it (rules 10, 18)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
  mail,
  radicale,
}) => {
  if (!radicale) throw new Error("needs Radicale");
  const pc = await teamOfTwo(page, signIn, colleague, mail);
  app.cli("seat-limit", "--email", EMAIL, "--seats", "10");

  // A member cannot use the provisioning API or the grant.
  const refused = await pc.evaluate(async () => {
    const post = (url: string, body: unknown, method = "POST") =>
      fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.status);
    return [
      await post("/api/team/provisioning", { people: [{ email: "intruder@tempoloom.test" }] }),
      (await fetch("/api/team/provisioning")).status,
      await post("/api/team/grant", { serverUrl: "http://127.0.0.1/", username: "x" }, "PUT"),
      (await fetch("/api/team/grant")).status,
    ];
  });
  expect(refused).toEqual([403, 403, 403, 403]);

  await setGrant(page, radicale.grant);
  const persons = [await people(3), await people(4), await people(5), await people(6)];
  await persons[0]?.cal.addEvent({ title: "Kickoff", start: at(W, "09:00"), end: at(W, "10:00") });
  const emails = [
    ...persons.map((p) => p.email),
    "no-calendar-1@tempoloom.test",
    "no-calendar-2@tempoloom.test",
  ];
  const departments = ["Finance", "Finance", "Sales", "Sales", "Legal", "Legal"];
  const imp = page.getByTestId("provision-import");
  await imp
    .getByLabel("People to add")
    .fill(
      [
        "email,name,department",
        ...emails.map((e, i) => `${e},Person ${i + 1},${departments[i]}`),
      ].join("\n"),
    );
  await imp.getByRole("button", { name: "Add people" }).click();
  await expect(imp.getByTestId("import-result")).toHaveText("6 people queued.");
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("provision-progress")).toHaveText("6 of 6 people added", {
      timeout: 1000,
    });
  }).toPass({ timeout: 45_000 });

  await rowShows(page, emails[0] ?? "", "calendar: attached (1 event read");
  for (const [i, email] of emails.entries()) {
    await expect(row(page, email)).toContainText(`Person ${i + 1}`);
    await expect(row(page, email)).toContainText(`department: ${departments[i]}`);
    await expect(row(page, email)).toContainText("signed in: no");
    await expect(row(page, email)).toContainText(i < 4 ? "calendar: attached" : "calendar: none");
    await expect(role(page, email)).toHaveText("member");
  }
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 10 seats used, 8 left");

  // People appear over time: one at a time, about a second apart.
  const created = app
    .query<{ created_at: number }>(
      `SELECT d.created_at FROM directory_profiles d JOIN users u ON u.id = d.user_id
       WHERE u.email IN (${emails.map(() => "?").join(",")}) ORDER BY d.created_at`,
      ...emails,
    )
    .map((r) => r.created_at);
  expect(created).toHaveLength(6);
  for (let i = 1; i < created.length; i++) {
    expect((created[i] ?? 0) - (created[i - 1] ?? 0)).toBeGreaterThanOrEqual(900);
  }
});
