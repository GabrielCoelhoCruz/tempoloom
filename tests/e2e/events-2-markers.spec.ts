// Title marker settings (docs/specs/events-title-emoji.md, settings and rules 1, 5, 7).
//
// Ways this can fail, each covered below:
// - the chosen markers are not saved, or a reload shows the defaults again;
// - the position "after the title" is ignored, or a state change (lock) puts
//   the marker back in front;
// - the planner shows the calendar marker in its own titles;
// - an empty marker field comes back with its default after a reload;
// - moving the position back does not rewrite titles that exist.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, blockUntil, type CalendarDriver, eventually, expect, test } from "./fixtures.ts";
import { addHabit, openEvent, openWeek, titled, W } from "./helpers.ts";

const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
const lunches = async (cal: CalendarDriver) =>
  titled(await week(cal), "Lunch").map((e) => e.summary);

async function saveMarkers(page: Page, fields: Record<string, string>, position?: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("marker-form");
  for (const [label, value] of Object.entries(fields))
    await form.getByLabel(label, { exact: true }).fill(value);
  if (position) await form.getByLabel("Marker position").selectOption({ label: position });
  await form.getByRole("button", { name: "Save markers" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}

test("chosen markers after the title replace the defaults on new and changed events; the planner shows plain titles; back before the title rewrites them (settings; rules 1, 5, 7)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await saveMarkers(page, { Free: "🆓", Locked: "🔐", Busy: "" }, "After the title");
  await page.reload();
  const form = page.getByTestId("marker-form");
  await expect(form.getByLabel("Free", { exact: true })).toHaveValue("🆓");
  await expect(form.getByLabel("Locked", { exact: true })).toHaveValue("🔐");
  await expect(form.getByLabel("Busy", { exact: true })).toHaveValue("");
  await expect(form.getByLabel("Marker position")).toHaveValue("end");

  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  await eventually(
    () => lunches(cal),
    (l) => expect(l).toEqual(Array(5).fill("Lunch 🆓")),
  );
  await openWeek(page);
  await expect(page.locator(".ev", { hasText: "Lunch" }).first()).toHaveAttribute("title", "Lunch");
  await openEvent(page, "Lunch");
  await page.getByTestId("event-drawer").getByRole("button", { name: "Lock" }).click();
  await eventually(
    () => lunches(cal),
    (l) => expect(l).toEqual(["Lunch 🔐", ...Array(4).fill("Lunch 🆓")]),
  );
  await page.reload();
  await expect(page.locator(".ev", { hasText: "Lunch" }).first()).toHaveAttribute("title", "Lunch");

  // Back to the start: the events that exist get new titles.
  await saveMarkers(page, {}, "Before the title");
  await eventually(
    () => lunches(cal),
    (l) => expect(l).toEqual(["🔐 Lunch", ...Array(4).fill("🆓 Lunch")]),
  );
  await page.reload();
  await expect(page.getByTestId("marker-form").getByLabel("Marker position")).toHaveValue("start");
});
