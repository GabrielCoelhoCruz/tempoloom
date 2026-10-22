// Auto-lock per flexible meeting (docs/specs/meetings-flexible-rescheduling.md
// rules 7, 14, 15; acceptance test 9). The server clock is set
// (TEST_CLOCK_START), so the lock hour (01:00, planning-locks.md LCK-31) of the
// days in the test week comes inside the test. The planning week starts on
// Sunday (LCK-33), so a "week" run on Monday-start weeks shows.
//
// Ways it can fail, and the check that catches each:
// - the meeting's own choice is ignored and the setting for all flexible
//   meetings (here off) decides                                -> AL-W, AL-D lock
// - "week" counts from Monday, not the planning week, or locks the next
//   week too, or runs again on another day                    -> AL-W on Sunday 01:30
// - "day" locks the whole week, or a day before its run        -> AL-D on Sunday, Tuesday
// - "off" locks with the setting turned on                     -> AL-O
// - "As in settings" does not follow the setting, or turning the
//   setting on locks the meetings with their own choice too    -> AL-S, AL-O
// - an occurrence placed after the run is locked by it (rule 15),
//   or a meeting turned from off to each day waits a day, or
//   locks at its old time when the same save moves it          -> AL-L, AL-K
// - an auto-locked occurrence moves on a conflict, or stays with no
//   flag and no suggested times (rule 7, acceptance test 9)    -> AL-D Tuesday
// - the choices are lost after a reload                        -> edit form
import { localToUtc } from "../../src/shared/time.ts";
import { day, openSettings, span } from "./automation-helpers.ts";
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
  ZONE,
} from "./fixtures.ts";
import { titled, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

const LOCK = "🔒";
const WARN = "⚠️";
const LONG = { timeout: 60_000 };
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));
type Evs = Awaited<ReturnType<typeof twoWeeks>>;
const iso = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return new Date(localToUtc(ZONE, date, h * 60 + m)).toISOString();
};
const stateOf = (e: Evs[number]) =>
  e.summary.startsWith(WARN)
    ? "conflict"
    : e.summary.startsWith(LOCK) && e.busy
      ? "locked"
      : "open";
/** "<time> <state>" per occurrence of a meeting from weekday `since` of the test week on. */
const states = (l: Evs, title: string, since = 0) =>
  titled(l, title)
    .filter((e) => e.start >= at(day(since), "00:00"))
    .map((e) => `${span(e)} ${stateOf(e)}`);
const weekdays = [0, 1, 2, 3, 4];
/** A daily meeting at `hhmm`: this week's state from `since`, next week open. */
const daily = (hhmm: string, end: string, state: (d: number) => string, since = 0) => [
  ...weekdays.filter((d) => d >= since).map((d) => `${day(d)} ${hhmm}-${end} ${state(d)}`),
  ...weekdays.map((d) => `${day(d + 7)} ${hhmm}-${end} open`),
];
const all = (s: string) => () => s;

test("auto-lock per meeting: each week locks the planning week on its first day, each day locks that day, off never locks, and 'as in settings' follows the setting; a later occurrence stays open until off and on; a locked occurrence keeps its time on a conflict and is flagged with suggested times (MEET-02 rules 7, 14, 15; acceptance test 9)", async ({
  page,
  app,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Moves the server clock (CalDAV only).");
  test.setTimeout(360_000);
  await blockUntil(cal, W);
  await signIn();
  const patch = (body: object) =>
    page.evaluate(
      (b) =>
        fetch("/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b),
        }).then((r) => r.status),
      body,
    );
  // LCK-33: the planning week starts on Sunday.
  expect(await patch({ weekStart: 7 })).toBe(200);
  // The setting for all flexible meetings is off, so only a meeting's own choice locks.
  await openSettings(page);
  const settingsForm = page.getByTestId("auto-lock");
  const chooseSetting = async (value: "off" | "day") => {
    const saved = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === "/api/settings",
    );
    await settingsForm.getByLabel("Flexible meetings").selectOption(value);
    expect((await saved).ok()).toBe(true);
  };
  await chooseSetting("off");

  const meeting = (title: string, idealTime: string, lock: string, notice = "12") =>
    addMeeting(page, {
      title,
      guests: "dana@example.com",
      idealTime,
      more: async (form) => {
        await form.getByLabel("How often").selectOption({ label: "Every day" });
        await form.getByLabel("Move notice (hours)").fill(notice);
        // The default is "As in settings".
        await expect(form.getByLabel("Auto-lock")).toHaveValue("");
        if (lock) await form.getByLabel("Auto-lock").selectOption({ label: lock });
      },
    });
  await meeting("AL-W", "09:00", "Each week");
  await meeting("AL-D", "10:00", "Each day");
  await meeting("AL-S", "11:00", "", "0");
  await meeting("AL-O", "13:00", "Off");
  const placed = (l: Evs) => {
    expect(states(l, "AL-W")).toEqual(daily("09:00", "09:30", all("open")));
    expect(states(l, "AL-D")).toEqual(daily("10:00", "10:30", all("open")));
    expect(states(l, "AL-S")).toEqual(daily("11:00", "11:30", all("open")));
    expect(states(l, "AL-O")).toEqual(daily("13:00", "13:30", all("open")));
  };
  await eventually(() => twoWeeks(cal), placed, 60_000);

  // Sunday 01:30, the first day of the planning week: "each week" locks Monday
  // to Friday of this week, not the next. "Each day" locks Sunday only (none).
  app.env.TEST_CLOCK_START = iso(day(-1), "01:30");
  await app.restart();
  await page.reload();
  const sunday = (l: Evs) => {
    expect(states(l, "AL-W")).toEqual(daily("09:00", "09:30", all("locked")));
    expect(states(l, "AL-D")).toEqual(daily("10:00", "10:30", all("open")));
    expect(states(l, "AL-S")).toEqual(daily("11:00", "11:30", all("open")));
    expect(states(l, "AL-O")).toEqual(daily("13:00", "13:30", all("open")));
  };
  await eventually(() => twoWeeks(cal), sunday, 60_000);
  await planNow(page);
  sunday(await twoWeeks(cal));

  // Tuesday 01:30: "each day" locks Tuesday only; the setting (off) locks nothing.
  app.env.TEST_CLOCK_START = iso(day(1), "01:30");
  await app.restart();
  await page.reload();
  const dayLocked = (d: number) => (d === 1 ? "locked" : "open");
  const tuesday = (l: Evs) => {
    expect(states(l, "AL-W", 1)).toEqual(daily("09:00", "09:30", all("locked"), 1));
    expect(states(l, "AL-D", 1)).toEqual(daily("10:00", "10:30", dayLocked, 1));
    expect(states(l, "AL-S", 1)).toEqual(daily("11:00", "11:30", all("open"), 1));
    expect(states(l, "AL-O", 1)).toEqual(daily("13:00", "13:30", all("open"), 1));
  };
  await eventually(() => twoWeeks(cal), tuesday, 60_000);

  // Rule 7, acceptance test 9: a busy event at both Tuesday occurrences. The
  // open one (AL-S) moves; the locked one (AL-D) keeps its time and is flagged.
  await cal.addEvent({
    title: "Client call",
    start: at(day(1), "10:00"),
    end: at(day(1), "10:30"),
  });
  await cal.addEvent({ title: "Dentist", start: at(day(1), "11:00"), end: at(day(1), "11:30") });
  const conflicted = await eventually(
    () => twoWeeks(cal),
    (l) => {
      expect(states(l, "AL-D", 1)).toEqual(
        daily("10:00", "10:30", (d) => (d === 1 ? "conflict" : "open"), 1),
      );
      const s = titled(l, "AL-S").filter((e) => local(e.start).startsWith(day(1)));
      expect(s.map((e) => local(e.start).slice(0, 10))).toEqual([day(1)]);
      expect(s.map(stateOf)).toEqual(["open"]);
      expect(local(s[0]?.start ?? 0)).not.toBe(`${day(1)} 11:00`);
    },
    60_000,
  );
  const sTuesday = titled(conflicted, "AL-S").find((e) => local(e.start).startsWith(day(1)));
  if (!sTuesday) throw new Error("no AL-S occurrence on Tuesday");
  const sSpan = span(sTuesday);

  await page.getByRole("link", { name: "Meetings" }).click();
  const alD = page.locator('[data-meeting-title="AL-D"]');
  const flag = alD.getByTestId("meeting-flag");
  await expect(flag).toContainText("Locked", LONG);
  await expect(flag).toContainText(`${day(1)} 10:00`);
  await expect(alD.getByTestId("meeting-occurrences")).toContainText("locked");
  await expect(
    page.getByTestId("attention-item").and(page.locator('[data-reason="locked-conflict"]')),
  ).toContainText("AL-D");
  const suggestions = flag.getByTestId("suggestion");
  await expect(suggestions.first()).toBeVisible();
  expect(await suggestions.count()).toBeLessThanOrEqual(3);
  // The open meeting is not flagged.
  await expect(page.locator('[data-meeting-title="AL-S"]').getByTestId("meeting-flag")).toHaveCount(
    0,
  );
  // Acceptance test 9: the same state after a reload.
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(flag).toContainText(`${day(1)} 10:00`, LONG);
  await expect(flag.getByTestId("suggestion").first()).toBeVisible();
  await expect(
    page.getByTestId("attention-item").and(page.locator('[data-reason="locked-conflict"]')),
  ).toContainText("AL-D");

  // The setting for all flexible meetings goes from off to each day: the
  // meetings "as in settings" lock today at once; "off" stays open.
  await openSettings(page);
  await chooseSetting("day");
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const s = titled(l, "AL-S")
        .filter((e) => e.start >= at(day(1), "00:00"))
        .map((e) => `${span(e)} ${stateOf(e)}`);
      expect(s).toEqual([`${sSpan} locked`, ...daily("11:00", "11:30", all("open"), 2)]);
      expect(states(l, "AL-O", 1)).toEqual(daily("13:00", "13:30", all("open"), 1));
      expect(states(l, "AL-W", 1)).toEqual(daily("09:00", "09:30", all("locked"), 1));
    },
    60_000,
  );

  // Rule 15: meetings made after today's run (each day) and this week's run
  // (each week) are placed open and stay open.
  await meeting("AL-L", "15:00", "Each day");
  await meeting("AL-K", "12:00", "Each week");
  const late =
    (tue: "open" | "locked", hhmm = "15:00", end = "15:30") =>
    (l: Evs) =>
      expect(states(l, "AL-L", 1)).toEqual(daily(hhmm, end, (d) => (d === 1 ? tue : "open"), 1));
  const weekly = (l: Evs) =>
    expect(states(l, "AL-K", 1)).toEqual(daily("12:00", "12:30", all("open"), 1));
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      late("open")(l);
      weekly(l);
    },
    60_000,
  );
  await planNow(page);
  await planNow(page);
  late("open")(await twoWeeks(cal));
  weekly(await twoWeeks(cal));
  // Off and then each day again locks today at once (LCK-32).
  const editLock = async (title: string, label: string, idealTime?: string) => {
    await page.getByRole("link", { name: "Meetings" }).click();
    await page
      .locator(`[data-meeting-title="${title}"]`)
      .getByRole("button", { name: "Edit" })
      .click();
    const form = page.getByTestId("meeting-form");
    await form.getByLabel("Auto-lock").selectOption({ label });
    if (idealTime) await form.getByLabel("Ideal time").fill(idealTime);
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "PUT" && new URL(r.url()).pathname.startsWith("/api/meetings/"),
    );
    await form.getByRole("button", { name: "Save meeting" }).click();
    expect((await saved).ok()).toBe(true);
  };
  await editLock("AL-L", "Off");
  await planNow(page);
  late("open")(await twoWeeks(cal));
  // The same save also moves the ideal time: the occurrences take the new
  // time first, then today's locks there, not at the old time (MEET-02 rule 4).
  await editLock("AL-L", "Each day", "16:00");
  await eventually(() => twoWeeks(cal), late("locked", "16:00", "16:30"), 60_000);

  // Apply a suggested time to the flagged occurrence: a move by hand, locked.
  await page.getByRole("link", { name: "Meetings" }).click();
  const first = flag.getByTestId("suggestion").first();
  const target = ((await first.textContent()) ?? "").replace("Move to ", "");
  await first.click();
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const d = titled(l, "AL-D").filter((e) => local(e.start).startsWith(day(1)));
      expect(d.map((e) => `${local(e.start)} ${stateOf(e)}`)).toEqual([`${target} locked`]);
    },
    60_000,
  );

  // The choices persist after a reload.
  await page.reload();
  await page.getByRole("link", { name: "Meetings" }).click();
  await expect(alD.getByTestId("meeting-flag")).toHaveCount(0, LONG);
  for (const [title, value] of [
    ["AL-W", "week"],
    ["AL-D", "day"],
    ["AL-S", ""],
    ["AL-O", "off"],
    ["AL-L", "day"],
    ["AL-K", "week"],
  ] as const) {
    await page
      .locator(`[data-meeting-title="${title}"]`)
      .getByRole("button", { name: "Edit" })
      .click();
    await expect(page.getByTestId("meeting-form").getByLabel("Auto-lock")).toHaveValue(value);
  }
  await openSettings(page);
  await expect(settingsForm.getByLabel("Flexible meetings")).toHaveValue("day");
});
