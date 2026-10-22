// Habits, part B (docs/specs/habits-automation.md concepts `guests`, rules 7,
// 18, 31, 35, 37-39; meetings-flexible.md rule 22): guests, auto-decline,
// dependencies between habits and on flexible meetings, snooze of one
// occurrence and of the habit, and the search box of the automation list.
//
// Ways it can fail, and the check that catches each:
// - guests are not written, or get a notice from the server or Tempoloom
//                                  -> ATTENDEE lines, SCHEDULE-AGENT=CLIENT, empty mailbox
// - a busy guest moves the habit (an availability check)  -> 12:00 on the guest's busy day
// - an edit of the guests does not reach the events        -> guests after the edit
// - auto-decline answers while off, or over a free occurrence -> answers stay unanswered
// - the decline has no note                                -> COMMENT line
// - a habit without a message sends no note or the focus note -> default COMMENT line
// - a dependency is ignored, or moves the other item       -> event times of both
// - "before" places the habit on days without the other item -> only its days
// - "not after" limits days without the other item         -> ideal time on those days
// - "not on the same day" still uses the other item's days -> event days
// - a rule that makes a loop is accepted                    -> refusal in the form
// - a snooze acts as a reschedule (nearest time) or moves the day -> 14:00, not 12:30
// - a typed time is ignored, or an earlier time moves it back -> 15:45; refusal at 11:30
// - a snooze of an occurrence that has started does nothing -> 12:15, not 12:00
// - a snooze or reschedule puts an occurrence whose event moved to another day
//   back on its own date                                  -> Thursday 10:00, 11:00
// - snooze until a date leaves earlier events, or drops later ones -> event days
// - the search shows other titles, or hides matches        -> names in the list
import type { Page } from "@playwright/test";
import { boxOf, day, invite, rawEvent, span, week } from "./automation-helpers.ts";
import { edit, names, openAutomations, save } from "./automation-list-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  local,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, openWeek, titled, W } from "./helpers.ts";

test.skip(
  BACKEND === "google",
  "These scenarios use a second CalDAV user, invitations and raw CalDAV reads.",
);

const days = (evs: { start: number }[]) => evs.map((e) => local(e.start).slice(0, 10));
const fiveAt = (from: string, to: string) => [0, 1, 2, 3, 4].map((n) => `${day(n)} ${from}-${to}`);

/** The answers of the user to these invitations, in order. */
const answers = async (cal: CalendarDriver, ids: string[]) => {
  const l = await week(cal);
  return ids.map((id) => l.find((e) => e.id === id)?.selfResponse);
};

test("habit guests are written to each event without notices, and a busy guest does not move the habit (habits concepts guests)", async ({
  page,
  cal,
  radicale,
  signIn,
  colleague,
  mail,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  // The guest is a Tempoloom user who is busy over Tuesday's ideal time.
  await colleague.cal.addEvent({
    title: "Workshop",
    start: at(day(1), "11:00"),
    end: at(day(1), "14:00"),
  });
  await colleague.signIn();
  await signIn();
  await page.getByRole("link", { name: "Habits" }).click();
  const form = page.getByTestId("habit-form");
  await form.getByLabel("Title").fill("Lunch walk");
  await form.getByLabel("Ideal time").fill("12:00");
  await form.getByLabel("Shortest (minutes)").fill("30");
  await form.getByLabel("Longest (minutes)").fill("30");
  await form.getByLabel("Guests (comma list)").fill(`${colleague.email}, Ana@Example.com`);
  await form.getByRole("button", { name: "Add habit" }).click();
  await expect(page.locator('[data-habit-title="Lunch walk"]')).toBeVisible();

  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch walk").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  for (const e of titled(evs, "Lunch walk")) {
    expect(await cal.guests(e.id)).toEqual([
      { email: colleague.email, optional: false },
      { email: "ana@example.com", optional: false },
    ]);
  }
  const tuesday = titled(evs, "Lunch walk")[1];
  if (!tuesday) throw new Error("no Tuesday event");
  const guestLines = (await rawEvent(radicale, tuesday.id))
    .split(/\r?\n/)
    .filter((l) => l.startsWith("ATTENDEE"));
  expect(guestLines).toHaveLength(2);
  for (const l of guestLines) expect(l).toMatch(/SCHEDULE-AGENT=CLIENT/i);
  // Later runs keep the time, and nobody got a message.
  await page.waitForTimeout(11_000);
  expect(titled(await week(cal), "Lunch walk").map(span)).toEqual(fiveAt("12:00", "12:30"));
  expect(await mail.count(colleague.email)).toBe(0);
  expect(await mail.count("ana@example.com")).toBe(0);

  // An edit of the guests reaches every event.
  const habitForm = await edit(page, "Lunch walk");
  await expect(habitForm.getByLabel("Guests (comma list)")).toHaveValue(
    `${colleague.email}, ana@example.com`,
  );
  await habitForm.getByLabel("Guests (comma list)").fill(colleague.email);
  await save(habitForm);
  await eventually(
    async () => Promise.all(titled(await week(cal), "Lunch walk").map((e) => cal.guests(e.id))),
    (l) => {
      expect(l).toHaveLength(5);
      for (const g of l) expect(g).toEqual([{ email: colleague.email, optional: false }]);
    },
  );
  const again = await edit(page, "Lunch walk");
  await page.reload();
  await expect(again.getByLabel("Guests (comma list)")).toHaveValue(colleague.email);
  expect(titled(await week(cal), "Lunch walk").map(span)).toEqual(fiveAt("12:00", "12:30"));
});

test("habit auto-decline declines invitations over a busy occurrence with the message, never over a free one (rules 37-39)", async ({
  page,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Deep work",
    ideal: "10:00",
    min: 60,
    max: 60,
    defense: "Always busy",
  });
  await addHabit(page, {
    title: "Reading",
    ideal: "14:00",
    min: 60,
    max: 60,
    defense: "Always free",
  });
  const evs = await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Deep work").map(span)).toEqual(fiveAt("10:00", "11:00"));
      expect(titled(l, "Reading").map(span)).toEqual(fiveAt("14:00", "15:00"));
    },
  );
  expect(titled(evs, "Deep work").every((e) => e.busy)).toBe(true);
  expect(titled(evs, "Reading").some((e) => e.busy)).toBe(false);
  const overBusy = await invite(cal, "Vendor pitch", day(1), "10:00", "10:30");
  const overFree = await invite(cal, "Book club", day(1), "14:00", "14:30");
  const ids = [overBusy, overFree];
  // Auto-decline is off: nothing is answered.
  await page.waitForTimeout(11_000);
  expect(await answers(cal, ids)).toEqual(["needsAction", "needsAction"]);

  for (const [name, message] of [
    ["Reading", ""],
    ["Deep work", "Deep work time"],
  ] as const) {
    const form = await edit(page, name);
    await form.getByLabel("Decline invitations that overlap this habit while it is busy").check();
    await expect(form.getByText("Tempoloom sends these declines to other people.")).toBeVisible();
    if (message) await form.getByLabel("Decline message").fill(message);
    await save(form);
  }
  await eventually(
    () => answers(cal, ids),
    (a) => expect(a).toEqual(["declined", "needsAction"]),
  );
  const raw = await rawEvent(radicale, overBusy);
  expect(raw).toMatch(/ATTENDEE;[^\n]*PARTSTAT=DECLINED[^\n]*mailto:e2e@tempoloom\.test/i);
  expect(raw).toContain("COMMENT:Deep work time");
  // Later runs keep the answers; the habits did not move.
  await page.waitForTimeout(11_000);
  expect(await answers(cal, ids)).toEqual(["declined", "needsAction"]);
  expect(titled(await week(cal), "Deep work").map(span)).toEqual(fiveAt("10:00", "11:00"));
  const form = await edit(page, "Deep work");
  await page.reload();
  await expect(
    form.getByLabel("Decline invitations that overlap this habit while it is busy"),
  ).toBeChecked();
  await expect(form.getByLabel("Decline message")).toHaveValue("Deep work time");
});

test("habit auto-decline without a message of its own declines with the default note (rule 37)", async ({
  page,
  cal,
  radicale,
  signIn,
}) => {
  if (!radicale) throw new Error("CalDAV only");
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, {
    title: "Stretch",
    ideal: "16:00",
    min: 30,
    max: 30,
    defense: "Always busy",
  });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Stretch").map(span)).toEqual(fiveAt("16:00", "16:30")),
  );
  const form = await edit(page, "Stretch");
  await form.getByLabel("Decline invitations that overlap this habit while it is busy").check();
  await expect(form.getByLabel("Decline message")).toHaveValue("");
  await expect(form.getByLabel("Decline message")).toHaveAttribute(
    "placeholder",
    "Declined automatically: this time is reserved for a routine.",
  );
  await save(form);
  const id = await invite(cal, "Sales demo", day(2), "16:00", "16:30");
  await eventually(
    () => answers(cal, [id]),
    (a) => expect(a).toEqual(["declined"]),
  );
  const raw = await rawEvent(radicale, id);
  expect(raw).toMatch(/ATTENDEE;[^\n]*PARTSTAT=DECLINED[^\n]*mailto:e2e@tempoloom\.test/i);
  expect(raw).toContain("COMMENT:Declined automatically: this time is reserved for a routine.");
  await page.reload();
  const again = await edit(page, "Stretch");
  await expect(
    again.getByLabel("Decline invitations that overlap this habit while it is busy"),
  ).toBeChecked();
  await expect(again.getByLabel("Decline message")).toHaveValue("");
});

/** Replaces the dependencies of a habit in its form with one rule and saves it. */
async function depend(page: Page, habit: string, rule: string, target: string) {
  const form = await edit(page, habit);
  const deps = form.getByTestId("habit-dependencies");
  const old = deps.getByRole("button", { name: "Remove" });
  while ((await old.count()) > 0) await old.first().click();
  await deps.getByLabel("Rule", { exact: true }).selectOption({ label: rule });
  await deps.getByLabel("Habit or meeting").selectOption({ label: `Habit: ${target}` });
  await deps.getByRole("button", { name: "Add dependency" }).click();
  await expect(deps.getByTestId("dependency")).toHaveCount(1);
  await expect(deps.getByTestId("dependency")).toContainText(`${rule} ${target}`);
  await save(form);
}

test("habit dependencies: before keeps a habit to the other habit's days and ahead of it, not after limits those days only, not on the same day keeps it off them (rule 18)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Review", ideal: "11:00", min: 30, max: 30 });
  await addHabit(page, { title: "Gym", ideal: "15:00", min: 30, max: 30 });
  // Last: the form keeps the checked days for the next habit.
  await addHabit(page, {
    title: "Standup",
    ideal: "10:00",
    min: 30,
    max: 30,
    days: ["Mon", "Wed"],
  });
  const standup = [`${day(0)} 10:00-10:30`, `${day(2)} 10:00-10:30`];
  // Without dependencies every habit keeps its ideal time on each of its days.
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Standup").map(span)).toEqual(standup);
      expect(titled(l, "Review").map(span)).toEqual(fiveAt("11:00", "11:30"));
      expect(titled(l, "Gym").map(span)).toEqual(fiveAt("15:00", "15:30"));
    },
  );

  await depend(page, "Review", "Before", "Standup");
  await depend(page, "Gym", "Not on the same day as", "Standup");
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Review").map(span)).toEqual([
        `${day(0)} 09:30-10:00`,
        `${day(2)} 09:30-10:00`,
      ]);
      expect(days(titled(l, "Gym"))).toEqual([day(1), day(3), day(4)]);
      expect(titled(l, "Standup").map(span)).toEqual(standup);
    },
  );

  await depend(page, "Review", "Not after", "Standup");
  const expected = [
    `${day(0)} 09:30-10:00`,
    `${day(1)} 11:00-11:30`,
    `${day(2)} 09:30-10:00`,
    `${day(3)} 11:00-11:30`,
    `${day(4)} 11:00-11:30`,
  ];
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Review").map(span)).toEqual(expected),
  );
  const form = await edit(page, "Gym");
  await page.reload();
  await expect(form.getByTestId("dependency")).toHaveCount(1);
  await expect(form.getByTestId("dependency")).toContainText("Not on the same day as Standup");
  const after = await week(cal);
  expect(titled(after, "Review").map(span)).toEqual(expected);
  expect(days(titled(after, "Gym"))).toEqual([day(1), day(3), day(4)]);
  expect(titled(after, "Standup").map(span)).toEqual(standup);

  // A rule back to Review makes a loop: the form refuses it.
  const loop = (await edit(page, "Standup")).getByTestId("habit-dependencies");
  await loop.getByLabel("Rule", { exact: true }).selectOption({ label: "Not after" });
  await loop.getByLabel("Habit or meeting").selectOption({ label: "Habit: Review" });
  await loop.getByRole("button", { name: "Add dependency" }).click();
  await expect(loop.getByRole("alert")).toHaveText(
    "This rule makes a loop: Review already depends on Standup, directly or through other habits",
  );
  await expect(loop.getByTestId("dependency")).toHaveCount(0);
});

test("the meeting form adds a habit dependency: the habit goes before the meeting or not after it on its day, and removing it frees the habit (meetings rule 22)", async ({
  page,
  cal,
  signIn,
  colleague,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.signIn();
  await signIn();
  await addHabit(page, { title: "Prep notes", ideal: "14:00", min: 30, max: 30 });
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("Sync");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(colleague.email);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  await page.getByRole("button", { name: "Add meeting" }).click();
  const sync = [`${day(1)} 10:00-10:30`];
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Sync").map(span)).toEqual(sync);
      expect(titled(l, "Prep notes").map(span)).toEqual(fiveAt("14:00", "14:30"));
    },
  );

  const deps = page.getByTestId("meeting-habit-dependencies");
  const openMeeting = async () => {
    await page.getByRole("link", { name: "Meetings" }).click();
    await page.locator('[data-meeting-title="Sync"]').getByRole("button", { name: "Edit" }).click();
    await expect(deps).toBeVisible();
  };
  const rule = async (label: string | null) => {
    await openMeeting();
    // The habits have loaded: "Prep notes" shows as a rule or as a choice.
    await expect(deps.getByText("Prep notes").first()).toBeAttached();
    const old = deps.getByRole("button", { name: "Remove" });
    if ((await old.count()) > 0) {
      await old.click();
      await expect(deps.getByTestId("dependency")).toHaveCount(0);
    }
    if (!label) return;
    await deps.getByLabel("Habit", { exact: true }).selectOption({ label: "Prep notes" });
    await deps.getByLabel("Rule", { exact: true }).selectOption({ label });
    await deps.getByRole("button", { name: "Add habit dependency" }).click();
    await expect(deps.getByTestId("dependency")).toContainText("Prep notes");
  };

  await rule("Before this meeting");
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Prep notes").map(span)).toEqual([`${day(1)} 09:30-10:00`]);
      expect(titled(l, "Sync").map(span)).toEqual(sync);
    },
  );
  // The rule is stored on the habit: its own form shows it after a reload.
  const habitForm = await edit(page, "Prep notes");
  await page.reload();
  await expect(habitForm.getByTestId("dependency")).toContainText("Before Sync");

  await rule("Not after this meeting");
  await expect(deps.getByTestId("dependency")).toContainText("Prep notes: not after this meeting");
  const notAfter = fiveAt("14:00", "14:30");
  notAfter[1] = `${day(1)} 09:30-10:00`;
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Prep notes").map(span)).toEqual(notAfter);
      expect(titled(l, "Sync").map(span)).toEqual(sync);
    },
  );

  await rule(null);
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Prep notes").map(span)).toEqual(fiveAt("14:00", "14:30"));
      expect(titled(l, "Sync").map(span)).toEqual(sync);
    },
  );
  await page.reload();
  await openMeeting();
  await expect(deps.getByTestId("dependency")).toHaveCount(0);
});

test("snooze moves one habit occurrence to the first free time at or after the chosen time that day (rule 31)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "Supplier call",
    start: at(day(2), "13:00"),
    end: at(day(2), "14:00"),
  });
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 30, max: 30 });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  const wednesday = titled(evs, "Lunch")[2];
  if (!wednesday) throw new Error("no Wednesday lunch");
  await openWeek(page);
  await (await boxOf(page, app, wednesday.id)).click();
  const snooze = page.getByTestId("snooze-form");
  await snooze.getByRole("button", { name: "+1 h" }).click();
  await expect(snooze.getByLabel("Not before")).toHaveValue("13:00");
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  // 13:00 to 14:00 is taken: the first free start after 13:00 is 14:00. The
  // time nearest to 13:00 (a reschedule) would be 12:30.
  const expected = fiveAt("12:00", "12:30");
  expected[2] = `${day(2)} 14:00-14:30`;
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(expected),
  );
  await page.waitForTimeout(11_000);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Lunch" })).toHaveCount(5);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
});

test("snooze offers +15 min to +2 h from the occurrence's start, takes a typed time, and refuses a time at or before the start (rule 31)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 30, max: 30 });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  const thursday = titled(evs, "Lunch")[3];
  if (!thursday) throw new Error("no Thursday lunch");
  await openWeek(page);
  await (await boxOf(page, app, thursday.id)).click();
  const snooze = page.getByTestId("snooze-form");
  const field = snooze.getByLabel("Not before");
  for (const [button, time] of [
    ["+15 min", "12:15"],
    ["+30 min", "12:30"],
    ["+1 h", "13:00"],
    ["+2 h", "14:00"],
  ] as const) {
    await snooze.getByRole("button", { name: button }).click();
    await expect(field).toHaveValue(time);
  }
  // A time at or before the start is not a snooze: refused, nothing moves.
  await field.fill("11:30");
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(snooze.getByRole("alert")).toHaveText("Pick a time after 12:00");
  await field.fill("15:45");
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  const expected = fiveAt("12:00", "12:30");
  expected[3] = `${day(3)} 15:45-16:15`;
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(expected),
  );
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Lunch" })).toHaveCount(5);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
});

test("snooze moves an occurrence that has started to the chosen time (rule 31)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 30, max: 30 });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  // Tuesday 12:05: the Tuesday lunch has started. Without a snooze it stays
  // (SCH-60a): a whole plan run at 12:05 ends before the read.
  app.env.TEST_CLOCK_START = new Date(at(day(1), "12:05")).toISOString();
  await app.restart();
  await planNow(page);
  const evs = await week(cal);
  expect(titled(evs, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30"));
  const tuesday = titled(evs, "Lunch")[1];
  if (!tuesday) throw new Error("no Tuesday lunch");
  await openWeek(page);
  await (await boxOf(page, app, tuesday.id)).click();
  const snooze = page.getByTestId("snooze-form");
  await snooze.getByLabel("Not before").fill("12:15");
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  const expected = fiveAt("12:00", "12:30");
  expected[1] = `${day(1)} 12:15-12:45`;
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(expected),
  );
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Lunch" })).toHaveCount(5);
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(expected);
});

test("snooze and reschedule keep the occurrence on the day its event moved to (rules 30, 31)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 30, max: 30 });
  const evs = await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  const wednesday = titled(evs, "Lunch")[2];
  if (!wednesday) throw new Error("no Wednesday lunch");
  // The user moves Wednesday's lunch to Thursday 14:00 in the calendar: it locks there.
  await cal.update(wednesday.id, { start: at(day(3), "14:00"), end: at(day(3), "14:30") });
  await eventually(
    () => week(cal),
    (l) => expect(l.find((e) => e.id === wednesday.id)?.summary).toContain("🔒"),
  );
  // The moved event runs before Thursday's own lunch at 12:00.
  const onThursday = (time: string) => [
    `${day(0)} 12:00-12:30`,
    `${day(1)} 12:00-12:30`,
    `${day(3)} ${time}`,
    `${day(3)} 12:00-12:30`,
    `${day(4)} 12:00-12:30`,
  ];
  const lunches = async () => titled(await week(cal), "Lunch").map(span);
  await openWeek(page);
  // Reschedule to 10:00: Thursday 10:00, not Wednesday 10:00 (the occurrence's date).
  await (await boxOf(page, app, wednesday.id)).click();
  const reschedule = page.getByTestId("reschedule-form");
  await reschedule.getByLabel("Reschedule to").fill("10:00");
  await reschedule.getByRole("button", { name: "Reschedule" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  await eventually(lunches, (l) => expect(l).toEqual(onThursday("10:00-10:30")));
  // Snooze +1 h from 10:00: Thursday 11:00. On Wednesday, 11:00 would be refused
  // as before the start, or the occurrence would go back to Wednesday.
  await (await boxOf(page, app, wednesday.id)).click();
  const snooze = page.getByTestId("snooze-form");
  await snooze.getByRole("button", { name: "+1 h" }).click();
  await expect(snooze.getByLabel("Not before")).toHaveValue("11:00");
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(page.getByTestId("event-drawer")).toHaveCount(0);
  const expected = onThursday("11:00-11:30");
  await eventually(lunches, (l) => expect(l).toEqual(expected));
  const event = (await week(cal)).find((e) => e.id === wednesday.id);
  expect(event && span(event)).toBe(`${day(3)} 11:00-11:30`);
  await page.reload();
  await expect(page.locator(".ev-habit", { hasText: "Lunch" })).toHaveCount(5);
  expect(await lunches()).toEqual(expected);
});

test("snooze until a date removes the habit's events before that date and keeps the later ones (rule 35)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 30, max: 30 });
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
  const row = page.locator('[data-habit-title="Lunch"]');
  const snooze = row.getByTestId("snooze-habit");
  await snooze.getByLabel("Snooze until").fill(day(3));
  await snooze.getByRole("button", { name: "Snooze" }).click();
  await expect(row).toContainText(`snoozed until ${day(3)}`);
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30").slice(3)),
  );
  // The next week keeps its events.
  expect(days(titled(await week(cal, day(7)), "Lunch"))).toEqual(
    [7, 8, 9, 10, 11].map((n) => day(n)),
  );
  await page.reload();
  await expect(row).toContainText(`snoozed until ${day(3)}`);
  await expect(row.getByLabel("Snooze until")).toHaveValue(day(3));
  expect(titled(await week(cal), "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30").slice(3));

  // Clearing the snooze brings the earlier days back.
  await row.getByLabel("Snooze until").fill("");
  await row.getByRole("button", { name: "Clear snooze" }).click();
  await expect(row).not.toContainText("snoozed until");
  await eventually(
    () => week(cal),
    (l) => expect(titled(l, "Lunch").map(span)).toEqual(fiveAt("12:00", "12:30")),
  );
});

test("the automation list search box filters habits by title (rule 7)", async ({
  page,
  signIn,
}) => {
  await signIn();
  for (const title of ["Lunch", "Morning walk", "Evening Walk"])
    await addHabit(page, { title, ideal: "12:00", min: 15, max: 15 });
  await openAutomations(page);
  const list = page.getByTestId("automations-page");
  const search = page.locator("#automation-search");
  const habits = () =>
    list
      .locator('[data-testid="automation"][data-type="habit"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-name")).sort());
  await expect.poll(habits).toEqual(["Evening Walk", "Lunch", "Morning walk"]);
  await search.fill("walk");
  await expect.poll(() => names(list)).toEqual(["Morning walk", "Evening Walk"]);
  await search.fill("LUNCH");
  await expect.poll(() => names(list)).toEqual(["Lunch"]);
  await search.fill("dentist");
  await expect.poll(() => names(list)).toEqual([]);
  await expect(list.getByText("No automations match").first()).toBeVisible();
  await search.fill("");
  await expect.poll(habits).toEqual(["Evening Walk", "Lunch", "Morning walk"]);
  await page.reload();
  await expect(search).toHaveValue("");
  await search.fill("morning");
  await expect.poll(() => names(list)).toEqual(["Morning walk"]);
});
