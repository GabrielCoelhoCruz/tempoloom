// Cold page load and interaction latency of the planner, in real Chrome.
// A local server gets a seeded database: one user, 30 meetings and the
// managed events that plan() makes for the benchmark week.
// Usage: npm run build && node bench/page-load.ts [runs]
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { plan } from "../src/scheduler/plan.ts";
import { createSession, ensureUser, upsertAccount } from "../src/server/accounts.ts";
import { SecretBox } from "../src/server/crypto.ts";
import { openDb, run } from "../src/server/db.ts";
import { addDays, localToUtc, utcToLocal, weekdayOf } from "../src/shared/time.ts";
import { benchSnapshot } from "./week-fixture.ts";

const RUNS = Number(process.argv[2] ?? 10);
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const ZONE = "Europe/Berlin";
const ROOT = join(import.meta.dirname, "..");

const dataDir = mkdtempSync(join(tmpdir(), "tempoloom-bench-"));
const secretKey = randomBytes(32).toString("base64");

// Seed: user, a calendar, the meetings, and the planned managed events.
const now = Date.now();
// The seeded week starts on the next Monday; the planner opens it with ?week=.
let monday = addDays(utcToLocal(ZONE, now).date, 1);
while (weekdayOf(monday) !== 1) monday = addDays(monday, 1);
const snapshot = benchSnapshot(ZONE, monday, now);
const result = plan(snapshot);
const db = openDb(join(dataDir, "tempoloom.db"));
const box = new SecretBox(secretKey);
const user = ensureUser(db, "bench@tempoloom.test", "Bench");
run(db, "UPDATE users SET time_zone = ? WHERE id = ?", ZONE, user.id);
const accountId = upsertAccount(db, box, {
  userId: user.id,
  provider: "caldav",
  externalId: "bench",
  email: "bench@tempoloom.test",
  serverUrl: "http://127.0.0.1:9/",
  credentials: { username: "bench", password: "unused" },
});
const calendarId = randomUUID();
run(
  db,
  "INSERT INTO calendars (id, account_id, provider_id, name, is_primary, check_availability, window_end) VALUES (?, ?, 'bench', 'Bench', 1, 1, ?)",
  calendarId,
  accountId,
  now + 365 * 86_400_000,
);
run(
  db,
  "UPDATE accounts SET calendars_synced_at = ? WHERE id = ?",
  now + 365 * 86_400_000,
  accountId,
);
for (const e of snapshot.events) {
  run(
    db,
    "INSERT INTO events (calendar_id, event_id, summary, start_ms, end_ms, busy, attendee_count) VALUES (?, ?, ?, ?, ?, 1, 3)",
    calendarId,
    e.id,
    e.title,
    e.start,
    e.end,
  );
}
for (const p of result.placements) {
  run(
    db,
    `INSERT INTO managed_events (id, user_id, calendar_id, event_id, key, kind, source_id, start_ms, end_ms, busy, title, locked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    randomUUID(),
    user.id,
    calendarId,
    randomUUID(),
    p.key,
    p.kind,
    p.itemId,
    p.start,
    p.end,
    p.busy ? 1 : 0,
    `${p.kind} ${p.itemId}`,
  );
}
const token = createSession(db, user.id);
db.close();

const server = spawn(process.execPath, ["src/server/main.ts"], {
  cwd: ROOT,
  env: {
    PATH: process.env.PATH ?? "",
    PORT: String(PORT),
    BASE_URL: BASE,
    DATA_DIR: dataDir,
    SECRET_KEY: secretKey,
    SYNC_INTERVAL_SECONDS: "3600",
    WEB_DIST: join(ROOT, "dist/web"),
  },
  stdio: "ignore",
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${BASE}/healthz`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] ?? 0;
};

process.on("exit", () => server.kill("SIGTERM"));
const browser = await chromium.launch({ channel: "chrome" });
const load: { fcp: number; ready: number; transferKB: number }[] = [];
const inWeek = result.placements.filter(
  (p) =>
    p.start >= localToUtc(ZONE, monday, 0) && p.start < localToUtc(ZONE, addDays(monday, 7), 0),
).length;
for (let i = 0; i < RUNS; i++) {
  const context = await browser.newContext({
    timezoneId: ZONE,
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([{ name: "tl_session", value: token, url: BASE }]);
  const page = await context.newPage();
  await page.bringToFront();
  await page.goto(`${BASE}/?week=${monday}`);
  await page.waitForFunction(
    (n) => document.querySelectorAll(".ev").length >= n,
    Math.min(inWeek, 20),
  );
  const m = await page.evaluate(async () => {
    const ready = performance.now();
    const paint = await new Promise<PerformanceEntry[]>((resolve) => {
      new PerformanceObserver((l) => resolve(l.getEntries())).observe({
        type: "paint",
        buffered: true,
      });
      setTimeout(() => resolve([]), 500);
    });
    const fcp = paint.find((e) => e.name === "first-contentful-paint")?.startTime ?? -1;
    const bytes = performance
      .getEntriesByType("resource")
      .concat(performance.getEntriesByType("navigation"))
      .reduce((a, r) => a + ((r as PerformanceResourceTiming).transferSize ?? 0), 0);
    return { fcp, ready, transferKB: bytes / 1024 };
  });
  load.push(m);
  await context.close();
}

// Interaction latency: Event Timing API durations (input to next paint).
const context = await browser.newContext({
  timezoneId: ZONE,
  viewport: { width: 1440, height: 900 },
});
await context.addCookies([{ name: "tl_session", value: token, url: BASE }]);
const page = await context.newPage();
await page.goto(`${BASE}/?week=${monday}`);
await page.waitForSelector(".ev-task, .ev-habit, .ev-focus");
await page.evaluate(() => {
  (window as unknown as { __durations: number[] }).__durations = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[]) {
      if (e.interactionId)
        (window as unknown as { __durations: number[] }).__durations.push(e.duration);
    }
  }).observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
});
const openDetails: number[] = [];
const weekSwitch: number[] = [];
const boxes = page.locator(".ev-task, .ev-habit, .ev-focus");
for (let i = 0; i < 20; i++) {
  const t0 = Date.now();
  await boxes.nth(i % Math.max(1, await boxes.count())).click();
  await page.getByTestId("event-drawer").waitFor();
  openDetails.push(Date.now() - t0);
  await page.getByRole("button", { name: "Close" }).click();
}
for (let i = 0; i < 10; i++) {
  const t0 = Date.now();
  await page.getByRole("button", { name: i % 2 ? "Previous week" : "Next week" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ev").length > 0);
  weekSwitch.push(Date.now() - t0);
}
const durations = await page.evaluate(
  () => (window as unknown as { __durations: number[] }).__durations,
);
await browser.close();
server.kill("SIGTERM");

console.log(
  JSON.stringify(
    {
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGB: Math.round(totalmem() / 2 ** 30),
      node: process.version,
      chrome: "system Google Chrome (channel chrome)",
      runs: RUNS,
      seeded: {
        managedEvents: result.placements.length,
        meetings: snapshot.events.length,
        inViewWeek: inWeek,
      },
      coldLoadMs: {
        firstContentfulPaint: {
          median: Math.round(median(load.map((l) => l.fcp))),
          p95: Math.round(p95(load.map((l) => l.fcp))),
        },
        plannerReady: {
          median: Math.round(median(load.map((l) => l.ready))),
          p95: Math.round(p95(load.map((l) => l.ready))),
        },
        transferKB: Math.round(median(load.map((l) => l.transferKB))),
      },
      interaction: {
        eventTimingMs: {
          count: durations.length,
          median: Math.round(median(durations)),
          p95: Math.round(p95(durations)),
        },
        openDetailsWallMs: { median: median(openDetails), p95: p95(openDetails) },
        weekSwitchWallMs: { median: median(weekSwitch), p95: p95(weekSwitch) },
      },
    },
    null,
    2,
  ),
);
