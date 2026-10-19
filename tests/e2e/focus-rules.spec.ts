// Focus time rules (docs/specs/focus-time.md): block lengths and scheduling
// hours from the shared form, moves for accepted events, the lock after a
// calendar move, the place of focus after every other item (P4, then P2 for
// booking links), and the focus tag in counted time.
//
// Ways it can fail, and the check that catches each:
// - a block is shorter than the shortest or longer than the longest length
//                                                          -> exact spans, then lengths after an edit
// - focus lands outside its hours set                      -> every event inside 18:00 to 22:00
// - an unanswered invitation moves focus, or an accepted one does not
//                                                          -> event start after each invitation
// - a moved focus event is put back or moves for a new event -> lock marker and start
// - focus takes time a P4 task needs, or a P2 booking link offers focus time
//                                                          -> task and focus spans; booking slots
// - an event with the focus tag does not count toward the goal
//                                                          -> focus minutes with and without the tag
import { addDays } from "../../src/shared/time.ts";
import { day, minutesOf, openSettings, span, week } from "./automation-helpers.ts";
import {
  automation,
  create,
  edit,
  group,
  openAutomations,
  save,
} from "./automation-list-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, local, planNow, test } from "./fixtures.ts";
import {
  addHabit,
  addLink,
  addTask,
  claimPage,
  inHours,
  MIN,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";

const protect10 = async (page: Parameters<typeof openSettings>[0]) => {
  await openSettings(page);
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
};

test("focus blocks keep the shortest and longest length and stay in their hours set (rule 3; hours concept)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // Monday evening leaves 45 minutes: enough for a 45-minute shortest block, not
  // for the default 60. Wednesday evening leaves 30 minutes: too short.
  await cal.addEvent({ title: "Choir", start: at(W, "18:00"), end: at(W, "21:15") });
  await cal.addEvent({ title: "Dinner", start: at(day(2), "18:00"), end: at(day(2), "21:30") });
  await signIn();
  const form = await create(page, "Focus time");
  await form.getByLabel("Title").fill("Evening focus");
  await form.getByLabel("Weekly goal (hours)").fill("6");
  await form.getByLabel("Daily minimum (hours)").fill("0");
  await form.getByLabel("Daily maximum (hours)").fill("2");
  await form.getByLabel("Shortest block (minutes)").fill("45");
  await form.getByLabel("Longest block (minutes)").fill("90");
  await form.getByLabel("Hours", { exact: true }).selectOption({ label: "Personal hours" });
  await save(form);
  const evs = await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Evening focus").map(span)).toEqual([
        `${W} 21:15-22:00`,
        `${day(1)} 18:00-19:30`,
        `${day(3)} 18:00-19:30`,
        `${day(4)} 18:00-19:30`,
        `${day(5)} 18:00-18:45`,
      ]),
  );
  for (const e of titled(evs, "Evening focus")) expect(e.busy).toBe(true);

  // A shorter longest block (the default is 240) splits the time into more, shorter blocks.
  const again = await edit(page, "Evening focus");
  await expect(again.getByLabel("Longest block (minutes)")).toHaveValue("90");
  await again.getByLabel("Longest block (minutes)").fill("60");
  await save(again);
  const after = await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Evening focus").map(span)).toEqual([
        `${W} 21:15-22:00`,
        `${day(1)} 18:00-19:00`,
        `${day(1)} 19:00-20:00`,
        `${day(3)} 18:00-19:00`,
        `${day(3)} 19:00-20:00`,
        `${day(4)} 18:00-19:00`,
      ]),
  );
  for (const e of titled(after, "Evening focus")) {
    expect(inHours(e.start, e.end, "18:00", "22:00")).toBe(true);
    expect((e.end - e.start) / MIN).toBeLessThanOrEqual(60);
  }
  await page.reload();
  const shown = await edit(page, "Evening focus");
  await expect(shown.getByLabel("Longest block (minutes)")).toHaveValue("60");
  await expect(shown.getByLabel("Shortest block (minutes)")).toHaveValue("45");
  await expect(shown.getByLabel("Hours", { exact: true }).locator("option:checked")).toHaveText(
    "Personal hours",
  );
});

test("an accepted invitation over focus time moves it; an unanswered one does not (rules 18-19)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "A service account cannot receive invitations.");
  await blockUntil(cal, W);
  await signIn();
  await protect10(page);
  const evs = await eventually(
    () => week(cal),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(600),
  );
  const tue = titled(evs, "Focus time").find((e) => local(e.start).startsWith(day(1)));
  const thu = titled(evs, "Focus time").find((e) => local(e.start).startsWith(day(3)));
  if (!tue || !thu) throw new Error("no Tuesday or Thursday focus");
  await cal.addInvite({
    title: "Maybe sync",
    start: tue.start,
    end: tue.start + 30 * MIN,
    answer: "NEEDS-ACTION",
  });
  await cal.addInvite({
    title: "Design review",
    start: thu.start,
    end: thu.start + 60 * MIN,
    answer: "ACCEPTED",
  });
  const moved = await eventually(
    () => week(cal),
    (l) => {
      const f = titled(l, "Focus time");
      expect(f.some((e) => e.start < thu.start + 60 * MIN && e.end > thu.start)).toBe(false);
      expect(minutesOf(f)).toBe(600);
    },
  );
  expect(titled(moved, "Focus time").find((e) => e.id === tue.id)?.start).toBe(tue.start);
  await page.reload();
  await planNow(page);
  const later = titled(await week(cal), "Focus time");
  expect(later.find((e) => e.id === tue.id)?.start).toBe(tue.start);
  expect(later.some((e) => e.start < thu.start + 60 * MIN && e.end > thu.start)).toBe(false);
});

test("moving a focus event in the calendar locks it; a new event over it does not move it (rule 20)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await protect10(page);
  const evs = await eventually(
    () => week(cal),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(600),
  );
  const wed = titled(evs, "Focus time").find((e) => local(e.start).startsWith(day(2)));
  if (!wed) throw new Error("no Wednesday focus");
  const start = wed.start + 60 * MIN;
  const end = start + (wed.end - wed.start);
  await cal.update(wed.id, { start, end });
  await eventually(
    () => week(cal),
    (l) => {
      const e = titled(l, "Focus time").find((x) => x.id === wed.id);
      expect(e?.summary).toBe("🔒 Focus time");
      expect(e?.start).toBe(start);
    },
  );
  await cal.addEvent({ title: "Walk-in", start, end: start + 30 * MIN });
  await planNow(page);
  await page.reload();
  const after = titled(await week(cal), "Focus time").find((x) => x.id === wed.id);
  expect(after?.start).toBe(start);
  expect(after?.summary).toBe("🔒 Focus time");
});

test("focus time is placed after every other item, ranks in P4, and counts as P2 for booking links (rules 29-32)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  // The week is full except Monday 09:00 to 12:00.
  await cal.addEvent({ title: "Busy", start: at(W, "12:00"), end: at(W, "17:00") });
  for (const n of [1, 2, 3, 4]) {
    await cal.addEvent({ title: "Busy", start: at(day(n), "09:00"), end: at(day(n), "17:00") });
  }
  await signIn();
  await protect10(page);
  await eventually(
    () => week(cal),
    (l) => {
      const f = titled(l, "Focus time");
      expect(minutesOf(f)).toBe(180);
      for (const e of f) expect(inHours(e.start, e.end, "09:00", "12:00")).toBe(true);
    },
  );
  await openAutomations(page);
  await expect(group(page, 4).locator('[data-testid="automation"]')).toHaveCount(1);
  await expect(automation(page, "Focus time")).toBeVisible();
  await expect(group(page, 4)).toContainText("Focus time");

  // A P1 link may offer the placed focus time; a P2 link may not.
  await claimPage(page, "fia");
  await addLink(page, { title: "Team call", durations: "30", level: 2 });
  const v = await visitor(browser);
  await v.goto("/book/fia/important-meeting");
  await expect(slot(v, at(W, "10:00"))).toBeVisible();
  await v.goto("/book/fia/team-call");
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(slot(v, at(W, "10:00"))).toHaveCount(0);

  // A P4 flexible meeting, habit and task take the time first; focus keeps what is left.
  await page.getByRole("link", { name: "Meetings" }).click();
  const meeting = page.getByTestId("meeting-form");
  await meeting.getByLabel("Title").fill("Vendor sync");
  await meeting.getByLabel("Guests (comma list)", { exact: true }).fill("ana@example.com");
  await meeting.getByLabel("Ideal time").fill("10:30");
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
    await meeting.getByLabel(d, { exact: true }).setChecked(d === "Mon");
  await meeting.getByLabel("Priority").selectOption({ label: "P4 low" });
  await meeting.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Vendor sync"]')).toBeVisible();
  await addHabit(page, { title: "Tea", ideal: "10:00", min: 30, max: 30, level: 4, days: ["Mon"] });
  await addTask(page, { title: "AT-Report", minutes: 60, split: false, due: "", level: 4 });
  const expected = {
    "AT-Report": [`${W} 09:00-10:00`],
    Tea: [`${W} 10:00-10:30`],
    "Vendor sync": [`${W} 10:30-11:00`],
    "Focus time": [`${W} 11:00-12:00`],
  };
  const check = (l: Awaited<ReturnType<typeof week>>) => {
    for (const [title, spans] of Object.entries(expected))
      expect(titled(l, title).map(span)).toEqual(spans);
  };
  const evs = await eventually(() => week(cal), check);
  expect(titled(evs, "Focus time")[0]?.busy).toBe(true);
  await page.reload();
  await planNow(page);
  check(await week(cal));
});

test("an event with the focus tag counts toward the weekly goal (counted time; #tl_focus)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tagged = await cal.addEvent({
    title: "Writing #tl_focus",
    start: at(day(1), "09:00"),
    end: at(day(1), "11:00"),
  });
  await signIn();
  await protect10(page);
  await eventually(
    () => week(cal),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(600 - 120),
  );
  await page.reload();
  await planNow(page);
  expect(minutesOf(titled(await week(cal), "Focus time"))).toBe(480);
  // Without the tag the event no longer counts: focus fills the whole goal.
  await cal.update(tagged, {
    start: at(day(1), "09:00"),
    end: at(day(1), "11:00"),
    summary: "Writing",
  });
  await eventually(
    () => cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00")),
    (l) => expect(minutesOf(titled(l, "Focus time"))).toBe(600),
  );
});
