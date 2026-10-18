// Delegated access (docs/specs/accounts-delegated-access.md, SPEC-ACCT-03) and
// the executive assistant journey (teams-executive-assistant-use.md T1, T2, T4).
// The owner is Radicale user e2e (name "e2e"); the delegate is e2e2 (the
// colleague, name "e2e2"); e2e3 is a second executive; e2e4 is outside the team.
//
// Ways it can fail, and the test that catches each:
// - the search offers people outside the owner's team, or the owner     -> give access
// - the API accepts a delegate from another team                        -> give access
// - access is given without the confirmation, or Cancel still gives it  -> give access
// - the delegate list or the delegate's account menu misses the grant   -> give access
// - switching does not reload into the owner's account, or no banner     -> switch
// - the banner is missing on some pages, or gone after a reload          -> switch
// - an item made while acting lands in the delegate's account/calendar   -> switch, T2, T4
// - the owner cannot see which delegate made a change (rule 11)          -> switch
// - exit leaves the session in the owner's account, or comes back on reload -> switch
// - an acting delegate can add or remove accounts, connect calendars,
//   manage API keys, change delegates or delete the account (rule 7)     -> blocked
// - a blocked action fails without a message, or changes data anyway     -> blocked
// - a change by one session needs a manual reload in the other (rule 9)  -> live
// - a removed delegate keeps acting in an open session (rule 10)         -> remove
// - a delegate who leaves the team keeps access (edge case 1)            -> remove
// - with two executives, an item lands in the wrong one's calendar (T4)  -> two executives
// Every test reloads the pages and reads the state again.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  accountMessage,
  accountRow,
  addCalDavAccount,
  candidate,
  createKey,
  delegateRow,
  exitActing,
  giveAccess,
  keyRow,
  openAccount,
  openAccountMenu,
  statuses,
  switchTo,
} from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, allEvents, titled, W } from "./helpers.ts";
import { accept, invite, joinLink, openTeam, teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Delegation E2E uses several CalDAV users.");

const banner = (p: Page) => p.getByTestId("acting-banner");
const taskRow = (p: Page, title: string) => p.locator(`[data-task-title="${title}"]`);
const habitRow = (p: Page, title: string) => p.locator(`[data-habit-title="${title}"]`);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 14), "00:00"));
/** Faster than any polling in the views: a change that shows within it came live. */
const LIVE = { timeout: 10_000 };

test("the owner gives a team member access after a confirmation; people outside the team are not offered (rules 1-4; AT-1, AT-4)", async ({
  page,
  app,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const outsider = await people(4);
  await outsider.signIn();
  const pb = await teamOfTwo(page, signIn, colleague, mail);

  await openAccount(page);
  await expect(page.getByTestId("delegate-list")).toContainText("Nobody has delegated access.");
  await page.getByLabel("Search team members").fill("e2e");
  await expect(candidate(page, COLLEAGUE_EMAIL)).toBeVisible();
  await expect(candidate(page, outsider.email)).toHaveCount(0);
  await expect(candidate(page, EMAIL)).toHaveCount(0);
  await page.getByLabel("Search team members").fill("e2e4");
  await expect(page.getByTestId("candidates")).toContainText("No team member matches.");

  // The API refuses a person from another team, too.
  const [outsiderId] = app.query<{ id: string }>(
    "SELECT id FROM users WHERE email = ?",
    outsider.email,
  );
  expect(
    await statuses(page, [
      { method: "POST", url: "/api/delegates", body: { userId: outsiderId?.id } },
    ]),
  ).toEqual([{ status: 400, error: "not_in_team" }]);

  // Cancel gives nothing; confirm gives access.
  await page.getByLabel("Search team members").fill("colleague");
  await candidate(page, COLLEAGUE_EMAIL).getByRole("button", { name: "Give access" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "e2e2 will see and change your Tempoloom data: tasks, habits, meetings, booking links and settings.",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(delegateRow(page, COLLEAGUE_EMAIL)).toHaveCount(0);
  await giveAccess(page, COLLEAGUE_EMAIL);
  // A delegate is no longer offered in the search.
  await page.getByLabel("Search team members").fill("colleague");
  await expect(candidate(page, COLLEAGUE_EMAIL)).toHaveCount(0);

  await page.reload();
  await expect(delegateRow(page, COLLEAGUE_EMAIL)).toContainText("e2e2");
  await expect(delegateRow(page, outsider.email)).toHaveCount(0);
  await expect(page.getByTestId("delegate-list").locator("[data-delegate]")).toHaveCount(1);

  // The delegate's account menu lists the owner; the outsider's lists nobody.
  await pb.reload();
  await openAccountMenu(pb);
  await expect(pb.getByRole("menuitem", { name: "Switch to e2e's account" })).toBeVisible();
  const po = await outsider.signIn();
  await openAccountMenu(po);
  await expect(po.getByRole("menuitem", { name: /^Switch to/ })).toHaveCount(0);
});

test("the delegate switches into the owner's account, sees the banner on every page, plans a task on the owner's calendar, and exits (rules 5, 6, 8, 11; AT-1, AT-3; T1)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await giveAccess(page, COLLEAGUE_EMAIL);

  await pb.reload();
  await expect(banner(pb)).toHaveCount(0);
  await switchTo(pb, "e2e");
  await expect(banner(pb)).toContainText("e2e@tempoloom.test");
  await expect(pb.getByTestId("user-email")).toHaveText(EMAIL);
  for (const link of [
    "Tasks",
    "Habits",
    "Meetings",
    "Booking links",
    "Team",
    "Settings",
    "Account",
  ]) {
    await pb.getByRole("link", { name: link, exact: true }).click();
    await expect(banner(pb)).toBeVisible();
  }

  await addTask(pb, { title: "Prepare board pack", minutes: 60, due: `${addDays(W, 4)}T17:00` });
  const placed = await eventually(
    () => twoWeeks(cal),
    (l) => expect(titled(l, "Prepare board pack")).toHaveLength(1),
  );
  const chunk = titled(placed, "Prepare board pack")[0];
  expect(chunk && chunk.end - chunk.start).toBe(3_600_000);
  expect(titled(await allEvents(colleague.cal), "Prepare board pack")).toHaveLength(0);

  // Reload check: still acting, banner shown, the task is in the owner's account.
  await pb.reload();
  await expect(banner(pb)).toContainText("You are acting in e2e's account");
  await pb.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(taskRow(pb, "Prepare board pack")).toBeVisible();

  // The owner sees the task and who made it.
  await page.goto("/tasks");
  await expect(taskRow(page, "Prepare board pack")).toBeVisible();
  await openAccount(page);
  await expect(page.getByTestId("delegate-changes")).toContainText(
    `${COLLEAGUE_EMAIL} added a task`,
  );

  // Exit: back in the delegate's own account, also after a reload.
  await exitActing(pb, "e2e");
  await expect(pb.getByTestId("user-email")).toHaveText(COLLEAGUE_EMAIL);
  await pb.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(pb.getByTestId("task-list")).toBeVisible();
  await expect(taskRow(pb, "Prepare board pack")).toHaveCount(0);
  await pb.reload();
  await expect(banner(pb)).toHaveCount(0);
  await expect(pb.getByTestId("user-email")).toHaveText(COLLEAGUE_EMAIL);
  await expect(taskRow(pb, "Prepare board pack")).toHaveCount(0);
});

test("an acting delegate cannot add or remove accounts, connect calendars, manage API keys, change delegates or delete the account (rule 7; edge cases 4, 5; AT-2)", async ({
  page,
  signIn,
  colleague,
  people,
  radicale,
  mail,
}) => {
  const extra = await people(6);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  // The owner has a second account and an API key: real things to change.
  await addCalDavAccount(page, { ...(radicale?.users[6] ?? fail()), email: extra.email });
  await expect(accountRow(page, extra.email)).toBeVisible();
  await createKey(page, "Owner key");
  await giveAccess(page, COLLEAGUE_EMAIL);

  await pb.reload();
  await switchTo(pb, "e2e");
  await openAccount(pb);
  const blockedAccounts = "Delegates cannot add or remove accounts or calendars. Ask e2e to do it.";
  await pb.getByRole("button", { name: "Add another account" }).click();
  await expect(accountMessage(pb)).toHaveText(blockedAccounts);
  await expect(pb.getByTestId("add-account-form")).toHaveCount(0);

  await accountRow(pb, extra.email).getByRole("button", { name: "Remove" }).click();
  await pb.getByRole("dialog").getByRole("button", { name: "Remove account" }).click();
  await expect(accountMessage(pb)).toHaveText(blockedAccounts);

  const form = pb.getByTestId("key-form");
  await form.getByLabel("Key name").fill("Assistant key");
  await form.getByRole("button", { name: "Generate" }).click();
  const blockedKeys = "Delegates cannot create or change API keys. Ask e2e to do it.";
  await expect(accountMessage(pb)).toHaveText(blockedKeys);
  await expect(pb.getByTestId("new-key")).toHaveCount(0);
  await keyRow(pb, "Owner key").getByRole("button", { name: "Regenerate" }).click();
  await expect(accountMessage(pb)).toHaveText(blockedKeys);
  await keyRow(pb, "Owner key").getByRole("button", { name: "Delete" }).click();
  await expect(accountMessage(pb)).toHaveText(blockedKeys);

  await expect(pb.getByTestId("delegates")).toContainText("Only e2e can change delegated access.");

  await pb.getByRole("button", { name: "Delete my account" }).click();
  await pb.getByLabel("Type your email to confirm").fill(EMAIL);
  await pb.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(accountMessage(pb)).toHaveText("Delegates cannot delete e2e's account.");

  // The API refuses each of them, and the team change, too.
  const accounts = await pb.evaluate(() =>
    fetch("/api/me").then((r) => r.json() as Promise<{ accounts: { id: string }[] }>),
  );
  const keys = await pb.evaluate(() =>
    fetch("/api/keys").then((r) => r.json() as Promise<{ keys: { id: string }[] }>),
  );
  const calendars = await pb.evaluate(() =>
    fetch("/api/calendars").then((r) => r.json() as Promise<{ calendars: { id: string }[] }>),
  );
  const [main, second] = accounts.accounts;
  const [key] = keys.keys;
  const [calendar] = calendars.calendars;
  const forbidden = { status: 403, error: "delegate_forbidden" };
  expect(
    await statuses(pb, [
      {
        method: "POST",
        url: "/api/accounts",
        body: { serverUrl: "http://x.test/", username: "a", password: "b" },
      },
      { method: "DELETE", url: `/api/accounts/${main?.id}` },
      { method: "DELETE", url: `/api/accounts/${second?.id}` },
      { method: "PATCH", url: `/api/calendars/${calendar?.id}`, body: { checkAvailability: true } },
      { method: "POST", url: "/api/keys", body: { name: "x", expires: "never" } },
      { method: "POST", url: `/api/keys/${key?.id}/regenerate` },
      { method: "DELETE", url: `/api/keys/${key?.id}` },
      { method: "POST", url: "/api/delegates", body: { userId: "x" } },
      { method: "POST", url: "/api/team/leave" },
      { method: "DELETE", url: "/api/me", body: { confirm: EMAIL } },
    ]),
  ).toEqual(Array(10).fill(forbidden));

  // Reload check as the owner: accounts, key and delegate unchanged.
  await page.reload();
  await expect(page.getByTestId("account-list").locator("[data-account]")).toHaveCount(2);
  await expect(accountRow(page, EMAIL)).toContainText("main");
  await expect(accountRow(page, extra.email)).toBeVisible();
  await expect(page.getByTestId("key-list").locator("[data-key]")).toHaveCount(1);
  await expect(keyRow(page, "Owner key")).toBeVisible();
  await expect(delegateRow(page, COLLEAGUE_EMAIL)).toBeVisible();
});

test("owner and delegate see each other's changes without a reload (rule 9)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await giveAccess(page, COLLEAGUE_EMAIL);
  await pb.reload();
  await switchTo(pb, "e2e");

  // Both look at the task list; each adds a task; the other's list shows it.
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await addTask(pb, { title: "Draft agenda", minutes: 30 });
  await expect(taskRow(page, "Draft agenda")).toBeVisible(LIVE);
  await addTask(page, { title: "Review budget", minutes: 30 });
  await expect(taskRow(pb, "Review budget")).toBeVisible(LIVE);

  // The same for habits, on another page.
  await page.getByRole("link", { name: "Habits", exact: true }).click();
  await addHabit(pb, { title: "Inbox zero", ideal: "16:00", min: 30, max: 30 });
  await expect(habitRow(page, "Inbox zero")).toBeVisible(LIVE);

  // Persistence: both after a reload, and the chunks are on the owner's calendar.
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(titled(l, "Draft agenda")).toHaveLength(1);
      expect(titled(l, "Review budget")).toHaveLength(1);
    },
  );
  await page.reload();
  await expect(habitRow(page, "Inbox zero")).toBeVisible();
  await pb.getByRole("link", { name: "Tasks", exact: true }).click();
  await pb.reload();
  await expect(taskRow(pb, "Draft agenda")).toBeVisible();
  await expect(taskRow(pb, "Review budget")).toBeVisible();
});

test("removing a delegate ends the open acting session; a delegate who leaves the team loses access (rule 10; edge case 1)", async ({
  page,
  signIn,
  colleague,
  mail,
}) => {
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await giveAccess(page, COLLEAGUE_EMAIL);
  await pb.reload();
  await switchTo(pb, "e2e");
  await pb.getByRole("link", { name: "Tasks", exact: true }).click();

  await delegateRow(page, COLLEAGUE_EMAIL).getByRole("button", { name: "Remove access" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove access" }).click();
  await expect(delegateRow(page, COLLEAGUE_EMAIL)).toHaveCount(0);

  // The delegate's open session ends at its next request, without a manual reload.
  await expect(banner(pb)).toHaveCount(0, LIVE);
  await expect(pb.getByTestId("acting-ended")).toHaveText(
    "Your access to that account ended. You are back in your own account.",
  );
  await expect(pb.getByTestId("user-email")).toHaveText(COLLEAGUE_EMAIL);
  await pb.reload();
  await expect(banner(pb)).toHaveCount(0);
  await openAccountMenu(pb);
  await expect(pb.getByRole("menuitem", { name: /^Switch to/ })).toHaveCount(0);
  const ownerId = await page.evaluate(() =>
    fetch("/api/me").then((r) => r.json() as Promise<{ user: { id: string } }>),
  );
  expect(
    await statuses(pb, [
      { method: "POST", url: "/api/acting", body: { ownerId: ownerId.user.id } },
    ]),
  ).toEqual([{ status: 403, error: "no_access" }]);

  // Access again, then the delegate leaves the team: access ends.
  await giveAccess(page, COLLEAGUE_EMAIL);
  await pb.reload();
  await openTeam(pb);
  await pb
    .locator(`[data-member="${COLLEAGUE_EMAIL}"]`)
    .getByRole("button", { name: "Leave team" })
    .click();
  await pb.getByRole("button", { name: "Leave", exact: true }).click();
  await page.reload();
  await expect(page.getByTestId("delegate-list")).toContainText("Nobody has delegated access.");
  await pb.reload();
  await openAccountMenu(pb);
  await expect(pb.getByRole("menuitem", { name: /^Switch to/ })).toHaveCount(0);
});

test("the assistant sets up a flexible meeting for the executive, on the executive's calendar only (EA T2)", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  const s = await teamOfTwo(page, signIn, colleague, mail);
  await giveAccess(page, COLLEAGUE_EMAIL);
  await s.reload();
  await switchTo(s, "e2e");

  await s.getByRole("link", { name: "Meetings", exact: true }).click();
  const form = s.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("One-on-one with Dana");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  await form.getByLabel("Priority").selectOption("1");
  await s.getByRole("button", { name: "Add meeting" }).click();
  await expect(s.locator('[data-meeting-title="One-on-one with Dana"]')).toBeVisible();

  await eventually(
    () => twoWeeks(cal),
    (l) => expect(titled(l, "One-on-one with Dana").length).toBeGreaterThanOrEqual(2),
  );
  expect(titled(await allEvents(colleague.cal), "One-on-one with Dana")).toHaveLength(0);

  // Reload as the executive: the meeting is theirs; the assistant's own list lacks it.
  await page.goto("/meetings");
  const critical = page.locator("section", {
    has: page.getByRole("heading", { name: "P1 critical" }),
  });
  await expect(critical.locator('[data-meeting-title="One-on-one with Dana"]')).toBeVisible();
  await exitActing(s, "e2e");
  await s.getByRole("link", { name: "Meetings", exact: true }).click();
  await s.reload();
  await expect(s.getByTestId("meeting-form")).toBeVisible();
  await expect(s.locator('[data-meeting-title="One-on-one with Dana"]')).toHaveCount(0);
});

test("an assistant with two executives switches between them; a habit lands on the chosen executive's calendar only (rule 4; EA T4)", async ({
  page,
  cal,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const x2 = await people(3);
  await blockUntil(cal, W);
  await blockUntil(x2.cal, W);
  const s = await colleague.signIn();
  const px2 = await x2.signIn();
  await signIn();
  await invite(page, [COLLEAGUE_EMAIL, x2.email]);
  await accept(s, joinLink((await mail.message(COLLEAGUE_EMAIL, /invited you/)).text));
  await accept(px2, joinLink((await mail.message(x2.email, /invited you/)).text));
  await giveAccess(page, COLLEAGUE_EMAIL);
  await giveAccess(px2, COLLEAGUE_EMAIL);

  await s.reload();
  await openAccountMenu(s);
  await expect(s.getByRole("menuitem", { name: /^Switch to/ })).toHaveCount(2);
  await s.keyboard.press("Escape");
  await switchTo(s, "e2e3");
  await addHabit(s, { title: "Catch up", ideal: "16:00", min: 30, max: 30 });
  await eventually(
    () => twoWeeks(x2.cal),
    (l) => expect(titled(l, "Catch up").length).toBeGreaterThanOrEqual(5),
  );
  expect(titled(await twoWeeks(cal), "Catch up")).toHaveLength(0);
  expect(titled(await allEvents(colleague.cal), "Catch up")).toHaveLength(0);

  // Straight from one executive to the other, without exit.
  await switchTo(s, "e2e");
  await s.getByRole("link", { name: "Habits", exact: true }).click();
  await expect(s.getByTestId("habit-form")).toBeVisible();
  await expect(habitRow(s, "Catch up")).toHaveCount(0);

  // Reload checks for both executives.
  await page.goto("/habits");
  await expect(page.getByTestId("habit-form")).toBeVisible();
  await expect(habitRow(page, "Catch up")).toHaveCount(0);
  await px2.goto("/habits");
  await expect(habitRow(px2, "Catch up")).toBeVisible();
});

function fail(): never {
  throw new Error("This test needs the CalDAV backend.");
}
