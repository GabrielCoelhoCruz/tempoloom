// Hours sets: delete with a replacement, item-specific hours, the hours
// preview in item editors, and the first-run review
// (docs/specs/planning-hours.md HRS-10, HRS-11, HRS-15, item-specific hours, AT-H4, AT-H6).
//
// Ways it can fail, and the check that catches each:
// - a set in use is deleted without a replacement, or items keep it   -> dialog; event moves
// - the replacement is not applied to the item's events               -> Radicale in 09:00-17:00
// - a deleted set comes back, or stays in item menus                  -> reload; task menu
// - tasks are offered item-specific hours                             -> task menu options
// - a habit's own hours are ignored                                   -> Radicale 07:00 Tue/Thu
// - another item can pick a habit's own hours                         -> task menu, hours page
// - the preview shows stale ranges, or no way to the hours page       -> preview text, link
// - the first-run review never shows, or shows again after it is done -> banner, reload, restart
// - a change made in the review does not move events                  -> Radicale 10:00
import type { Page } from "@playwright/test";
import { weekdayOf } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { addTask, allEvents, inHours, titled, W } from "./helpers.ts";

async function newSet(page: Page, name: string, from: string, to: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("New hours set name").fill(name);
  await page.getByRole("button", { name: "+ Custom hours" }).click();
  const set = page.getByTestId("hours-custom").filter({ hasText: name });
  for (const d of [1, 2, 3, 4, 5]) {
    await set.getByTestId(`range-custom-${d}-0`).locator("input").first().fill(from);
    await set.getByTestId(`range-custom-${d}-0`).locator("input").last().fill(to);
  }
  await set.getByRole("button", { name: `Save ${name.toLowerCase()}` }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}

test("deleting a custom set in use asks for a replacement and moves its items there (HRS-10, AT-H4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await newSet(page, "AT-Evening", "19:00", "21:00");
  await newSet(page, "AT-Unused", "08:00", "09:00");
  await addTask(page, { title: "AT-H3", minutes: 60, split: false, due: "", hours: "AT-Evening" });
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(titled(l, "AT-H3")).toHaveLength(1),
  );
  const [first] = titled(evs, "AT-H3");
  expect(inHours(first?.start ?? 0, first?.end ?? 0, "19:00", "21:00")).toBe(true);

  await page.getByRole("link", { name: "Settings" }).click();
  // A set no item uses goes after a plain confirmation.
  await page
    .getByTestId("hours-custom")
    .filter({ hasText: "AT-Unused" })
    .getByRole("button", { name: "Delete AT-Unused" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("No items use AT-Unused");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("hours-custom").filter({ hasText: "AT-Unused" })).toHaveCount(0);

  await page
    .getByTestId("hours-custom")
    .filter({ hasText: "AT-Evening" })
    .getByRole("button", { name: "Delete AT-Evening" })
    .click();
  await expect(dialog).toContainText("1 item uses AT-Evening");
  await dialog.getByLabel("Move them to").selectOption({ label: "Work hours" });
  await dialog.getByRole("button", { name: "Delete and move" }).click();
  await expect(page.getByTestId("hours-custom")).toHaveCount(0);
  await eventually(
    () => allEvents(cal),
    (l) => {
      const [e] = titled(l, "AT-H3");
      expect(inHours(e?.start ?? 0, e?.end ?? 0, "09:00", "17:00")).toBe(true);
    },
  );
  await page.reload();
  await expect(page.getByTestId("hours-custom")).toHaveCount(0);
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(
    page.getByTestId("task-form").getByLabel("Hours").locator("option", { hasText: "AT-Evening" }),
  ).toHaveCount(0);
});

test("a habit can use item-specific hours that tasks and other items cannot pick (item-specific hours, AT-H6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("AT-Run");
  await form.getByLabel("Hours").selectOption({ label: "Item-specific hours" });
  const own = form.getByTestId("item-hours");
  await own.getByLabel("Tue").check();
  await own.getByLabel("Thu").check();
  await own.getByLabel("From").fill("07:00");
  await own.getByLabel("To").fill("08:00");
  await form.getByLabel("Ideal time").fill("07:00");
  await form.getByLabel("Shortest (minutes)").fill("30");
  await form.getByLabel("Longest (minutes)").fill("30");
  await form.getByRole("button", { name: "Add habit" }).click();
  const row = page.locator('[data-habit-title="AT-Run"]');
  await expect(row).toContainText("Item-specific hours");

  const evs = await eventually(
    () => allEvents(cal),
    (l) =>
      expect(titled(l, "AT-Run").filter((e) => e.start >= at(W, "00:00")).length).toBeGreaterThan(
        1,
      ),
  );
  for (const e of titled(evs, "AT-Run").filter((x) => x.start >= at(W, "00:00"))) {
    const [date = "", time] = local(e.start).split(" ");
    expect(time).toBe("07:00");
    expect([2, 4]).toContain(weekdayOf(date));
  }

  await page.getByRole("link", { name: "Tasks" }).click();
  const taskHours = page.getByTestId("task-form").getByLabel("Hours");
  await expect(taskHours.locator("option", { hasText: "Item-specific" })).toHaveCount(0);
  await expect(taskHours.locator("option")).toHaveCount(3);
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByTestId("hours-custom")).toHaveCount(0);
  await page.reload();
  await page.getByRole("link", { name: "Habits" }).click();
  await expect(page.locator('[data-habit-title="AT-Run"]')).toContainText(
    "Item-specific hours: Tue, Thu 07:00–08:00",
  );
});

test("the hours menu of an item editor previews the chosen hours and links to the hours page (HRS-11)", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.getByRole("link", { name: "Tasks" }).click();
  const form = page.getByTestId("task-form");
  await form.getByLabel("Hours").selectOption({ label: "Personal hours" });
  await form.getByRole("button", { name: "Preview hours" }).click();
  const preview = form.getByTestId("hours-preview");
  await expect(preview).toContainText("Mon 17:00–21:00");
  await expect(preview).toContainText("Sat 09:00–21:00");

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByTestId("range-personal-1-0").locator("input").first().fill("18:00");
  await page.getByRole("button", { name: "Save personal hours" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  await page.getByRole("link", { name: "Habits" }).click();
  const habit = page.getByTestId("habit-form");
  await habit.getByLabel("Hours").selectOption({ label: "Personal hours" });
  await habit.getByRole("button", { name: "Preview hours" }).click();
  await expect(habit.getByTestId("hours-preview")).toContainText("Mon 18:00–21:00");
  await page.reload();
  await page.getByTestId("habit-form").getByRole("button", { name: "Preview hours" }).click();
  // Work hours is the default choice.
  await expect(page.getByTestId("habit-form").getByTestId("hours-preview")).toContainText(
    "Mon 09:00–17:00",
  );
  await page.getByTestId("hours-preview").getByRole("link", { name: "Edit hours" }).click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(page.getByTestId("hours-work")).toBeInViewport();
});

test("a new user is asked once to review work, meeting and personal hours, and a change there moves events (HRS-15)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const banner = page.getByTestId("hours-review-banner");
  await expect(banner).toBeVisible();
  await addTask(page, { title: "AT-Review", minutes: 60, split: false, due: "" });
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Review")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await page.getByRole("link", { name: "Planner" }).click();
  await banner.getByRole("button", { name: "Review hours" }).click();
  const dialog = page.getByRole("dialog", { name: "Review your hours" });
  await expect(dialog.getByTestId("hours-work")).toBeVisible();
  await expect(dialog.getByTestId("hours-meeting")).toBeVisible();
  await expect(dialog.getByTestId("hours-personal")).toBeVisible();
  await dialog.getByTestId("range-work-1-0").locator("input").first().fill("10:00");
  await dialog.getByRole("button", { name: "Save work hours" }).click();
  await expect(dialog.getByTestId("review-message")).toHaveText("Saved");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(banner).toBeHidden();
  await eventually(
    () => allEvents(cal),
    (l) => expect(local(titled(l, "AT-Review")[0]?.start ?? 0)).toBe(`${W} 10:00`),
  );
  await page.reload();
  await expect(page.getByTestId("planner")).toBeVisible();
  await expect(banner).toBeHidden();
  await app.restart();
  await page.reload();
  await expect(page.getByTestId("planner")).toBeVisible();
  await expect(banner).toBeHidden();
});
