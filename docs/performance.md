# Performance

Speed is a product goal. This file records how we measure it, the numbers,
and the hardware. Re-run the commands after a change that can affect speed.

## What we measure

| Metric | Definition | Command |
|---|---|---|
| Scheduler solve time | Wall time of one `plan()` call for a realistic week: 50 tasks, 10 habits and 30 meetings over a 14-day horizon. Median and p95 of 200 runs after 20 warm-up runs. | `npm run bench` |
| Cold page load | A new browser context with an empty cache opens the planner. We report first contentful paint, and "planner ready": the time until the week grid shows the seeded events. Median of 10 runs against a local server. | `node bench/page-load.ts` |
| Interaction latency | Event Timing API duration for dragging a task block to a new slot and for opening an event's details. Median and p95 of 20 interactions. | `node bench/page-load.ts` |
| Client bundle | Compressed size of the JavaScript and CSS that the planner loads. | `npm run build` |

## Results

Not measured yet. Results are added with the scheduler and planner.
