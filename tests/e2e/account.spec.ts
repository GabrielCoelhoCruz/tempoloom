// Account settings: added accounts (accounts-login-emails-permissions.md rules
// 6-8), personal API keys (integrations-api-keys-zapier.md rules 1-5, AT-1,
// AT-2) and deleting the own account (delegated-access rule 7 needs it real).
//
// Ways it can fail, and the test that catches each:
// - a wrong password still adds an account                                -> accounts
// - adding another user's calendar account moves it or its credentials    -> accounts
// - an added account's calendars do not show, or stay after removal       -> accounts
// - the main account can be removed; removal needs no confirmation        -> accounts
// - the key secret is shown again after creation, or copy gives another   -> keys
// - a key does not act as its user, or its task is not planned            -> keys
// - regenerate keeps the old secret working, or makes a second key        -> keys
// - a deleted key still works; the expiry or last use is not shown        -> keys
// - the sole admin of a team with members deletes the account             -> delete
// - deletion happens without typing the email                             -> delete
// - deletion leaves the user's data or future managed events behind,
//   or removes events Tempoloom does not manage                           -> delete
// Every test reloads the pages and reads the state again.
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import {
  accountMessage,
  accountRow,
  addCalDavAccount,
  createKey,
  keyRow,
  openAccount,
} from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  BASE_URL,
  blockUntil,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  test,
  ZONE,
} from "./fixtures.ts";
import { addTask, allEvents, titled, W } from "./helpers.ts";
import { teamOfTwo } from "./team-helpers.ts";

test.skip(BACKEND === "google", "Account E2E adds CalDAV accounts.");

test("a user adds a second CalDAV account and removes it after a confirmation; the main account stays (rules 6-8)", async ({
  page,
  signIn,
  colleague,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  await colleague.signIn();
  await signIn();
  await openAccount(page);
  await expect(accountRow(page, EMAIL)).toContainText("main");
  await expect(accountRow(page, EMAIL).getByRole("button", { name: "Remove" })).toHaveCount(0);

  await addCalDavAccount(page, { ...six, password: "wrong", email: extra.email });
  await expect(accountMessage(page)).toHaveText("The server rejected the user name or password.");
  // Another Tempoloom user's calendar account is refused, not moved.
  await addCalDavAccount(page, { ...radicale.colleague, email: COLLEAGUE_EMAIL });
  await expect(accountMessage(page)).toHaveText(
    "This calendar account belongs to another Tempoloom user.",
  );
  await expect(page.getByTestId("account-list").locator("[data-account]")).toHaveCount(1);

  await addCalDavAccount(page, { ...six, email: extra.email });
  await expect(accountRow(page, extra.email)).toContainText("caldav");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(extra.email);

  await openAccount(page);
  await accountRow(page, extra.email).getByRole("button", { name: "Remove" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Remove ${extra.email}?`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.reload();
  await expect(accountRow(page, extra.email)).toBeVisible();
  await accountRow(page, extra.email).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove account" }).click();
  await expect(accountRow(page, extra.email)).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId("account-list").locator("[data-account]")).toHaveCount(1);
  await expect(accountRow(page, EMAIL)).toContainText("main");
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByTestId("calendar-list")).toContainText(EMAIL);
  await expect(page.getByTestId("calendar-list")).not.toContainText(extra.email);

  // The colleague's account still signs in to the colleague's own Tempoloom account.
  const pc = await colleague.signIn();
  await expect(pc.getByTestId("user-email")).toHaveText(COLLEAGUE_EMAIL);
});

test("a personal API key creates a planned task; regenerate replaces the secret; delete revokes it (API keys rules 1-5; AT-1, AT-2)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const secret = await createKey(page, "test");
  await page.getByTestId("new-key").getByRole("button", { name: "Copy" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await expect(keyRow(page, "test")).toContainText("never expires");
  await expect(keyRow(page, "test")).toContainText("never used");

  const call = (key: string, method = "GET", body?: unknown) =>
    fetch(`${BASE_URL}/api/tasks`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const due = at(addDays(W, 1), "17:00");
  expect((await call(secret, "POST", { title: "API task", minutes: 60, dueAt: due })).status).toBe(
    201,
  );
  const placed = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "API task")).toHaveLength(1),
  );
  const chunk = titled(placed, "API task")[0];
  expect(chunk && chunk.end - chunk.start).toBe(3_600_000);
  expect(chunk && chunk.end <= due).toBe(true);

  // The secret shows once: not after a reload. The list shows the last use.
  await page.reload();
  await expect(page.getByTestId("new-key")).toHaveCount(0);
  expect(await page.content()).not.toContain(secret);
  await expect(keyRow(page, "test")).toContainText(/last used \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-task-title="API task"]')).toBeVisible();

  // Regenerate: the old secret stops at once, the new one works, still one key.
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await keyRow(page, "test").getByRole("button", { name: "Regenerate" }).click();
  const fresh = (await page.getByTestId("new-key").locator("code").textContent()) ?? "";
  expect(fresh).toMatch(/^tl-/);
  expect(fresh).not.toBe(secret);
  expect((await call(secret)).status).toBe(401);
  expect((await call(fresh)).status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("key-list").locator("[data-key]")).toHaveCount(1);

  // An expiry shows as a date; a deleted key gets 401.
  await createKey(page, "Quarterly", "90 days");
  const in90 = utcToLocal(ZONE, Date.now() + 90 * 86_400_000).date;
  await expect(keyRow(page, "Quarterly")).toContainText(`expires ${in90}`);
  await keyRow(page, "test").getByRole("button", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete key" }).click();
  await expect(keyRow(page, "test")).toHaveCount(0);
  expect((await call(fresh)).status).toBe(401);
  await page.reload();
  await expect(page.getByTestId("key-list").locator("[data-key]")).toHaveCount(1);
  await expect(keyRow(page, "Quarterly")).toBeVisible();
});

test("deleting the own account needs the email typed, is refused for a sole admin with members, and removes data and future managed events", async ({
  page,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  const pb = await teamOfTwo(page, signIn, colleague, mail);
  await addTask(page, { title: "Doomed task", minutes: 60 });
  await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "Doomed task")).toHaveLength(1),
  );

  await openAccount(page);
  await page.getByRole("button", { name: "Delete my account" }).click();
  const confirm = page.getByLabel("Type your email to confirm");
  const go = page.getByRole("button", { name: "Delete account permanently" });
  await confirm.fill("someone@else.test");
  await expect(go).toBeDisabled();
  await confirm.fill(EMAIL);
  await go.click();
  await expect(accountMessage(page)).toHaveText(
    "You are the only admin of a team with other members. Make another member an admin before you delete your account.",
  );

  // The member leaves; now the owner can delete the account.
  await pb.goto("/team");
  await pb
    .locator(`[data-member="${COLLEAGUE_EMAIL}"]`)
    .getByRole("button", { name: "Leave team" })
    .click();
  await pb.getByRole("button", { name: "Leave", exact: true }).click();
  await page.reload();
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByLabel("Type your email to confirm").fill(EMAIL);
  await page.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(page.getByTestId("caldav-form")).toBeVisible();

  // Future managed events are gone; the user's own events stay.
  await eventually(
    () => allEvents(cal),
    (l) => {
      expect(titled(l, "Doomed task")).toHaveLength(0);
      expect(l.some((e) => e.summary === "E2E blocker")).toBe(true);
    },
  );
  await page.reload();
  await expect(page.getByTestId("caldav-form")).toBeVisible();

  // Signing in again makes a new, empty account.
  await signIn();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByTestId("task-list")).toBeVisible();
  await expect(page.locator('[data-task-title="Doomed task"]')).toHaveCount(0);
});
