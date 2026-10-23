// More page loads that answer late (the same fault as load-races.spec.ts): a
// load for another query answers after a newer one. The routes below hold one
// call, so each fault shows on every run, not only on a slow runner.
//
// Ways it can fail, and the check that catches each:
// - an older page of booking times answers after a newer page and shows its
//   times                                     -> the newer page stays
// - the same in the availability inspector    -> the newer page stays
// - an older guest lookup on the meeting form answers after a newer one
//                                             -> the newer guest stays
import type { Page, Route } from "@playwright/test";
import { addDays } from "../../src/shared/time.ts";
import { at, expect, test } from "./fixtures.ts";
import { addLink, claimPage, W } from "./helpers.ts";

const P2 = addDays(W, 14);
const P3 = addDays(W, 28);

/** Holds each request of `url` until the returned function is called. */
async function hold(page: Page, url: string): Promise<() => void> {
  let release = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  await page.route(url, async (route: Route) => {
    await released;
    await route.continue();
  });
  return release;
}

/** Waits until the page drew what its last answers changed. */
const drawn = (page: Page) =>
  page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );

/**
 * Clicks "Later" in `box` twice, the second time after the page drew the first
 * click but before it starts that load: two pages load at the same time.
 */
const laterTwice = (page: Page, box: string) =>
  page.evaluate(async (box) => {
    const later = () =>
      [...document.querySelectorAll(`[data-testid="${box}"] button`)].find(
        (b) => b.textContent === "Later",
      ) as HTMLButtonElement | undefined;
    later()?.click();
    await new Promise((r) => setTimeout(r, 0));
    const again = later();
    if (!again) throw new Error("Later is gone before the second click");
    again.click();
  }, box);

test("booking times of an older page that answers last do not replace the newer page", async ({
  page,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "lr");
  await addLink(page, { title: "Race times", durations: "30" });
  await page.goto(`/book/lr/race-times?day=${W}`);
  const times = page.getByTestId("times");
  await expect(times.locator(`[data-day="${W}"]`)).toBeVisible();

  // The second page (two weeks after W) waits; the third is after the last
  // bookable day, so it has no times.
  const release = await hold(page, `**/pub/pages/lr/race-times/times?*from=${at(P2, "00:00")}*`);
  const third = page.waitForResponse((r) => r.url().includes(`from=${at(P3, "00:00")}`));
  await laterTwice(page, "times");
  expect((await third).ok()).toBe(true);
  const empty = times.getByText("No free times in these two weeks.");
  await expect(empty).toBeVisible();

  const second = page.waitForResponse((r) => r.url().includes(`from=${at(P2, "00:00")}`));
  release();
  expect((await second).ok()).toBe(true);
  await drawn(page);
  await expect(empty).toBeVisible();
  await expect(times.getByTestId("day-times")).toHaveCount(0);
});

test("the availability inspector of an older page that answers last does not replace the newer page", async ({
  page,
  signIn,
}) => {
  await signIn();
  await claimPage(page, "lr");
  await addLink(page, { title: "Race inspect", durations: "30" });
  await page.goto(`/book/lr/race-inspect?day=${W}&inspect=1`);
  const inspector = page.getByTestId("inspector");
  await expect(inspector.locator(`[data-day="${W}"]`)).toBeVisible();

  const release = await hold(page, `**/api/booking/inspect?*from=${at(P2, "00:00")}*`);
  const third = page.waitForResponse((r) => r.url().includes(`from=${at(P3, "00:00")}`));
  await laterTwice(page, "inspector");
  expect((await third).ok()).toBe(true);
  await expect(inspector.locator(`[data-day="${P3}"]`)).toBeVisible();

  const second = page.waitForResponse((r) => r.url().includes(`from=${at(P2, "00:00")}`));
  release();
  expect((await second).ok()).toBe(true);
  await drawn(page);
  await expect(inspector.locator(`[data-day="${P3}"]`)).toBeVisible();
  await expect(inspector.locator(`[data-day="${P2}"]`)).toHaveCount(0);
});

test("an older guest lookup on the meeting form that answers last does not replace the newer one", async ({
  page,
  signIn,
}) => {
  await signIn();
  await page.getByRole("link", { name: "Meetings" }).click();
  const guests = page
    .getByTestId("meeting-form")
    .getByLabel("Guests (comma list)", { exact: true });
  const release = await hold(page, "**/api/meetings/person?email=lr-first*");
  await guests.fill("lr-first@example.com");
  await guests.blur();
  const newer = page.waitForResponse((r) => r.url().includes("email=lr-second"));
  await guests.fill("lr-second@example.com");
  await guests.blur();
  expect((await newer).ok()).toBe(true);
  const info = page.getByTestId("attendee-info");
  await expect(info).toContainText("lr-second@example.com");

  const older = page.waitForResponse((r) => r.url().includes("email=lr-first"));
  release();
  expect((await older).ok()).toBe(true);
  await drawn(page);
  await expect(info).toContainText("lr-second@example.com");
  await expect(info).not.toContainText("lr-first@example.com");
});
