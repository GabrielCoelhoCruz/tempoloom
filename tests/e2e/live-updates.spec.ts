// Live updates (docs/specs/accounts-delegated-access.md rule 9): an open page
// reads its view again after a change to the account, also a change made
// before its change stream connected, and a fresh load reads each view once.
//
// Ways it can fail, and the check that catches each:
// - a change made before the stream connects shows only at the 15 s refresh -> event visible in 8 s
// - the account data stays stale after the missed change                    -> /api/me read again
// - the stream's first signal makes the planner load a second time          -> one events request
import type { Page } from "@playwright/test";
import { at, BASE_URL, expect, planNow, test } from "./fixtures.ts";
import { openWeek, W } from "./helpers.ts";

const isPath = (url: string, path: string) => new URL(url).pathname === path;

/** Holds this page's change stream until the returned function is called. */
async function holdLive(page: Page): Promise<() => void> {
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route(
    (url) => url.pathname === "/api/live",
    async (route) => {
      await held;
      await route.continue();
    },
  );
  return release;
}

test("a calendar change synced before the live stream connects shows without a reload", async ({
  page,
  cal,
  signIn,
}) => {
  await signIn();
  await planNow(page);
  const release = await holdLive(page);
  const loaded = Date.now();
  const firstLoad = page.waitForResponse((r) => isPath(r.url(), "/api/planner/events"));
  await openWeek(page);
  await firstLoad;
  const event = page.locator(".ev-external", { hasText: "LV-Missed call" });
  await expect(event).toHaveCount(0);

  await cal.addEvent({ title: "LV-Missed call", start: at(W, "10:00"), end: at(W, "11:00") });
  // The sync reads the event while the stream is held: its signal reaches no page.
  const sync = await page.request.post("/api/planner/sync", { headers: { origin: BASE_URL } });
  expect(sync.status()).toBe(200);
  // The planner's own refresh comes 15 s after the load; the stream must be faster.
  expect(Date.now() - loaded).toBeLessThan(6_000);
  const meAgain = page.waitForRequest((r) => isPath(r.url(), "/api/me"), { timeout: 8_000 });
  release();
  await expect(event).toBeVisible({ timeout: 8_000 });
  // The account data (settings, accounts, access) is read again too.
  await meAgain;
});

test("a fresh planner load asks for its events once", async ({ page, signIn }) => {
  await signIn();
  await planNow(page);
  const loads: string[] = [];
  page.on("request", (r) => {
    if (isPath(r.url(), "/api/planner/events")) loads.push(r.url());
  });
  const live = page.waitForResponse((r) => isPath(r.url(), "/api/live"));
  await openWeek(page);
  await live;
  await expect.poll(() => loads.length).toBe(1);
  // The stream's first signal comes with its headers; a second load would follow at once.
  await page.waitForTimeout(1_000);
  expect(loads).toHaveLength(1);
});
