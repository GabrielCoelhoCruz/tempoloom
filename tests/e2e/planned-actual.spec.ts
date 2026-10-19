// Planned versus actual time on the stats page
// (docs/specs/analytics-personal-stats.md rule 16). The server clock is set
// (TEST_CLOCK_START), so a day can begin and end inside the test.
//
// Ways this can fail, each covered below:
// - planned time counts work added after the day began;
// - actual time misses what stayed on the calendar;
// - a day that has not ended counts;
// - the panel loses the range on reload.
import type { Page } from "@playwright/test";
import { addDays, localToUtc } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";

const day = (n: number) => addDays(W, n);
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};

async function statsFor(page: Page, date: string) {
  await page.goto(`/stats?from=${date}&to=${date}`);
  return page.getByTestId("planned-actual");
}

test("planned time is the calendar when the day began and actual time is what stayed; only ended days count", async ({
  page,
  cal,
  app,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  // Before Monday W begins: a habit at 16:00 on Mondays.
  await addHabit(page, { title: "Inbox", ideal: "16:00", min: 30, max: 30, days: ["Mon"] });
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(titled(l, "Inbox").map((e) => local(e.start))).toEqual([`${W} 16:00`]),
  );

  // Monday W, 12:00: the day has begun. A new task lands that afternoon.
  app.env.TEST_CLOCK_START = iso(W, "12:00");
  await app.restart();
  await addTask(page, { title: "Report", minutes: 60, split: false, due: "" });
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => {
      const report = titled(l, "Report");
      expect(report).toHaveLength(1);
      expect(local(report[0]?.start ?? 0) >= `${W} 12:00`).toBe(true);
    },
  );
  // Time logged by hand on another task is a past event of that task (rule 15).
  await addTask(page, { title: "Notes", minutes: 60, split: false, due: "" });
  await page.getByRole("link", { name: "Tasks" }).click();
  const notes = page.locator('[data-task-title="Notes"]');
  await notes.getByRole("button", { name: "Start timer" }).click();
  await notes.getByRole("button", { name: "Stop" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop timer" });
  await dialog.getByLabel("Minutes").fill("25");
  await dialog.getByRole("button", { name: "Log time" }).click();
  await expect(dialog).toBeHidden();
  // The rest of Notes (35 min) is placed on Monday afternoon too.
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) =>
      expect(
        titled(l, "Notes")
          .map((e) => (e.end - e.start) / 60_000)
          .sort(),
      ).toEqual([25, 35]),
  );
  // The day has not ended: nothing counts yet.
  await expect(await statsFor(page, W)).toContainText("No day of this range has ended yet.");

  // Tuesday 08:00: Monday has ended.
  app.env.TEST_CLOCK_START = iso(day(1), "08:00");
  await app.restart();
  const check = async (panel: ReturnType<Page["getByTestId"]>) => {
    await expect(panel).toContainText("Over 1 ended day.");
    await expect(panel.locator(".row", { hasText: "Habits" })).toContainText(
      "planned 30 min · actual 30 min",
    );
    // The tasks came after the day began: not planned, but they stayed, with the logged time.
    await expect(panel.locator(".row", { hasText: "Tasks" })).toContainText(
      "planned 0 min · actual 2 h",
    );
  };
  await check(await statsFor(page, W));
  await page.reload();
  await check(page.getByTestId("planned-actual"));
});
