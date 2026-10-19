// Steps for the automation list, the shared automation form and the event
// data checks (docs/specs/automations-overview.md, planning-notifications.md).
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.ts";
import { credentials } from "./ics.ts";

/** The iCalendar text of one event on Radicale, with folded lines joined. */
export async function rawEvent(url: string): Promise<string> {
  const object = url.replace(/#.*$/, "");
  const res = await fetch(object, { headers: { authorization: credentials(object) } });
  if (!res.ok) throw new Error(`GET ${object}: ${res.status}`);
  return (await res.text()).replace(/\r?\n[ \t]/g, "");
}

/** The VEVENT part of an object, without its alarms. */
const eventPart = (ics: string) =>
  ics
    .slice(ics.indexOf("BEGIN:VEVENT"), ics.indexOf("END:VEVENT"))
    .replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r?\n?/g, "");

/** The value of one property of the event (not of an alarm), or null. */
export function eventProp(ics: string, name: string): string | null {
  const line = eventPart(ics)
    .split(/\r?\n/)
    .find((l) => l.toUpperCase().startsWith(`${name.toUpperCase()}:`));
  return line ? line.slice(name.length + 1) : null;
}

/** The triggers of the event's alarms, for example ["-PT10M"]. */
export function alarms(ics: string): string[] {
  return [...ics.matchAll(/BEGIN:VALARM([\s\S]*?)END:VALARM/g)].map(
    (m) => /TRIGGER[^:]*:(.*)/.exec(m[1] ?? "")?.[1]?.trim() ?? "",
  );
}

export async function openAutomations(page: Page): Promise<void> {
  await page.getByRole("link", { name: "Automations" }).click();
  await expect(page.getByTestId("automations-page")).toBeVisible();
}

export const group = (page: Page, level: 1 | 2 | 3 | 4) =>
  page.locator(`[data-testid="automation-group"][data-level="${level}"]`);

export const automation = (page: Page, name: string) =>
  page.locator(`[data-testid="automation"][data-name="${name}"]`);

/** Names of the automations shown in a part of the page, in order. */
export const names = (where: Locator) =>
  where
    .locator('[data-testid="automation"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-name")));

/** Opens the shared form from the top-bar create button (automations-overview rule 1). */
export async function create(page: Page, kind: "Focus time" | "Buffer"): Promise<Locator> {
  const menu = page.getByTestId("create-menu");
  await menu.locator("summary").click();
  await menu.getByRole("link", { name: kind, exact: true }).click();
  const form = page.getByTestId("automation-form");
  await expect(form).toBeVisible();
  return form;
}

/** Opens the shared form of an automation from the automation list. */
export async function edit(page: Page, name: string): Promise<Locator> {
  await openAutomations(page);
  await automation(page, name).getByRole("link", { name: "Edit" }).click();
  const form = page.getByTestId("automation-form");
  await expect(form).toBeVisible();
  return form;
}

/** Saves the shared form; the automation list opens. */
export async function save(form: Locator): Promise<void> {
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form.page().getByTestId("automations-page")).toBeVisible();
}

export interface EventSettingsForm {
  emoji?: string;
  category?: "Work" | "Personal";
  /** "Category color", "Calendar color" or a color name such as "Tomato". */
  color?: string;
  visibility?: "Calendar default" | "Public" | "Private";
  /** A number is custom minutes before the start. */
  reminders?: "Calendar default" | "None" | number;
  calendar?: string;
  location?: string;
  description?: string;
}

/** Fills the event settings part of the habit form or the shared form. */
export async function fillEventSettings(form: Locator, s: EventSettingsForm): Promise<void> {
  if (s.emoji !== undefined) await form.getByLabel("Emoji").fill(s.emoji);
  if (s.category) await form.getByLabel("Category").selectOption({ label: s.category });
  if (s.color) await form.getByLabel("Color").selectOption({ label: s.color });
  if (s.visibility) await form.getByLabel("Visibility").selectOption({ label: s.visibility });
  if (typeof s.reminders === "number") {
    await form.getByLabel("Reminders").selectOption({ label: "Custom" });
    await form.getByLabel("Remind me (minutes)").fill(String(s.reminders));
  } else if (s.reminders) {
    await form.getByLabel("Reminders").selectOption({ label: s.reminders });
  }
  if (s.calendar)
    await form.getByLabel("Calendar", { exact: true }).selectOption({ label: s.calendar });
  if (s.location !== undefined) await form.getByLabel("Location").fill(s.location);
  if (s.description !== undefined) await form.getByLabel("Description").fill(s.description);
}
