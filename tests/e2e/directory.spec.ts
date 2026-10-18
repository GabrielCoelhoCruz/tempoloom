// Directory provisioning over SCIM 2.0 (docs/specs/admin-sso-provisioning.md
// rules 6-8, 16; edge cases 1, 6; teams-membership.md rule 26). The test acts as
// the identity provider: it sends standard SCIM requests with the team's token.
//
// Ways it can fail, and the check that catches each:
// - a request without the token, or with a wrong one, changes data     -> 401 checks
// - a member who is not admin can make a token                         -> 403 check
// - a provisioned person who never signed in uses a seat               -> seat bar
// - attributes are lost or mapped to the wrong name (enterprise,
//   product and custom extensions; manager as a person)                -> directory table
// - a person who already signed up gets a second account or team       -> adopted user
// - the provisioned person signs in and lands in a new team            -> sign-in check
// - an update does not reach the stored attributes                     -> PATCH check
// - the identity provider cannot find a user by userName               -> filter check
// - deactivation keeps sessions, sign-in or the seat                   -> deactivation
// Every check reads the admin view again after a reload.
import { BACKEND, BASE_URL, EMAIL, expect, test } from "./fixtures.ts";
import { scim } from "./scim.ts";
import { member, openTeam } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Directory E2E uses several CalDAV users.");

test("SCIM provisioning adds people with attributes and no seat until sign-in; updates and deactivation follow the directory (rules 6-8, 16; edge cases 1, 6)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
}) => {
  await signIn();
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  await openTeam(page);
  const directory = page.getByTestId("directory");
  await directory.getByRole("button", { name: "Create SCIM token" }).click();
  await expect(directory.getByTestId("scim-base-url")).toHaveText(`${BASE_URL}/scim/v2`);
  const token = (await directory.getByTestId("scim-token").textContent()) ?? "";
  expect(token.length).toBeGreaterThan(20);
  const idp = scim(token);

  expect((await scim("wrong-token").find(EMAIL)).status).toBe(401);
  expect((await fetch(`${BASE_URL}/scim/v2/Users`)).status).toBe(401);

  // The signed-up admin is adopted, not created again; then a new person arrives.
  const adminId = await idp.create({ userName: EMAIL, department: "Leadership", title: "CEO" });
  const v = await people(4);
  const vId = await idp.create({
    userName: v.email,
    displayName: "Vera",
    department: "Finance",
    managerId: adminId,
    location: "Porto",
    custom: { site: "Lisbon", startDate: "next spring" },
  });
  const found = await idp.find(v.email);
  expect(found.status).toBe(200);
  expect(found.body.totalResults).toBe(1);

  await page.reload();
  const row = (email: string) =>
    page.getByTestId("directory").locator(`[data-directory="${email}"]`);
  await expect(row(EMAIL)).toContainText("Leadership");
  await expect(row(EMAIL)).toContainText("signed in: yes");
  await expect(row(v.email)).toContainText("department: Finance");
  await expect(row(v.email)).toContainText("manager: e2e");
  await expect(row(v.email)).toContainText("location: Porto");
  await expect(row(v.email)).toContainText("site: Lisbon");
  await expect(row(v.email)).toContainText("startDate: next spring");
  await expect(row(v.email)).toContainText("signed in: no");
  await expect(row(v.email)).toContainText("seat: none");
  await expect(page.getByTestId("seat-bar")).toHaveText("1 of 5 seats used, 4 left");
  await expect(member(page, v.email)).toContainText("member");

  // A member cannot make tokens. Vera signs in and is already in the team.
  const pv = await v.signIn();
  await openTeam(pv);
  await expect(pv.getByTestId("team-name")).toHaveText("e2e's team");
  const status = await pv.evaluate(
    async () => (await fetch("/api/team/scim-token", { method: "POST" })).status,
  );
  expect(status).toBe(403);
  await page.reload();
  await expect(row(v.email)).toContainText("signed in: yes");
  await expect(row(v.email)).toContainText("seat: used");
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 5 seats used, 3 left");

  // An update from the directory replaces the value.
  const patched = await idp.patch(vId, [
    {
      op: "replace",
      path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
      value: "Engineering",
    },
  ]);
  expect(patched.status).toBe(200);
  await page.reload();
  await expect(row(v.email)).toContainText("department: Engineering");

  // Deactivation ends the sessions, blocks sign-in and frees the seat.
  expect((await idp.patch(vId, [{ op: "replace", path: "active", value: false }])).status).toBe(
    200,
  );
  await pv.reload();
  await expect(pv.getByTestId("caldav-form")).toBeVisible();
  const refused = await v.attemptSignIn();
  await expect(refused.getByRole("alert")).toHaveText(
    "Your organization deactivated this account.",
  );
  await page.reload();
  await expect(row(v.email)).toContainText("deactivated");
  await expect(page.getByTestId("seat-bar")).toHaveText("1 of 5 seats used, 4 left");
  await expect(member(page, v.email)).toHaveCount(0);

  // The colleague who signed up alone is not touched by this team's directory.
  const pb = await colleague.signIn();
  await openTeam(pb);
  await expect(pb.getByTestId("team-name")).toHaveText("e2e2's team");
});
