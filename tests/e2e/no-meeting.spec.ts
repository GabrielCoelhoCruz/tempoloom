// No-meeting time from the #tl_free tag (docs/specs/events-tags.md rules 1-5, 8):
// tasks and habits may use the time; flexible meetings and booking links may not.
//
// Ways it can fail, and the test that catches each:
// - the organizer's flexible meeting lands inside a #tl_free block       -> own block
// - a habit no longer uses #tl_free time (the tag turned into plain busy) -> own block, team day
// - a P1 booking link offers #tl_free time after the user lowered the
//   event's priority (rule 4: whatever the link priority)                 -> own block
// - the lowered priority or the block is lost after a reload             -> own block
// - an accepted team no-meeting day (tag in the description) does not
//   block the invitee's own flexible meetings or booking link             -> team day
// - an unanswered invitation already acts as a no-meeting day            -> team day
// - a "maybe" answer does not count                                      -> team day
// - the no-meeting invitation moves meetings that other people organize
//   for the invitee only on the wrong days                               -> team day
import type { Browser, Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  local,
  test,
} from "./fixtures.ts";
import { addHabit, claimPage, openWeek, titled, visitor, W } from "./helpers.ts";
import { invitation } from "./ics.ts";

test.skip(BACKEND === "google", "No-meeting E2E writes invitations between CalDAV users.");

const day = (n: number) => addDays(W, n);
const week = (cal: CalendarDriver) => cal.events(at(W, "00:00"), at(day(7), "00:00"));
const starts = (evs: Awaited<ReturnType<typeof week>>, title: string) =>
  titled(evs, title).map((e) => `${local(e.start)}-${local(e.end).slice(11)}`);

async function addMeeting(page: Page, title: string, guests: string) {
  await page.getByRole("link", { name: "Meetings" }).click();
  const form = page.getByTestId("meeting-form");
  await form.getByLabel("Title").fill(title);
  await form.getByLabel("Guests (comma list)", { exact: true }).fill(guests);
  await form.getByLabel("Guests (comma list)", { exact: true }).blur();
  await page.getByRole("button", { name: "Add meeting" }).click();
}

/** Offered start times of a public booking link on one local date, as "HH:MM". */
async function offered(browser: Browser, path: string, date: string): Promise<string[]> {
  const v = await visitor(browser);
  await v.goto(path);
  await expect(v.getByTestId("times")).toBeVisible();
  const starts = await v
    .locator('[data-testid="times"] button[data-start]')
    .evaluateAll((bs) => bs.map((b) => Number(b.getAttribute("data-start"))));
  await v.context().close();
  return starts
    .map(local)
    .filter((s) => s.startsWith(date))
    .map((s) => s.slice(11));
}

test("a #tl_free block keeps habits but not the organizer's flexible meetings or any booking link, even at a lowered priority (rules 1-4)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  const tue = day(1);
  await blockUntil(cal, W);
  await cal.addEvent({
    title: "No meetings #tl_free",
    start: at(tue, "09:00"),
    end: at(tue, "13:00"),
  });
  await signIn();
  await addHabit(page, { title: "Plan", ideal: "10:00", min: 30, max: 30 });
  await addMeeting(page, "Sync", "dana@example.com");
  await eventually(
    () => week(cal),
    (l) => {
      // The habit keeps its ideal time inside the block (rule 2).
      expect(starts(l, "Plan")).toContain(`${tue} 10:00-10:30`);
      // The meeting keeps its ideal day but leaves the block (rule 3).
      expect(starts(l, "Sync")).toEqual([`${tue} 13:00-13:30`]);
    },
  );

  // The user lowers the block's priority; even a P1 link must not offer it (rule 4).
  await claimPage(page, "nomeet");
  await openWeek(page);
  await page.locator(".ev-external", { hasText: "No meetings" }).click();
  const form = page.getByTestId("external-priority");
  await form.getByLabel("Priority for booking links").selectOption("3");
  await form.getByRole("button", { name: "Save priority" }).click();
  const p1 = await offered(browser, "/book/nomeet/important-meeting", tue);
  expect(p1.filter((t) => t >= "09:00" && t < "13:00")).toEqual([]);
  expect(p1).toContain("14:00");

  // The block stays busy and unmoved for other people.
  const block = (await week(cal)).find((e) => e.summary === "No meetings #tl_free");
  expect(block && [local(block.start), block.busy]).toEqual([`${tue} 09:00`, true]);
  await page.reload();
  await page.locator(".ev-external", { hasText: "No meetings" }).click();
  await expect(
    page.getByTestId("external-priority").getByLabel("Priority for booking links"),
  ).toHaveValue("3");
  const again = await offered(browser, "/book/nomeet/important-meeting", tue);
  expect(again.filter((t) => t >= "09:00" && t < "13:00")).toEqual([]);
  expect(starts(await week(cal), "Sync")).toEqual([`${tue} 13:00-13:30`]);
});

test("a team no-meeting day invitation counts for each invitee who answers yes or maybe, not for an unanswered one (rule 8)", async ({
  browser,
  cal,
  colleague,
  people,
}) => {
  const tue = day(1);
  const c = await people(3);
  for (const x of [colleague.cal, c.cal]) await blockUntil(x, W);
  // The organizer's all-day event with the tag in the description, invited to B and C.
  // Radicale does not deliver invitations, so each invitee's copy is written as a
  // mail client would, with that invitee's own answer.
  const event = (answer: "NEEDS-ACTION" | "ACCEPTED" | "TENTATIVE", self: string) => ({
    title: "Team no-meeting day",
    description: "Deep work for everyone #tl_free",
    span: { from: tue, to: day(2) },
    organizer: EMAIL,
    attendees: [
      { email: colleague.email, answer: self === colleague.email ? answer : "NEEDS-ACTION" },
      { email: c.email, answer: self === c.email ? answer : "NEEDS-ACTION" },
    ],
  });
  await invitation(cal.calendarId, event("ACCEPTED", EMAIL));
  await invitation(colleague.cal.calendarId, event("ACCEPTED", colleague.email));
  const cInvite = await invitation(c.cal.calendarId, event("NEEDS-ACTION", c.email));

  const pb = await colleague.signIn();
  const pc = await c.signIn();
  await addHabit(pb, { title: "Review", ideal: "11:00", min: 30, max: 30 });
  await addMeeting(pb, "B sync", "dana@example.com");
  await addMeeting(pc, "C sync", "dana@example.com");
  await eventually(
    () => week(colleague.cal),
    (l) => {
      // B accepted: habits keep the day, B's own meeting leaves it.
      expect(starts(l, "Review")).toContain(`${tue} 11:00-11:30`);
      expect(starts(l, "B sync")).toHaveLength(1);
      expect(starts(l, "B sync")[0]?.startsWith(tue)).toBe(false);
    },
  );
  // C has not answered: the invitation does not count yet.
  await eventually(
    () => week(c.cal),
    (l) => expect(starts(l, "C sync")).toEqual([`${tue} 10:00-10:30`]),
  );
  await claimPage(pb, "bee");
  expect(await offered(browser, "/book/bee/important-meeting", tue)).toEqual([]);
  expect((await offered(browser, "/book/bee/important-meeting", day(2))).length).toBeGreaterThan(0);

  // C answers "maybe": from then on the day is a no-meeting day for C too.
  await invitation(c.cal.calendarId, event("TENTATIVE", c.email), cInvite);
  await eventually(
    () => week(c.cal),
    (l) => {
      expect(starts(l, "C sync")).toHaveLength(1);
      expect(starts(l, "C sync")[0]?.startsWith(tue)).toBe(false);
    },
  );

  await pb.reload();
  await pc.reload();
  const b = await week(colleague.cal);
  expect(starts(b, "Review")).toContain(`${tue} 11:00-11:30`);
  expect(starts(b, "B sync")[0]?.startsWith(tue)).toBe(false);
  expect(starts(await week(c.cal), "C sync")[0]?.startsWith(tue)).toBe(false);
});
