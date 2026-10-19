// Single sign-on through a team's OpenID Connect identity provider
// (docs/specs/admin-sso-provisioning.md rules 2-5, 9; edge cases 3-5;
// acceptance tests T1, T2, T5). The identity provider is a real Dex server on
// loopback (scripts/oidc-server.sh); people sign in on its own login page.
// Tempoloom's other sign-in methods are Google and CalDAV; these tests use
// CalDAV, which goes through the same sign-in rules as Google.
//
// Ways it can fail, and the check that catches each:
// - a new SSO setup does not default to "SSO only" (rule 5)                -> default mode check
// - the setup is lost on reload, or the client secret goes back to the page -> reload checks
// - a member who is not admin can read or change the setup                 -> 403 checks
// - two teams register the same domain (edge case 5)                       -> domain taken check
// - in SSO-only mode a person on the domain can still use another sign-in,
//   or the refusal does not point to SSO (rule 3, T1)                      -> refused CalDAV sign-in
// - the SSO sign-in lands the person in a new team, or the session does not
//   survive a reload (T1)                                                   -> team page after reload
// - an SSO user cannot connect a calendar, keeps a wrong time zone, or
//   Tempoloom writes to it before the user creates an item (T1)             -> calendar checks
// - SSO signs in to an account that signed up on its own in another team
//   (account takeover through an identity provider)                         -> refused SSO sign-in
// - people outside the SSO team lose their own sign-in (rule 2, edge case 4)-> CalDAV sign-ins
// - turning SSO off keeps blocking the other sign-in                        -> sign-in after turn-off
// - in "SSO and other sign-in" mode the other sign-in is refused (rule 4)   -> T2 check
// - domain capture does not move a new sign-up into the team, captures when
//   it is off, or captures a domain that is not registered (rule 9, edge
//   case 3, T5)                                                            -> capture checks
// ID token checks (signature, issuer, audience, nonce, expiry) are in
// tests/unit/oidc.test.ts: a real identity provider does not send bad tokens.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { BACKEND, BASE_URL, blockUntil, EMAIL, managed, planNow, ZONE } from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";
import { expect, type Idp, test } from "./sso-fixtures.ts";
import { member, openTeam, role } from "./team-helpers.ts";

test.skip(BACKEND === "google", "SSO E2E uses several CalDAV users.");

const SSO_REQUIRED = "Your organization uses single sign-on. Sign in with SSO.";

async function setSso(
  p: Page,
  idp: Idp,
  s: { domains: string; mode?: "sso_only" | "sso_and_google"; capture?: boolean },
): Promise<void> {
  await openTeam(p);
  const sso = p.getByTestId("sso");
  await sso.getByLabel("Email domains").fill(s.domains);
  await sso.getByLabel("Issuer URL").fill(idp.issuer);
  await sso.getByLabel("Client ID").fill(idp.clientId);
  await sso.getByLabel("Client secret").fill(idp.clientSecret);
  if (s.mode) await sso.getByLabel("Sign-in mode").selectOption(s.mode);
  if (s.capture !== undefined) await sso.getByLabel("Domain capture").setChecked(s.capture);
  await sso.getByRole("button", { name: "Save single sign-on" }).click();
}

test("SSO only: people on the team's domain sign in through its identity provider, other sign-ins point them to SSO, and people outside the team keep theirs (rules 2, 3, 5; T1; edge cases 4, 5)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
  idp,
  radicale,
}) => {
  // M signed up on the company domain before the team used SSO: own team.
  const m = await people(5, idp.email("m"));
  await m.signIn();

  await signIn();
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  await openTeam(page);
  const sso = page.getByTestId("sso");
  await expect(sso.getByLabel("Sign-in mode")).toHaveValue("sso_only");
  await expect(sso.getByLabel("Domain capture")).not.toBeChecked();
  await expect(sso.getByTestId("sso-redirect-uri")).toHaveText(`${BASE_URL}/auth/sso/callback`);
  await setSso(page, idp, { domains: "corp.test" });
  await expect(sso.getByTestId("sso-saved")).toBeVisible();
  await page.reload();
  await expect(sso.getByLabel("Email domains")).toHaveValue("corp.test");
  await expect(sso.getByLabel("Issuer URL")).toHaveValue(idp.issuer);
  await expect(sso.getByLabel("Client ID")).toHaveValue(idp.clientId);
  await expect(sso.getByLabel("Client secret")).toHaveValue("");
  await expect(sso.getByTestId("sso-secret-state")).toHaveText("A client secret is saved.");
  await expect(sso.getByLabel("Sign-in mode")).toHaveValue("sso_only");

  // U is new: CalDAV sign-in is refused and points to SSO; nothing is created.
  const u = await people(3, idp.email("u"));
  const refused = await u.attemptSignIn();
  await expect(refused.getByRole("alert")).toHaveText(SSO_REQUIRED);
  await refused.reload();
  await expect(refused.getByTestId("caldav-form")).toBeVisible();

  // U signs in on the identity provider's page and lands in the team.
  const pu = await idp.signIn("u");
  await expect(pu.getByTestId("user-email")).toHaveText(idp.email("u"));
  await pu.reload();
  await expect(pu.getByTestId("app-shell")).toBeVisible();
  await openTeam(pu);
  await expect(pu.getByTestId("team-name")).toHaveText("e2e's team");
  await expect(role(pu, idp.email("u"))).toHaveText("member");
  const forbidden = await pu.evaluate(async () => [
    (await fetch("/api/team/sso")).status,
    (await fetch("/api/team/sso", { method: "PUT", body: "{}" })).status,
  ]);
  expect(forbidden).toEqual([403, 403]);

  // U connects a CalDAV calendar. Tempoloom writes nothing until U creates an item.
  const connect = pu.getByTestId("connect-calendar");
  const env = radicale?.users[3];
  if (!env) throw new Error("no Radicale user e2e3");
  await connect.getByLabel("CalDAV server URL").fill(env.url);
  await connect.getByLabel("User name").fill(env.username);
  await connect.getByLabel("Password").fill(env.password);
  await connect.getByRole("button", { name: "Connect calendar" }).click();
  await expect(connect).toHaveCount(0);
  await pu.getByRole("link", { name: "Settings" }).click();
  await expect(pu.getByTestId("calendar-list")).toContainText(`caldav, ${idp.email("u")}, main`);
  // SSO brings no time zone; the first calendar connection takes the browser's.
  await expect(pu.getByLabel("Time zone")).toHaveValue(ZONE);
  await planNow(pu);
  expect(managed(await allEvents(u.cal))).toHaveLength(0);
  // Busy until W, so the task lands in W as one event. Placed today, it would be
  // split (SCH-90) when less than an hour of today's work hours is left.
  await blockUntil(u.cal, W);
  await addTask(pu, { title: "Board deck", minutes: 60, due: `${addDays(W, 4)}T17:00` });
  await expect
    .poll(async () => titled(await allEvents(u.cal), "Board deck").length, { timeout: 45_000 })
    .toBe(1);
  await pu.reload();
  await expect(pu.locator('[data-task-title="Board deck"]')).toBeVisible();

  // U is a member now: CalDAV sign-in stays refused.
  const again = await u.attemptSignIn();
  await expect(again.getByRole("alert")).toHaveText(SSO_REQUIRED);

  // M keeps CalDAV sign-in, and SSO does not take over M's account.
  const pm = await m.signIn();
  await openTeam(pm);
  await expect(pm.getByTestId("team-name")).toHaveText("e2e5's team");
  const takeover = await idp.attemptSignIn("m");
  await expect(takeover.getByRole("alert")).toHaveText(
    "This account is not in your organization's team. Ask a team admin to add it.",
  );
  await takeover.reload();
  await expect(takeover.getByTestId("caldav-form")).toBeVisible();

  await page.reload();
  await expect(role(page, idp.email("u"))).toHaveText("member");
  await expect(member(page, idp.email("m"))).toHaveCount(0);
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 5 seats used, 3 left");

  // Another team cannot register the same domain; its own sign-in is untouched.
  const pc = await colleague.signIn();
  await setSso(pc, idp, { domains: "corp.test" });
  await expect(pc.getByTestId("sso").getByRole("alert")).toHaveText(
    "corp.test already uses single sign-on with another team.",
  );
  await pc.reload();
  await expect(pc.getByTestId("sso").getByLabel("Email domains")).toHaveValue("");

  // Turning SSO off gives members their other sign-in back.
  await openTeam(page);
  await page.getByTestId("sso").getByRole("button", { name: "Turn off single sign-on" }).click();
  await page.reload();
  await expect(page.getByTestId("sso").getByLabel("Email domains")).toHaveValue("");
  const back = await u.signIn();
  await openTeam(back);
  await expect(back.getByTestId("team-name")).toHaveText("e2e's team");
});

test("SSO and other sign-in, with domain capture: members use either, new sign-ups on the domain join the team, others keep their own team (rules 4, 9; T2, T5; edge case 3)", async ({
  page,
  signIn,
  people,
  idp,
}) => {
  await signIn();
  await setSso(page, idp, { domains: "corp.test", mode: "sso_and_google", capture: true });
  const sso = page.getByTestId("sso");
  await expect(sso.getByTestId("sso-saved")).toBeVisible();
  await page.reload();
  await expect(sso.getByLabel("Sign-in mode")).toHaveValue("sso_and_google");
  await expect(sso.getByLabel("Domain capture")).toBeChecked();

  // U signs in with SSO, signs out, then signs in with CalDAV: both land in the team.
  const u = await people(3, idp.email("u"));
  const pu = await idp.signIn("u");
  await openTeam(pu);
  await expect(pu.getByTestId("team-name")).toHaveText("e2e's team");
  await pu.getByRole("button", { name: "Sign out" }).click();
  await expect(pu.getByTestId("sso-form")).toBeVisible();
  const pu2 = await u.signIn();
  await pu2.reload();
  await openTeam(pu2);
  await expect(pu2.getByTestId("team-name")).toHaveText("e2e's team");

  // X is new on the domain and signs up with CalDAV: captured into the team.
  const x = await people(4, idp.email("x"));
  const px = await x.signIn();
  await px.reload();
  await openTeam(px);
  await expect(px.getByTestId("team-name")).toHaveText("e2e's team");
  await expect(role(px, idp.email("x"))).toHaveText("member");

  // A domain that is not registered is not captured (edge case 3).
  const y = await people(6, "y@corp-partner.test");
  const py = await y.signIn();
  await openTeam(py);
  await expect(py.getByTestId("team-name")).toHaveText("e2e6's team");

  // With capture off, a new sign-up on the domain keeps a team of its own.
  await setSso(page, idp, { domains: "corp.test", mode: "sso_and_google", capture: false });
  await expect(sso.getByTestId("sso-saved")).toBeVisible();
  const z = await people(5, "z@corp.test");
  const pz = await z.signIn();
  await openTeam(pz);
  await expect(pz.getByTestId("team-name")).toHaveText("e2e5's team");

  await page.reload();
  await expect(role(page, idp.email("u"))).toHaveText("member");
  await expect(role(page, idp.email("x"))).toHaveText("member");
  await expect(member(page, "y@corp-partner.test")).toHaveCount(0);
  await expect(member(page, "z@corp.test")).toHaveCount(0);
});
