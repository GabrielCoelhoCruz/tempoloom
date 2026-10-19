// Link cards on the links page: what each card shows, its actions, and the
// priority change from the card. Spec: booking-links.md rules 5-6 and 9;
// booking-links-availability.md rule 12.
//
// Ways this can fail:
//  1. A card misses its title, durations or priority, or one of its actions.   (rule 5)
//  2. Cards are not grouped by page: a hidden link sits with the main ones.    (rules 5, 6)
//  3. Copy URL copies another URL; the open action opens another page.
//  4. The priority select on the card does not save, or the booking page keeps
//     offering the old times.                                                 (rule 9)
//  5. The card shows the new priority but a reload shows the old one.
import { at, BASE_URL, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addHabit, addLink, allEvents, claimPage, slot, titled, visitor, W } from "./helpers.ts";

test("link cards show title, durations and priority with their actions, grouped by page; the priority changes from the card and the booking page follows (rules 5, 6, 9)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await addHabit(page, {
    title: "Morning prep",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 3,
    days: ["Mon"],
    defense: "Always busy",
  });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "Morning prep")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await claimPage(page, "kai");
  await addLink(page, { title: "Low", durations: "30, 60", level: 4 });
  await addLink(page, { title: "Secret", durations: "30", hidden: true });

  const card = page.locator('[data-link-title="Low"]');
  await expect(card).toContainText("P4 low · 30, 60 min");
  for (const name of ["Edit", "Copy link", "Delete"]) {
    await expect(card.getByRole("button", { name })).toBeVisible();
  }
  await expect(card.getByLabel("Priority")).toHaveValue("4");
  await expect(card.getByRole("link", { name: "Open booking page" })).toHaveAttribute(
    "href",
    `${BASE_URL}/book/kai/low`,
  );
  await expect(page.locator('[data-page="main"] [data-link-title="Low"]')).toBeVisible();
  await expect(page.locator('[data-page="hidden"] [data-link-title="Secret"]')).toBeVisible();
  await expect(page.locator('[data-page="main"] [data-link-title="Secret"]')).toHaveCount(0);

  await card.getByRole("button", { name: "Copy link" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${BASE_URL}/book/kai/low`);
  const [opened] = await Promise.all([
    page.context().waitForEvent("page"),
    card.getByRole("link", { name: "Open booking page" }).click(),
  ]);
  await expect(opened.getByTestId("booking-page")).toContainText("Low");
  await opened.close();

  // P4 does not offer the P3 habit's time; P1 from the card does.
  const v = await visitor(browser);
  await v.goto("/book/kai/low");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);
  await card.getByLabel("Priority").selectOption("1");
  await expect(card).toContainText("P1 critical · 30, 60 min");
  await v.reload();
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-link-title="Low"]').getByLabel("Priority")).toHaveValue("1");
  await expect(page.locator('[data-link-title="Low"]')).toContainText("P1 critical · 30, 60 min");
});
