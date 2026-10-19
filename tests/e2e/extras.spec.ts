// External event priority for booking links, and travel and airport buffers.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test } from "./fixtures.ts";
import { openWeek, titled, visitor, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);

const slot = (p: Page, t: number) => p.locator(`[data-testid="times"] button[data-start="${t}"]`);

test("a lowered external event is offered only by higher-priority booking links (events-external-priority rules 1-5, 9)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Team standup", start: at(W, "09:00"), end: at(W, "10:00") });
  await signIn();
  await page.getByRole("link", { name: "Booking links" }).click();
  await page.getByTestId("claim-form").getByLabel("Page address").fill("hana");
  await page.getByRole("button", { name: "Create booking page" }).click();
  await expect(page.getByTestId("link-row")).toHaveCount(3);
  const v = await visitor(browser);
  await v.goto("/book/hana/important-meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);

  await openWeek(page);
  await page.locator(".ev-external", { hasText: "Team standup" }).click();
  const form = page.getByTestId("external-priority");
  await form.getByLabel("Priority for booking links").selectOption("3");
  await form.getByRole("button", { name: "Save priority" }).click();

  await v.goto("/book/hana/important-meeting");
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  await v.goto("/book/hana/meeting");
  await expect(slot(v, at(W, "09:00"))).toBeVisible();
  await v.goto("/book/hana/quick-meeting");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);
  // The event itself is never moved; the stored priority survives a reload.
  const standup = (await cal.events(at(W, "00:00"), at(day(1), "00:00"))).find(
    (e) => e.summary === "Team standup",
  );
  expect(standup && local(standup.start)).toBe(`${W} 09:00`);
  await page.reload();
  await page.locator(".ev-external", { hasText: "Team standup" }).click();
  await expect(
    page.getByTestId("external-priority").getByLabel("Priority for booking links"),
  ).toHaveValue("3");
});

test("travel time wraps events at an address; flights get airport time instead (buffers-travel rules 1-6)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  const wed = day(2);
  await cal.addEvent({
    title: "Client visit",
    start: at(tue, "14:00"),
    end: at(tue, "15:00"),
    location: "1 Oak Ave, Springfield, IL 62701",
  });
  await cal.addEvent({
    title: "Coffee",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    location: "Main St, Springfield",
  });
  await cal.addEvent({
    title: "Flight LH 1234",
    start: at(wed, "10:00"),
    end: at(wed, "12:00"),
    location: "FRA, Terminal 1, Gate A12",
  });
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await page.getByRole("button", { name: /Add airport time/ }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Airport");
  const evs = await eventually(
    () => cal.events(at(W, "00:00"), at(day(7), "00:00")),
    (l) => {
      expect(titled(l, "Travel")).toHaveLength(2);
      expect(titled(l, "Airport")).toHaveLength(2);
    },
  );
  expect(titled(evs, "Travel").map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)).toEqual([
    `${tue} 13:30-14:00`,
    `${tue} 15:00-15:30`,
  ]);
  expect(titled(evs, "Airport").map((e) => `${local(e.start)}-${local(e.end).slice(11)}`)).toEqual([
    `${wed} 08:00-10:00`,
    `${wed} 12:00-13:00`,
  ]);
});
