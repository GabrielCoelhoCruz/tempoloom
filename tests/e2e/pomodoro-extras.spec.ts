// Pomodoro extras: background audio during work sessions and the mini
// window (docs/specs/tools-pomodoro-timer.md rules 13, 14).
//
// Ways it can fail, and the check that catches each:
// - the track plays in breaks, or not at all in work sessions   -> running sources, status
// - the chosen track is not the one that plays                  -> status names the track
// - pausing the session leaves the track playing                -> running sources 0
// - the audio settings are lost on reload                       -> checkbox, select after reload
// - the mini window shows another time than the timer           -> mini text equals timer
// - the mini window does not follow the running timer           -> mini text after time passes
// - Pause in the mini window does not pause the timer           -> main shows Start
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/** Counts audio buffer sources that play now (started and not stopped). */
async function watchSources(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __playing: number };
    w.__playing = 0;
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (this: AudioContext) {
      const src = create.call(this);
      const start = src.start.bind(src);
      const stop = src.stop.bind(src);
      let on = false;
      src.start = (...a: Parameters<AudioBufferSourceNode["start"]>) => {
        if (!on) w.__playing++;
        on = true;
        start(...a);
      };
      src.stop = (when?: number) => {
        if (on) w.__playing--;
        on = false;
        stop(when);
      };
      return src;
    };
  });
}
const playing = (page: Page) =>
  page.evaluate(() => (window as unknown as { __playing: number }).__playing);

test("background audio plays the chosen track during work sessions only (rule 14)", async ({
  page,
}) => {
  await watchSources(page);
  await page.clock.install({ time: new Date("2026-11-09T09:00:00") });
  await page.goto("/tools/pomodoro");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("timer-settings");
  await settings.getByLabel("Background audio in work sessions").check();
  await settings.getByLabel("Track").selectOption({ label: "Brown noise" });
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("bg-audio")).toHaveText("Playing: Brown noise");
  await expect.poll(() => playing(page)).toBe(1);

  await page.getByRole("button", { name: "Pause" }).click();
  await expect.poll(() => playing(page)).toBe(0);
  await expect(page.getByTestId("bg-audio")).toHaveCount(0);
  await page.getByRole("button", { name: "Start" }).click();
  await expect.poll(() => playing(page)).toBe(1);

  await page.clock.fastForward("25:01");
  await expect(page.getByRole("tab", { name: "Short break" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(() => playing(page)).toBe(0);
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("02:00");
  expect(await playing(page)).toBe(0);
  await expect(page.getByTestId("bg-audio")).toHaveCount(0);

  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(settings.getByLabel("Background audio in work sessions")).toBeChecked();
  await expect(settings.getByLabel("Track")).toHaveValue("brown");
});

test("the mini window shows the running timer and controls it (rule 13)", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-09T09:00:00") });
  await page.goto("/tools/pomodoro");
  const [mini] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("button", { name: "Mini window" }).click(),
  ]);
  const miniTimer = mini.getByTestId("mini-timer");
  await expect(miniTimer).toHaveText("25:00");
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("10:00");
  await expect(page.getByTestId("timer")).toHaveText("15 00");
  await expect(miniTimer).toHaveText("15:00");
  await expect(mini.getByTestId("mini-phase")).toHaveText("Work session");
  await mini.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(page.getByTestId("timer")).toHaveText("15 00");
  await expect(miniTimer).toHaveText("15:00");
  await mini.close();
  await expect(page.getByRole("button", { name: "Mini window" })).toBeVisible();
});
