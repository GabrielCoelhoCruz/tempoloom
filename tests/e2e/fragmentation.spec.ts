// Calendar fragmentation policy: the baseline report of fragmented time per
// group, and the scheduler preference that places new flexible items next to
// busy time within the member's flexibility (docs/specs/teams-policies.md
// rules 6, 21-24, T5).
//
// Ways it can fail, and the check that catches each:
// - the baseline counts the wrong gaps (edges of work hours, usable gaps) -> 30 and 15 minutes
// - the baseline mixes groups, or shows one person's name                 -> per-group grids
// - the baseline uses the wrong 4 weeks or days                           -> each past Tuesday
// - the baseline changes the calendar                                     -> no new events
// - an enabled policy does not change placements for members in scope     -> B at 10:00
// - the policy changes placements for members outside the scope           -> C at the ideal 10:30
// - the system moves further than the member's flexibility allows         -> B at 10:15 when low
// - the member's flexibility is not kept                                  -> reload
// - existing placements move when the policy starts or changes (rule 6)   -> B's first habit stays
import { addDays, utcToLocal, weekdayOf } from "../../src/shared/time.ts";
import { at, BACKEND, eventually, expect, local, managed, test, ZONE } from "./fixtures.ts";
import { addHabit, titled, W } from "./helpers.ts";
import { createPolicy, openPolicies, openReport, provisioned } from "./policy-helpers.ts";

test.skip(BACKEND === "google", "Fragmentation policy E2E uses several CalDAV users.");

test("the fragmentation baseline shows the group average of fragmented time on each day of the 4 weeks before (T5; rules 21, 22)", async ({
  page,
  signIn,
  people,
}) => {
  const { members } = await provisioned(page, signIn, people, [
    { n: 3, department: "Engineering" },
    { n: 4, department: "Sales" },
  ]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];
  const today = utcToLocal(ZONE, Date.now()).date;
  const monday = addDays(today, 1 - weekdayOf(today));
  const tuesdays = [4, 3, 2, 1].map((k) => addDays(monday, 1 - 7 * k));
  for (const d of tuesdays) {
    for (const [from, to] of [
      ["10:00", "10:30"],
      ["11:00", "11:30"],
      ["14:00", "14:30"],
    ] as const) {
      await b.person.cal.addEvent({ title: "Meeting", start: at(d, from), end: at(d, to) });
    }
    for (const [from, to] of [
      ["10:00", "10:30"],
      ["10:45", "11:15"],
    ] as const) {
      await c.person.cal.addEvent({ title: "Call", start: at(d, from), end: at(d, to) });
    }
  }
  const pastEvents = async () =>
    (await b.person.cal.events(at(tuesdays[0] as string, "00:00"), at(monday, "00:00"))).length;
  const countBefore = await pastEvents();

  await createPolicy(page, {
    type: "Calendar fragmentation",
    name: "Fewer gaps",
    minBlock: 60,
    target: 25,
    enabled: false,
  });
  const report = await openReport(page, "Fewer gaps");
  await report.getByLabel("Group by").fill("department");
  await report.getByRole("button", { name: "Show baseline" }).click();
  const grid = (group: string) => page.getByTestId("baseline").locator(`[data-group="${group}"]`);
  const check = async () => {
    for (const d of tuesdays) {
      await expect(grid("Engineering").locator(`td[data-date="${d}"]`)).toHaveText("30");
      await expect(grid("Sales").locator(`td[data-date="${d}"]`)).toHaveText("15");
      await expect(grid("Engineering").locator(`td[data-date="${addDays(d, 1)}"]`)).toHaveText("0");
    }
    await expect(grid("Engineering").locator("td[data-date]")).toHaveCount(20);
  };
  // Members' calendars reach the server on their next sync.
  await eventually(
    async () => {
      await page.reload();
      return [
        await grid("Engineering").locator(`td[data-date="${tuesdays[0]}"]`).textContent(),
        await grid("Sales").locator(`td[data-date="${tuesdays[3]}"]`).textContent(),
      ];
    },
    (v) => expect(v).toEqual(["30", "15"]),
  );
  await check();
  await expect(page.getByTestId("baseline")).not.toContainText(b.person.email);
  await page.reload();
  await check();
  expect(await pastEvents()).toBe(countBefore);
});

test("an enabled fragmentation policy places new habits of members in scope next to busy time, within each member's flexibility (rules 6, 23)", async ({
  page,
  signIn,
  people,
}) => {
  const { members } = await provisioned(page, signIn, people, [
    { n: 3, department: "Engineering" },
    { n: 4, department: "Sales" },
  ]);
  const [b, c] = members as [(typeof members)[0], (typeof members)[0]];
  const tue = addDays(W, 1);
  const thu = addDays(W, 3);
  for (const m of [b, c]) {
    for (const d of [tue, thu]) {
      await m.person.cal.addEvent({ title: "Standup", start: at(d, "09:00"), end: at(d, "10:00") });
    }
  }
  await createPolicy(page, {
    type: "Calendar fragmentation",
    name: "Fewer gaps",
    scope: { attribute: "department", value: "Engineering" },
    minBlock: 60,
    flexibility: "Medium",
  });

  for (const m of [b, c]) {
    await addHabit(m.page, { title: "Review", ideal: "10:30", min: 30, max: 30, days: ["Tue"] });
  }
  const startOn = async (m: (typeof members)[0], title: string, date: string) => {
    const evs = await m.person.cal.events(at(date, "00:00"), at(addDays(date, 1), "00:00"));
    const [e] = titled(evs, title);
    return e ? local(e.start) : null;
  };
  // Medium flexibility moves the habit 30 minutes to close the gap; Sales is out of scope.
  await eventually(
    () => startOn(b, "Review", tue),
    (s) => expect(s).toBe(`${tue} 10:00`),
  );
  await eventually(
    () => startOn(c, "Review", tue),
    (s) => expect(s).toBe(`${tue} 10:30`),
  );

  // B allows less movement; a new habit moves at most 15 minutes. The first one stays.
  await openPolicies(b.page);
  const mine = b.page.locator('[data-my-policy="Fewer gaps"]');
  await mine.getByLabel("My flexibility").selectOption({ label: "Low" });
  await mine.getByRole("button", { name: "Save flexibility" }).click();
  await expect(mine.getByTestId("my-policy-saved")).toBeVisible();
  await b.page.reload();
  await expect(
    b.page.locator('[data-my-policy="Fewer gaps"]').getByLabel("My flexibility"),
  ).toHaveValue("low");
  await addHabit(b.page, { title: "Notes", ideal: "10:30", min: 30, max: 30, days: ["Thu"] });
  await eventually(
    () => startOn(b, "Notes", thu),
    (s) => expect(s).toBe(`${thu} 10:15`),
  );
  expect(await startOn(b, "Review", tue)).toBe(`${tue} 10:00`);
  const all = await b.person.cal.events(at(W, "00:00"), at(addDays(W, 7), "00:00"));
  expect(managed(all).filter((e) => e.summary.includes("Review"))).toHaveLength(1);
});
