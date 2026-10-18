// Team links and round-robin links (docs/specs/booking-links-team.md).
// Each team member is a Radicale user; Radicale delivers no invitations, so
// every check reads each person's own calendar.
//
// Ways this can fail:
//  1. A team link offers a time when one required organizer is busy or outside
//     the hours chosen for them on the link.                          (rules 2, 4, 6)
//  2. A booking reaches only the host: other organizers are not guests, their
//     calendars get nothing, and their schedulers keep managed events under it.
//                                                                       (rules 8, 25)
//  3. An optional organizer's busy time still blocks the link, or the optional
//     organizer is invited as required, or not invited at all.         (rule 3)
//  4. The event is written to the creator's calendar when another organizer
//     is host, or the host is not the event organizer.                  (rule 9)
//  5. The recovery buffer check uses only one organizer's buffer, or cannot be
//     turned off.                                                       (rule 7)
//  6. A co-organizer cannot find or change the link, or can change its URL,
//     page, or delete it (UI or API).                                   (rules 10, 11, 22)
//  7. A round-robin link offers only times when every pool member is free, or
//     a time when no pool member is free.                               (rules 14, 17)
//  8. The booking page shows a host before confirmation, or the confirmation
//     does not name the assigned member.                                (rules 15, 23)
//  9. Assignment ignores preferred members, load, or the order of the two.
//                                                                       (rule 16, edge case 2)
// 10. A reschedule changes the member who is still free, or keeps a member who
//     is no longer free.                                    (rule 20, edge case 6)
// 11. Required organizers of a round-robin link are not checked, optional ones
//     are, or the unassigned pool members get the event.          (rules 13, 18, 26)
// 12. A pool member who leaves the team still gives times; existing bookings
//     disappear.                                                   (edge case 3)
// 13. Data is lost on reload, or saving the editor changes fields it did not touch.
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import {
  addLink,
  addTask,
  allEvents,
  book,
  claimPage,
  slot,
  titled,
  visitor,
  W,
} from "./helpers.ts";
import {
  addOrganizer,
  addToPool,
  customHours,
  editLink,
  meetingHoursFrom,
  offered,
  organizer,
  poolMember,
  saveLink,
  teamOf,
} from "./link-helpers.ts";
import { member, openTeam } from "./team-helpers.ts";

const day = (n: number) => addDays(W, n);
const TUE = day(1);

const named = async (cal: CalendarDriver, summary: string) =>
  (await allEvents(cal)).find((e) => e.summary === summary);

test("a team link offers only times when every required organizer is free, invites everyone, and the co-organizer changes their own hours and most fields from the team links group (rules 1-2, 4, 8, 10-11, 22, 25)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  // C has a low-priority task on Monday 09:00 that a booking must push away.
  await addTask(pc, { title: "C-Report", minutes: 60, split: false, due: "", level: 4 });
  await eventually(
    () => allEvents(colleague.cal),
    (l) => expect(local(titled(l, "C-Report")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );

  await claimPage(page, "ana");
  await addLink(page, { title: "Panel", durations: "30", level: 2 });
  await editLink(page, "Panel");
  await addOrganizer(page, colleague.email);
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/ana/panel");
  expect(await offered(v, W)).toContain("09:00");
  await book(v, at(W, "09:00"), "Bea Booker", "bea@example.com");

  // The host's event invites C and the booker; C's calendar has it too, and C's task moved.
  const ev = await eventually(
    () => named(cal, "Panel with Bea Booker"),
    (e) => expect(e && local(e.start)).toBe(`${W} 09:00`),
  );
  const guests = (await cal.guests(ev?.id ?? "")).map((g) => g.email);
  expect(guests).toEqual(expect.arrayContaining([colleague.email, "bea@example.com"]));
  await eventually(
    () => allEvents(colleague.cal),
    (l) => {
      const copy = l.find((e) => e.summary === "Panel with Bea Booker");
      expect(copy && local(copy.start)).toBe(`${W} 09:00`);
      const [task] = titled(l, "C-Report");
      expect(task && local(task.start)).not.toBe(`${W} 09:00`);
    },
  );
  await v.goto("/book/ana/panel");
  expect(await offered(v, W)).not.toContain("09:00");

  // C chooses their own hours on the link from the team links group.
  await customHours(pc, "Afternoons", "13:00");
  await pc.getByRole("link", { name: "Booking links" }).click();
  const row = pc.getByTestId("team-links").locator('[data-link-title="Panel"]');
  await expect(row).toContainText(`Owned by e2e (${EMAIL})`);
  await expect(row.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await row.getByRole("button", { name: "Edit" }).click();
  const ced = pc.getByTestId("link-editor");
  await expect(ced.getByTestId("owner-note")).toContainText(EMAIL);
  await expect(ced.getByLabel("URL name")).toHaveCount(0);
  await expect(ced.getByLabel(/Hide from my page/)).toHaveCount(0);
  await organizer(pc, colleague.email).getByLabel("Hours").selectOption({ label: "Afternoons" });
  await ced.getByLabel("Title").fill("Panel review");
  await ced.getByLabel("Priority").selectOption("1");
  await saveLink(pc);

  // The API refuses the owner-only changes for C.
  const id = await pc
    .getByTestId("team-links")
    .locator('[data-link-title="Panel review"]')
    .getAttribute("data-link-id");
  const refused = await pc.evaluate(async (linkId) => {
    const patch = await fetch(`/api/booking/links/${linkId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "mine" }),
    });
    const del = await fetch(`/api/booking/links/${linkId}`, { method: "DELETE" });
    return [patch.status, del.status];
  }, id);
  expect(refused).toEqual([403, 403]);

  await v.goto("/book/ana/panel");
  await expect(v.getByTestId("booking-page")).toContainText("Panel review");
  const tue = await offered(v, TUE);
  expect(tue[0]).toBe("13:00");
  expect(tue.at(-1)).toBe("16:30");

  // A sees C's changes after a reload.
  await page.reload();
  await expect(page.locator('[data-link-title="Panel review"]')).toContainText("P1 critical");
  await editLink(page, "Panel review");
  await expect(
    organizer(page, colleague.email).getByLabel("Hours").locator("option:checked"),
  ).toHaveText("Afternoons");
  await pc.reload();
  await expect(pc.getByTestId("team-links")).toContainText("Panel review");
});

test("an optional organizer is invited but not checked; another organizer can be host and gets the event (rules 3, 9)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.cal.addEvent({
    title: "C busy",
    start: at(TUE, "10:00"),
    end: at(TUE, "11:00"),
  });
  await teamOf(page, signIn, [colleague], mail);
  await claimPage(page, "bo");
  await addLink(page, { title: "Sync", durations: "30", level: 4 });
  await editLink(page, "Sync");
  await addOrganizer(page, colleague.email);
  await organizer(page, colleague.email).getByLabel("Required").uncheck();
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/bo/sync");
  expect(await offered(v, TUE)).toContain("10:00");
  await book(v, at(TUE, "10:00"), "Ola", "ola@example.com");
  const ev = await eventually(
    () => named(cal, "Sync with Ola"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 10:00`),
  );
  const guests = await cal.guests(ev?.id ?? "");
  expect(guests).toContainEqual({ email: colleague.email, optional: true });
  expect(guests).toContainEqual({ email: "ola@example.com", optional: false });
  await eventually(
    () => named(colleague.cal, "Sync with Ola"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 10:00`),
  );

  // C becomes a required organizer and the host.
  await editLink(page, "Sync");
  await organizer(page, colleague.email).getByLabel("Required").check();
  await organizer(page, colleague.email).getByLabel("Host").check();
  await saveLink(page);
  await page.reload();
  await editLink(page, "Sync");
  await expect(organizer(page, colleague.email).getByLabel("Host")).toBeChecked();
  await expect(organizer(page, EMAIL).getByLabel("Host")).not.toBeChecked();

  await v.goto("/book/bo/sync");
  expect(await offered(v, TUE)).not.toContain("10:00");
  await book(v, at(TUE, "15:00"), "Pia", "pia@example.com");
  // The event is on C's calendar with C as organizer; A has the invitation.
  const hosted = await eventually(
    () => named(colleague.cal, "Sync with Pia"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 15:00`),
  );
  expect(hosted?.organizerSelf).toBe(true);
  expect((await colleague.cal.guests(hosted?.id ?? "")).map((g) => g.email)).toEqual(
    expect.arrayContaining([EMAIL, "pia@example.com"]),
  );
  const copy = await eventually(
    () => named(cal, "Sync with Pia"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 15:00`),
  );
  expect(copy?.organizerSelf).toBe(false);
});

test("a team link keeps the longest recovery buffer among its organizers free, and the link can turn it off (rule 7, availability rule 10)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await colleague.cal.addEvent({
    title: "C review",
    start: at(TUE, "14:00"),
    end: at(TUE, "15:00"),
  });
  await teamOf(page, signIn, [colleague], mail);
  // Only A has a recovery buffer (15 minutes after meetings).
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  await claimPage(page, "cy");
  await addLink(page, { title: "Panel", durations: "30", level: 4 });
  const ed = await editLink(page, "Panel");
  await addOrganizer(page, colleague.email);
  await expect(ed.getByLabel("Keep recovery buffers free")).toBeChecked();
  await expect(ed).toContainText("Turn this off to offer more times");
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/cy/panel");
  const before = await offered(v, TUE);
  // 13:30 to 14:00 leaves no 15 minutes before C's 14:00 event: A's buffer applies to C too.
  expect(before).toContain("13:15");
  expect(before).not.toContain("13:30");
  expect(before).not.toContain("14:00");

  await editLink(page, "Panel");
  await page.getByTestId("link-editor").getByLabel("Keep recovery buffers free").uncheck();
  await saveLink(page);
  await v.reload();
  const after = await offered(v, TUE);
  expect(after).toContain("13:30");
  expect(after).not.toContain("14:00");
  await page.reload();
  // Saving the editor keeps the fields it did not change.
  await expect(page.locator('[data-link-title="Panel"]')).toContainText("P4 low");
  await editLink(page, "Panel");
  await expect(page.getByTestId("link-editor").getByLabel("Priority")).toHaveValue("4");
  await expect(
    page.getByTestId("link-editor").getByLabel("Keep recovery buffers free"),
  ).not.toBeChecked();
});

test("a round-robin link offers every pool member's time, names nobody before confirmation, balances the load, and keeps the member on reschedule while they are free (rules 14-20, 23, 26)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  await meetingHoursFrom(pc, "13:00");
  await claimPage(page, "dee");
  await addLink(page, { title: "Support", durations: "30", level: 4 });
  await editLink(page, "Support");
  await organizer(page, EMAIL).getByRole("button", { name: "Remove" }).click();
  await addToPool(page, EMAIL);
  await addToPool(page, colleague.email);
  await saveLink(page);
  await page.reload();
  await editLink(page, "Support");
  await expect(page.getByTestId("link-editor").locator("[data-organizer]")).toHaveCount(0);
  await expect(page.getByTestId("link-editor").locator("[data-pool-member]")).toHaveCount(2);

  const v = await visitor(browser);
  const info = v.waitForResponse((r) => r.url().endsWith("/pub/pages/dee/support"));
  await v.goto("/book/dee/support");
  expect(await (await info).text()).not.toContain("e2e");
  const tue = await offered(v, TUE);
  expect(tue[0]).toBe("09:00");
  expect(tue.at(-1)).toBe("16:30");
  await expect(v.getByTestId("booking-page")).not.toContainText(EMAIL);
  await expect(v.getByTestId("booking-page")).not.toContainText(colleague.email);

  // 10:00: only A is in hours.
  await book(v, at(TUE, "10:00"), "Rob", "rob@example.com");
  await expect(v.getByTestId("booked")).toContainText(`e2e (${EMAIL})`);
  const rob = await eventually(
    () => named(cal, "Support with Rob"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 10:00`),
  );
  expect(rob?.organizerSelf).toBe(true);

  // 14:00: both are free; C has fewer bookings.
  await v.goto("/book/dee/support");
  await book(v, at(TUE, "14:00"), "Sue", "sue@example.com");
  await expect(v.getByTestId("booked")).toContainText(colleague.email);
  const sue = await eventually(
    () => named(colleague.cal, "Support with Sue"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 14:00`),
  );
  expect(sue?.organizerSelf).toBe(true);
  expect(await named(cal, "Support with Sue")).toBeUndefined();
  expect(await named(colleague.cal, "Support with Rob")).toBeUndefined();

  // Reschedule to 15:30: C is still free and keeps the meeting (same event).
  await v.getByTestId("manage-link").click();
  await expect(v.getByTestId("booking-host")).toContainText(colleague.email);
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(TUE, "15:30")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  await eventually(
    () => named(colleague.cal, "Support with Sue"),
    (e) => {
      expect(e?.id).toBe(sue?.id);
      expect(e && local(e.start)).toBe(`${TUE} 15:30`);
    },
  );

  // Reschedule to 10:30: C is outside their hours, so the meeting goes to A.
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(TUE, "10:30")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  await eventually(
    () => named(cal, "Support with Sue"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 10:30`),
  );
  await eventually(
    () => named(colleague.cal, "Support with Sue"),
    (e) => expect(e).toBeUndefined(),
  );
  await v.reload();
  await expect(v.getByTestId("booking-host")).toContainText(EMAIL);
});

test("a preferred pool member is chosen first, but a reschedule keeps the member who is still free (rule 16, edge cases 2 and 6)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  mail,
}) => {
  await blockUntil(cal, W);
  await blockUntil(colleague.cal, W);
  await cal.addEvent({ title: "A busy", start: at(TUE, "16:00"), end: at(TUE, "17:00") });
  const [pc] = await teamOf(page, signIn, [colleague], mail);
  if (!pc) throw new Error("no colleague page");
  await meetingHoursFrom(pc, "13:00");
  await claimPage(page, "eli");
  await addLink(page, { title: "Help", durations: "30", level: 4 });
  await editLink(page, "Help");
  await organizer(page, EMAIL).getByRole("button", { name: "Remove" }).click();
  await addToPool(page, EMAIL);
  await addToPool(page, colleague.email);
  await poolMember(page, EMAIL).getByLabel("Preferred").check();
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/eli/help");
  await book(v, at(TUE, "09:00"), "Uma", "uma@example.com");
  await expect(v.getByTestId("booked")).toContainText(EMAIL);
  // A has one booking more than C, but A is preferred.
  await v.goto("/book/eli/help");
  await book(v, at(TUE, "15:00"), "Val", "val@example.com");
  await expect(v.getByTestId("booked")).toContainText(EMAIL);
  await eventually(
    () => named(cal, "Help with Val"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 15:00`),
  );
  // 16:00: A is busy, so C gets it.
  await v.goto("/book/eli/help");
  await book(v, at(TUE, "16:00"), "Wes", "wes@example.com");
  await expect(v.getByTestId("booked")).toContainText(colleague.email);
  const wes = await eventually(
    () => named(colleague.cal, "Help with Wes"),
    (e) => expect(e && local(e.start)).toBe(`${TUE} 16:00`),
  );
  // 15:30: A is free and preferred, but C is free too and keeps the meeting.
  await v.getByTestId("manage-link").click();
  await v.getByRole("button", { name: "Reschedule" }).click();
  await slot(v, at(TUE, "15:30")).click();
  await expect(v.getByText("Your booking has a new time.")).toBeVisible();
  await eventually(
    () => named(colleague.cal, "Help with Wes"),
    (e) => {
      expect(e?.id).toBe(wes?.id);
      expect(e && local(e.start)).toBe(`${TUE} 15:30`);
    },
  );
  expect(await named(cal, "Help with Wes")).toBeUndefined();
  await v.reload();
  await expect(v.getByTestId("booking-host")).toContainText(colleague.email);
});

test("a round-robin link with organizers checks the required ones, invites all of them, and drops a pool member who leaves the team (rules 13, 18, 26, edge case 3)", async ({
  page,
  browser,
  cal,
  signIn,
  colleague,
  people,
  mail,
}) => {
  const d = await people(3);
  const e = await people(4);
  for (const c of [cal, colleague.cal, d.cal, e.cal]) await blockUntil(c, W);
  await cal.addEvent({ title: "A busy", start: at(TUE, "15:00"), end: at(TUE, "16:00") });
  await d.cal.addEvent({ title: "D busy", start: at(TUE, "10:00"), end: at(TUE, "11:00") });
  await d.cal.addEvent({ title: "D lunch", start: at(TUE, "13:00"), end: at(TUE, "14:00") });
  await e.cal.addEvent({ title: "E busy", start: at(TUE, "09:00"), end: at(TUE, "10:00") });
  const [pc] = await teamOf(page, signIn, [colleague, d, e], mail);
  if (!pc) throw new Error("no colleague page");
  await meetingHoursFrom(pc, "13:00");

  await claimPage(page, "fay");
  await addLink(page, { title: "Demo", durations: "30", level: 4 });
  await editLink(page, "Demo");
  await addOrganizer(page, e.email);
  await organizer(page, e.email).getByLabel("Required").uncheck();
  await addToPool(page, colleague.email);
  await addToPool(page, d.email);
  await poolMember(page, colleague.email).getByLabel("Preferred").check();
  await saveLink(page);

  const v = await visitor(browser);
  await v.goto("/book/fay/demo");
  const tue = await offered(v, TUE);
  expect(tue).toContain("09:00"); // E is optional; D is free
  expect(tue).not.toContain("10:00"); // C is outside hours, D is busy
  expect(tue).toContain("13:00"); // C is free
  expect(tue).not.toContain("15:00"); // A is a required organizer and busy

  await book(v, at(TUE, "14:00"), "Tim", "tim@example.com");
  await expect(v.getByTestId("booked")).toContainText(colleague.email);
  // A hosts; C is a guest; E is an optional guest; D is not invited.
  const ev = await eventually(
    () => named(cal, "Demo with Tim"),
    (x) => expect(x && local(x.start)).toBe(`${TUE} 14:00`),
  );
  expect(ev?.organizerSelf).toBe(true);
  const guests = await cal.guests(ev?.id ?? "");
  expect(guests).toContainEqual({ email: colleague.email, optional: false });
  expect(guests).toContainEqual({ email: e.email, optional: true });
  expect(guests.map((g) => g.email)).not.toContain(d.email);
  await eventually(
    () => named(colleague.cal, "Demo with Tim"),
    (x) => expect(x).toBeDefined(),
  );
  await eventually(
    () => named(e.cal, "Demo with Tim"),
    (x) => expect(x).toBeDefined(),
  );
  expect(await named(d.cal, "Demo with Tim")).toBeUndefined();

  // C leaves the team: only D stays in the pool; the booking stays.
  await openTeam(pc);
  await member(pc, colleague.email).getByRole("button", { name: "Leave team" }).click();
  await pc.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(pc.getByTestId("team-name")).toHaveText("e2e2's team");
  await v.goto("/book/fay/demo");
  const later = await offered(v, TUE);
  expect(later).toContain("09:00");
  expect(later).not.toContain("13:00");
  expect(await named(cal, "Demo with Tim")).toBeDefined();
  await page.reload();
  await editLink(page, "Demo");
  await expect(page.getByTestId("link-editor").locator("[data-pool-member]")).toHaveCount(1);
  await expect(poolMember(page, d.email)).toBeVisible();
});
