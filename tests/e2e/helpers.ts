// Shared steps for E2E scenarios: they drive the real UI like a user would.
import type { Browser, Page } from "@playwright/test";
import type { ProviderEvent } from "../../src/server/providers/types.ts";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BASE_URL,
  type CalendarDriver,
  expect,
  local,
  managed,
  testWeek,
  visitorContexts,
  ZONE,
} from "./fixtures.ts";

export const MIN = 60_000;
export const W = testWeek();
export const windowFrom = () => Date.now() - 3_600_000;
export const windowTo = () => at(addDays(W, 21), "00:00");

export const titled = (events: ProviderEvent[], text: string) =>
  managed(events)
    .filter((e) => e.summary.includes(text))
    .sort((a, b) => a.start - b.start);

export const inHours = (t0: number, t1: number, from = "09:00", to = "17:00") => {
  const [d0, h0] = local(t0).split(" ");
  const [d1, h1] = local(t1).split(" ");
  return d0 === d1 && (h0 ?? "") >= from && (h1 ?? "") <= to;
};

export const allEvents = (cal: CalendarDriver) => cal.events(windowFrom(), windowTo());

/**
 * A change from another client: the live stream makes the open page read the
 * account again (lib/live.ts). Resolves after the page had a turn to draw the
 * answer that holds this change.
 */
export async function changeElsewhere(page: Page, breakMinutes: number): Promise<void> {
  const reread = page.waitForResponse(
    async (r) =>
      new URL(r.url()).pathname === "/api/me" &&
      r.request().method() === "GET" &&
      ((await r.json()) as { settings?: { breakMinutes?: number } }).settings?.breakMinutes ===
        breakMinutes,
  );
  const res = await page.request.patch("/api/settings", { data: { breakMinutes } });
  expect(res.status()).toBe(200);
  await reread;
  // The page sets the signal after it parsed the answer; the redraw follows in
  // the next frames.
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r)))),
  );
}

export interface TaskForm {
  title: string;
  minutes?: number;
  min?: number;
  max?: number;
  split?: boolean;
  /** "" clears the due date; undefined keeps the default. */
  due?: string;
  startAfter?: string;
  level?: 1 | 2 | 3 | 4;
  hours?: string;
  nextUp?: boolean;
  notes?: string;
  visibility?: "Calendar default" | "Private";
}

/** Fills and submits the task form. Dates are "YYYY-MM-DDTHH:MM" in the user's zone. */
export async function addTask(page: Page, t: TaskForm): Promise<void> {
  await page.getByRole("link", { name: "Tasks" }).click();
  const form = page.getByTestId("task-form");
  await form.getByLabel("Title").fill(t.title);
  if (t.minutes !== undefined) await form.getByLabel("Duration (minutes)").fill(String(t.minutes));
  if (t.due !== undefined) await form.getByLabel("Due").fill(t.due);
  if (t.startAfter) await form.getByLabel("Start after").fill(t.startAfter);
  if (t.level) await form.getByLabel("Priority").selectOption(String(t.level));
  if (t.hours) await form.getByLabel("Hours").selectOption({ label: t.hours });
  if (t.split === false) await form.getByLabel("Split into chunks").selectOption("no");
  if (t.min) await form.getByLabel("Shortest chunk").fill(String(t.min));
  if (t.max) await form.getByLabel("Longest chunk").fill(String(t.max));
  if (t.nextUp) await form.getByLabel(/Next up/).check();
  if (t.notes) await form.getByLabel("Notes").fill(t.notes);
  if (t.visibility) await form.getByLabel("Visibility").selectOption({ label: t.visibility });
  await expect(form.getByLabel("Title")).toHaveValue(t.title);
  // Wait for the save and for the plan run the form starts after it: callers
  // read the calendar next, so addTask returns only when the new task is
  // planned there. The list row alone can show up earlier, through a live update.
  const created = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/tasks",
    { timeout: 60_000 },
  );
  await form.getByRole("button", { name: "Add task" }).click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const planned = await page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/planner/sync",
    { timeout: 60_000 },
  );
  expect(planned.ok(), await planned.text()).toBe(true);
  await expect(page.locator(`[data-task-title="${t.title}"]`)).toBeVisible();
}

export interface HabitForm {
  title: string;
  ideal?: string;
  min?: number;
  max?: number;
  level?: 1 | 2 | 3 | 4;
  days?: ("Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun")[];
  defense?: "Free until time gets short" | "Always free" | "Always busy";
  noRoom?: "Keep and mark the conflict" | "Remove that day";
  starting?: string;
  skipWords?: string;
  notes?: string;
  hours?: string;
  /** Preview mode is on: the save is staged, so no habit row appears yet. */
  staged?: boolean;
}

export async function addHabit(page: Page, h: HabitForm): Promise<void> {
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill(h.title);
  if (h.ideal) await form.getByLabel("Ideal time").fill(h.ideal);
  if (h.min) await form.getByLabel("Shortest (minutes)").fill(String(h.min));
  if (h.max) await form.getByLabel("Longest (minutes)").fill(String(h.max));
  if (h.level) await form.getByLabel("Priority").selectOption(String(h.level));
  if (h.hours) await form.getByLabel("Hours").selectOption({ label: h.hours });
  if (h.defense) await form.getByLabel("Show as").selectOption({ label: h.defense });
  if (h.noRoom) await form.getByLabel("When there is no room").selectOption({ label: h.noRoom });
  if (h.starting) await form.getByLabel("Starting").fill(h.starting);
  if (h.skipWords) await form.getByLabel(/Skip days with events named/).fill(h.skipWords);
  if (h.notes) await form.getByLabel("Notes").fill(h.notes);
  for (const d of h.days ?? []) await form.getByLabel(d, { exact: true }).check();
  await form.getByRole("button", { name: "Add habit" }).click();
  if (h.staged) return;
  await expect(page.locator(`[data-habit-title="${h.title}"]`)).toBeVisible();
}

/** Opens the planner on week W. */
export async function openWeek(page: Page, monday = W): Promise<void> {
  await page.goto(`/?week=${monday}`);
  await expect(page.getByTestId("week-label")).toContainText(monday);
}

/** Opens the details panel of a managed event in the planner by title text. */
export async function openEvent(page: Page, text: string): Promise<void> {
  await page.locator(".ev", { hasText: text }).first().click();
  await expect(page.getByTestId("event-drawer")).toBeVisible();
}

// Booking links.

export async function claimPage(page: Page, slug: string) {
  await page.getByRole("link", { name: "Booking links" }).click();
  await page.getByTestId("claim-form").getByLabel("Page address").fill(slug);
  await page.getByRole("button", { name: "Create booking page" }).click();
  await expect(page.getByTestId("page-url")).toContainText(`/book/${slug}`);
}

export async function addLink(
  page: Page,
  l: { title: string; durations?: string; level?: number; maxPerDay?: number; hidden?: boolean },
) {
  await page.getByRole("link", { name: "Booking links" }).click();
  const form = page.getByTestId("link-form");
  await form.getByLabel("Title").fill(l.title);
  if (l.durations) await form.getByLabel(/Durations/).fill(l.durations);
  if (l.level) await form.getByLabel("Priority").selectOption(String(l.level));
  if (l.maxPerDay) await form.getByLabel("Most bookings per day").fill(String(l.maxPerDay));
  if (l.hidden) await form.getByLabel("Page", { exact: true }).selectOption("hidden");
  await form.getByRole("button", { name: "Add link" }).click();
  await expect(page.locator(`[data-link-title="${l.title}"]`)).toBeVisible();
}

/** A signed-out visitor in a separate browser context. */
export async function visitor(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ timezoneId: ZONE, locale: "en-GB", baseURL: BASE_URL });
  visitorContexts.push(ctx);
  return ctx.newPage();
}

export const slot = (p: Page, t: number) =>
  p.locator(`[data-testid="times"] button[data-start="${t}"]`);

export async function book(p: Page, t: number, name: string, email: string) {
  await slot(p, t).click();
  const form = p.getByTestId("book-form");
  await form.getByLabel("Your name").fill(name);
  await form.getByLabel("Your email").fill(email);
  await form.getByRole("button", { name: "Book" }).click();
  await expect(p.getByTestId("booked")).toBeVisible();
}
