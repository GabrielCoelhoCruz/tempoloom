// Event tips in managed event descriptions (docs/specs/planning-event-content.md
// CNT-15; AT 3).
//
// Ways this can fail, and the check that catches each:
// - no tip by default, or a tip in the wrong place               -> description order on Radicale
// - turning tips off leaves them on future events                -> descriptions in week W after the change
// - the setting is lost on reload, or a plan run brings tips back -> checkbox after reload; replan
import type { Page } from "@playwright/test";
import { openSettings, week } from "./calendar-helpers.ts";
import { blockUntil, eventually, expect, planNow, test } from "./fixtures.ts";
import { addTask, titled, W } from "./helpers.ts";
import { addMeeting } from "./meeting-helpers.ts";

const TIP = "Tempoloom tip:";
const tipsBox = (page: Page) => page.getByLabel("Add tips to event descriptions");

test("event tips sit between the notes and the planner link, and turning them off removes them from future events (CNT-15; AT 3)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await openSettings(page);
  await expect(tipsBox(page)).toBeChecked();

  await addTask(page, {
    title: "AT-C3 task",
    minutes: 60,
    split: false,
    due: "",
    notes: "Bring notes",
  });
  await addMeeting(page, { title: "AT-C3", guests: "dana@example.com" });
  await eventually(
    () => week(cal),
    (l) => {
      const task = titled(l, "AT-C3 task")[0]?.description ?? "";
      const notes = task.indexOf("Bring notes");
      const tip = task.indexOf(TIP);
      expect(notes).toBeGreaterThanOrEqual(0);
      expect(tip).toBeGreaterThan(notes);
      expect(task.indexOf("Open in Tempoloom:")).toBeGreaterThan(tip);
      const meetings = titled(l, "AT-C3").filter((e) => !e.summary.includes("task"));
      expect(meetings.length).toBeGreaterThan(0);
      for (const m of meetings) {
        expect(m.description).toContain(TIP);
        expect(m.description).toContain("decline");
      }
    },
  );

  await openSettings(page);
  await tipsBox(page).uncheck();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
  await eventually(
    () => week(cal),
    (l) => {
      const ours = [...titled(l, "AT-C3 task"), ...titled(l, "AT-C3")];
      expect(ours.length).toBeGreaterThan(1);
      for (const e of ours) expect(e.description).not.toContain(TIP);
      expect(titled(l, "AT-C3 task")[0]?.description).toContain("Bring notes");
    },
  );
  await page.reload();
  await expect(tipsBox(page)).not.toBeChecked();
  await planNow(page);
  for (const e of [...titled(await week(cal), "AT-C3")]) expect(e.description).not.toContain(TIP);
});
