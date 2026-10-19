// Personalize: one-off links and shared times.
// Spec: booking-links-sharing.md rules 8-22 and 31-32.
//
// Ways this can fail:
//  1. The one-off link changes the source link, or does not use its own
//     settings (priority, duration, hours).                                  (rules 12, 31, 32)
//  2. The booking page does not prefill the invitee, or the booker cannot change it.  (rule 9)
//  3. The one-off link shows on the links page or on a booking page.         (rule 11)
//  4. Copy link does not save it or copies another URL.                      (rule 10)
//  5. The creator cannot open and edit it from its URL.                      (rule 13)
//  6. Its bookings do not count against the source link's limits.            (rule 16)
//  7. It never expires, or expires at another time than 30 days after creation.  (rule 14)
//  8. Shared times: more than 5 dates can be picked; times not offered can be
//     picked; the result is not in the chosen format; adjacent text ranges do
//     not merge; a time link does not open the booking page on that time.    (rules 17-22)
//  9. The edited template is not kept for next time.                         (rule 20)
// 10. Copy times does not put both HTML and plain text on the clipboard.     (rule 21)
import type { Page } from "@playwright/test";
import { addDays, utcToLocal } from "../../src/shared/time.ts";
import { at, blockUntil, eventually, expect, local, test, ZONE } from "./fixtures.ts";
import { addHabit, addLink, allEvents, claimPage, slot, titled, visitor, W } from "./helpers.ts";
import { customHours } from "./link-helpers.ts";

const day = (n: number) => addDays(W, n);

async function personalize(p: Page, title: string): Promise<void> {
  await p.getByRole("link", { name: "Booking links" }).click();
  await p
    .locator(`[data-link-title="${title}"]`)
    .getByRole("button", { name: "Personalize" })
    .click();
  await expect(p.getByTestId("personalize")).toBeVisible();
}

/** The clipboard as text and HTML; empty while a copy is still being written. */
const clipboard = (p: Page) =>
  p.evaluate(async () => {
    try {
      const [item] = await navigator.clipboard.read();
      const html = item?.types.includes("text/html")
        ? await (await item.getType("text/html")).text()
        : "";
      return { text: await navigator.clipboard.readText(), html };
    } catch {
      return { text: "", html: "" };
    }
  });

test("a one-off link has its own settings and prefilled invitee, stays unlisted, leaves the source unchanged, counts against its limits, and the creator edits it from its URL (sharing rules 8-13, 16, 31-32)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await customHours(page, "Late", "13:00");
  await addHabit(page, {
    title: "Morning prep",
    ideal: "09:00",
    min: 60,
    max: 60,
    level: 3,
    days: ["Mon"],
    defense: "Always busy",
  });
  await eventually(
    () => cal.events(at(W, "00:00"), at(day(1), "00:00")),
    (l) => expect(local(titled(l, "Morning prep")[0]?.start ?? 0)).toBe(`${W} 09:00`),
  );
  await claimPage(page, "omar");
  await addLink(page, { title: "Chat", durations: "30", level: 4, maxPerDay: 1 });

  await personalize(page, "Chat");
  const form = page.getByTestId("oneoff-form");
  await expect(form.getByLabel("Page title")).toHaveValue("Chat");
  await expect(form.getByLabel("Priority")).toHaveValue("4");
  await form.getByLabel("Invitee name").fill("Pia");
  await form.getByLabel("Invitee email").fill("pia@example.com");
  await form.getByLabel("Priority").selectOption("1");
  await form.getByLabel(/^Durations/).fill("45");
  await form.getByRole("button", { name: "Copy link" }).click();
  const urlBox = page.getByTestId("oneoff-url");
  await expect(urlBox).toHaveText(/\/book\/o\/[a-z0-9]{16}$/);
  const url = (await urlBox.textContent()) ?? "";
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const expires = addDays(utcToLocal(ZONE, Date.now()).date, 30);
  await expect(page.getByTestId("oneoff-expiry")).toHaveAttribute("data-date", expires);

  // Not listed anywhere.
  await page.reload();
  await expect(page.locator('[data-link-title="Chat"]')).toHaveCount(1);
  await expect(page.locator('[data-link-title="Chat"]')).toContainText("P4 low · 30 min");
  const v = await visitor(browser);
  await v.goto("/book/omar");
  await expect(v.getByTestId("public-link").filter({ hasText: "Chat" })).toHaveCount(1);
  // The source stays P4: the P3 habit's time is not offered there.
  await v.goto(`/book/omar/chat?day=${W}`);
  await expect(slot(v, at(W, "10:00"))).toBeVisible();
  await expect(slot(v, at(W, "09:00"))).toHaveCount(0);

  // The one-off link: P1 offers the P3 habit's time, 45 minutes, prefilled invitee.
  await v.goto(new URL(url).pathname);
  await expect(v.getByTestId("booking-page")).toContainText("Chat");
  await slot(v, at(W, "09:00")).click();
  const bf = v.getByTestId("book-form");
  await expect(bf).toContainText("09:00 to 09:45");
  await expect(bf.getByLabel("Your name")).toHaveValue("Pia");
  await expect(bf.getByLabel("Your email")).toHaveValue("pia@example.com");
  await bf.getByLabel("Your name").fill("Pia Park");
  await bf.getByRole("button", { name: "Book" }).click();
  await expect(v.getByTestId("booked")).toBeVisible();
  const evs = await eventually(
    () => allEvents(cal),
    (l) => expect(l.find((e) => e.summary === "Chat with Pia Park")).toBeDefined(),
  );
  const ev = evs.find((e) => e.summary === "Chat with Pia Park");
  expect([local(ev?.start ?? 0), local(ev?.end ?? 0)]).toEqual([`${W} 09:00`, `${W} 09:45`]);

  // The source keeps 30 minutes, and the booking used its daily limit.
  await v.goto(`/book/omar/chat?day=${day(1)}`);
  await slot(v, at(day(1), "10:00")).click();
  await expect(v.getByTestId("book-form")).toContainText("10:00 to 10:30");
  await v.goto(`/book/omar/chat?day=${W}`);
  await expect(v.getByTestId("times")).toBeVisible();
  const monday = (
    await v
      .locator('[data-testid="times"] button[data-start]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-start"))))
  ).map(local);
  expect(monday.filter((s) => s.startsWith(W))).toEqual([]);

  // The creator opens the URL signed in and edits it: other hours and 60 minutes.
  await page.goto(new URL(url).pathname);
  await page.getByRole("button", { name: "Edit this link" }).click();
  const edit = page.getByTestId("oneoff-form");
  await expect(edit.getByLabel("Invitee name")).toHaveValue("Pia");
  await expect(edit.getByLabel("Priority")).toHaveValue("1");
  await edit.getByLabel(/^Durations/).fill("60");
  await edit
    .locator("[data-organizer]")
    .first()
    .getByLabel("Hours")
    .selectOption({ label: "Late" });
  await edit.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("oneoff-form")).toHaveCount(0);
  await v.goto(`${new URL(url).pathname}?day=${day(1)}`);
  const first = v
    .locator('[data-testid="day-times"]')
    .first()
    .locator("button[data-start]")
    .first();
  await expect(first).toHaveAttribute("data-start", String(at(day(1), "13:00")));
  await first.click();
  await expect(v.getByTestId("book-form")).toContainText("13:00 to 14:00");
  await v.reload();
  await expect(v.getByTestId("durations")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Edit this link" }).click();
  await expect(page.getByTestId("oneoff-form").getByLabel(/^Durations/)).toHaveValue("60");
});

test("a one-off link expires 30 days after creation: its URL then shows an expired page with no times (sharing rule 14)", async ({
  page,
  browser,
  signIn,
  app,
}) => {
  // The 30 days count in the user's zone. At 22:30 UTC Berlin is already on the
  // next day, and summer time ends within the 30 days: 30 x 24 h ends a day early.
  const created = Date.parse("2026-10-19T22:30:00Z");
  app.env.TEST_CLOCK_START = new Date(created).toISOString();
  await app.restart();
  await signIn();
  await claimPage(page, "pam");
  await personalize(page, "Meeting");
  await page.getByTestId("oneoff-form").getByRole("button", { name: "Copy link" }).click();
  const url = (await page.getByTestId("oneoff-url").textContent()) ?? "";
  expect(utcToLocal(ZONE, created).date).toBe("2026-10-20");
  await expect(page.getByTestId("oneoff-expiry")).toHaveAttribute("data-date", "2026-11-19");
  const v = await visitor(browser);
  await v.goto(new URL(url).pathname);
  await expect(v.getByTestId("times")).toBeVisible();
  await expect(v.getByTestId("expired")).toHaveCount(0);

  // The operator shortens the lifetime: the link created above is now past it.
  app.env.ONEOFF_LINK_DAYS = "0";
  app.env.TEST_CLOCK_START = new Date(created + 3_600_000).toISOString();
  await app.restart();
  await v.reload();
  await expect(v.getByTestId("expired")).toContainText("expired");
  await expect(v.getByTestId("times")).toHaveCount(0);
  const status = await v.evaluate(
    async (path) =>
      (
        await fetch(`/pub/pages/o/${path.split("/").at(-1)}/book`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            start: Date.now() + 86_400_000,
            duration: 30,
            name: "Late",
            email: "late@example.com",
          }),
        })
      ).status,
    new URL(url).pathname,
  );
  expect(status).toBe(410);
});

test("shared times: up to 5 dates, offered times as buttons or text, merged text ranges, time links that open the booking page, and the last template kept (sharing rules 17-22)", async ({
  page,
  browser,
  cal,
  signIn,
}) => {
  await blockUntil(cal, W);
  await cal.addEvent({ title: "Busy", start: at(day(1), "11:00"), end: at(day(1), "12:00") });
  await signIn();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await claimPage(page, "quin");
  await addLink(page, { title: "Chat", durations: "30" });
  await personalize(page, "Chat");
  await page.getByTestId("personalize").getByRole("button", { name: "Share times" }).click();
  const st = page.getByTestId("share-times");

  // Five dates at most.
  for (const n of [0, 1, 2, 3, 4]) await st.locator(`[data-date="${day(n)}"] input`).check();
  await expect(st.locator(`[data-date="${day(5)}"] input`)).toBeDisabled();
  for (const n of [0, 2, 3, 4]) await st.locator(`[data-date="${day(n)}"] input`).uncheck();
  await expect(st.locator(`[data-date="${day(5)}"] input`)).toBeEnabled();

  // Only offered times can be picked: 11:00 is busy.
  const times = st.locator(`[data-times-of="${day(1)}"]`);
  await expect(times.locator(`[data-start="${at(day(1), "10:00")}"]`)).toBeVisible();
  await expect(times.locator(`[data-start="${at(day(1), "11:00")}"]`)).toHaveCount(0);
  await times.locator(`[data-start="${at(day(1), "10:00")}"] input`).check();
  await times.locator(`[data-start="${at(day(1), "10:30")}"] input`).check();

  // Text, start and end, no links: one merged range.
  await st.getByLabel("Text", { exact: true }).check();
  await st.getByLabel("Show start and end").check();
  await st.getByLabel("Include links").uncheck();
  await expect(st.getByTestId("times-preview")).toContainText("10:00–11:00");
  await st.getByRole("button", { name: "Copy times" }).click();
  await expect.poll(async () => (await clipboard(page)).text).toContain("10:00–11:00");
  const copied = await clipboard(page);
  expect(copied.text).not.toContain("10:30");
  expect(copied.html).toContain("10:00–11:00");

  // Buttons: one link per time, opening the booking page on that time.
  await st.getByLabel("Buttons", { exact: true }).check();
  const buttons = st.getByTestId("times-preview").getByRole("link", { name: /^10:/ });
  await expect(buttons).toHaveCount(2);
  const href = (await buttons.first().getAttribute("href")) ?? "";
  expect(href).toContain(`day=${day(1)}`);
  expect(href).toContain("time=10:00");
  expect(href).toContain("duration=30");
  expect(href).toContain("tz=Europe%2FBerlin");
  const v = await visitor(browser);
  await v.goto(href);
  await expect(v.getByTestId("book-form")).toContainText("10:00 to 10:30");

  // The template: variables, preview, and kept for next time.
  const template = st.getByLabel("Message template");
  await template.fill("Pick one ({timezone}, {duration}):\n{times}\nAll times: {link}");
  await template.blur();
  await expect(st.getByTestId("times-preview")).toContainText(
    "Pick one (Europe/Berlin, 30 minutes)",
  );
  await expect(st.getByTestId("times-preview")).toContainText("/book/quin/chat");
  await st.getByRole("button", { name: "Copy times" }).click();
  await expect.poll(async () => (await clipboard(page)).text).toContain("Pick one (");
  await page.reload();
  await personalize(page, "Chat");
  await page.getByTestId("personalize").getByRole("button", { name: "Share times" }).click();
  await expect(page.getByTestId("share-times").getByLabel("Message template")).toHaveValue(
    "Pick one ({timezone}, {duration}):\n{times}\nAll times: {link}",
  );
});
