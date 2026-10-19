// Steps shared by the task, timer, hours and travel scenarios.
import type { Page } from "@playwright/test";
import { expect } from "./fixtures.ts";

/** A custom hours set that covers every day, 00:00 to 23:59, so tests can work near now. */
export async function alwaysHours(page: Page, name = "AT-Always"): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("New hours set name").fill(name);
  await page.getByRole("button", { name: "+ Custom hours" }).click();
  const set = page.getByTestId("hours-custom").filter({ hasText: name });
  for (let d = 1; d <= 7; d++) {
    const range = set.getByTestId(`range-custom-${d}-0`);
    if ((await range.count()) === 0)
      await set
        .locator(".hours-day")
        .nth(d - 1)
        .getByRole("button", { name: "+", exact: true })
        .click();
    await range.locator("input").first().fill("00:00");
    await range.locator("input").last().fill("23:59");
  }
  await set.getByRole("button", { name: `Save ${name.toLowerCase()}` }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}

/** Selects a value in Settings and waits for the save. */
export async function chooseSetting(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel(label).selectOption({ label: option });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}
