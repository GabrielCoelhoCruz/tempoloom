# Performance

Speed is a product goal. This file records how we measure it, the numbers,
and the hardware. Re-run the commands after a change that can affect speed.

## Hardware and software

- CPU: AMD EPYC-Genoa, 12 vCPUs (1 thread per core), shared virtual server
- Memory: 31 GB
- Node.js 24.21.0, Google Chrome 155.0.8059.79 (headless, through Playwright)
- Server and browser on the same host (loopback network)
- Measured on 2026-10-19 on the code of commit `a715aae` (first measured at `06f0e59`; see History)
- The host is shared: medians of the same build move by about 4 ms between runs.
  Compare builds in one session, alternating them (see "Comparing two builds").

## Results

| Metric | Median | p95 | Notes |
|---|---|---|---|
| Scheduler solve, realistic two-week plan, first plan | 1.60 to 1.70 ms | 3.0 to 3.4 ms | 300 runs after 20 warm-up runs, three rounds |
| Scheduler solve, same plan with existing placements (steady state) | 1.60 to 1.72 ms | 2.2 to 3.1 ms | stickiness path |
| Scheduler solve, first call in a fresh process | 12 to 14 ms | | one call; includes time-zone formatter setup |
| Cold page load: first contentful paint | 76 to 80 ms | 88 to 92 ms | new browser context, empty cache, 30 runs, three rounds |
| Cold page load: planner ready (week grid shows its events) | 90 to 96 ms | 102 to 113 ms | 53 events in the viewed week |
| Data transferred until the planner is ready | 25 KB | | HTML, JS, CSS and API JSON, compressed (brotli or gzip, as the browser asks) |
| Client code on cold load | 19.3 KB JS + 3.3 KB CSS | | gzip; the entry and the shared base chunk. Other pages, the sign-in page and the planner's side parts load on first use |
| Interaction latency (Event Timing, input to next paint) | ≤ 16 ms | ≤ 24 ms | about 150 events; almost all at the API's 16 ms reporting floor |
| Open an event's details (click to panel visible) | 36 to 37 ms | 58 to 127 ms | wall time seen by the test driver, includes its own overhead; the tail is the first click while the side parts load |
| Switch week (click to new week's events drawn) | 66 to 67 ms | 67 to 89 ms | includes the API request |

### Comparing two builds

On 2026-10-19 the end of the team work (`4eb705b`) and `a715aae` (round 3:
185 more parity rows done) were measured in one session, alternating, three
rounds of 30 cold loads and three rounds of 300 scheduler runs each. The
values are the medians of each round:

| Build | First contentful paint | Planner ready | Transferred until ready | Scheduler, first plan |
|---|---|---|---|---|
| `4eb705b` (before round 3) | 80, 80, 80 ms | 92, 92, 93 ms | 23 KB | 1.66, 1.55, 1.62 ms |
| `a715aae` (round 3) | 80, 80, 76 ms | 94, 96, 90 ms | 25 KB | 1.60, 1.70, 1.65 ms |

The first merge of round 3 drew the planner's new side parts (the now line,
hints, preview panel, focus progress, issues panel) with the week. That cost
15 ms of planner ready and 18 KB, because their code and nine small API
requests ran beside the week's own request. They now render once the week's
events are drawn and the browser is idle (`settled` in `src/web/lib/lazy.ts`).
Grouping them into one chunk made it worse: the chunk became part of the
first load. The sign-in page left the entry chunk at the same time.

### What "realistic two-week plan" means

The benchmark input (`bench/week-fixture.ts`) is deterministic: 50 tasks
(30 to 120 minutes, chunks of 30 to 120 minutes, 70% with due dates), 10
habits (daily and weekly, all three defense modes), 30 meetings, 2 buffer
automations, a 8-hour focus goal, 10-minute breaks, urgency mode
"due date and remaining work", over a 14-day window in Europe/Berlin. The
plan has 112 placements; 53 report entries say what could not be placed in
full (the week is deliberately overbooked).

## How to reproduce

```bash
npm ci
npm run build
node bench/scheduler-week.ts 200   # solver; prints JSON
node bench/page-load.ts 10         # page load and interactions; prints JSON
```

`bench/page-load.ts` starts its own server on port 8799 with a temporary,
seeded database and stops it at the end. It needs Google Chrome installed
(Playwright channel `chrome`).

## History

| Commit | Change | Effect |
|---|---|---|
| `06f0e59` | First measurement | FCP 72 ms, planner ready 91 ms, 67 KB transferred, bundle 16.8 KB gzip |
| `45dae92` | Booking links, webhooks, mirroring, stats, tools, flexible meetings | bundle 26.5 KB gzip; 105 KB transferred, because the server did not compress |
| `ed4db11` | Compressed responses; the client is compressed once at start | 29 KB transferred; FCP 72 ms. Compressing per request cost about 8 ms of FCP, so static files are compressed once |
| `69696a6` | Automation library, categories and colors (measured again on 2026-10-19) | 33 KB transferred; FCP 76 ms, planner ready 87 ms in that session |
| `e23a14d` | Team features; every page other than the planner loads on first use, with one shared base chunk | 23 KB transferred; FCP and planner ready equal to `69696a6` within 3 ms. Splitting pages into more chunks without the base chunk cost about 8 ms of FCP |
| `a715aae` | Round 3 features; the planner's side parts render after its first data; the sign-in page loads on demand | 25 KB until the planner is ready; FCP and planner ready equal to `4eb705b` within 2 ms; the first click on an event can wait for the side parts (details p95 up to 127 ms) |

## Notes on method

- The solver time is wall time of `plan()` only: no database or network.
  The first call in a process is slower because `Intl.DateTimeFormat` objects
  for the time zone are built; later calls reuse a per-zone offset cache.
- "Planner ready" is `performance.now()` when the week grid holds the
  expected number of event blocks, measured from navigation start.
- First contentful paint is read from the performance timeline after the
  grid is ready. Runs without the entry would be listed as `missing`; there
  were none.
- The Event Timing API reports only interactions of 16 ms or more, rounded
  to 8 ms. Every measured interaction sat at that floor.
- CI runs the solver benchmark on every push as a smoke check of speed;
  CI runners are slower and shared, so their numbers are not recorded here.
