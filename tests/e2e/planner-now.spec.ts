// The planner's "now" line: what is next with a one-click join, the tab
// alert and chime at event start, and overlapping external events flagged
// with a suggested fix (docs/specs/planning-planner.md PLN-7;
// docs/specs/planning-notifications.md NTF-1 to NTF-3;
// docs/specs/events-external-priority.md rule 8).
//
// Ways it can fail, and the check that catches each:
// - the next meeting is not shown, or a past one is                 -> now-bar text
// - Join opens nothing, or a link that is not the meeting's           -> popup URL
// - a link in the description is missed when there is no location     -> Join href
// - the current meeting is skipped in favour of the next              -> "Now:" text
// - the tab title does not flash at the start                         -> document title
// - the chime does not play when on, or plays when off                -> oscillator count
// - a blocked chime gives no hint                                     -> hint text
// - the alert still flashes when turned off                           -> title unchanged
// - alert settings are lost on reload                                 -> checkbox state
// - overlapping events are not flagged, or free/declined ones are     -> ev-conflict classes
// - no suggested fix, or the fix moves an event                       -> list text; Radicale times
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, eventually, expect, planNow, test } from "./fixtures.ts";
import { allEvents, MIN, openWeek, W } from "./helpers.ts";

const minute = (t: number) => Math.ceil(t / MIN) * MIN;

test("the planner shows the current or next meeting and joins it in one click (PLN-7)", async ({
  page,
  cal,
  signIn,
}) => {
  await page
    .context()
    .route("https://meet.example.test/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<title>Meeting room</title>" }),
    );
  await page
    .context()
    .route("https://video.example.test/**", (r) =>
      r.fulfill({ status: 200, contentType: "text/html", body: "<title>Video room</title>" }),
    );
  const start = minute(Date.now()) + 30 * MIN;
  const standup = await cal.addEvent({
    title: "AT-Standup",
    start,
    end: start + 30 * MIN,
    location: "https://meet.example.test/standup",
  });
  await cal.addEvent({
    title: "AT-Review",
    start: start + 3 * 60 * MIN,
    end: start + 4 * 60 * MIN,
    description: "Agenda: numbers\nJoin: https://video.example.test/r/42 (passcode 1)",
  });
  await signIn();
  const next = page.getByTestId("now-bar").getByTestId("next-meeting");
  await expect(next).toContainText("Next: AT-Standup");
  const join = next.getByRole("link", { name: "Join" });
  await expect(join).toHaveAttribute("href", "https://meet.example.test/standup");
  const [room] = await Promise.all([page.waitForEvent("popup"), join.click()]);
  await expect(room).toHaveTitle("Meeting room");
  await room.close();

  // Without the standup, the review is next; its link comes from the description.
  await cal.remove(standup);
  await planNow(page);
  await page.reload();
  await expect(next).toContainText("Next: AT-Review");
  await expect(next.getByRole("link", { name: "Join" })).toHaveAttribute(
    "href",
    "https://video.example.test/r/42",
  );

  // A meeting in progress comes first.
  await cal.addEvent({
    title: "AT-Now",
    start: Date.now() - 10 * MIN,
    end: Date.now() + 20 * MIN,
    location: "https://meet.example.test/now",
  });
  await planNow(page);
  await page.reload();
  await expect(next).toContainText("Now: AT-Now");
  await expect(next.getByRole("link", { name: "Join" })).toHaveAttribute(
    "href",
    "https://meet.example.test/now",
  );
});

/** Counts oscillators that start, and can make the audio policy block sound. */
async function watchAudio(page: Page, blocked: boolean) {
  await page.addInitScript((block) => {
    const w = window as unknown as { __chimes: number };
    w.__chimes = 0;
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function (this: AudioContext) {
      const osc = create.call(this);
      const start = osc.start.bind(osc);
      osc.start = (when?: number) => {
        if (this.state === "running") w.__chimes++;
        start(when);
      };
      return osc;
    };
    if (block) {
      Object.defineProperty(AudioContext.prototype, "state", { get: () => "suspended" });
      AudioContext.prototype.resume = () => Promise.resolve();
    }
  }, blocked);
}
const chimes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __chimes: number }).__chimes);

test("an event start flashes the tab title, and plays the chime when it is on (NTF-1 to NTF-3)", async ({
  page,
  cal,
  signIn,
}) => {
  await watchAudio(page, false);
  await page.clock.install();
  await signIn();
  const first = minute(Date.now()) + 5 * MIN;
  await cal.addEvent({ title: "AT-Alert", start: first, end: first + 30 * MIN });
  await planNow(page);
  await page.reload();
  await expect(page.getByTestId("now-bar")).toContainText("AT-Alert");
  await page.clock.fastForward(first - (await page.evaluate(() => Date.now())) + 2_000);
  await expect(page).toHaveTitle(/AT-Alert/);
  expect(await chimes(page)).toBe(0);

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Chime when an event starts").check();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await page.reload();
  await expect(page.getByLabel("Chime when an event starts")).toBeChecked();
  await expect(page.getByLabel("Flash the tab title when an event starts")).toBeChecked();
  const second = minute(Date.now()) + 10 * MIN;
  await cal.addEvent({ title: "AT-Chime", start: second, end: second + 15 * MIN });
  await planNow(page);
  await page.getByRole("link", { name: "Planner" }).click();
  await expect(page.getByTestId("now-bar")).toContainText("AT-Chime");
  await page.clock.fastForward(second - (await page.evaluate(() => Date.now())) + 2_000);
  await expect(page).toHaveTitle(/AT-Chime/);
  await expect.poll(() => chimes(page)).toBe(1);

  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Flash the tab title when an event starts").uncheck();
  await page.getByLabel("Chime when an event starts").uncheck();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const third = minute(Date.now()) + 15 * MIN;
  await cal.addEvent({ title: "AT-Quiet", start: third, end: third + 15 * MIN });
  await planNow(page);
  await page.getByRole("link", { name: "Planner" }).click();
  await expect(page.getByTestId("now-bar")).toContainText("AT-Quiet");
  await page.clock.fastForward(third - (await page.evaluate(() => Date.now())) + 2_000);
  await page.clock.runFor(3_000);
  await expect(page).not.toHaveTitle(/AT-Quiet/);
  expect(await chimes(page)).toBe(1);
});

test("a chime the browser blocks shows a hint (NTF-2)", async ({ page, cal, signIn }) => {
  await watchAudio(page, true);
  await page.clock.install();
  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Chime when an event starts").check();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  const start = minute(Date.now()) + 5 * MIN;
  await cal.addEvent({ title: "AT-Blocked", start, end: start + 30 * MIN });
  await planNow(page);
  await page.getByRole("link", { name: "Planner" }).click();
  await expect(page.getByTestId("now-bar")).toContainText("AT-Blocked");
  await page.clock.fastForward(start - (await page.evaluate(() => Date.now())) + 2_000);
  await expect(page.getByTestId("chime-hint")).toContainText("The browser blocked the start chime");
  expect(await chimes(page)).toBe(0);
});

test("overlapping external events are flagged with a suggested fix and never moved (events-external-priority rule 8)", async ({
  page,
  cal,
  signIn,
}) => {
  const tue = addDays(W, 1);
  const a = await cal.addEvent({
    title: "AT-Clash A",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
  });
  const b = await cal.addEvent({
    title: "AT-Clash B",
    start: at(tue, "10:30"),
    end: at(tue, "11:30"),
  });
  await cal.addEvent({ title: "AT-Solo", start: at(tue, "14:00"), end: at(tue, "15:00") });
  await cal.addEvent({
    title: "AT-Free",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    busy: false,
  });
  await cal.addInvite({
    title: "AT-Declined",
    start: at(tue, "10:00"),
    end: at(tue, "10:30"),
    answer: "DECLINED",
  });
  await signIn();
  await openWeek(page);
  const flagged = page.locator(".ev.ev-conflict");
  await expect(flagged).toHaveCount(2);
  await expect(page.locator(".ev.ev-conflict", { hasText: "AT-Clash A" })).toHaveCount(1);
  await expect(page.locator(".ev.ev-conflict", { hasText: "AT-Clash B" })).toHaveCount(1);
  await page.getByTestId("now-bar").getByRole("button", { name: "1 conflict" }).click();
  const list = page.getByTestId("conflicts");
  await expect(list).toContainText("AT-Clash A and AT-Clash B overlap");
  await expect(list).toContainText("Suggested fix: move AT-Clash B to");
  await expect(list).toContainText("11:00–12:00");

  await planNow(page);
  await page.reload();
  await expect(flagged).toHaveCount(2);
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(l.length).toBeGreaterThan(3),
  );
  const byId = new Map(evs.map((e) => [e.id, e]));
  expect([byId.get(a)?.start, byId.get(a)?.end]).toEqual([at(tue, "10:00"), at(tue, "11:00")]);
  expect([byId.get(b)?.start, byId.get(b)?.end]).toEqual([at(tue, "10:30"), at(tue, "11:30")]);
});
