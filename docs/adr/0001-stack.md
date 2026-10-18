# ADR 0001: Stack

Status: accepted (2026-10-18)

## Context

Tempoloom schedules tasks, habits, focus time and buffers into a user's
calendar. It must be:

- fast: short cold page load, low interaction latency, and a scheduler that
  solves a realistic week in milliseconds;
- easy to self-host: one process, one data file, no external services except
  the calendar provider;
- type-safe and simple to maintain by a small group of contributors.

The scheduler is the core. It must be deterministic: the same input always
gives the same calendar.

## Decision

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict mode, everywhere | One language for scheduler, server and UI. The domain types are shared, so the compiler checks the boundaries. |
| Server runtime | Node.js 24 LTS | Runs `.ts` files directly (type stripping). The server has no build step. |
| Database | SQLite through the built-in `node:sqlite` module, WAL mode | No native addon to compile. One file to back up. Enough for one person or one team on one host. |
| HTTP | Hono on `@hono/node-server` | Small, fast, Web-standard `Request`/`Response`. Easy to test in process. |
| UI | Preact with Signals, built by Vite | About 4 KB of runtime. Signals update only the DOM nodes that change, which keeps drag interactions fast. |
| Validation | Zod at the HTTP boundary | Parses untrusted input into the shared domain types. |
| Calendar provider | Google Calendar REST API with `fetch` | The official SDK is large. We use only a few endpoints. |
| Scheduler | Own deterministic solver, pure TypeScript | See below. |
| Tests | Vitest (with fast-check) for the scheduler; Playwright for E2E against a real Google account | E2E is the main proof. The scheduler also gets behavior and property tests because its failure modes are combinatorial. |
| Lint and format | Biome | One fast tool for both. |

### Scheduler model

The scheduler is a constraint problem on a time grid:

- Hard constraints: no overlap with busy time, stay inside the item's hours,
  respect start-after and due dates, chunk sizes, and daily limits.
- Soft goals: ideal time and ideal days, keep the previous placement
  (stability), earlier placement before a deadline, and fewer fragments.

The solver places items in a fixed lexicographic order (priority first, then
the item's urgency, then a stable id). For each item it scores every feasible
slot with an integer score and takes the best one. Ties break on start time.
There is no randomness and no floating-point score, so results are
reproducible across machines.

We did not use an exact solver (for example OR-Tools CP-SAT). It adds a native
dependency, its run time varies, and a week of personal scheduling does not
need it. The solver interface keeps this option open.

## Alternatives considered

- Go or Rust single binary: faster raw execution and a single static file.
  Rejected because it splits the code base into two languages and loses
  shared types with the UI. The TypeScript scheduler is fast enough (see
  `docs/performance.md`).
- PostgreSQL: better for many tenants on one deployment. Rejected for now
  because it doubles the self-hosting work. The data access layer is small,
  so a later move stays possible.
- React: larger runtime (about 45 KB compressed). Preact keeps the same
  component model with a much smaller bundle.
- Full-stack frameworks with server rendering (Next.js, Remix): more moving
  parts and a heavier runtime for a single-page planner.
- `googleapis` SDK: tens of megabytes of generated code for a handful of calls.

## Consequences

- The server code must use only erasable TypeScript syntax (no `enum`, no
  parameter properties), because Node.js strips the types without compiling.
- Imports use explicit `.ts` extensions.
- SQLite limits write concurrency to one writer. This is acceptable for the
  target size. Long-running work (calendar sync) must keep transactions short.
- Each new calendar provider (for example Microsoft Outlook) implements the
  same provider interface as Google.
