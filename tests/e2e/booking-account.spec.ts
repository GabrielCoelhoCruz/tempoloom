// The account of a booking link (docs/specs/accounts-connected-calendars.md
// rule 22; booking-links.md targetCalendar): booked events go to the primary
// calendar of the added account chosen on the link, and that account sends
// the invitations (it is the event organizer).
//
// Ways this can fail:
// - the link offers no account choice, or only the main account;
// - the event still goes to the main calendar after the change;
// - the event is on the chosen account but the main email is its organizer;
// - the choice is lost on reload;
// - a disconnected or removed account falls back to the main calendar without a
//   word, the editor shows "Main account" for it, or a booking on a removed
//   account can no longer be moved (rule 19).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { accountRow, addCalDavAccount, openAccount } from "./delegation-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  EMAIL,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, slot, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";
import { setPassword } from "./radicale-users.ts";

test.skip(BACKEND === "google", "A second added account needs CalDAV.");

test("a booking link writes its events to the primary calendar of the added account chosen on the link, with that account as organizer; the main calendar is the default (accounts rule 22)", async ({
  page,
  browser,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6, "zoe@side.example");
  await blockUntil(cal, W);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  await expect(accountRow(page, extra.email)).toContainText("caldav");
  await claimPage(page, "zoe");
  await addLink(page, { title: "Consult", durations: "30" });
  const named = async (c: typeof cal, summary: string) =>
    (await allEvents(c)).filter((e) => e.summary === summary);

  // The default: the main account's primary calendar, with the main email as organizer.
  const v = await visitor(browser);
  await v.goto("/book/zoe/consult");
  await book(v, at(W, "10:00"), "Ann", "ann@example.com");
  const [first] = await eventually(
    () => named(cal, "Consult with Ann"),
    (l) => expect(l.map((e) => local(e.start))).toEqual([`${W} 10:00`]),
  );
  expect(first?.organizerSelf).toBe(true);
  expect(await named(extra.cal, "Consult with Ann")).toEqual([]);

  let ed = await editLink(page, "Consult");
  await expect(ed.getByLabel("Account for booked events").locator("option:checked")).toHaveText(
    `Main account (${EMAIL})`,
  );
  await ed.getByLabel("Account for booked events").selectOption({ label: extra.email });
  await saveLink(page);

  await v.goto("/book/zoe/consult");
  await book(v, at(addDays(W, 1), "11:00"), "Bob", "bob@example.com");
  const [second] = await eventually(
    () => named(extra.cal, "Consult with Bob"),
    (l) => expect(l.map((e) => local(e.start))).toEqual([`${addDays(W, 1)} 11:00`]),
  );
  // extra.cal reads as zoe@side.example: the added account is the organizer.
  expect(second?.organizerSelf).toBe(true);
  expect((await extra.cal.guests(second?.id ?? "")).map((g) => g.email)).toContain(
    "bob@example.com",
  );
  expect(await named(cal, "Consult with Bob")).toEqual([]);

  await page.reload();
  ed = await editLink(page, "Consult");
  await expect(ed.getByLabel("Account for booked events").locator("option:checked")).toHaveText(
    extra.email,
  );
});

/** The error of a link whose account for booked events is lost (accounts rule 19). */
const lostTarget = (page: Page) =>
  page.locator('[data-link-title="Consult"]').getByTestId("link-target-error");

test("a link whose account for booked events is disconnected shows the error, keeps showing that account, and takes no bookings until the user picks another account (accounts rules 19, 22)", async ({
  page,
  browser,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6, "zoe@side.example");
  try {
    await blockUntil(cal, W);
    await signIn();
    await addCalDavAccount(page, { ...six, email: extra.email });
    await expect(accountRow(page, extra.email)).toContainText("caldav");
    // Tempoloom reads the account's calendar, so it sees the lost login.
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    const row = page
      .getByTestId("calendar-list")
      .locator("[data-calendar]", { hasText: extra.email });
    await row.getByRole("checkbox").check();
    await expect(row.getByRole("checkbox")).toBeChecked();
    await claimPage(page, "yara");
    await addLink(page, { title: "Consult", durations: "30" });
    let ed = await editLink(page, "Consult");
    await ed.getByLabel("Account for booked events").selectOption({ label: extra.email });
    await saveLink(page);
    // The default: a working account shows no error and the page takes bookings.
    await expect(lostTarget(page)).toHaveCount(0);
    const v = await visitor(browser);
    await v.goto("/book/yara/consult");
    await expect(slot(v, at(W, "10:00"))).toBeVisible();

    // The server no longer takes the stored password.
    setPassword(six.username, 6, `new-${Date.now()}`);
    await planNow(page);
    await openAccount(page);
    await expect
      .poll(
        async () => {
          await page.reload();
          return accountRow(page, extra.email).getByTestId("account-status").textContent();
        },
        { timeout: 45_000 },
      )
      .toBe("Disconnected");
    const why = `Paused: ${extra.email} is disconnected. Reconnect it on the Account page, or choose another account for booked events.`;
    await page.getByRole("link", { name: "Booking links" }).click();
    await expect(lostTarget(page)).toHaveText(why);
    ed = await editLink(page, "Consult");
    await expect(ed.getByLabel("Account for booked events").locator("option:checked")).toHaveText(
      extra.email,
    );
    await expect(ed.getByTestId("link-target-error")).toHaveText(why);
    await v.goto("/book/yara/consult");
    await expect(v.getByTestId("paused")).toHaveText(
      "This link takes no bookings right now. Ask the organizer for another way to meet.",
    );
    await expect(v.getByTestId("times")).toHaveCount(0);

    // Another account: the error goes and the link takes bookings again, on the main calendar.
    await ed
      .getByLabel("Account for booked events")
      .selectOption({ label: `Main account (${EMAIL})` });
    await saveLink(page);
    await page.reload();
    await expect(lostTarget(page)).toHaveCount(0);
    await v.goto("/book/yara/consult");
    await book(v, at(W, "10:00"), "Ann", "ann@example.com");
    await eventually(
      () => allEvents(cal),
      (l) =>
        expect(
          l.filter((e) => e.summary === "Consult with Ann").map((e) => local(e.start)),
        ).toEqual([`${W} 10:00`]),
    );
  } finally {
    setPassword(six.username, 6, six.password);
  }
});

test("a link whose account for booked events is removed shows the error and the removed account; a booking on that account can still be moved (accounts rules 19, 22)", async ({
  page,
  browser,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  const extra = await people(6, "zoe@side.example");
  await blockUntil(cal, W);
  await signIn();
  await addCalDavAccount(page, { ...six, email: extra.email });
  await expect(accountRow(page, extra.email)).toContainText("caldav");
  await claimPage(page, "una");
  await addLink(page, { title: "Consult", durations: "30" });
  let ed = await editLink(page, "Consult");
  await ed.getByLabel("Account for booked events").selectOption({ label: extra.email });
  await saveLink(page);
  const v = await visitor(browser);
  await v.goto("/book/una/consult");
  await book(v, at(addDays(W, 1), "11:00"), "Bob", "bob@example.com");
  await eventually(
    () => allEvents(extra.cal),
    (l) => expect(l.filter((e) => e.summary === "Consult with Bob")).toHaveLength(1),
  );
  await v.getByTestId("manage-link").click();
  await expect(v.getByTestId("manage-page")).toBeVisible();
  const manage = v.url();

  await openAccount(page);
  await accountRow(page, extra.email).getByRole("button", { name: "Remove" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Remove account" }).click();
  await expect(accountRow(page, extra.email)).toHaveCount(0);

  // The booker still moves the booking; the new time goes to the main calendar.
  await v.goto(manage);
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(addDays(W, 2), "14:00")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  await eventually(
    () => allEvents(cal),
    (l) =>
      expect(l.filter((e) => e.summary === "Consult with Bob").map((e) => local(e.start))).toEqual([
        `${addDays(W, 2)} 14:00`,
      ]),
  );

  // The link shows the error and the removed account, not the main account.
  const why =
    "Paused: the account for booked events was removed. Choose another account for booked events.";
  await page.getByRole("link", { name: "Booking links" }).click();
  await expect(lostTarget(page)).toHaveText(why);
  await page.reload();
  ed = await editLink(page, "Consult");
  await expect(ed.getByLabel("Account for booked events").locator("option:checked")).toHaveText(
    "Removed account",
  );
  await expect(ed.getByTestId("link-target-error")).toHaveText(why);
  await v.goto("/book/una/consult");
  await expect(v.getByTestId("paused")).toBeVisible();
  await expect(v.getByTestId("times")).toHaveCount(0);
});
