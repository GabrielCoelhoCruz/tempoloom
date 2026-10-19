// Personal stats panels (docs/specs/analytics-personal-stats.md rules 1, 4, 6-8,
// 12-13; events-categories-and-colors.md solo work split): time by category with
// deep and shallow work, breaks, travel and time away; the most productive and
// the busiest meeting weekday; people met; insights; and calendar facts.
//
// Ways this can fail, each covered below:
// - solo work is not split at 2 hours, or an overlapping event is counted twice;
// - recovery buffers count as solo work instead of breaks, or travel buffers miss travel;
// - an all-day out-of-office day does not count as one workday of vacation;
// - a declined meeting counts, or its guests show among the people met;
// - people met miss someone, include the user, or sort wrongly;
// - the most productive or busiest weekday is wrong;
// - insights miss the meeting-heavy day, the short focus pieces or a repeat event;
// - the panels lose the chosen range on reload.
import { addDays } from "../../src/shared/time.ts";
import { at, BACKEND, eventually, expect, test } from "./fixtures.ts";
import { MIN, titled, W } from "./helpers.ts";
import { outOfOffice } from "./ics.ts";

const day = (n: number) => addDays(W, n);
const team = ["ana@tempoloom.test", "ben@tempoloom.test", "cyd@tempoloom.test"];
const vera = "vera@tempoloom.test";
const sam = "sam@example-b.test";

test("stats split solo work into deep and shallow, count breaks, travel and time away, and name people met (SPEC-ANALYTICS-01 T1, T2, rules 1, 4, 6-8, 12-13)", async ({
  page,
  cal,
  signIn,
}) => {
  test.skip(BACKEND === "google", "Meetings with attendees and out-of-office need CalDAV here.");
  const meeting = (title: string, d: number, from: string, to: string, attendees: string[]) =>
    cal.addEvent({ title, start: at(day(d), from), end: at(day(d), to), attendees });
  await meeting("1:1 with Vera", 0, "10:00", "11:00", [vera]);
  await meeting("Team sync", 0, "13:00", "13:30", team);
  await meeting("Standup", 1, "09:00", "10:00", team);
  await meeting("1:1 with Vera", 1, "11:00", "12:00", [vera]);
  await meeting("Vendor call", 1, "15:00", "15:45", [sam]);
  await meeting("Team planning", 3, "18:00", "19:00", team);
  await cal.addInvite({
    title: "Declined offsite",
    start: at(day(1), "13:00"),
    end: at(day(1), "14:00"),
    answer: "DECLINED",
  });
  await cal.addEvent({ title: "Write spec", start: at(day(2), "09:00"), end: at(day(2), "11:30") });
  await cal.addEvent({ title: "Email", start: at(day(2), "14:00"), end: at(day(2), "15:00") });
  await cal.addEvent({ title: "Inbox", start: at(day(2), "14:30"), end: at(day(2), "15:00") });
  await cal.addEvent({
    title: "Site visit",
    start: at(day(3), "10:00"),
    end: at(day(3), "11:00"),
    location: "Hauptstrasse 1, 10115 Berlin",
  });
  await outOfOffice(cal.calendarId, "Vacation", { from: day(4), to: day(5) });

  await signIn();
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Add 15 min recovery after meetings" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Recovery");
  await page.getByRole("button", { name: "Add travel time (30 min)" }).click();
  await expect(page.getByTestId("buffer-list")).toContainText("Travel");
  const placed = await eventually(
    () => cal.events(at(W, "00:00"), at(day(7), "00:00")),
    (l) => {
      expect(titled(l, "Travel")).toHaveLength(2);
      expect(titled(l, "Recovery").length).toBeGreaterThanOrEqual(4);
    },
  );
  const recovery = titled(placed, "Recovery").reduce((a, e) => a + (e.end - e.start) / MIN, 0);
  const hm = (m: number) => {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h && r ? `${h} h ${r} min` : h ? `${h} h` : `${r} min`;
  };

  await page.getByRole("link", { name: "Stats" }).click();
  await page.getByLabel("From").fill(W);
  await page.getByLabel("To").fill(day(6));
  const check = async () => {
    const cats = page.getByTestId("cat-breakdown");
    await expect(cats.getByTestId("cat-one_on_one")).toHaveText("2 h");
    await expect(cats.getByTestId("cat-team_meeting")).toHaveText("2 h 30 min");
    await expect(cats.getByTestId("cat-external_meeting")).toHaveText("45 min");
    await expect(cats.getByTestId("cat-deep_work")).toHaveText("2 h 30 min");
    // Email and the overlapping Inbox count once; the site visit is the other short piece.
    await expect(cats.getByTestId("cat-shallow_work")).toHaveText("2 h");
    await expect(cats.getByTestId("cat-travel")).toHaveText("1 h");
    await expect(cats.getByTestId("cat-breaks")).toHaveText(hm(recovery));
    // Friday's out-of-office day is one workday of time away.
    await expect(cats.getByTestId("cat-vacation")).toHaveText("8 h");

    const focus = page.getByTestId("focus-panel");
    await expect(focus).toContainText("Most productive day: Wednesday");
    await expect(focus.getByTestId("weekday-3")).toContainText("3 h 30 min");
    const meetings = page.getByTestId("meeting-days");
    await expect(meetings).toContainText("Busiest meeting day: Tuesday (2 h 45 min)");
    await expect(meetings).toContainText("Lightest meeting day: Wednesday");

    const people = page.getByTestId("people-met").getByTestId("person");
    await expect(people).toHaveCount(5);
    await expect(people.nth(0)).toContainText(team[0] as string);
    await expect(people.nth(0)).toContainText("2 h 30 min");
    await expect(people.nth(3)).toContainText(vera);
    await expect(people.nth(3)).toContainText("2 h");
    await expect(people.nth(4)).toContainText(sam);
    await expect(page.getByTestId("people-met")).not.toContainText("organizer@example.com");

    await expect(page.getByTestId("hl-breaks")).toHaveText(hm(recovery));
    await expect(page.getByTestId("hl-travel")).toHaveText("1 h");

    const insights = page.getByTestId("insights");
    await expect(insights).toContainText("Meetings 5 h 15 min · solo work 4 h 30 min");
    await expect(insights).toContainText("Days with many meetings: Tuesday (3 meetings)");
    await expect(insights).toContainText("Focus time in short pieces: 2 h in 2 pieces");
    await expect(insights).toContainText("1:1 with Vera (2 times)");

    const facts = page.getByTestId("calendar-facts");
    await expect(facts).toContainText("Busiest meeting day: Tuesday");
    await expect(facts).toContainText("Longest focus session: 2 h 30 min");
    await expect(facts).toContainText("People met: 5");
    await expect(facts).toContainText(`Breaks taken: ${hm(recovery)}`);
  };
  await check();
  // The range stays in the address, so a reload shows the same panels.
  await page.reload();
  await expect(page.getByLabel("From")).toHaveValue(W);
  await check();
});
