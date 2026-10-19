// Category detection and color rules (docs/specs/events-categories-and-colors.md).
//
// Ways this can fail, each covered below:
// - a change of guests in the calendar does not change the category, so the
//   color stays the old one;
// - a new category color repaints only future events, not ones that ended;
// - "Repaint all events" does not put back a color the user changed in the
//   calendar, or it can repaint without limit.
import type { Page } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import {
  at,
  BACKEND,
  blockUntil,
  type CalendarDriver,
  EMAIL,
  eventually,
  expect,
  planNow,
  test,
} from "./fixtures.ts";
import { addHabit, MIN, openWeek, titled, W } from "./helpers.ts";
import { credentials, putEvent } from "./ics.ts";

test.skip(BACKEND === "google", "Color E2E reads the CalDAV COLOR property.");

const day = (n: number) => addDays(W, n);
const span = (cal: CalendarDriver) => cal.events(Date.now() - 2 * 86_400_000, at(day(7), "00:00"));
/** Lunches of the test week; days before it are blocked, so lunches there are conflicts. */
const inW = (l: Awaited<ReturnType<typeof span>>) =>
  titled(l, "Lunch").filter((e) => e.start >= at(W, "00:00"));
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]|\.\d{3}/g, "");

async function saveColors(page: Page, change: Record<string, string>) {
  await page.getByRole("link", { name: "Settings" }).click();
  const form = page.getByTestId("color-form");
  for (const [label, value] of Object.entries(change))
    await form.getByLabel(label, { exact: true }).selectOption({ label: value });
  await form.getByRole("button", { name: "Save colors" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Saved");
}

/** Another calendar app sets the color of one event (RFC 7986 COLOR). */
async function recolor(url: string, cssColor: string) {
  const auth = credentials(url);
  const ics = await (await fetch(url, { headers: { authorization: auth } })).text();
  const res = await fetch(url, {
    method: "PUT",
    headers: { authorization: auth, "content-type": "text/calendar" },
    body: ics
      .replace(/^COLOR:.*\r?\n/m, "")
      .replace("END:VEVENT", `COLOR:${cssColor}\r\nEND:VEVENT`),
  });
  if (!res.ok) throw new Error(`PUT ${url} failed: ${res.status}`);
}

test("a meeting gets a new category and color when its guests change in the calendar (category detection rules 1, 3)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  const meeting = (guests: string[]) => [
    `DTSTART:${stamp(at(day(1), "11:00"))}`,
    `DTEND:${stamp(at(day(1), "11:30"))}`,
    "SUMMARY:Roadmap chat",
    "TRANSP:OPAQUE",
    `ORGANIZER:mailto:${EMAIL}`,
    ...[EMAIL, ...guests].map((g) => `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${g}`),
  ];
  const id = await putEvent(cal.calendarId, meeting(["ana@tempoloom.test"]));
  await signIn();
  await saveColors(page, { Paint: "All events on my calendars" });
  const chat = (l: Awaited<ReturnType<typeof span>>) => l.find((e) => e.summary === "Roadmap chat");
  await eventually(
    () => span(cal),
    (l) => expect(chat(l)?.colorId).toBe("7"),
  );
  const shows = async (label: string) => {
    await openWeek(page);
    await page.locator(".ev-external", { hasText: "Roadmap chat" }).click();
    await expect(page.getByTestId("event-drawer").locator(".status").nth(1)).toContainText(label);
  };
  await shows("One-on-one");

  // Two more people of the same domain join: a team meeting.
  await putEvent(
    cal.calendarId,
    meeting(["ana@tempoloom.test", "ben@tempoloom.test", "cyd@tempoloom.test"]),
    id,
  );
  await eventually(
    () => span(cal),
    (l) => expect(chat(l)?.colorId).toBe("9"),
  );
  await page.reload();
  await shows("Team meeting");

  // A guest from another company joins: an external meeting.
  await putEvent(
    cal.calendarId,
    meeting(["ana@tempoloom.test", "ben@tempoloom.test", "vic@example-d.test"]),
    id,
  );
  await eventually(
    () => span(cal),
    (l) => expect(chat(l)?.colorId).toBe("11"),
  );
  await page.reload();
  await shows("External meeting");
  await planNow(page);
  expect(chat(await span(cal))?.colorId).toBe("11");
});

test("a new category color repaints events that ended too; Repaint all events puts back colors changed in the calendar, at most twice a minute (color rules 8, 11, 12)", async ({
  page,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await addHabit(page, { title: "Lunch", ideal: "12:00", min: 60, max: 60 });
  const placed = await eventually(
    () => span(cal),
    (l) => expect(inW(l)).toHaveLength(5),
  );
  const [past, future] = inW(placed);
  if (!past || !future) throw new Error("missing lunches");
  // The user moves one lunch to earlier today in another calendar app: it has ended.
  const start = Math.floor((Date.now() - 3 * 3_600_000) / (15 * MIN)) * 15 * MIN;
  await cal.update(past.id, { start, end: start + 60 * MIN });
  const byId = (l: Awaited<ReturnType<typeof span>>, id: string) => l.find((e) => e.id === id);
  await eventually(
    () => span(cal),
    (l) => expect(byId(l, past.id)?.summary).toContain("✅"),
  );

  await saveColors(page, { "Solo work": "Tomato" });
  await eventually(
    () => span(cal),
    (l) => {
      expect(byId(l, future.id)?.colorId).toBe("11");
      expect(byId(l, past.id)?.colorId).toBe("11");
    },
  );

  // The user paints one lunch yellow in the calendar; normal runs leave it so.
  await recolor(future.id, "gold");
  await planNow(page);
  await eventually(
    () => span(cal),
    (l) => expect(byId(l, future.id)?.colorId).toBe("5"),
  );
  const form = page.getByTestId("color-form");
  await form.getByRole("button", { name: "Repaint all events" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Repainted all events");
  await eventually(
    () => span(cal),
    (l) => {
      expect(byId(l, future.id)?.colorId).toBe("11");
      expect(byId(l, past.id)?.colorId).toBe("11");
    },
  );
  await page.reload();
  await expect(page.getByTestId("color-form").getByLabel("Solo work", { exact: true })).toHaveValue(
    "11",
  );
  await page.getByTestId("color-form").getByRole("button", { name: "Repaint all events" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText("Repainted all events");
  await page.getByTestId("color-form").getByRole("button", { name: "Repaint all events" }).click();
  await expect(page.getByTestId("settings-message")).toHaveText(
    "Wait a minute before you repaint again.",
  );
  const after = await span(cal);
  expect(titled(after, "Lunch").every((e) => e.colorId === "11")).toBe(true);
});
