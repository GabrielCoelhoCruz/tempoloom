// Calendar mirroring: which events get a copy and how a copy looks
// (docs/specs/sync-calendar-mirroring.md rules 9, 19-22, 24, 26-28 and the
// account-level setting for events with no reply).
//
// Ways it can fail, and the test that catches each:
// - the owner's answer or role does not decide free/busy, or the source's
//   free/busy wins over it                                                 -> answers
// - the no-reply setting is missing, is per policy, or does not repaint the
//   copies; its choice is lost on reload                                    -> answers
// - details mode skips free events, or label mode copies them              -> answers
// - details copies miss the location; label copies are not public          -> answers
// - all-day events are copied in the wrong mode, or as timed events        -> all-day
// - "outside work hours" is ignored, cuts an overlapping event, or the
//   checkbox is not saved                                                  -> work hours
// - busy-only copies leak the title or the description; private details
//   copies are not private, or miss the description and location           -> privacy
// - the calendar type does not change the label and the category color     -> type
// - turning a policy off and on leaves a drifted or stale copy, or runs no
//   full check                                                             -> resync
// Every test reads the calendars again and reloads the page.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  addPolicy,
  copies,
  editRaw,
  openSettings,
  policyRow,
  rawEvent,
  week,
} from "./calendar-helpers.ts";
import { addCalDavAccount } from "./delegation-helpers.ts";
import { at, BACKEND, EMAIL, eventually, expect, local, planNow, test } from "./fixtures.ts";
import { W } from "./helpers.ts";
import { putEvent } from "./ics.ts";

const day = (n: number) => addDays(W, n);
const utc = (t: number) =>
  new Date(t)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

test.skip(BACKEND === "google", "Mirroring E2E uses CalDAV calendars.");

/** An event with a free/busy, an organizer and guests, as another calendar app writes it. */
function meeting(
  calendarUrl: string,
  e: {
    title: string;
    start: number;
    end: number;
    free?: boolean;
    location?: string;
    organizer?: string;
    guests?: [string, string][];
  },
) {
  return putEvent(calendarUrl, [
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${e.title}`,
    `TRANSP:${e.free ? "TRANSPARENT" : "OPAQUE"}`,
    ...(e.location ? [`LOCATION:${e.location}`] : []),
    ...(e.organizer ? [`ORGANIZER:mailto:${e.organizer}`] : []),
    ...(e.guests ?? []).map(([email, answer]) => `ATTENDEE;PARTSTAT=${answer}:mailto:${email}`),
  ]);
}

/** [title, busy] of each copy, by start time. */
const facts = (l: Awaited<ReturnType<typeof week>>) => copies(l).map((e) => [e.summary, e.busy]);

async function editPolicy(
  page: Page,
  name: string,
  change: (form: ReturnType<Page["getByTestId"]>) => Promise<unknown>,
) {
  await openSettings(page);
  await policyRow(page, name).getByRole("button", { name: "Edit" }).click();
  const edit = page.getByTestId("mirror-edit");
  await change(edit);
  await edit.getByRole("button", { name: "Save policy" }).click();
  await expect(edit).toHaveCount(0);
}

test("the owner's answer and role decide a copy's free/busy; the no-reply setting applies to every policy; details copy free events (rules 21, 22; account-level setting)", async ({
  page,
  cal,
  signIn,
  people,
  radicale,
}) => {
  const six = radicale?.users[6];
  if (!radicale || !six) throw new Error("This test needs the CalDAV backend.");
  // The source is another account's calendar: an invitation to the destination's
  // own email would already be on the destination (rule 17).
  const extra = await people(6);
  await signIn();
  const side = await cal.newCalendar("Side");
  await addCalDavAccount(page, { ...six, email: extra.email });
  const priv = extra.cal;
  const OWNER = extra.email;
  const from = `Work (${OWNER})`;
  const to = `Work (${EMAIL})`;
  const boss = "boss@example.com";
  // Each source event's own free/busy is the opposite of what its copy must show.
  await meeting(priv.calendarId, {
    title: "Accepted talk",
    start: at(W, "09:00"),
    end: at(W, "10:00"),
    free: true,
    location: "Room 7",
    organizer: boss,
    guests: [
      [boss, "ACCEPTED"],
      [OWNER, "ACCEPTED"],
    ],
  });
  await meeting(priv.calendarId, {
    title: "Maybe talk",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
    free: true,
    organizer: boss,
    guests: [
      [boss, "ACCEPTED"],
      [OWNER, "TENTATIVE"],
    ],
  });
  await meeting(priv.calendarId, {
    title: "Unanswered talk",
    start: at(W, "11:00"),
    end: at(W, "12:00"),
    organizer: boss,
    guests: [
      [boss, "ACCEPTED"],
      [OWNER, "NEEDS-ACTION"],
    ],
  });
  await meeting(priv.calendarId, {
    title: "My workshop",
    start: at(W, "13:00"),
    end: at(W, "14:00"),
    free: true,
    organizer: OWNER,
    guests: [["guest@example.com", "NEEDS-ACTION"]],
  });
  await meeting(priv.calendarId, {
    title: "Optional reading",
    start: at(W, "15:00"),
    end: at(W, "16:00"),
    free: true,
  });
  await meeting(priv.calendarId, {
    title: "Deep work",
    start: at(W, "16:00"),
    end: at(W, "17:00"),
  });

  await addPolicy(page, { from, to, show: "Details" });
  const detailed = await eventually(
    () => week(cal),
    (l) =>
      expect(facts(l)).toEqual([
        ["Accepted talk", true],
        ["Maybe talk", true],
        ["Unanswered talk", false],
        ["My workshop", true],
        ["Optional reading", false],
        ["Deep work", true],
      ]),
  );
  expect(copies(detailed)[0]?.location).toBe("Room 7");
  // A second policy, to show that the no-reply setting applies to every policy.
  const sideTo = "Side";
  await addPolicy(page, { from, to: sideTo, show: "Details" });
  const unanswered = (l: Awaited<ReturnType<typeof week>>) =>
    facts(l).filter(([title]) => title === "Unanswered talk");
  await eventually(
    () => week(side),
    (l) => expect(unanswered(l)).toEqual([["Unanswered talk", false]]),
  );

  // The account-level setting turns copies of unanswered events busy.
  const noReply = page.getByLabel("Copies of events you have not answered");
  await expect(noReply).toHaveValue("free");
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH" && r.ok(),
  );
  await noReply.selectOption({ label: "Show as busy" });
  await saved;
  await eventually(
    () => week(cal),
    (l) =>
      expect(facts(l)).toEqual([
        ["Accepted talk", true],
        ["Maybe talk", true],
        ["Unanswered talk", true],
        ["My workshop", true],
        ["Optional reading", false],
        ["Deep work", true],
      ]),
  );
  await eventually(
    () => week(side),
    (l) => expect(unanswered(l)).toEqual([["Unanswered talk", true]]),
  );
  await page.reload();
  await expect(page.getByLabel("Copies of events you have not answered")).toHaveValue("busy");

  // With a label only, the free event gets no copy; the answered ones keep theirs.
  // A label copy has no details (rule 26). The run deletes the free event's copy
  // before it rewrites the others, so wait for the rewrite too.
  await editPolicy(page, `${from} → ${to}`, (f) =>
    f.getByLabel("Copies show").selectOption({ label: "A label only" }),
  );
  const labelled = await eventually(
    () => week(cal),
    (l) =>
      expect(copies(l).map((e) => [local(e.start), e.summary, e.location ?? ""])).toEqual([
        [`${W} 09:00`, "🏠 Personal commitment", ""],
        [`${W} 10:00`, "🏠 Personal commitment", ""],
        [`${W} 11:00`, "🏠 Personal commitment", ""],
        [`${W} 13:00`, "🏠 Personal commitment", ""],
        [`${W} 16:00`, "🏠 Personal commitment", ""],
      ]),
  );
  // A label copy is public (rule 26).
  const label = copies(labelled)[0];
  const labelRaw = await rawEvent(radicale, label?.id ?? "");
  expect(labelRaw).toContain("CLASS:PUBLIC");
  expect(labelRaw).not.toContain("Room 7");
  await page.reload();
  await expect(page.getByLabel("Copies of events you have not answered")).toHaveValue("busy");
  await expect(policyRow(page, `${from} → ${to}`)).toContainText("label only");
});

test("all-day events: none by default, then busy ones, then all; a copy of an all-day event is all-day (rules 19, 24)", async ({
  page,
  cal,
  signIn,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addAllDay(day(1), "Conference", true);
  await priv.addAllDay(day(2), "Birthday", false);
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  await addPolicy(page, { from: "Private", to: "Work", show: "Details" });
  await eventually(
    () => week(cal),
    (l) => expect(facts(l)).toEqual([["Dentist", true]]),
  );
  await planNow(page);
  expect(facts(await week(cal))).toEqual([["Dentist", true]]);

  await editPolicy(page, "Private → Work", (f) =>
    f.getByLabel("All-day events").selectOption({ label: "Copy busy ones" }),
  );
  const busyOnes = await eventually(
    () => week(cal),
    (l) =>
      expect(facts(l)).toEqual([
        ["Dentist", true],
        ["Conference", true],
      ]),
  );
  const conference = copies(busyOnes).find((e) => e.summary === "Conference");
  expect(conference?.allDay).toBe(true);
  expect(local(conference?.start ?? 0)).toBe(`${day(1)} 00:00`);
  expect(await rawEvent(radicale, conference?.id ?? "")).toContain(
    `DTSTART;VALUE=DATE:${day(1).replace(/-/g, "")}`,
  );

  await editPolicy(page, "Private → Work", (f) =>
    f.getByLabel("All-day events").selectOption({ label: "Copy all" }),
  );
  const everything = await eventually(
    () => week(cal),
    (l) =>
      expect(facts(l)).toEqual([
        ["Dentist", true],
        ["Conference", true],
        ["Birthday", false],
      ]),
  );
  expect(copies(everything).find((e) => e.summary === "Birthday")?.allDay).toBe(true);
  await page.reload();
  await policyRow(page, "Private → Work").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("mirror-edit").getByLabel("All-day events")).toHaveValue("all");
});

test("copy only during work hours: events fully outside are skipped, an overlapping one is copied in full; the checkbox is saved (rule 20)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Early run", start: at(W, "07:00"), end: at(W, "08:00") });
  await priv.addEvent({ title: "Breakfast", start: at(W, "08:30"), end: at(W, "09:30") });
  await priv.addEvent({ title: "Evening class", start: at(W, "18:00"), end: at(W, "19:00") });
  await priv.addEvent({ title: "Market", start: at(day(5), "10:00"), end: at(day(5), "11:00") });

  await openSettings(page);
  await page.getByRole("button", { name: "Refresh calendar list" }).click();
  const form = page.getByTestId("mirror-form");
  await expect(
    form.getByLabel("Copy events from").locator("option", { hasText: "Private" }),
  ).toHaveCount(1);
  await form.getByLabel("Copy events from").selectOption({ label: "Private" });
  await form.getByLabel("To").selectOption({ label: "Work" });
  await expect(form.getByLabel("Copy events outside work hours")).toBeChecked();
  await form.getByLabel("Copy events outside work hours").uncheck();
  await form.getByRole("button", { name: "Add mirroring" }).click();
  await expect(policyRow(page, "Private → Work")).toBeVisible();
  await eventually(
    () => week(cal),
    (l) =>
      expect(copies(l).map((e) => [local(e.start), local(e.end)])).toEqual([
        [`${W} 08:30`, `${W} 09:30`],
      ]),
  );
  await planNow(page);
  expect(copies(await week(cal))).toHaveLength(1);
  await page.reload();
  await policyRow(page, "Private → Work").getByRole("button", { name: "Edit" }).click();
  await expect(
    page.getByTestId("mirror-edit").getByLabel("Copy events outside work hours"),
  ).not.toBeChecked();
  await page.getByTestId("mirror-edit").getByRole("button", { name: "Cancel" }).click();

  await editPolicy(page, "Private → Work", (f) =>
    f.getByLabel("Copy events outside work hours").check(),
  );
  await eventually(
    () => week(cal),
    (l) =>
      expect(copies(l).map((e) => local(e.start))).toEqual([
        `${W} 07:00`,
        `${W} 08:30`,
        `${W} 18:00`,
        `${day(5)} 10:00`,
      ]),
  );
});

test("privacy: busy-only copies say Busy with no details; private details copies keep the details, are marked private, and copy free events as free (rules 22, 26)", async ({
  page,
  cal,
  signIn,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  await signIn();
  const priv = await cal.newCalendar("Private");
  const side = await cal.newCalendar("Side");
  await priv.addEvent({
    title: "Therapy",
    start: at(W, "10:00"),
    end: at(W, "11:00"),
    description: "Room 4, bring the forms",
    location: "Clinic Nord",
  });
  await priv.addEvent({
    title: "Maybe yoga",
    start: at(W, "15:00"),
    end: at(W, "16:00"),
    busy: false,
  });
  await addPolicy(page, { from: "Private", to: "Work", show: '"Busy"' });
  await addPolicy(page, { from: "Private", to: "Side", show: "Details, private" });

  const work = await eventually(
    () => week(cal),
    (l) => expect(facts(l)).toEqual([["Busy", true]]),
  );
  const [busy] = copies(work);
  expect(busy?.description).toBe(
    "Copied by Tempoloom from another calendar. Change the original event, not this copy.",
  );
  expect(busy?.location ?? "").toBe("");
  const busyRaw = await rawEvent(radicale, busy?.id ?? "");
  expect(busyRaw).not.toContain("Therapy");
  expect(busyRaw).not.toContain("CLASS:PRIVATE");

  const details = await eventually(
    () => week(side),
    (l) =>
      expect(facts(l)).toEqual([
        ["Therapy", true],
        ["Maybe yoga", false],
      ]),
  );
  const [therapy, yoga] = copies(details);
  expect(therapy?.description).toContain("Room 4, bring the forms");
  expect(therapy?.location).toBe("Clinic Nord");
  expect(await rawEvent(radicale, therapy?.id ?? "")).toContain("CLASS:PRIVATE");
  expect(await rawEvent(radicale, yoga?.id ?? "")).toContain("CLASS:PRIVATE");

  await page.reload();
  await expect(policyRow(page, "Private → Work")).toContainText("busy only");
  await expect(policyRow(page, "Private → Side")).toContainText("details private");
});

test("the calendar type of a policy sets the label and the category color of its copies (rules 27, 28)", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  const seen = (l: Awaited<ReturnType<typeof week>>) =>
    copies(l).map((e) => [e.summary, e.colorId]);
  await addPolicy(page, { from: "Private", to: "Work" });
  await eventually(
    () => week(cal),
    (l) => expect(seen(l)).toEqual([["🏠 Personal commitment", "3"]]),
  );
  await editPolicy(page, "Private → Work", (f) =>
    f.getByLabel("Label").selectOption({ label: "Work commitment" }),
  );
  await eventually(
    () => week(cal),
    (l) => expect(seen(l)).toEqual([["Work commitment", "2"]]),
  );
  await editPolicy(page, "Private → Work", (f) =>
    f.getByLabel("Label").selectOption({ label: "Travel" }),
  );
  await eventually(
    () => week(cal),
    (l) => expect(seen(l)).toEqual([["Travel", "5"]]),
  );
  await page.reload();
  await policyRow(page, "Private → Work").getByRole("button", { name: "Edit" }).click();
  await expect(page.getByTestId("mirror-edit").getByLabel("Label")).toHaveValue("travel");
});

test("turning a policy off and on runs a full re-sync: a drifted copy and changes made while it was off are all put right (rule 9)", async ({
  page,
  cal,
  signIn,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(W, "10:00"), end: at(W, "11:00") });
  const physio = await priv.addEvent({
    title: "Physio",
    start: at(day(1), "09:00"),
    end: at(day(1), "10:00"),
  });
  const yoga = await priv.addEvent({
    title: "Yoga",
    start: at(day(2), "18:00"),
    end: at(day(2), "19:00"),
  });
  await addPolicy(page, { from: "Private", to: "Work" });
  const first = await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(3),
  );

  // Someone repaints a copy: the regular sync leaves the color alone.
  const dentist = copies(first)[0];
  expect(dentist?.colorId).toBe("3");
  await editRaw(radicale, dentist?.id ?? "", (ics) => ics.replace(/COLOR:[^\r\n]*/, "COLOR:red"));
  await planNow(page);
  await planNow(page);
  expect(copies(await week(cal))[0]?.colorId).not.toBe("3");

  const reconciled = async () =>
    ((await (await page.request.get("/api/mirrors")).json()) as { reconciledAt: number | null })
      .reconciledAt;
  const before = await reconciled();
  expect(before).not.toBeNull();
  await openSettings(page);
  await policyRow(page, "Private → Work").getByRole("button", { name: "Turn off" }).click();
  await expect(policyRow(page, "Private → Work")).toContainText("· off");
  await eventually(
    () => week(cal),
    (l) => expect(copies(l)).toHaveLength(0),
  );
  // While the policy is off, the source changes.
  await priv.update(physio, { start: at(day(1), "11:00"), end: at(day(1), "12:00") });
  await priv.remove(yoga);
  await priv.addEvent({ title: "Haircut", start: at(day(3), "12:00"), end: at(day(3), "13:00") });

  await policyRow(page, "Private → Work").getByRole("button", { name: "Turn on" }).click();
  await expect(policyRow(page, "Private → Work")).not.toContainText("· off");
  await eventually(
    () => week(cal),
    (l) =>
      expect(copies(l).map((e) => [local(e.start), e.colorId])).toEqual([
        [`${W} 10:00`, "3"],
        [`${day(1)} 11:00`, "3"],
        [`${day(3)} 12:00`, "3"],
      ]),
  );
  // Turning it on ran a new full check.
  await expect.poll(reconciled).toBeGreaterThan(before ?? 0);
  await page.reload();
  await expect(policyRow(page, "Private → Work")).not.toContainText("· off");
  await expect(page.getByTestId("mirror-reconciled")).toHaveText(
    /^Last full check: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
  );
});
