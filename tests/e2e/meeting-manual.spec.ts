// Flexible meeting edits in the calendar by the organizer
// (docs/specs/meetings-flexible-rescheduling.md rule 22).
//
// Ways it can fail, and the test that catches each:
// - a visibility (CLASS) edit in the calendar is kept instead of written
//   back from the meeting's event settings                            -> privacy
// - the write-back of visibility or free/busy rewrites the whole event and
//   puts back the organizer's description, location, color, note or guests  -> privacy
// - a later plan run puts back the description edit                   -> privacy
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
import { titled, W } from "./helpers.ts";
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
  expect(eventProp(await rawEvent(cal.calendarId, next), "CLASS")).toBe("PUBLIC");
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
