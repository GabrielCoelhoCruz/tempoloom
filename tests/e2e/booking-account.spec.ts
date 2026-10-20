// The account of a booking link (docs/specs/accounts-connected-calendars.md
// rule 22; booking-links.md targetCalendar): booked events go to the primary
// calendar of the added account chosen on the link, and that account sends
// the invitations (it is the event organizer).
//
// Ways this can fail:
// - the link offers no account choice, or only the main account;
// - the event still goes to the main calendar after the change;
// - the event is on the chosen account but the main email is its organizer;
// - the choice is lost on reload.
import { addDays } from "../../src/shared/time.ts";
import { accountRow, addCalDavAccount } from "./delegation-helpers.ts";
import { at, BACKEND, blockUntil, EMAIL, eventually, expect, local, test } from "./fixtures.ts";
import { addLink, allEvents, book, claimPage, visitor, W } from "./helpers.ts";
import { editLink, saveLink } from "./link-helpers.ts";

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
