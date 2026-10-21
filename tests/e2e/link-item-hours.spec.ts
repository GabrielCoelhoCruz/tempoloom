// Item-specific hours on booking links (docs/specs/planning-hours.md,
// item-specific hours; booking-links.md `hours`; booking-links-team.md rule 2).
//
// Ways this can fail:
// - the link's hours menu has no "Item-specific hours" choice;
// - the link keeps offering its organizer's meeting hours after the change;
// - a team link uses one organizer's item-specific hours for everyone;
// - the ranges are lost or changed on reload, or after a save of other fields;
// - the private ranges show as a named set in another link's hours menus.
import { addDays } from "../../src/shared/time.ts";
import { blockUntil, EMAIL, expect, test } from "./fixtures.ts";
import { addLink, claimPage, visitor, W } from "./helpers.ts";
import { addOrganizer, editLink, offered, organizer, saveLink, teamOf } from "./link-helpers.ts";

const TUE = addDays(W, 1);

test("a booking link offers times only inside its item-specific hours, and on a team link each organizer's own item-specific hours count (planning-hours item-specific hours; booking-links-team rule 2)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await teamOf(page, signIn, [colleague], mail);
  await claimPage(page, "ivy");
  await addLink(page, { title: "Early call", durations: "30" });
  const v = await visitor(browser);
  await v.goto("/book/ivy/early-call");
  // The default: the organizer's meeting hours, 09:00 to 17:00 on workdays.
  expect(await offered(v, W)).toContain("09:00");
  expect(await offered(v, TUE)).not.toContain("07:00");

  await editLink(page, "Early call");
  const mine = organizer(page, EMAIL);
  await mine.getByLabel("Hours").selectOption({ label: "Item-specific hours" });
  await mine.getByLabel("Tue").check();
  await mine.getByLabel("From").fill("07:00");
  await mine.getByLabel("To").fill("08:30");
  await saveLink(page);
  await expect
    .poll(async () => {
      await v.goto("/book/ivy/early-call");
      return [await offered(v, W), await offered(v, TUE)];
    })
    .toEqual([[], ["07:00", "07:15", "07:30", "07:45", "08:00"]]);

  // A team link: each organizer has their own item-specific hours on the link.
  await editLink(page, "Early call");
  await addOrganizer(page, colleague.email);
  const theirs = organizer(page, colleague.email);
  await theirs.getByLabel("Hours").selectOption({ label: "Item-specific hours" });
  await theirs.getByLabel("Tue").check();
  await theirs.getByLabel("From").fill("08:00");
  await theirs.getByLabel("To").fill("10:00");
  await saveLink(page);
  await expect
    .poll(async () => {
      await v.goto("/book/ivy/early-call");
      return offered(v, TUE);
    })
    .toEqual(["08:00"]);

  // Both organizers keep their own ranges after a reload and a save of another field.
  await page.reload();
  const ed = await editLink(page, "Early call");
  await ed.getByLabel("Title").fill("Early call 2");
  await saveLink(page);
  await page.reload();
  await editLink(page, "Early call 2");
  for (const [email, from, to] of [
    [EMAIL, "07:00", "08:30"],
    [colleague.email, "08:00", "10:00"],
  ] as const) {
    const row = organizer(page, email);
    await expect(row.getByLabel("Hours").locator("option:checked")).toHaveText(
      "Item-specific hours",
    );
    await expect(row.getByLabel("Tue")).toBeChecked();
    await expect(row.getByLabel("Mon")).not.toBeChecked();
    await expect(row.getByLabel("From")).toHaveValue(from);
    await expect(row.getByLabel("To")).toHaveValue(to);
  }
  await v.goto("/book/ivy/early-call");
  expect(await offered(v, TUE)).toEqual(["08:00"]);

  // The private ranges are no named set: the hours menus of the people on another
  // link do not list them, also not the colleague's (the team people list).
  await addLink(page, { title: "Late call", durations: "30" });
  await editLink(page, "Late call");
  await addOrganizer(page, colleague.email);
  for (const email of [EMAIL, colleague.email]) {
    const menu = organizer(page, email).getByLabel("Hours");
    await expect(menu.locator("option")).not.toHaveCount(0);
    await expect(menu).toContainText("Item-specific hours");
    await expect(menu).not.toContainText("(item-specific hours)");
  }
});
