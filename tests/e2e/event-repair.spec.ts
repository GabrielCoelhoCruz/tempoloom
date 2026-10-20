// Repair one event from the lookup page (docs/specs/support-troubleshooting.md
// rule 10): the copy decision runs again for that one event and its result is
// written, also where a normal sync leaves the calendar as it is.
//
// Ways it can fail, and the check that catches each:
// - the regular sync already puts the color back (no repair needed)  -> color stays red after two runs
// - repair is offered for an event Tempoloom has nothing to decide on -> no button on an own event
// - repair writes nothing, or writes another event                   -> the copy's color is the policy color
// - repair is not logged, or not stored                              -> "copy restored" entry after a reload
import { addDays } from "../../src/shared/time.ts";
import { addPolicy, copies, editRaw, week } from "./calendar-helpers.ts";
import { at, BACKEND, blockUntil, eventually, expect, planNow, test } from "./fixtures.ts";
import { W } from "./helpers.ts";

test.skip(BACKEND === "google", "The test repaints a copy on the loopback CalDAV server.");

const tue = addDays(W, 1);

test("repair on the lookup page runs the copy decision again for one event and writes it: a copy repainted by hand gets the policy color back (SPEC-SUPPORT-01 rule 10)", async ({
  page,
  cal,
  signIn,
  radicale,
}) => {
  if (!radicale) throw new Error("This test needs the CalDAV backend.");
  await blockUntil(cal, W);
  await signIn();
  const priv = await cal.newCalendar("Private");
  await priv.addEvent({ title: "Dentist", start: at(tue, "10:00"), end: at(tue, "11:00") });
  const board = await cal.addEvent({
    title: "Board",
    start: at(tue, "16:00"),
    end: at(tue, "17:00"),
  });
  await addPolicy(page, { from: "Private", to: "Work", color: "Banana" });
  const first = await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => e.colorId)).toEqual(["5"]),
  );
  const id = copies(first)[0]?.id ?? "";

  // Someone repaints the copy; the regular sync leaves the color as it is.
  await editRaw(radicale, id, (ics) => ics.replace(/COLOR:[^\r\n]*/, "COLOR:red"));
  await planNow(page);
  await planNow(page);
  expect(copies(await week(cal))[0]?.colorId).not.toBe("5");

  // An event Tempoloom neither manages nor copies has nothing to repair.
  await page.goto(`/help/lookup?q=${encodeURIComponent(board)}`);
  const result = page.getByTestId("lookup-result");
  await expect(result).toContainText("Tempoloom does not manage this event");
  await expect(result.getByRole("button", { name: "Repair" })).toHaveCount(0);

  await page.goto(`/help/lookup?q=${encodeURIComponent(id)}`);
  await expect(result).toContainText("Copy made by calendar mirroring Private → Work");
  const repaired = page.waitForResponse(
    (r) => r.url().includes("/api/help/repair") && r.request().method() === "POST",
  );
  await result.getByRole("button", { name: "Repair" }).click();
  expect((await repaired).status()).toBe(200);
  await expect(page.getByTestId("repair-message")).toHaveText(
    "Repaired: Tempoloom wrote this event again as its copy rules give it.",
  );
  await eventually(
    () => week(cal),
    (l) => expect(copies(l).map((e) => [e.id, e.colorId])).toEqual([[id, "5"]]),
  );
  const entry = result.getByTestId("change-entry").first();
  await expect(entry).toContainText("update · copy restored");
  await page.reload();
  await expect(page.getByTestId("lookup-result").getByTestId("change-entry").first()).toContainText(
    "update · copy restored",
  );
});
