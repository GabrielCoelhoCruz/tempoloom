// Event categories and colors (docs/specs/events-categories-and-colors.md).
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addTask, openWeek, titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "Color E2E reads the CalDAV COLOR property.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const named = (l: Awaited<ReturnType<typeof week>>, title: string) =>
  l.find((e) => e.summary === title);

async function saveColors(page: Page, change: Record<string, string>) {
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("color-form");
  for (const [label, value] of Object.entries(change))
    await form.getByLabel(label, { exact: true }).selectOption({ label: value });
  await form.getByRole("button", { name: "Save colors" }).click();
}

test("managed events take their category color, a new color repaints them, and external events change color only for the scope all events (rules 1, 4, 6-8, 11)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const client = await cal.addEvent({
    title: "Client call",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
    attendees: ["x@other.com"],
  });
  await cal.addEvent({
    title: "1:1 Ana",
    start: at(day(1), "11:00"),
    end: at(day(1), "11:30"),
    attendees: ["ana@tempoloom.test"],
  });
  await signIn();
  await addTask(page, { title: "AT-Color", minutes: 60, split: false, due: "" });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Color")[0]?.colorId).toBe("2"),
  );
  expect(named(await week(cal), "Client call")?.colorId).toBeNull();

  await saveColors(page, { "Solo work": "Tomato" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "AT-Color")[0]?.colorId).toBe("11"),
  );
  expect(named(await week(cal), "Client call")?.colorId).toBeNull();

  await saveColors(page, { Paint: "All events on my calendars" });
  const painted = await eventually(
    () => week(cal),
    (l) => {
      expect(named(l, "Client call")?.colorId).toBe("11");
      expect(named(l, "1:1 Ana")?.colorId).toBe("7");
    },
  );
  // Only the color changed.
  const call = named(painted, "Client call");
  expect([local(call?.start ?? 0), local(call?.end ?? 0)]).toEqual([
    `${day(1)} 10:00`,
    `${day(1)} 10:30`,
  ]);
  expect((await cal.guests(client)).map((g) => g.email)).toEqual([
    "e2e@tempoloom.test",
    "x@other.com",
  ]);

  // A category the user sets wins, and its color follows.
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "1:1 Ana" }).click();
  await page.getByTestId("event-category").selectOption({ label: "Personal" });
  await eventually(
    () => week(cal),
    (l) => expect(named(l, "1:1 Ana")?.colorId).toBe("3"),
  );
  await page.reload();
  await page.locator(".ev-external", { hasText: "1:1 Ana" }).click();
  await expect(page.getByTestId("event-drawer")).toContainText("Personal");
  await expect(page.getByTestId("event-category")).toHaveValue("personal");

  // At most two scope changes a minute.
  await saveColors(page, { Paint: "Only events Tempoloom manages" });
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await saveColors(page, { Paint: "All events on my calendars" });
  await expect(page.getByTestId("settings-message")).toHaveText(
    "Wait a minute before you change the scope again.",
  );
});

test("a buffer for external meetings adds prep before a meeting with another domain only (rule 14; library entry 13)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Client call",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
    attendees: ["x@other.com"],
  });
  await cal.addEvent({
    title: "Team sync",
    start: at(day(1), "14:00"),
    end: at(day(1), "14:30"),
    attendees: ["ana@tempoloom.test", "bo@tempoloom.test"],
  });
  await signIn();
  await page.getByRole("link", { name: "Library" }).click();
  await page.getByRole("tab", { name: "Buffers" }).click();
  const entry = page.locator('[data-entry="Prep before customer meetings"]');
  await entry.getByRole("button", { name: "Add" }).click();
  await expect(entry).toContainText("Added");
  await eventually(
    () => week(cal),
    (l) =>
      expect(
        titled(l, "Prep before customer meetings").map(
          (e) => `${local(e.start)}-${local(e.end).slice(11)}`,
        ),
      ).toEqual([`${day(1)} 09:45-10:00`]),
  );
});
