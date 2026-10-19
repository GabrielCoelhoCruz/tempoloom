// Buffer filters (docs/specs/buffers-automation.md rules 3, 4, 7, event filter,
// calendar_scope, edge case 3; buffers-travel.md rule 13;
// automations-library.md entries 2 and 27): the filter editor with a
// plain-language description and a live list of matching events, filters by
// person, calendar scope, a buffer after a run of meetings, and mirrored
// copies that hide their details.
//
// Ways it can fail, and the check that catches each:
// - the executive prep entry saves without a person                -> the form refuses
// - a description is misread, or a condition (people, count, length, category,
//   exact title, text, tag) matches the wrong events               -> live list per description
// - unknown words are dropped silently                             -> the form names them
// - the live list does not follow a manual change                  -> list after clearing a field
// - the saved buffer uses another filter than the one shown        -> buffers on the calendar
// - a buffer for one calendar takes meetings from another, or "all" skips one
//                                                                  -> buffers per calendar
// - a run of back-to-back meetings gets a buffer between its meetings, a short
//   run gets one, or a long run gets none                          -> one buffer after the long run
// - a mirrored copy that hides its details gives travel time from its hidden
//   tag, or a copy with details gives none                         -> travel buffers per copy
// - settings are lost on reload                                    -> rows after reload
import type { Page } from "@playwright/test";
import { day, openLibrary, openSettings, span, week } from "./automation-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, test } from "./fixtures.ts";
import { titled, W } from "./helpers.ts";

test.skip(BACKEND === "google", "These scenarios use guests and several CalDAV calendars.");

const editorOf = (page: Page) => page.getByTestId("buffer-editor");
const matchTitles = (page: Page) =>
  editorOf(page).getByTestId("filter-matches").locator("[data-match] .match-title");

async function describe(page: Page, text: string) {
  const editor = editorOf(page);
  await editor.getByLabel("Describe the events").fill(text);
  await editor.getByRole("button", { name: "Use description" }).click();
}

test("the executive prep entry needs people; a plain-language description fills the filter; the live list follows every change; saving places the buffers (rules 3, 4; event filter; library entry 2)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const tue = day(1);
  await cal.addEvent({
    title: "Board review",
    start: at(tue, "10:00"),
    end: at(tue, "11:00"),
    attendees: ["ceo@corp.example", "cfo@corp.example"],
  });
  await cal.addEvent({
    title: "Quick sync",
    start: at(tue, "14:00"),
    end: at(tue, "14:15"),
    attendees: ["ceo@corp.example"],
  });
  await cal.addEvent({
    title: "Team standup",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
    attendees: ["bob@tempoloom.test", "eve@tempoloom.test"],
    description: "Daily #standup",
  });
  await cal.addEvent({
    title: "Partner call",
    start: at(day(3), "15:00"),
    end: at(day(3), "15:45"),
    attendees: ["ana@partner.example"],
  });
  await signIn();
  await openLibrary(page);
  const entry = page.locator('[data-entry="Prep before executive meetings"]');
  await expect(entry).not.toContainText("Needs a buffer filter by person");
  await entry.getByRole("button", { name: "Use" }).click();
  const editor = editorOf(page);
  await expect(editor.getByLabel("Title")).toHaveValue("Prep before executive meetings");
  await expect(editor.getByLabel("Side")).toHaveValue("before");
  await expect(editor.getByLabel("Minutes before")).toHaveValue("15");
  await expect(editor.getByLabel("Priority")).toHaveValue("2");
  await editor.getByRole("button", { name: "Add buffer" }).click();
  await expect(editor.getByRole("alert")).toHaveText("Add at least one person.");

  // Each description sets the conditions; the live list shows what they match.
  const cases: [string, string[]][] = [
    ["meetings with ceo@corp.example", ["Board review", "Quick sync"]],
    ["meetings with 3 or more people", ["Board review", "Team standup"]],
    ["external meetings", ["Board review", "Quick sync", "Partner call"]],
    ['titled "Team standup"', ["Team standup"]],
    ['containing "sync"', ["Quick sync"]],
    ["tagged #standup", ["Team standup"]],
    ["events shorter than 30 minutes", ["Quick sync"]],
  ];
  for (const [text, titles] of cases) {
    await describe(page, text);
    await expect(matchTitles(page)).toHaveText(titles);
  }
  await describe(page, "meetings on Mars");
  await expect(editor.getByRole("alert")).toHaveText("Not understood: “on Mars”.");

  await describe(page, "meetings with ceo@corp.example longer than 30 minutes");
  await expect(editor.getByLabel("With people")).toHaveValue("ceo@corp.example");
  await expect(editor.getByLabel("Length")).toHaveValue(">");
  await expect(editor.getByLabel("Length (minutes)")).toHaveValue("30");
  await expect(matchTitles(page)).toHaveText(["Board review"]);
  // A manual change updates the list at once.
  await editor.getByLabel("Length (minutes)").fill("");
  await expect(matchTitles(page)).toHaveText(["Board review", "Quick sync"]);
  await editor.getByLabel("Length (minutes)").fill("30");
  await expect(matchTitles(page)).toHaveText(["Board review"]);
  await editor.getByRole("button", { name: "Add buffer" }).click();
  await expect(page.locator('[data-buffer-title="Prep before executive meetings"]')).toBeVisible();

  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Prep before executive meetings").map(span)).toEqual([`${tue} 09:45-10:00`]),
  );
  await openLibrary(page);
  await expect(entry).toContainText("Added");
  await page.reload();
  await expect(entry).toContainText("Added");
});

test("calendar scope: a buffer for one calendar skips meetings on other calendars; all calendars covers them (calendar_scope; edge case 3)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const side = await cal.newCalendar("Side");
  await cal.addEvent({
    title: "Main meeting",
    start: at(day(1), "10:00"),
    end: at(day(1), "11:00"),
    attendees: ["ana@example.com"],
  });
  await side.addEvent({
    title: "Side meeting",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
    attendees: ["ana@example.com"],
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  const sideRow = page.getByTestId("calendar-list").locator("label", { hasText: "Side" });
  await sideRow.getByRole("checkbox").check();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");

  const editor = editorOf(page);
  const add = async (title: string, calendars: string, titles: string[]) => {
    await editor.getByLabel("Title").fill(title);
    await editor.getByLabel("Side").selectOption("after");
    await editor.getByLabel("Minutes after").fill("15");
    await describe(page, "meetings with 2 or more people");
    await editor.getByLabel("Calendars").selectOption({ label: calendars });
    await expect(matchTitles(page)).toHaveText(titles);
    await editor.getByRole("button", { name: "Add buffer" }).click();
    await expect(page.locator(`[data-buffer-title="${title}"]`)).toBeVisible();
  };
  await add("Work recovery", "Work", ["Main meeting"]);
  await add("Any recovery", "All calendars", ["Main meeting", "Side meeting"]);
  // Both want 11:00 on Tuesday; the first one keeps it (same priority, earlier rank).
  await eventually(
    () => week(cal),
    (l) => {
      expect(titled(l, "Work recovery").map(span)).toEqual([`${day(1)} 11:00-11:15`]);
      expect(titled(l, "Any recovery").map(span)).toEqual([`${day(2)} 11:00-11:15`]);
    },
  );
  await page.reload();
  await expect(page.locator('[data-buffer-title="Work recovery"]')).toContainText("Work only");
  await expect(page.locator('[data-buffer-title="Any recovery"]')).toContainText("all calendars");
});

test("the meeting runs entry adds recovery after a run of back-to-back meetings longer than 90 minutes only (library entry 27)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const meeting = (n: number, from: string, to: string) =>
    cal.addEvent({
      title: "Call",
      start: at(day(n), from),
      end: at(day(n), to),
      attendees: ["ana@example.com"],
    });
  await meeting(1, "10:00", "11:00");
  await meeting(1, "11:00", "12:00");
  await meeting(2, "10:00", "11:00");
  await meeting(3, "14:00", "14:45");
  await meeting(3, "14:45", "15:30");
  await signIn();
  await openLibrary(page);
  const entry = page.locator('[data-entry="Breaks after meeting runs"]');
  await expect(entry).not.toContainText("Needs a buffer after a run");
  await entry.getByRole("button", { name: "Add" }).click();
  await expect(entry).toContainText("Added");
  // Tuesday's run is 120 minutes; Wednesday's single hour and Thursday's 90 minutes are not longer.
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Breaks after meeting runs").map(span)).toEqual([`${day(1)} 12:00-12:15`]),
  );
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Breaks after meeting runs").map(span)).toEqual([
    `${day(1)} 12:00-12:15`,
  ]);
  await page.reload();
  await expect(entry).toContainText("Added");
});

test("travel time follows what a mirrored copy shows: a copy with details gets it from its tag, a busy-only copy does not (buffers-travel rule 13)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  const club = await cal.newCalendar("Club");
  const priv = await cal.newCalendar("Private");
  await club.addEvent({
    title: "Match",
    start: at(day(2), "10:00"),
    end: at(day(2), "11:00"),
    description: "Away game #tl_travel",
  });
  await priv.addEvent({
    title: "Doctor",
    start: at(day(3), "10:00"),
    end: at(day(3), "11:00"),
    description: "Clinic visit #tl_travel",
  });
  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  await expect(page.getByTestId("calendar-list")).toContainText("Private");
  const mirror = async (from: string, visibility: string) => {
    const form = page.getByTestId("mirror-form");
    await form.getByLabel("Copy events from").selectOption({ label: from });
    await form.getByLabel("To").selectOption({ label: "Work" });
    await form.getByLabel("Copies show").selectOption({ label: visibility });
    await form.getByRole("button", { name: "Add mirroring" }).click();
    await expect(page.getByTestId("mirror-list")).toContainText(`${from} → Work`);
  };
  await mirror("Club", "Details");
  await mirror("Private", '"Busy"');
  await eventually(
    () => week(cal),
    (l) => {
      const copies = l.filter((e) => e.privateProps.tl_key?.startsWith("mirror:"));
      expect(copies.map((e) => e.summary).sort()).toEqual(["Busy", "Match"]);
    },
  );

  const editor = editorOf(page);
  await editor.getByLabel("Title").fill("Travel");
  await editor.getByLabel("Side").selectOption("both");
  await editor.getByLabel("Minutes before").fill("30");
  await editor.getByLabel("Minutes after").fill("30");
  await editor.getByLabel("At an address or tagged #tl_travel").check();
  await editor.getByLabel("Calendars").selectOption({ label: "Work" });
  await expect(matchTitles(page)).toHaveText(["Match"]);
  await editor.getByRole("button", { name: "Add buffer" }).click();
  await eventually(
    () => week(cal),
    (l) =>
      expect(titled(l, "Travel").map(span)).toEqual([
        `${day(2)} 09:30-10:00`,
        `${day(2)} 11:00-11:30`,
      ]),
  );
  await page.waitForTimeout(6000);
  expect(titled(await week(cal), "Travel").map(span)).toEqual([
    `${day(2)} 09:30-10:00`,
    `${day(2)} 11:00-11:30`,
  ]);
  await page.reload();
  await expect(page.locator('[data-buffer-title="Travel"]')).toContainText("Work only");
});
