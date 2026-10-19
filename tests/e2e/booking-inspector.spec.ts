// The availability inspector on the booking page: organizers see why each time
// is or is not offered. Spec: booking-links-availability.md rules 18-22.
//
// Ways this can fail:
//  1. A signed-out booker, or a signed-in person who does not organize the
//     link, sees the inspector switch.                                        (rule 18)
//  2. A co-organizer does not see it.                                         (rule 18)
//  3. Times that are not offered are left out, or a time shows a dot for a
//     check that did not fail, or misses one that did.                       (rules 19-20)
//  4. The details do not name the reason, the person or the blocking event;
//     another organizer's event title shows to the viewer.                   (rule 21)
//  5. A setting link does not open the setting that controls the check.      (rule 21)
//  6. Inspecting changes what bookers are offered.                           (rule 22)
//  7. The switch is lost on reload.
import type { Page } from "@playwright/test";
import { addDays, diffDays, utcToLocal } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addHabit, addLink, book, claimPage, slot, titled, visitor, W } from "./helpers.ts";
import { addOrganizer, editLink, saveLink, teamOf } from "./link-helpers.ts";

const day = (n: number) => addDays(W, n);
const time = (p: Page, t: number) => p.locator(`[data-testid="inspector"] [data-start="${t}"]`);
const dots = async (p: Page, t: number) => {
  await expect(time(p, t)).toBeVisible();
  return time(p, t)
    .locator("[data-reason]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-reason")).sort());
};

test("the availability inspector shows organizers every time with a dot per failed check, explains each and links its setting; others never see it (availability rules 18-22)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  people,
  mail,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Board meeting", start: at(W, "10:00"), end: at(W, "11:00") });
  await colleague.cal.addEvent({
    title: "C private",
    start: at(W, "12:00"),
    end: at(W, "13:00"),
  });
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  await addHabit(page, {
    title: "Deep prep",
    ideal: "15:00",
    min: 60,
    max: 60,
    level: 2,
    days: ["Mon"],
    defense: "Always busy",
  });
  // Only week W: before it the blocker leaves no room and the habit is kept as a conflict.
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(local(titled(l, "Deep prep")[0]?.start ?? 0)).toBe(`${W} 15:00`),
  );
  await claimPage(page, "ivo");
  await addLink(page, { title: "Inspect me", durations: "30", level: 3, maxPerDay: 1 });
  const ed = await editLink(page, "Inspect me");
  // The last bookable day is W + 2.
  const today = utcToLocal(ZONE, Date.now()).date;
  await ed.getByLabel("Book up to (days ahead)").fill(String(diffDays(today, day(2))));
  await ed.getByLabel("Buffer before (minutes)").fill("15");
  await addOrganizer(page, colleague.email);
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/ivo/inspect-me");
  await book(v, at(day(1), "10:00"), "Lim", "lim@example.com");
  await v.goto(`/book/ivo/inspect-me?day=${W}`);
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(v.getByLabel("Inspect availability")).toHaveCount(0);
  const offeredBefore = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-start")));

  // A signed-in person who does not organize the link sees no switch.
  const other = await (await people(3)).signIn();
  await other.goto(`/book/ivo/inspect-me?day=${W}`);
  await expect(other.getByTestId("times")).toBeVisible();
  await expect(other.getByLabel("Inspect availability")).toHaveCount(0);

  await page.goto(`/book/ivo/inspect-me?day=${W}`);
  await page.getByLabel("Inspect availability").check();
  await expect(page.getByTestId("inspector")).toBeVisible();
  expect(await dots(page, at(W, "09:00"))).toEqual([]);
  await expect(time(page, at(W, "09:00"))).toHaveAttribute("data-offered", "1");
  expect(await dots(page, at(W, "10:00"))).toEqual(["conflict"]);
  expect(await dots(page, at(W, "11:00"))).toEqual(["buffer"]);
  expect(await dots(page, at(W, "12:00"))).toEqual(["conflict"]);
  expect(await dots(page, at(W, "15:00"))).toEqual(["higherPriority"]);
  expect(await dots(page, at(W, "16:45"))).toEqual(["outsideHours", "outsideHours"]);
  expect(await dots(page, at(day(1), "09:00"))).toEqual(["limitReached"]);
  await expect(time(page, at(W, "10:00"))).toHaveAttribute("data-offered", "0");

  // Details: reason, person, event title (own events only) and the setting link.
  await time(page, at(W, "10:00")).click();
  let details = page.getByTestId("inspect-details");
  await expect(details.locator('[data-reason="conflict"]')).toContainText("Board meeting");
  await expect(
    details.locator('[data-reason="conflict"]').getByRole("link", { name: "Open in the planner" }),
  ).toHaveAttribute("href", `/?week=${W}`);
  await time(page, at(W, "12:00")).click();
  details = page.getByTestId("inspect-details");
  await expect(
    details.locator(`[data-reason="conflict"][data-person="${colleague.email}"]`),
  ).toContainText("a busy event");
  await expect(details).not.toContainText("C private");
  await time(page, at(W, "16:45")).click();
  await expect(
    page
      .getByTestId("inspect-details")
      .locator('[data-reason="outsideHours"]')
      .first()
      .getByRole("link"),
  ).toHaveAttribute("href", "/settings");
  await time(page, at(W, "15:00")).click();
  details = page.getByTestId("inspect-details");
  await expect(details.locator('[data-reason="higherPriority"]')).toContainText("Deep prep");
  await details.getByRole("link", { name: "Change the link priority" }).click();
  await expect(page.getByTestId("link-editor")).toBeVisible();
  await expect(page.getByTestId("link-editor")).toContainText("Edit Inspect me");

  // Days after the range end are listed, with their reason; the switch survives a reload.
  await page.goto(`/book/ivo/inspect-me?day=${day(3)}&inspect=1`);
  await expect(page.getByLabel("Inspect availability")).toBeChecked();
  expect(await dots(page, at(day(3), "09:00"))).toEqual(["afterRangeEnd"]);

  // The co-organizer sees the switch and the title of their own event.
  await pc.goto(`/book/ivo/inspect-me?day=${W}&inspect=1`);
  await expect(pc.getByTestId("inspector")).toBeVisible();
  await time(pc, at(W, "12:00")).click();
  await expect(pc.getByTestId("inspect-details")).toContainText("C private");

  // Inspecting changed nothing for bookers.
  await v.reload();
  await expect(v.getByTestId("times")).toBeVisible();
  const offeredAfter = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-start")));
  expect(offeredAfter).toEqual(offeredBefore);
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  await expect(slot(v, at(W, "10:00"))).toHaveCount(0);
});
