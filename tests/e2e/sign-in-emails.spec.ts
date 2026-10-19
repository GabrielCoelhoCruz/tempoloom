// Sign-in emails: log in with any added email, an email that several accounts
// hold, remove an added account, change the main email, and the error when
// the email is main in another account (docs/specs/accounts-login-emails-permissions.md
// rules 2-4, 7, 8, 10-13; AT-2, AT-3, AT-4, AT-6; accounts-connected-calendars.md
// rule 9, AT-7; sync-calendar-mirroring.md edge case 9).
//
// Ways it can fail, and the test that catches each:
// - a secondary email signs in to a new, empty account                     -> secondary
// - removing an added account leaves its policy, the copies it made on the
//   main calendar, or its calendars in the list                             -> secondary
// - a removed email still opens the account                                -> secondary
// - "use as main" switches without a confirmation, or the main badge, the
//   locked main calendar or the target of new events stay on the old email  -> main
// - the old main email can no longer sign in after the switch              -> main
// - an email that is main in another account becomes main here             -> taken
// - the error gives no way out, or the retry after the fix still fails     -> taken
// - an email that two accounts hold signs in to one of them                -> several
// - the offer to sign up creates nothing, or takes the email from the others -> several
// Every test reloads and reads the state again.

import {
  addPolicy,
  calendarRow,
  copies,
  openSettings,
  signInWith,
  signOut,
  week,
} from "./calendar-helpers.ts";
import { accountMessage, accountRow, addCalDavAccount, openAccount } from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  COLLEAGUE_EMAIL,
  EMAIL,
  eventually,
  expect,
  test,
} from "./fixtures.ts";
import { addTask, allEvents, titled, visitor, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Sign-in email E2E adds CalDAV accounts.");

const mainBadge = (p: Parameters<typeof accountRow>[0], email: string) =>
  accountRow(p, email).getByTestId("main-badge");

test("a secondary email signs in to the same account; removing it removes its policy, copies and calendars (rules 2, 3, 7; AT-2)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  await blockUntil(cal, W);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  await expect(accountRow(page, extra.email)).toContainText("caldav");
  await extra.cal.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  // A policy copies the added account's events into the main calendar.
  await addPolicy(page, { from: `Work (${extra.email})`, to: `Work (${EMAIL})` });
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => e.summary)).toEqual(["Personal commitment"]),
  );

  // Log out, then log in with the secondary email: the same account opens.
  await signOut(page);
  await signInWith(page, six, extra.email);
  await expect(page.getByTestId("user-email")).toHaveText(EMAIL);
  await openAccount(page);
  await expect(mainBadge(page, EMAIL)).toBeVisible();

  // Remove it after a confirmation: its policy, the copy and its calendars go.
  await accountRow(page, extra.email).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove account" }).click();
  await expect(accountRow(page, extra.email)).toHaveCount(0);
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  await page.reload();
  await expect(accountRow(page, extra.email)).toHaveCount(0);
  await openSettings(page);
  await expect(page.getByTestId("calendar-list")).not.toContainText(extra.email);
  await expect(page.getByTestId("mirror-list").locator("[data-mirror]")).toHaveCount(0);

  // The email no longer belongs to this account: signing in with it starts a new one.
  await signOut(page);
  await signInWith(page, six, extra.email);
  await expect(page.getByTestId("user-email")).toHaveText(extra.email);
});

test("use as main moves the main badge, the locked main calendar and new events; the old email still signs in (rules 10, 11; AT-3; connected calendars AT-7)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  await blockUntil(cal, W);
  await blockUntil(extra.cal, W);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });

  // The switch asks first; cancel keeps the main email.
  await accountRow(page, extra.email).getByRole("button", { name: "Use as main" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Use ${extra.email} as your main email?`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(mainBadge(page, EMAIL)).toBeVisible();
  await accountRow(page, extra.email).getByRole("button", { name: "Use as main" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use as main" }).click();
  await expect(mainBadge(page, extra.email)).toBeVisible();
  await expect(mainBadge(page, EMAIL)).toHaveCount(0);
  await expect(page.getByTestId("user-email")).toHaveText(extra.email);
  // The main email cannot be removed; the old one now can.
  await expect(accountRow(page, extra.email).getByRole("button", { name: "Remove" })).toHaveCount(
    0,
  );
  await expect(accountRow(page, EMAIL).getByRole("button", { name: "Remove" })).toBeVisible();

  // The new main calendar is connected and locked; the old one is no longer connected.
  await openSettings(page);
  const newMain = calendarRow(page, extra.email).getByRole("checkbox");
  const oldMain = calendarRow(page, EMAIL).getByRole("checkbox");
  await expect(newMain).toBeChecked();
  await expect(newMain).toBeDisabled();
  await expect(oldMain).not.toBeChecked();
  await expect(oldMain).toBeEnabled();

  // New events go to the new main calendar.
  await addTask(page, { title: "AT-Main", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(extra.cal),
    (l) => expect(titled(l, "AT-Main")).toHaveLength(1),
  );
  expect(titled(await allEvents(cal), "AT-Main")).toHaveLength(0);
  await page.reload();
  await openSettings(page);
  await expect(calendarRow(page, extra.email).getByRole("checkbox")).toBeDisabled();
  await expect(calendarRow(page, EMAIL).getByRole("checkbox")).not.toBeChecked();

  // The old main email still opens this account, where the new email stays main.
  await signOut(page);
  await signInWith(page, radicale, EMAIL);
  await expect(page.getByTestId("user-email")).toHaveText(extra.email);
  await openAccount(page);
  await expect(mainBadge(page, extra.email)).toBeVisible();
});

test("an email that is main in another account cannot become main here; after that account is deleted the retry works (rules 12, 13; AT-4)", async ({
  page,
  signIn,
  colleague,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  const pc = await colleague.signIn();
  await signIn();
  // Allowed as a secondary email (rule 4, edge case 2).
  await addCalDavAccount(page, { ...radicale.colleague, email: COLLEAGUE_EMAIL });
  await expect(accountRow(page, COLLEAGUE_EMAIL)).toContainText("caldav");
  await accountRow(page, COLLEAGUE_EMAIL).getByRole("button", { name: "Use as main" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use as main" }).click();
  await expect(accountMessage(page)).toHaveText(
    `${COLLEAGUE_EMAIL} is the main email of another Tempoloom account. This is often an older account that you forgot. To fix it, sign in with ${COLLEAGUE_EMAIL}, then delete that account or make another email its main email. Then sign in here again and retry.`,
  );
  await page.reload();
  await expect(mainBadge(page, EMAIL)).toBeVisible();
  await expect(mainBadge(page, COLLEAGUE_EMAIL)).toHaveCount(0);
  // The colleague's own account is untouched.
  await pc.reload();
  await expect(pc.getByTestId("user-email")).toHaveText(COLLEAGUE_EMAIL);

  // The fix: the other account is deleted; then the retry works.
  await pc.goto("/account");
  await pc.getByRole("button", { name: "Delete my account" }).click();
  await pc.getByLabel("Type your email to confirm").fill(COLLEAGUE_EMAIL);
  await pc.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(pc.getByTestId("caldav-form")).toBeVisible();
  await accountRow(page, COLLEAGUE_EMAIL).getByRole("button", { name: "Use as main" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Use as main" }).click();
  await expect(mainBadge(page, COLLEAGUE_EMAIL)).toBeVisible();
  await page.reload();
  await expect(mainBadge(page, COLLEAGUE_EMAIL)).toBeVisible();
  await expect(mainBadge(page, EMAIL)).toHaveCount(0);
});

test("an email that two accounts hold as secondary opens neither and offers a new account (rule 3.3; AT-6)", async ({
  page,
  browser,
  signIn,
  colleague,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6);
  const pc = await colleague.signIn();
  await addCalDavAccount(pc, { ...six, email: extra.email });
  await expect(accountRow(pc, extra.email)).toBeVisible();
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  await expect(accountRow(page, extra.email)).toBeVisible();

  const v = await visitor(browser);
  await v.goto("/");
  await signInWith(v, six, extra.email, false);
  const alert = v.getByTestId("caldav-form").getByRole("alert");
  await expect(alert).toHaveText(
    "This email belongs to more than one Tempoloom account, so Tempoloom cannot choose one. You can create a new Tempoloom account with it.",
  );
  // No session: a reload shows the sign-in page again.
  await v.reload();
  await expect(v.getByTestId("caldav-form")).toBeVisible();

  // Accepting the offer makes a new account with this email as main.
  await signInWith(v, six, extra.email, false);
  await v.getByRole("button", { name: "Create a new Tempoloom account" }).click();
  await expect(v.getByTestId("user-email")).toHaveText(extra.email);
  await v.reload();
  await expect(v.getByTestId("user-email")).toHaveText(extra.email);
  await openAccount(v);
  await expect(mainBadge(v, extra.email)).toBeVisible();

  // The two other accounts keep it as a secondary email.
  for (const p of [page, pc]) {
    await p.reload();
    await expect(accountRow(p, extra.email)).toBeVisible();
    await expect(mainBadge(p, extra.email)).toHaveCount(0);
  }
});
