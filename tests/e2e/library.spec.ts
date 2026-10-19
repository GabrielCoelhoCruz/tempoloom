// The automation library (docs/specs/automations-library.md).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const entry = (page: Page, name: string) => page.locator(`[data-entry="${name}"]`);

async function saveForm(page: Page) {
  await page.getByTestId("automation-form").getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("automations-page")).toBeVisible();
}

async function openLibrary(page: Page) {
  await page.getByRole("link", { name: "Library" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
}

test("a habit entry fills the habit form; saving places it and shows Added; a second use gets a suffix; delete clears the badge (rules 3-5, 9; T1, T4)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openLibrary(page);
  await page.getByRole("tab", { name: "Habits" }).click();
  await expect(page.getByTestId("library-entry")).toHaveCount(10);

  // A personal-hours entry fills hours and days too.
  await entry(page, "Exercise").getByRole("button", { name: "Use" }).click();
  const form = page.getByTestId("habit-form");
  await expect(form.getByLabel("Title")).toHaveValue("Exercise");
  await expect(form.getByLabel("Hours")).toHaveValue(
    (await form
      .getByLabel("Hours")
      .locator("option", { hasText: "Personal hours" })
      .getAttribute("value")) ?? "",
  );
  const checked = form.locator('input[name="days"]:checked');
  await expect(checked).toHaveCount(3);

  await openLibrary(page);
  await entry(page, "Lunch").getByRole("button", { name: "Use" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("Lunch");
  await expect(form.getByLabel("Ideal time")).toHaveValue("12:00");
  await expect(form.getByLabel("Shortest (minutes)")).toHaveValue("60");
  await expect(form.getByLabel("Longest (minutes)")).toHaveValue("60");
  await form.getByRole("button", { name: "Add habit" }).click();
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Lunch").map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)).toEqual(
        [0, 1, 2, 3, 4].map((d) => `${day(d)} 12:00-13:00`),
      ),
  );

  await openLibrary(page);
  await expect(entry(page, "Lunch")).toContainText("Added");
  await expect(entry(page, "Daily walk")).not.toContainText("Added");
  await page.reload();
  await expect(entry(page, "Lunch")).toContainText("Added");
  await entry(page, "Lunch").getByRole("button", { name: "Use" }).click();
  await expect(form.getByLabel("Title")).toHaveValue("Lunch 2");

  await page.locator('[data-habit-title="Lunch"]').getByRole("button", { name: "Delete" }).click();
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch")).toHaveLength(0),
  );
  await openLibrary(page);
  await expect(entry(page, "Lunch")).not.toContainText("Added");
});

test("buffer and focus entries add their automation as set; prompts offer no action (rule 4, entries 3, 21, 25)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Interview with Bo",
    start: at(day(1), "15:00"),
    end: at(day(1), "15:30"),
    attendees: ["bo@example.com"],
  });
  await signIn();
  await openLibrary(page);
  // The entry opens the shared automation form with its preset; saving adds it.
  await entry(page, "Prep before interviews").getByRole("button", { name: "Use" }).click();
  await saveForm(page);
  await openLibrary(page);
  await expect(entry(page, "Prep before interviews")).toContainText("Added");
  await eventually(
    () => week(cal),
    (l) =>
      expect(
        titled(l, "Prep before interviews").map(
          (e) => `${local(e.start)}-${local(e.end).slice(11)}`,
        ),
      ).toEqual([`${day(1)} 14:45-15:00`]),
  );

  await page.getByRole("tab", { name: "Focus time" }).click();
  await entry(page, "Deep work protection").getByRole("button", { name: "Use" }).click();
  await saveForm(page);
  await openLibrary(page);
  await expect(entry(page, "Deep work protection")).toContainText("Added");
  await eventually(
    () => week(cal),
    (l) => {
      const blocks = titled(l, "Deep work protection");
      const minutes = blocks.map((e) => (e.end - e.start) / 60_000);
      expect(minutes.reduce((a, m) => a + m, 0)).toBe(600);
      expect(Math.min(...minutes)).toBeGreaterThanOrEqual(120);
    },
  );

  await page.getByRole("tab", { name: "Prompts" }).click();
  const plan = entry(page, "Plan my day");
  await expect(plan).toContainText("Needs the assistant chat");
  await expect(plan.getByRole("button")).toHaveCount(0);
  await page.reload();
  await expect(entry(page, "Prep before interviews")).toContainText("Added");
  await expect(entry(page, "Deep work protection")).toContainText("Added");
});
