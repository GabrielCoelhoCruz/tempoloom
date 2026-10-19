// Pomodoro timer: reset, the alarm sound choice and the stats view
// (docs/specs/tools-pomodoro-timer.md rules 1, 3, 7, 8, 9, 17, 18; T3).
// The timer keeps its data in the browser and changes no calendar event.
//
// Ways this can fail, each covered below:
// - the chosen alarm is not the one that plays, or a sound plays while sound is off;
// - Reset leaves the timer running, keeps the time left, or counts the session as done;
// - the stats miss a figure of rule 17, or count a reset session as completed;
// - the streak, week and month do not carry over to the next day;
// - the chart does not group by day and by week;
// - the sound choice and the stats are lost on reload.
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/** Records the frequency of every tone the page starts. */
async function watchTones(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __tones: number[] };
    w.__tones = [];
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      const osc = create.call(this);
      const start = osc.start.bind(osc);
      osc.start = (when?: number) => {
        w.__tones.push(osc.frequency.value);
        start(when);
      };
      return osc;
    };
  });
}
const tones = (page: Page) =>
  page.evaluate(() => (window as unknown as { __tones: number[] }).__tones);

test("the pomodoro timer plays the chosen alarm, resets a running session without counting it, and shows the stats view with streak, completion rate and a chart (rules 7, 9, 17; T3)", async ({
  page,
  app,
  cal,
}) => {
  await watchTones(page);
  await page.clock.install({ time: new Date("2026-11-09T09:00:00") });
  await page.goto(`${app.baseUrl}/tools/pomodoro`);
  const timer = page.getByTestId("timer");
  await page.getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("timer-settings");
  await settings.getByLabel("Work session (minutes)").fill("15");
  await expect(settings.getByLabel("Alarm sound")).toHaveValue("bell");
  await settings.getByLabel("Alarm sound").selectOption({ label: "Chime" });
  const tab = (name: string) => page.getByRole("tab", { name });
  await tab("Work session").click();
  await expect(timer).toHaveText("15 00");

  // A work session ends with the chime (two tones), and so does its break.
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("15:01");
  await expect(tab("Short break")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => tones(page)).toEqual([660, 990]);
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("05:01");
  await expect(tab("Work session")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => tones(page)).toEqual([660, 990, 660, 990]);

  // With the sound off, a finished session plays nothing.
  await settings.getByLabel("Play a sound at the end of a phase").uncheck();
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("15:01");
  await expect(page.getByTestId("count-today")).toHaveText("Today 2");
  expect(await tones(page)).toHaveLength(4);

  // Reset stops a running session and sets it back to its full length.
  await tab("Work session").click();
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("05:00");
  await expect(timer).toHaveText("10 00");
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(timer).toHaveText("15 00");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  await page.clock.fastForward("01:00");
  await expect(timer).toHaveText("15 00");
  await expect(page).toHaveTitle("Pomodoro timer · Tempoloom");
  await expect(page.getByTestId("count-today")).toHaveText("Today 2");
  // The phase tabs set the full length of the chosen phase.
  await tab("Long break").click();
  await expect(timer).toHaveText("15 00");
  await tab("Short break").click();
  await expect(timer).toHaveText("05 00");

  await page.getByLabel("New task").fill("Write the summary");
  await page.getByRole("button", { name: "Add task" }).click();
  await page.getByTestId("timer-tasks").getByRole("checkbox").check();

  await page.getByRole("button", { name: "Stats" }).click();
  const stats = page.getByTestId("timer-stats-view");
  const stat = (id: string) => stats.getByTestId(`st-${id}`);
  await expect(stat("today")).toHaveText("2");
  await expect(stat("week")).toHaveText("2");
  await expect(stat("month")).toHaveText("2");
  await expect(stat("work-today")).toHaveText("30 min");
  await expect(stat("avg-work-day")).toHaveText("1 min");
  await expect(stat("tasks-today")).toHaveText("1");
  await expect(stat("streak")).toHaveText("1");
  await expect(stat("avg-sessions-day")).toHaveText("0.1");
  await expect(stat("avg-length")).toHaveText("15 min");
  // Three sessions started, two completed: the reset one is not completed.
  await expect(stat("completion")).toHaveText("67%");
  await expect(stat("breaks-today")).toHaveText("1");
  await expect(stat("break-minutes-today")).toHaveText("5 min");

  // The next day: one more session; the streak and the week carry over.
  await page.clock.fastForward("24:00:00");
  await tab("Work session").click();
  await page.getByRole("button", { name: "Start" }).click();
  await page.clock.fastForward("15:01");
  await expect(page.getByTestId("count-today")).toHaveText("Today 1");
  await expect(page.getByTestId("count-streak")).toHaveText("Streak 2");
  const check = async () => {
    await expect(stat("today")).toHaveText("1");
    await expect(stat("week")).toHaveText("3");
    await expect(stat("month")).toHaveText("3");
    await expect(stat("streak")).toHaveText("2");
    await expect(stat("work-today")).toHaveText("15 min");
    await expect(stat("tasks-today")).toHaveText("0");
    await expect(stat("breaks-today")).toHaveText("0");
    await expect(stat("completion")).toHaveText("75%");
    const bars = stats.getByTestId("st-bar");
    await stats.getByLabel("Chart by").selectOption("day");
    await expect(bars).toHaveCount(7);
    await expect(bars.nth(5)).toHaveText("Mon 9 Nov 30 min");
    await expect(bars.nth(6)).toHaveText("Tue 10 Nov 15 min");
    await stats.getByLabel("Chart by").selectOption("week");
    await expect(bars).toHaveCount(4);
    await expect(bars.nth(3)).toHaveText("Week of 9 Nov 45 min");
    await stats.getByLabel("Chart by").selectOption("month");
    await expect(bars).toHaveCount(3);
    await expect(bars.nth(2)).toHaveText("November 45 min");
  };
  await check();
  await page.reload();
  await page.getByRole("button", { name: "Stats" }).click();
  await check();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(settings.getByLabel("Alarm sound")).toHaveValue("chime");
  await expect(settings.getByLabel("Play a sound at the end of a phase")).not.toBeChecked();
  // The timer writes nothing to the calendar.
  expect(
    await cal.events(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-12-01T00:00:00Z")),
  ).toEqual([]);
});
