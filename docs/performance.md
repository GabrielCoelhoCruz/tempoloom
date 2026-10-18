# Performance

Speed is a product goal. This file records how we measure it, the numbers,
and the hardware. Re-run the commands after a change that can affect speed.

## Hardware and software

- CPU: AMD EPYC-Genoa, 12 vCPUs (1 thread per core), shared virtual server
- Memory: 31 GB
- Node.js 24.21.0, Google Chrome 155.0.8059.79 (headless, through Playwright)
- Server and browser on the same host (loopback network)
- Measured on 2026-10-18 at commit `374db4c`

## Results

| Metric | Median | p95 | Notes |
|---|---|---|---|
| Scheduler solve, realistic two-week plan, first plan | 1.64 ms | 3.07 ms | 200 runs after 20 warm-up runs |
| Scheduler solve, same plan with existing placements (steady state) | 1.59 ms | 3.00 ms | stickiness path |
| Scheduler solve, first call in a fresh process | 17.7 ms | | one call; includes time-zone formatter setup |
| Cold page load: first contentful paint | 72 ms | 80 ms | new browser context, empty cache, 10 runs |
| Cold page load: planner ready (week grid shows its events) | 91 ms | 97 ms | 53 events in the viewed week |
| Data transferred on cold load | 67 KB | | HTML, JS, CSS and API JSON |
| Client bundle | 16.8 KB JS + 1.9 KB CSS | | gzip; `npm run build` |
| Interaction latency (Event Timing, input to next paint) | ≤ 16 ms | ≤ 16 ms | 146 events; all at the API's 16 ms reporting floor |
| Open an event's details (click to panel visible) | 36 ms | 56 ms | wall time seen by the test driver, includes its own overhead |
| Switch week (click to new week's events drawn) | 67 ms | 67 ms | includes the API request |

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

## Notes on method

- The solver time is wall time of `plan()` only: no database or network.
  The first call in a process is slower because `Intl.DateTimeFormat` objects
  for the time zone are built; later calls reuse a per-zone offset cache.
- "Planner ready" is `performance.now()` when the week grid holds the
  expected number of event blocks, measured from navigation start.
- The Event Timing API reports only interactions of 16 ms or more, rounded
  to 8 ms. Every measured interaction sat at that floor.
- CI runs the solver benchmark on every push as a smoke check of speed;
  CI runners are slower and shared, so their numbers are not recorded here.
