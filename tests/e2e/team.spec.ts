// Team membership (docs/specs/teams-membership.md, SPEC-TEAMS-01) with several
// users of one instance, each with a Radicale calendar of their own.
//
// Ways it can fail, and the test that catches each:
// - a new user has no team or is not its admin                      -> invite, colleagues
// - the invitation email is missing, lacks the message or the link   -> invite
// - an address that is already a member gets an invitation           -> invite
// - joining moves or deletes the member's managed events             -> invite, leave
// - a new person cannot sign up from the link and then join          -> invite
// - a revoked link still adds the person                             -> revoke
// - discovery shows a team to another domain or an invite-only team  -> request, automatic
// - approval drops the admin toggle; a rejected request still joins  -> request
// - automatic join still asks for review                             -> automatic
// - the sole admin can leave or drop the own admin role               -> leave
// - leaving deletes the member's habits or events                     -> leave
// - a member (not admin) can change roles or remove people            -> roles
// - "admins only" invite permission still lets members invite         -> permission
// - a seat overage stops scheduling, or still lets people in          -> seats
// Every test reloads the pages and reads the state again.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  BASE_URL,
  blockUntil,
  type CalendarDriver,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addHabit, titled, visitor, W } from "./helpers.ts";
import {
  accept,
  invite,
  joinLink,
  member,
  openTeam,
  role,
  setTeamSettings,
  status,
  teamOfTwo,
} from "./team-helpers.ts";

test.skip(BACKEND === "google", "Team E2E uses several CalDAV users.");

const weekTimes = async (cal: CalendarDriver, title: string) =>
  titled(await cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00")), title).map(
    (e) => `${local(e.start)}-${local(e.end).slice(11)}`,
  );

test("an invitation by email adds an existing user at once and a new person after sign-up; members are refused (rules 1, 3-6, 9, 10; edge case 3; T1)", async ({
  page,
  browser,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const d = await people(4);
  await blockUntil(colleague.cal, W);
  const pb = await colleague.signIn();
  await addHabit(pb, { title: "Review", ideal: "11:00", min: 30, max: 30 });
  const before = await eventually(
    () => weekTimes(colleague.cal, "Review"),
    (t) => expect(t).toHaveLength(5),
  );

  await signIn();
  await openTeam(page);
  // A new user has a team of their own and is its admin.
  await expect(page.getByTestId("team-name")).toHaveText("e2e's team");
  await expect(role(page, EMAIL)).toHaveText("admin");
  await expect(status(page, EMAIL)).toHaveText("active");

  await invite(page, [COLLEAGUE_EMAIL, d.email], { message: "Welcome" });
  await expect(page.getByTestId("invite-result")).toContainText("Invitations sent to 2 people");
  await expect(status(page, COLLEAGUE_EMAIL)).toHaveText("invited");
  await expect(status(page, d.email)).toHaveText("invited");
  await invite(page, [EMAIL]);
  await expect(page.getByTestId("invite-result")).toContainText(`${EMAIL} is already a member`);

  const mailB = await mail.message(COLLEAGUE_EMAIL, /invited you to e2e's team/);
  expect(mailB.text).toContain("Welcome");
  expect(await mail.count(COLLEAGUE_EMAIL)).toBe(1);
  await accept(pb, joinLink(mailB.text));
  await expect(role(pb, EMAIL)).toHaveText("admin");
  await expect(role(pb, COLLEAGUE_EMAIL)).toHaveText("member");

  // A person without an account sees the invitation, signs up from it, then joins.
  const linkD = joinLink((await mail.message(d.email, /invited you to/)).text);
  const anon = await visitor(browser);
  await anon.goto(linkD);
  await expect(anon.getByTestId("join-page")).toContainText("e2e invited you to join e2e's team");
  await expect(anon.getByTestId("caldav-form")).toBeVisible();
  const pd = await d.signIn(new URL(linkD).pathname);
  await pd.getByRole("button", { name: "Join team" }).click();
  await expect(role(pd, d.email)).toHaveText("member");

  // Joining does not touch the member's calendar.
  expect(await weekTimes(colleague.cal, "Review")).toEqual(before);

  await page.reload();
  await expect(status(page, COLLEAGUE_EMAIL)).toHaveText("active");
  await expect(role(page, COLLEAGUE_EMAIL)).toHaveText("member");
  await expect(status(page, d.email)).toHaveText("active");
  await pb.reload();
  await expect(role(pb, EMAIL)).toHaveText("admin");
});

test("a copied invite link works until it is revoked; a revoked link adds nobody (rules 7, 8; edge case 4; T2)", async ({
  page,
  signIn,
  people,
  mail,
}) => {
  const c = await people(3);
  const pc = await c.signIn();
  await signIn();
  await invite(page, [c.email]);
  await mail.message(c.email, /invited you/);
  await member(page, c.email).getByRole("button", { name: "Copy invite link" }).click();
  const copied = (await page.getByTestId("copied-link").textContent()) ?? "";
  expect(copied).toMatch(new RegExp(`^${BASE_URL}/join/`));
  await member(page, c.email).getByRole("button", { name: "Revoke invitation" }).click();
  await expect(member(page, c.email)).toHaveCount(0);

  await pc.goto(copied);
  await expect(pc.getByTestId("join-page")).toContainText("This invitation is no longer valid.");
  await expect(pc.getByRole("button", { name: "Join team" })).toHaveCount(0);
  await pc.reload();
  await expect(pc.getByTestId("join-page")).toContainText("This invitation is no longer valid.");
  await openTeam(pc);
  await expect(pc.getByTestId("team-name")).toHaveText("e2e3's team");
  await expect(member(pc, EMAIL)).toHaveCount(0);

  await page.reload();
  await expect(member(page, c.email)).toHaveCount(0);
});

test("a same-domain user asks to join; the admin approves with admin rights or rejects; other domains see nothing (rules 12-14; edge case 7; T3)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  await teamOfTwo(page, signIn, colleague, mail);
  const d = await people(4);
  const c = await people(3);
  const outsider = await people(5, "e2e5@elsewhere.test");
  const pd = await d.signIn();
  const pc = await c.signIn();
  const po = await outsider.signIn();

  await openTeam(po);
  await expect(po.getByTestId("team-prompts")).not.toContainText("e2e's team");
  for (const p of [pd, pc]) {
    await openTeam(p);
    const prompt = p.getByTestId("join-prompt");
    await expect(prompt).toContainText("e2e's team");
    await prompt.getByRole("button", { name: "Request to join" }).click();
    await expect(prompt).toContainText("Request sent");
  }

  await page.reload();
  await expect(status(page, d.email)).toHaveText("requested");
  await member(page, d.email).getByRole("button", { name: "Review" }).click();
  const review = page.getByTestId("review");
  await expect(review).toContainText(d.email);
  await review.getByLabel("Make admin").check();
  await review.getByRole("button", { name: "Approve" }).click();
  await member(page, c.email).getByRole("button", { name: "Review" }).click();
  await page.getByTestId("review").getByRole("button", { name: "Reject" }).click();

  await page.reload();
  await expect(role(page, d.email)).toHaveText("admin");
  await expect(status(page, d.email)).toHaveText("active");
  await expect(member(page, c.email)).toHaveCount(0);
  await pd.reload();
  await expect(pd.getByTestId("team-name")).toHaveText("e2e's team");
  await expect(role(pd, EMAIL)).toHaveText("admin");
  await pc.reload();
  await expect(pc.getByTestId("team-name")).toHaveText("e2e3's team");
});

test("automatic join adds a same-domain user at once with no review; invite only hides the team (rules 15, 16; T4)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  await teamOfTwo(page, signIn, colleague, mail);
  await setTeamSettings(page, { joinMode: "Join automatically" });
  const c = await people(3);
  const pc = await c.signIn();
  await openTeam(pc);
  await pc.getByTestId("join-prompt").getByRole("button", { name: "Join" }).click();
  await expect(pc.getByTestId("team-name")).toHaveText("e2e's team");
  await expect(status(pc, COLLEAGUE_EMAIL)).toHaveText("active");

  await setTeamSettings(page, { joinMode: "Invite only" });
  const d = await people(4);
  const pd = await d.signIn();
  await openTeam(pd);
  await expect(pd.getByTestId("join-prompt")).toHaveCount(0);

  await page.reload();
  await expect(status(page, c.email)).toHaveText("active");
  await expect(page.getByRole("button", { name: "Review" })).toHaveCount(0);
  await pd.reload();
  await expect(pd.getByTestId("join-prompt")).toHaveCount(0);
});

test("the sole admin cannot leave or drop the admin role; a member leaves and keeps habits and events (rules 17-19; edge cases 1, 2; T5)", async ({
  page,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(colleague.cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addHabit(pb, { title: "Review", ideal: "11:00", min: 30, max: 30 });
  const placed = await eventually(
    () => weekTimes(colleague.cal, "Review"),
    (t) => expect(t).toHaveLength(5),
  );

  await member(page, EMAIL).getByRole("button", { name: "Leave team" }).click();
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Make another member an admin before you leave.",
  );
  await member(page, EMAIL).getByRole("button", { name: "Remove admin" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Make another member an admin before you remove your admin role.",
  );

  await openTeam(pb);
  await member(pb, COLLEAGUE_EMAIL).getByRole("button", { name: "Leave team" }).click();
  await pb.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(pb.getByTestId("team-name")).toHaveText("e2e2's team");
  expect(await weekTimes(colleague.cal, "Review")).toEqual(placed);

  await page.reload();
  await expect(role(page, EMAIL)).toHaveText("admin");
  await expect(member(page, COLLEAGUE_EMAIL)).toHaveCount(0);
  await pb.reload();
  await expect(member(pb, EMAIL)).toHaveCount(0);
  await pb.getByRole("link", { name: "Habits" }).click();
  await expect(pb.locator('[data-habit-title="Review"]')).toBeVisible();
  expect(await weekTimes(colleague.cal, "Review")).toEqual(placed);
});

test("an invitation can grant the admin role; an admin gives and removes the role and removes a member; members cannot; the seat bar frees a seat (rules 4, 21, 22, 25; T6)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  app.cli("seat-limit", "--email", EMAIL, "--seats", "5");
  const c = await people(3);
  const pc = await c.signIn();
  await invite(page, [c.email], { admin: true });
  await accept(pc, joinLink((await mail.message(c.email, /invited you/)).text));
  await expect(role(pc, c.email)).toHaveText("admin");
  await page.reload();
  await expect(role(page, c.email)).toHaveText("admin");
  await expect(page.getByTestId("seat-bar")).toHaveText("3 of 5 seats used, 2 left");
  await member(page, c.email).getByRole("button", { name: "Remove admin" }).click();
  await expect(role(page, c.email)).toHaveText("member");

  // A member sees no role or delete actions, and the API refuses them.
  await openTeam(pb);
  await expect(member(pb, c.email).getByRole("button", { name: "Delete" })).toHaveCount(0);
  const status = await pb.evaluate(async () => {
    const team = (await (await fetch("/api/team")).json()) as {
      members: { userId: string; email: string }[];
    };
    const target = team.members.find((m) => m.email === "e2e3@tempoloom.test");
    const r = await fetch(`/api/team/members/${target?.userId}`, { method: "DELETE" });
    return r.status;
  });
  expect(status).toBe(403);

  await member(page, COLLEAGUE_EMAIL).getByRole("button", { name: "Make admin" }).click();
  await expect(role(page, COLLEAGUE_EMAIL)).toHaveText("admin");
  await member(page, c.email).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(member(page, c.email)).toHaveCount(0);

  await page.reload();
  await expect(role(page, COLLEAGUE_EMAIL)).toHaveText("admin");
  await expect(member(page, c.email)).toHaveCount(0);
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 5 seats used, 3 left");
  await pc.reload();
  await openTeam(pc);
  await expect(pc.getByTestId("team-name")).toHaveText("e2e3's team");
  expect(await c.cal.events(Date.now() - 86_400_000, Date.now() + 30 * 86_400_000)).toEqual([]);
});

test("team settings are for admins only; with invite permission for admins only a member cannot invite, with all members a member can (team settings rules 1, 12)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  const d = await people(4);
  await openTeam(pb);
  await expect(pb.getByRole("button", { name: /^(Add member|Invite)$/ })).toHaveCount(0);
  const refused = await pb.evaluate(async () => {
    const r = await fetch("/api/team/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emails: ["e2e4@tempoloom.test"] }),
    });
    return r.status;
  });
  expect(refused).toBe(403);
  await expect(pb.getByTestId("team-settings")).toHaveCount(0);
  const patch = await pb.evaluate(async () => {
    const r = await fetch("/api/team", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitePermission: "all_members" }),
    });
    return r.status;
  });
  expect(patch).toBe(403);

  await setTeamSettings(page, { invitePermission: "All members" });
  await pb.reload();
  await invite(pb, [d.email]);
  await expect(pb.getByTestId("invite-result")).toContainText("Invitations sent to 1 person");
  const text = (await mail.message(d.email, /e2e2 invited you to e2e's team/)).text;
  const pd = await d.signIn();
  await accept(pd, joinLink(text));
  await page.reload();
  await expect(status(page, d.email)).toHaveText("active");
  await page.reload();
  await expect(page.getByTestId("team-settings").getByLabel("Who can invite")).toHaveValue(
    "all_members",
  );
});

test("people of the same domain who are alone are offered for a new team, and each gets one invitation (rule 2)", async ({
  page,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const c = await people(3);
  const outsider = await people(5, "e2e5@elsewhere.test");
  const pb = await colleague.signIn();
  await c.signIn();
  await outsider.signIn();
  await signIn();
  await openTeam(page);
  const prompt = page.getByTestId("colleagues-prompt");
  await expect(prompt).toContainText(COLLEAGUE_EMAIL);
  await expect(prompt).toContainText(c.email);
  await expect(prompt).not.toContainText(outsider.email);
  await prompt.getByLabel(COLLEAGUE_EMAIL).check();
  await prompt.getByLabel(c.email).check();
  await prompt.getByRole("button", { name: "Invite selected" }).click();
  await expect(page.getByTestId("invite-result")).toContainText("Invitations sent to 2 people");
  const text = (await mail.message(COLLEAGUE_EMAIL, /invited you/)).text;
  await mail.message(c.email, /invited you/);
  expect(await mail.count(COLLEAGUE_EMAIL)).toBe(1);
  expect(await mail.count(c.email)).toBe(1);
  expect(await mail.count(outsider.email)).toBe(0);
  await accept(pb, joinLink(text));

  // B is now in a team of two, so B is no longer offered.
  await page.reload();
  await expect(status(page, COLLEAGUE_EMAIL)).toHaveText("active");
  await expect(page.getByTestId("colleagues-prompt")).toHaveCount(0);
});

test("over the seat limit, scheduling goes on but invitations stop (rules 24, 27; edge case 8; T7)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
  mail,
}) => {
  await blockUntil(colleague.cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  app.cli("seat-limit", "--email", EMAIL, "--seats", "2");
  await page.reload();
  await expect(page.getByTestId("seat-bar")).toHaveText("2 of 2 seats used, 0 left");
  app.cli("seat-limit", "--email", EMAIL, "--seats", "1");
  await page.reload();
  await expect(page.getByTestId("overage")).toContainText("more members than seats");

  const c = await people(3);
  await invite(page, [c.email]);
  await expect(page.getByTestId("invite-result")).toContainText("The team has no free seats.");
  await addHabit(pb, { title: "Stretch", ideal: "15:00", min: 45, max: 45 });
  await eventually(
    () => weekTimes(colleague.cal, "Stretch"),
    (t) => expect(t).toHaveLength(5),
  );

  await page.reload();
  await expect(page.getByTestId("overage")).toContainText("more members than seats");
  await expect(member(page, c.email)).toHaveCount(0);
  expect(await mail.count(c.email)).toBe(0);
  await pb.reload();
  expect(await weekTimes(colleague.cal, "Stretch")).toHaveLength(5);
});
