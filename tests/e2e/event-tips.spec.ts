// Event tips in managed event descriptions (docs/specs/planning-event-content.md
// CNT-15; AT 3).
//
// Ways this can fail, and the check that catches each:
// - no tip by default, or a tip in the wrong place               -> description order on Radicale
// - a task, habit, focus or meeting event gets no tip            -> each kind's description
// - turning tips off leaves them on future events                -> descriptions in week W after the change
// - the setting is lost on reload, or a plan run brings tips back -> checkbox after reload; replan
// - a tip change writes over the organizer's own description of a
//   meeting occurrence (meetings-flexible-rescheduling.md rule 22) -> organizer test
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { eventProp } from "./automation-list-helpers.ts";
import { openSettings, week } from "./calendar-helpers.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  eventually,
  expect,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, addTask, titled, W } from "./helpers.ts";
import { addMeeting, editRaw, rawEvent } from "./meeting-helpers.ts";

const TIP = "Tempoloom tip:";
const tipsBox = (page: Page) => page.getByLabel("Add tips to event descriptions");

/**
 * Turns tips on or off in Settings and waits for the whole save: the PATCH,
 * the plan run and the reload of the settings. Until the reload, a render
 * can show the old value again, and a click then sends the old value.
 */
async function setTips(page: Page, on: boolean): Promise<void> {
  await openSettings(page);
  await expect(tipsBox(page)).toBeChecked({ checked: !on });
  let patched = false;
  const reloaded = page.waitForResponse((r) => {
    const method = r.request().method();
    if (r.url().endsWith("/api/settings") && method === "PATCH" && r.ok()) patched = true;
    return patched && r.url().endsWith("/api/settings") && method === "GET" && r.ok();
  });
  // A click, not setChecked: the box shows the saved value again while the save runs.
  await tipsBox(page).click();
  await reloaded;
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await expect(tipsBox(page)).toBeChecked({ checked: on });
}

test("event tips sit between the notes and the planner link on task, habit, focus and meeting events, and turning them off removes them from future events (CNT-15; AT 3)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  await expect(tipsBox(page)).toBeChecked();
  await page.getByRole("button", { name: "Protect 10 hours of focus time per week" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  await addTask(page, {
    title: "AT-C3 task",
    minutes: 60,
    split: false,
    due: "",
    notes: "Bring notes",
  });
  await addHabit(page, { title: "AT-C3 habit", min: 30, max: 30, days: ["Tue", "Thu"] });
  await addMeeting(page, { title: "AT-C3", guests: "dana@example.com" });
  const kinds = (l: Awaited<ReturnType<typeof week>>) => ({
    habit: titled(l, "AT-C3 habit"),
    focus: titled(l, "Focus time"),
    meeting: titled(l, "AT-C3").filter((e) => !/task|habit/.test(e.summary)),
  });
  await eventually(
    () => week(cal),
    (l) => {
      const task = titled(l, "AT-C3 task")[0]?.description ?? "";
      const notes = task.indexOf("Bring notes");
      const tip = task.indexOf(TIP);
      expect(notes).toBeGreaterThanOrEqual(0);
      expect(tip).toBeGreaterThan(notes);
      expect(task.indexOf("Open in Tempoloom:")).toBeGreaterThan(tip);
      const { habit, focus, meeting } = kinds(l);
      for (const [events, word] of [
        [habit, "finds another time"],
        [focus, "skip this focus time"],
        [meeting, "decline"],
      ] as const) {
        expect(events.length).toBeGreaterThan(0);
        for (const e of events) {
          expect(e.description).toContain(TIP);
          expect(e.description).toContain(word);
        }
      }
      for (const e of [...habit, ...focus])
        expect(e.description.indexOf("Open in Tempoloom:")).toBeGreaterThan(
          e.description.indexOf(TIP),
        );
    },
  );

  await setTips(page, false);
  await eventually(
    () => week(cal),
    (l) => {
      const { habit, focus, meeting } = kinds(l);
      const ours = [...titled(l, "AT-C3 task"), ...habit, ...focus, ...meeting];
      expect(habit.length * focus.length * meeting.length).toBeGreaterThan(0);
      for (const e of ours) expect(e.description).not.toContain(TIP);
      expect(titled(l, "AT-C3 task")[0]?.description).toContain("Bring notes");
    },
  );
  await page.reload();
  await expect(tipsBox(page)).not.toBeChecked();
  await planNow(page);
  for (const e of [...titled(await week(cal), "AT-C3")]) expect(e.description).not.toContain(TIP);
});

const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(addDays(W, 14), "00:00"));

test("turning tips off and on keeps the organizer's own description of a meeting occurrence; an occurrence with Tempoloom's text gets the change (CNT-15; MEET-02 rule 22)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "The organizer edit writes a raw iCalendar object to CalDAV.");
  await blockUntil(cal, W);
  await signIn();
  await addMeeting(page, { title: "AT-Tips sync", guests: "dana@example.com" });
  let ids: string[] = [];
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const occ = titled(l, "AT-Tips sync").sort((a, b) => a.start - b.start);
      expect(occ.length).toBeGreaterThan(1);
      for (const e of occ) expect(e.description).toContain(TIP);
      ids = occ.map((e) => e.id);
    },
  );
  const [edited, other] = ids as [string, string];
  // The organizer types an agenda over the description in another calendar app.
  await editRaw(cal.calendarId, edited, (lines) =>
    lines.flatMap((l) =>
      l.startsWith("DESCRIPTION")
        ? []
        : l.startsWith("SUMMARY:")
          ? [l, "DESCRIPTION:Bring the Q3 numbers"]
          : [l],
    ),
  );
  const descriptions = async () =>
    Promise.all(
      [edited, other].map(async (id) =>
        eventProp(await rawEvent(cal.calendarId, id), "DESCRIPTION"),
      ),
    );

  await setTips(page, false);
  await eventually(descriptions, ([e, o]) => {
    expect(o).not.toContain(TIP);
    expect(e).toBe("Bring the Q3 numbers");
  });
  await setTips(page, true);
  await eventually(descriptions, ([e, o]) => {
    expect(o).toContain(TIP);
    expect(e).toBe("Bring the Q3 numbers");
  });

  await page.reload();
  await planNow(page);
  expect((await descriptions())[0]).toBe("Bring the Q3 numbers");
});
