// Flexible meeting edits in the calendar by the organizer
// (docs/specs/meetings-flexible-rescheduling.md rules 21-23).
//
// Ways it can fail, and the test that catches each:
// - a visibility (CLASS) edit in the calendar is kept instead of written
//   back from the meeting's event settings                            -> privacy
// - the write-back of visibility or free/busy rewrites the whole event and
//   puts back the organizer's description, location, color, note or guests  -> privacy
// - an automatic move, a lock or an unlock rewrites the whole occurrence
//   and drops the organizer's edits                                   -> move
// - a description edit locks the occurrence, freezes its title, or is
//   written over after lock and unlock; a later form edit of the
//   description does not reach it (rule 23)                           -> description
// - a visibility or guest change in the meeting settings rewrites the
//   whole occurrence: the organizer's edits go and the guest the
//   organizer added is removed (a cancel the organizer did not send)  -> settings

import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { eventProp, fillEventSettings } from "./automation-list-helpers.ts";
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
import { openWeek, titled, W } from "./helpers.ts";
import { editRaw, rawEvent } from "./meeting-helpers.ts";

test.skip(BACKEND === "google", "Meeting E2E writes raw iCalendar objects to CalDAV.");

const day = (n: number) => addDays(W, n);
const twoWeeks = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(14), "00:00"));

/** The fields of an occurrence that the organizer edits in the calendar. */
const fields = (ics: string) => ({
  class: eventProp(ics, "CLASS"),
  transp: eventProp(ics, "TRANSP"),
  description: eventProp(ics, "DESCRIPTION"),
  location: eventProp(ics, "LOCATION"),
  color: eventProp(ics, "COLOR"),
  note: eventProp(ics, "COMMENT"),
  erin: ics.toLowerCase().includes("mailto:erin@example.com"),
});

/** The guests of an occurrence, sorted. */
const guests = (ics: string) =>
  [...ics.matchAll(/^ATTENDEE[^:]*:mailto:(.+)$/gim)]
    .map((m) => (m[1] ?? "").trim().toLowerCase())
    .sort();

/** The organizer's edits of description, location, color, note and guests. */
const ORGANIZER_EDITS = [
  "DESCRIPTION:Bring the Q3 numbers",
  "LOCATION:Room 9",
  "COLOR:tomato",
  "COMMENT:Running 5 minutes late",
  "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:erin@example.com",
];

/** Puts `extra` after the SUMMARY of the event and drops the lines it replaces. */
const organizerEdit = (extra: string[]) => (lines: string[]) => {
  const names = new Set(extra.map((l) => /^[A-Z-]+/.exec(l)?.[0]).filter((n) => n !== "ATTENDEE"));
  let inAlarm = false;
  return lines.flatMap((l) => {
    if (l.startsWith("BEGIN:VALARM")) inAlarm = true;
    if (l.startsWith("END:VALARM")) inAlarm = false;
    const name = /^[A-Z-]+/.exec(l)?.[0] ?? "";
    if (!inAlarm && names.has(name)) return [];
    return !inAlarm && l.startsWith("SUMMARY:") ? [l, ...extra] : [l];
  });
};

/** Adds the weekly "Review" meeting: always busy and private. */
async function addReview(page: Page, guestList: string) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("Review");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(guestList);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  await form.getByLabel("Show as").selectOption({ label: "Always busy" });
  await fillEventSettings(form, { visibility: "Private" });
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Review"]')).toBeVisible();
}

/** The ids of this week's and next week's occurrences, once both are at Tuesday 10:00. */
async function occurrences(cal: CalendarDriver): Promise<[string, string]> {
  let ids: [string, string] = ["", ""];
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const occ = (d: string) => titled(l, "Review").find((e) => local(e.start).startsWith(d));
      expect([local(occ(day(1))?.start ?? 0), local(occ(day(8))?.start ?? 0)]).toEqual([
        `${day(1)} 10:00`,
        `${day(8)} 10:00`,
      ]);
      ids = [occ(day(1))?.id ?? "", occ(day(8))?.id ?? ""];
    },
  );
  return ids;
}

/** Opens the meeting's edit form. */
async function editReview(page: Page) {
  await page.getByRole("link", { name: "Meetings" }).click();
  await page.locator('[data-meeting-title="Review"]').getByRole("button", { name: "Edit" }).click();
  const form = page.getByTestId("meeting-form");
  await expect(form.getByLabel("Title")).toHaveValue("Review");
  return form;
}

/** Clicks Lock or Unlock on the occurrence in the planner. */
async function lockAction(page: Page, name: "Lock" | "Unlock") {
  await openWeek(page);
  await page.locator(".ev-meeting", { hasText: "Review" }).first().click();
  await page.getByTestId("event-drawer").getByRole("button", { name }).click();
}

test("privacy and free/busy edits in the calendar are written back from the meeting's event settings; the organizer's description, location, color, note and guest edits are kept (MEET-02 rule 22)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill("Review");
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  await form.getByLabel("Show as").selectOption({ label: "Always busy" });
  await fillEventSettings(form, { visibility: "Private" });
  await form.getByRole("button", { name: "Add meeting" }).click();
  await expect(page.locator('[data-meeting-title="Review"]')).toBeVisible();

  let id = "";
  let next = "";
  await eventually(
    () => twoWeeks(cal),
    (l) => {
      const occ = (d: string) => titled(l, "Review").find((e) => local(e.start).startsWith(d));
      expect([local(occ(day(1))?.start ?? 0), local(occ(day(8))?.start ?? 0)]).toEqual([
        `${day(1)} 10:00`,
        `${day(8)} 10:00`,
      ]);
      id = occ(day(1))?.id ?? "";
      next = occ(day(8))?.id ?? "";
    },
  );
  for (const e of [id, next])
    expect(fields(await rawEvent(cal.calendarId, e))).toMatchObject({
      class: "PRIVATE",
      transp: "OPAQUE",
    });

  // A visibility edit alone: Tempoloom writes its own value back.
  await editRaw(cal.calendarId, next, (lines) =>
    lines.map((l) => (l.startsWith("CLASS:") ? "CLASS:PUBLIC" : l)),
  );
  await eventually(
    async () => eventProp(await rawEvent(cal.calendarId, next), "CLASS"),
    (c) => expect(c).toBe("PRIVATE"),
    60_000,
  );

  // The organizer makes the occurrence public and free, and edits the
  // description, the location, the color, the note and the guest list.
  await editRaw(cal.calendarId, id, (lines) => [
    ...lines.flatMap((l) =>
      /^(CLASS|TRANSP|DESCRIPTION|LOCATION|COLOR|COMMENT)[:;]/.test(l)
        ? []
        : l.startsWith("SUMMARY:")
          ? [
              l,
              "CLASS:PUBLIC",
              "TRANSP:TRANSPARENT",
              "DESCRIPTION:Bring the Q3 numbers",
              "LOCATION:Room 9",
              "COLOR:tomato",
              "COMMENT:Running 5 minutes late",
              "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:erin@example.com",
            ]
          : [l],
    ),
  ]);
  const kept = {
    class: "PRIVATE",
    transp: "OPAQUE",
    description: "Bring the Q3 numbers",
    location: "Room 9",
    color: "tomato",
    note: "Running 5 minutes late",
    erin: true,
  };
  await eventually(
    async () => fields(await rawEvent(cal.calendarId, id)),
    (f) => expect(f).toEqual(kept),
    60_000,
  );

  // Later plan runs and a reload keep it so, at the same time.
  await planNow(page);
  await planNow(page);
  await page.reload();
  await expect(page.locator('[data-meeting-title="Review"]')).toBeVisible();
  expect(fields(await rawEvent(cal.calendarId, id))).toEqual(kept);
  const after = titled(await twoWeeks(cal), "Review").find((e) => e.id === id);
  expect([local(after?.start ?? 0), local(after?.end ?? 0).slice(11), after?.busy]).toEqual([
    `${day(1)} 10:00`,
    "10:30",
    true,
  ]);
});

test("an automatic move, a lock and an unlock after the organizer's edits write only Tempoloom's own fields: the description, location, color, note and added guest stay (MEET-02 rules 21, 22, 37)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addReview(page, "dana@example.com");
  const [id] = await occurrences(cal);
  await editRaw(cal.calendarId, id, organizerEdit(ORGANIZER_EDITS));
  const kept = {
    class: "PRIVATE",
    transp: "OPAQUE",
    description: "Bring the Q3 numbers",
    location: "Room 9",
    color: "tomato",
    note: "Running 5 minutes late",
    erin: true,
  };
  const state = async () => {
    const e = titled(await twoWeeks(cal), "Review").find((x) => x.id === id);
    const ics = await rawEvent(cal.calendarId, id);
    return {
      summary: e?.summary ?? "",
      start: local(e?.start ?? 0),
      ...fields(ics),
      guests: guests(ics),
    };
  };
  await planNow(page);
  expect(await state()).toMatchObject({ ...kept, start: `${day(1)} 10:00` });

  // A clash moves the occurrence (an automatic move, rule 37).
  await cal.addEvent({ title: "Clash", start: at(day(1), "10:00"), end: at(day(1), "10:30") });
  const moved = await eventually(
    state,
    (s) => {
      expect(s.start).not.toBe(`${day(1)} 10:00`);
      expect(s.start.slice(0, 10)).toBe(day(1));
      expect(s).toMatchObject({ ...kept, guests: ["dana@example.com", "erin@example.com"] });
    },
    60_000,
  );

  // Lock and unlock from the planner change the title marker only.
  await lockAction(page, "Lock");
  await eventually(state, (s) => {
    expect(s.summary).toBe("🔒 Review");
    expect(s).toMatchObject({ ...kept, start: moved.start });
  });
  await lockAction(page, "Unlock");
  await eventually(state, (s) => {
    expect(s.summary).not.toContain("🔒");
    expect(s).toMatchObject({ ...kept, guests: ["dana@example.com", "erin@example.com"] });
  });

  await page.reload();
  await expect(page.locator(".ev-meeting", { hasText: "Review" }).first()).toBeVisible();
  await planNow(page);
  expect(await state()).toMatchObject(kept);
});

test("a description edit alone in the calendar is kept with no lock and no write; lock and unlock keep it, and a later description edit in the form reaches every occurrence (MEET-02 rules 21-23)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addReview(page, "dana@example.com");
  const [id, next] = await occurrences(cal);
  const before = titled(await twoWeeks(cal), "Review").find((e) => e.id === id)?.summary ?? "";
  expect(before).not.toContain("🔒");
  await editRaw(cal.calendarId, id, organizerEdit(["DESCRIPTION:Bring the Q3 numbers"]));
  const edited = await rawEvent(cal.calendarId, id);
  const state = async () => {
    const e = titled(await twoWeeks(cal), "Review").find((x) => x.id === id);
    const ics = await rawEvent(cal.calendarId, id);
    return { summary: e?.summary ?? "", description: eventProp(ics, "DESCRIPTION"), ics };
  };

  // Two plan runs: no lock, no write (the stored object is the organizer's).
  await planNow(page);
  await planNow(page);
  expect(await rawEvent(cal.calendarId, id)).toBe(edited);
  await openWeek(page);
  await expect(page.locator(".ev-meeting", { hasText: "Review" }).first()).toBeVisible();
  await expect(page.locator(".ev-meeting.ev-locked", { hasText: "Review" })).toHaveCount(0);

  await lockAction(page, "Lock");
  await eventually(state, (s) =>
    expect([s.summary, s.description]).toEqual(["🔒 Review", "Bring the Q3 numbers"]),
  );
  await lockAction(page, "Unlock");
  await eventually(state, (s) =>
    expect([s.summary, s.description]).toEqual([before, "Bring the Q3 numbers"]),
  );
  await planNow(page);
  expect((await state()).description).toBe("Bring the Q3 numbers");

  // Rule 23: a description edit in the form applies to this and the following occurrences.
  const form = await editReview(page);
  await form.getByLabel("Description").fill("Agenda v2");
  await form.getByRole("button", { name: "Save meeting" }).click();
  await eventually(
    async () =>
      Promise.all(
        [id, next].map(async (e) => eventProp(await rawEvent(cal.calendarId, e), "DESCRIPTION")),
      ),
    (d) => {
      for (const x of d) expect(x).toMatch(/^Agenda v2/);
    },
    60_000,
  );
});

test("a visibility change and a guest removal in the meeting settings write only those fields: the organizer's description, location, color, note and added guest stay (MEET-02 rule 22)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addReview(page, "dana@example.com, bob@example.com");
  const [id] = await occurrences(cal);
  await editRaw(cal.calendarId, id, organizerEdit(ORGANIZER_EDITS));
  const kept = {
    description: "Bring the Q3 numbers",
    location: "Room 9",
    color: "tomato",
    note: "Running 5 minutes late",
  };
  const state = async () => {
    const ics = await rawEvent(cal.calendarId, id);
    return { ...fields(ics), guests: guests(ics) };
  };
  await planNow(page);
  expect(await state()).toMatchObject({
    ...kept,
    class: "PRIVATE",
    guests: ["bob@example.com", "dana@example.com", "erin@example.com"],
  });

  let form = await editReview(page);
  await fillEventSettings(form, { visibility: "Public" });
  await form.getByRole("button", { name: "Save meeting" }).click();
  await eventually(
    state,
    (s) =>
      expect(s).toMatchObject({
        ...kept,
        class: "PUBLIC",
        guests: ["bob@example.com", "dana@example.com", "erin@example.com"],
      }),
    60_000,
  );

  // Removing Bob in Tempoloom removes Bob only: Erin, whom the organizer added, stays.
  form = await editReview(page);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill("dana@example.com");
  await form.getByRole("button", { name: "Save meeting" }).click();
  await eventually(
    state,
    (s) =>
      expect(s).toMatchObject({
        ...kept,
        class: "PUBLIC",
        guests: ["dana@example.com", "erin@example.com"],
      }),
    60_000,
  );

  await page.reload();
  await expect(page.locator('[data-meeting-title="Review"]')).toBeVisible();
  await planNow(page);
  expect(await state()).toMatchObject({
    ...kept,
    class: "PUBLIC",
    guests: ["dana@example.com", "erin@example.com"],
  });
});
