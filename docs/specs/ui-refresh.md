# UI refresh

Spec id: SPEC-UI-01
Evidence: none. This spec defines Tempoloom's own look and motion. It does not describe the reference product.
Status of evidence: not applicable

## Summary

This spec gives Tempoloom one visual system and a planner layout that gives
the calendar its full height. It sets design tokens with light, dark and
high-contrast values, a five-step type scale, and states for every control.
It moves the planner's side parts into a right column, redraws event cards
so their text is readable, fixes the breaks of the current app, adds a
mobile baseline, and adds motion only where motion has a purpose.

The design and motion rules come from Emil Kowalski's skills
(github.com/emilkowalski/skills, MIT): emil-design-eng, animate,
review-animations, mobile-native, break-ui and pick-ui-library. This spec
gives every value that the implementer needs. Do not look for values
elsewhere.

The work ships in four sequential pull requests (section 10). The E2E suite
stays unchanged and passes after each one.

## Reference images

The images are in `ui-refresh/` next to this file.

| Image | Content |
|---|---|
| `ui-refresh/planner-light.png` | Planner at 1440×900, light scheme |
| `ui-refresh/planner-dark.png` | Planner at 1440×900, dark scheme |
| `ui-refresh/planner-menu.png` | Planner with a menu open |
| `ui-refresh/planner-worst.png` | Planner with worst-case data (long titles, overlaps, short events, many notices) |
| `ui-refresh/planner-1024.png` | Planner at 1024 px: icon rail, right column as a drawer |
| `ui-refresh/planner-390.png` | Planner at 390 px: Day view and bottom bar |
| `ui-refresh/states.png` | Component states: default, hover, pressed, focus, disabled, selected |

The images show the target look. The text of this spec is the contract.
When an image and the text disagree, the text wins. The images can show
controls that this spec does not build (for example a quick-add field, a
free-time line under the day names, a resize grip, counts in the
navigation, or a "1 of 2" chunk index). Do not build a control or a
string that this spec does not list. Some of those controls also have
names that break E2E tests (rule TST-9).

## 1. Goal and non-goals

### Goals

1. One token system for color, type, spacing, radius, elevation, layers
   and motion, with light, dark, high-contrast and touch values.
2. A state for every interactive element: hover, pressed, focus, disabled
   and selected, with hit areas of 24 px (mouse) and 44 px (touch).
3. A planner in three columns: sidebar 208 px, main column, right column
   288 px. Only the toolbar is above the week.
4. Event cards with readable text in both schemes, one visual code per
   meaning, and a rule for overlaps and short events.
5. Fixes for the current breaks (section 8.2).
6. A mobile baseline and a layout for widths down to 390 px.
7. Motion with a purpose: press feedback, menus, dialogs, replanned events,
   drag and drop, toasts. All motion respects reduced motion.
8. No change to any existing test, and the full E2E suite passes after
   each pull request.
9. The cold-load budget holds (rule TST-12).

### Non-goals

1. New planner features: a quick-add field, drag from the right column to
   the calendar, a resize grip, free time per day, a Day/Week switch at
   desktop widths, a notice pager, counts in the navigation, the chunk
   index ("1 of 2") on cards, Delete in the event menu, undo endpoints.
2. A change to 48 px per hour, to the E2E viewport (1440×900), or to any
   accessible name, role or visible text in the test contract (section 2).
3. A theme switch. The app follows `prefers-color-scheme`.
4. Server API changes. Pagination in this spec is client-side.
5. Styled tooltips. Icon-only buttons keep a native `title`.
6. A redesign of the public booking pages, the stats charts and the
   tools pages. They get the tokens and the component states only.
7. The libraries that section 9 rejects or defers.

## 2. Rules that bind every pull request

### 2.1 Hard rules

- **TST-1.** Do not change an existing `test(...)` call: not its title,
  its body or its options. Do not edit any existing file under `tests/`,
  including the shared helpers (`helpers.ts`, `*-helpers.ts`,
  `fixtures.ts`). Exception: `tests/e2e/README.md`. A new test file is
  allowed.
- **TST-2.** Check TST-1 before each merge. This command must print
  nothing:
  `git diff --name-status origin/main...HEAD -- tests | grep -v '^A' | grep -v 'tests/e2e/README.md'`
- **TST-3.** Keep every accessible name, role and visible text in the test
  contract (2.2). Move a control only to the place that 2.2 gives.
- **TST-4.** Keep every class name, test id and attribute in 2.3. Do not
  rename them. Do not move them to another element.
- **TST-5.** Keep 48 px per hour. `HOUR_PX` in `src/web/views/week.tsx` and
  `--hour-px` in the tokens are both 48.
- **TST-6.** Do not add a step to an action that a test does: no confirm
  dialog, no hold-to-confirm, no second click, no delay before a control
  is usable.
- **TST-7.** Do not add text inside an element that a test reads with
  `toHaveText` or an exact name: `.ev-title`, `.ev-time`, `.day-name`,
  `[data-testid="week-label"]`, `[data-testid="user-email"]`, `.badge`,
  `.hour-label`, `.trend-col`, and the buttons and links in 2.2.
- **TST-8.** In an event card, keep the title before the time in the DOM.
  A test reads the card text with `/^Busy/`. Time-first layouts use the
  CSS `order` property only.
- **TST-9.** A new accessible name must not contain, case-insensitively,
  a name that a test queries without `exact: true` for the same role. A
  new name must not equal a name that a test queries with `exact: true`.
  Tests query these names without `exact` for buttons, among others:
  Close, Edit, Delete, Remove, Done, Save, Add, Open, Book, Start, Lock,
  Unlock, Snooze, Reschedule, Dismiss, Calendars, Tasks, Priorities,
  Next week, Log work, New task, Planner options, Sign out, Account menu.
  These names are therefore not allowed for new buttons: "Close side
  panel", "Add from Library", "Show tasks", "Mark {title} done". Use the
  names in this spec. To list all names that tests query, run:
  `grep -ohE 'getByRole\("[a-z]+", \{ name: "[^"]+"(, exact: true)?' tests/e2e/*.ts | sort -u`
- **TST-10.** New text that this spec adds is listed in this spec. Do not
  add other text on the planner, the task list, the navigation or a
  dialog.
- **TST-11.** Run the full E2E suite on CalDAV (`scripts/e2e-run.sh`) for
  each pull request. All tests pass. A test that fails is a defect of the
  pull request, not of the test.
- **TST-12.** Cold-load budget. Measure the gzip size (`gzip -9 -c FILE |
  wc -c`) of the three files that `dist/web/index.html` loads: the entry
  script, the `base` chunk and the entry stylesheet. A build of `a71564f`
  gives 11,138 bytes (entry) + 11,605 bytes (base) JS and 4,082 bytes
  CSS. Measure `main` again before PR 1 and use that value. For the four pull requests
  together, the JS grows by 1,000 bytes or less and the CSS grows by
  2,000 bytes or less. A library that loads on demand is not part of the cold load, but
  its chunk must not be in `base` (section 9). Planner ready and first
  contentful paint (`node bench/page-load.ts`, three rounds of 30 cold
  loads, alternating with `main` in one session) stay within 5 ms of
  `main`. `docs/performance.md` lists older numbers (19.3 KB + 3.3 KB);
  PR 4 records the new numbers there.

### 2.2 Test contract

Each row is a control that the E2E suite drives. "Place" is where the
control lives after this refresh. File and line numbers refer to
`tests/e2e/` at `a71564f`.

| Control | What the tests use | Place after the refresh |
|---|---|---|
| Week buttons | Buttons "Previous week" and "Next week" (`planning.spec.ts:174`, `assistant-C2.spec.ts:447`, `assistant-C4.spec.ts:789`) | Toolbar start. 32×32 icon buttons with a chevron mask. Keep the `aria-label`. At the E2E width the names stay "Previous week" and "Next week" (LAY-62 and LAY-63 change them only at 860 px and below) |
| Week title | `data-testid="week-label"`, text `Week of {date}` (`profile-formats.spec.ts:49`, `helpers.ts:163`) | Toolbar, after the week buttons. Same span, same text, nothing else inside the span |
| View as | Native `<select>` with the label "View as", `selectOption` (`planner-views.spec.ts:127, 145, 147, 172`) | Toolbar. Native select styled as a chip. The label text "View as" is in a `.sr-only` span inside the `<label>` |
| Calendars | Button "Calendars", not exact, page level (`planner-views.spec.ts:216, 243, 250`) | Toolbar. Icon button, `aria-label="Calendars"`, `title="Calendars"`, `aria-expanded` |
| Planner options | Button "Planner options", visible at load (`helpers.ts:172`) | Toolbar. Gear icon button |
| Log work | Button "Log work", page level (`task-progress.spec.ts:378`) | Toolbar. Icon button, `aria-label="Log work"`, `title="Log work"` |
| Plan now | Button "Plan now" | Toolbar end |
| Assistant | Button "Assistant", `exact: true`, with `aria-expanded` (`assistant-helpers.ts:12`) | Right column header (`now-bar`), in the panel switch with Tasks and Priorities |
| Preview mode | Checkbox with the label "Preview mode" inside `data-testid="preview-panel"`, `.check()` and `.uncheck()`; the panel contains "Changes you make now are staged"; the panel is visible at load (`preview.spec.ts:45-66`, `helpers.ts:174`); `preview-pending` and `apply-summary` texts (`preview.spec.ts:66, 68`; assistant specs) | Toolbar. The whole `section[data-testid="preview-panel"]` moves into the toolbar. Native checkbox with the `.switch` class. The sentence stays in the DOM and truncates |
| Now bar | `data-testid="now-bar"`; inside it `next-up`, `next-meeting`, buttons "Tasks" and "Priorities" with `aria-expanded`, the button "1 conflict", the text of the next meeting (`planner-views.spec.ts:170, 265-290`; `planner-now.spec.ts:55, 172, 214`; `task-flow.spec.ts:40`; `task-progress.spec.ts:688`) | Right column header. Keep the test id on the header element. The buttons are buttons, not `role="tab"` |
| Timer and block preview | `timer-bar` with button "Stop" (`task-timer.spec.ts:52, 151`); `block-preview` with "Apply", "Discard" and the text "work blocks for" with one block (`task-flow.spec.ts:300-308`, `disconnected-items.spec.ts:376-377`) | Right column header, one row each. Do not change the text "Preview: N work blocks for …" (ROB-21) |
| Side panels | `tasks-panel` (`task-flow.spec.ts:41`, `next-up-queue.spec.ts:161`), `priorities-panel` (`priorities.spec.ts:144`, `planner-views.spec.ts:270`), `conflicts` (`planner-now.spec.ts:214`, `planner-views.spec.ts:189-191`), `assistant-panel` (`assistant-helpers.ts:5`) | Right column content area, at the top |
| Issues | `role="tab"` with the name `/^Issues/`, then `checks-issues` (`meeting-helpers.ts:135-138`) | Right column overview |
| Report | `details[data-testid="issues"]`, a click on `summary`, text of the reasons (`habits.spec.ts:167-168`, `tasks.spec.ts:242-243`) | Right column overview, after Issues. Keep `details` and `summary` |
| Hints | `planner-hints` with `data-loaded` (`helpers.ts:173`); `hint-other-tools` with the link "Why" (`help.spec.ts:230-232`); `hint-assistant-chat` with the text "Ask the assistant about your calendar" and the button "Not now" (`assistant-C2-offer.spec.ts:28-95`); `hint-first-mirror` visible when present (`helpers.ts:180`, `mirror-planner.spec.ts:39, 190`) | Notices stack (LAY-20). All notices are visible at the same time |
| Other planner parts | `travel-prompt` (`travel.spec.ts:167, 170`), `hours-review-banner` (`hours-sets.spec.ts:196`), `focus-progress` (`events-2-tags.spec.ts:228`, `focus-modes.spec.ts:74`), `current-tasks` (`habit-actions.spec.ts:372`, `focus-modes.spec.ts:205`) | Travel prompt and hours review: notices stack. Focus progress and current tasks: right column overview |
| Event cards | Classes in 2.3; `.ev-time` exact text `HH:MM–HH:MM` (`profile-formats.spec.ts:54`, `planner-views.spec.ts:341`); card text starts with the title (`planner-views.spec.ts:149`); short-card geometry (`planner-views.spec.ts:318-353`); lock `::after` with a mask and a width above 0 (`planner-views.spec.ts:308, 355-360`) | Week grid. See CMP-80 to CMP-90 |
| Drags at 48 px per hour | `boundingBox()` then `page.mouse` (`planning.spec.ts:178-184`, `chunk-edits.spec.ts:161-178`, `preview.spec.ts:50-56`, `task-flow.spec.ts:321-330`, `task-progress.spec.ts:535-544`, `task-list.spec.ts:587-622`) | Keep the drop math and `data-start` updates |
| Week scroller | `.week-scroll` `scrollTop` in steps of 48 (`task-progress.spec.ts:352`, `task-list.spec.ts:357, 614`) | Keep `.week-scroll` as the vertical scroller of the grid |
| Day header | `.week-head .day-name` exact text (for example `Mon 26`) and `data-date` (`profile-formats.spec.ts:30, 50-52`); `.day-name.focus` (`weekly-report-extras.spec.ts:146, 152`); `.day-col` class `day-busy` | Keep. Today's number goes in a `<b>`. The text content stays `Mon 26` |
| Hour labels | `.week-body > .hours:not(.extra-hours) > .hour-label` nth(14) (`profile-formats.spec.ts:32`); `extra-hour` and `zone-head` test ids | Keep this structure. The now pill is not a `.hour-label` |
| Event details | `data-testid="event-drawer"`; buttons Lock or Unlock, Mark task done, Skip this day, Start timer, Reschedule, Snooze, Close, Ask the assistant; `event-category`, `event-source`, `event-copies`, `external-priority` | Right column content area, at the top. Same content and names. "Close" moves to the header and keeps the visible text "Close" |
| Navigation | Links Planner, Tasks, Habits, Meetings, Meeting checks, Automations, Priorities, Library, Booking links, Stats, Team, Policies, Settings, Account, Help; some with `exact: true` (`delegation.spec.ts:141-148` and others) | Sidebar. All 15 links stay. Group labels are not links. Icons are `aria-hidden` |
| Create | Button "New task" (`task-flow.spec.ts:76`); `details[data-testid="create-menu"]` with `summary` (`stats-balance.spec.ts:62`, `meeting-rules.spec.ts:343`, `automation-list-helpers.ts:57`) | Sidebar, top row. Keep both |
| Account | `data-testid="user-email"` with `toHaveText(email)`; button "Account menu" (`profile.spec.ts:20`, `delegation-helpers.ts:35`); button "Sign out" (`calendar-helpers.ts:96`, `sso.spec.ts:190`) | Sidebar footer. "Sign out" can be an icon button with `aria-label="Sign out"` |
| Dialogs | `getByRole("dialog", { name })`: "New task" and key `c` (`task-flow.spec.ts:75-79`), "Stop timer" (`task-timer.spec.ts:56`), "Review and apply" (`review-list`) | Keep one element with `role="dialog"` per dialog and its name |
| Task row | Native checkbox as a direct child, less than 30 px from the left; body `div` next to it; `.actions` at the right, beside the body (`task-list.spec.ts:667-704`) | Tasks page. Keep this DOM and geometry at 1440 px |
| Other CSS that tests read | `.next-up-queue` `border-top-style: dashed` (`next-up-queue.spec.ts:97`); priorities columns 260 px and 360 px (`priorities.spec.ts:112-116`); lock icons with `role="img"`, name "Locked" and `mask-image` (`helpers.ts:190-196`, `hours-sets.spec.ts:183`) | Keep |
| Text that tests read | Badge " next up" with its leading space (`priorities.spec.ts:124`, `tasks.spec.ts:130`); `.badge` "Added", "active"; `.trend-col` "Week of 9 Nov 45 min" (`pomodoro-stats.spec.ts:132`); `chime-hint` with `role="status"` and its text (`planner-now.spec.ts:174`) | Keep |

### 2.3 Class names, test ids and attributes that tests read

Keep these on the same elements:

- Classes: `ev`, `ev-task`, `ev-habit`, `ev-meeting`, `ev-external`,
  `ev-locked`, `ev-free`, `ev-conflict`, `ev-preview`, `ev-staged-new`,
  `ev-staged-from`, `ev-staged-deleted`, `ev-title`, `ev-time`, `ev-drag`,
  `week-head`, `week-body`, `week-scroll`, `day-name`, `focus` (on
  `.day-name`), `day-col`, `day-busy`, `hours`, `extra-hours`,
  `hour-label`, `row`, `badge`, `status`, `error`, `hours-day`, `day` (in
  `.hours-day`), `range`, `days` (on `fieldset`), `dot`, `info-icon`,
  `trend-col`, `baseline`, `match-title`, `tempoloom-embed`, `actions` (in
  task rows).
- Attributes: `data-testid` (all), `data-date`, `data-start`,
  `data-event-id`, `data-task-title`, `data-habit-title`,
  `data-meeting-title` and the other `data-*-title` attributes,
  `aria-expanded`, `aria-current`.
- Do not add `data-key` to any new element. Tests read `[data-key]` on
  the API key rows of the Account page (`account.spec.ts:142`).

### 2.4 E2E tests that click events in a cluster of 3 or more

The overlap rule (LAY-40) folds events into a "+N" list. A folded event is
not an `.ev` element, so a test that clicks or counts it fails. Do this in
the pull request that adds the rule (PR 1):

1. A static scan of `tests/e2e/*.spec.ts` found one test with three
   overlapping events: `planner-now.spec.ts:178` ("AT-Clash A", "AT-Clash
   B", "AT-Free" and a declined invite, Tuesday 10:00 to 11:30). It counts
   two `.ev.ev-conflict` cards. At 1440 px the cap is 3 columns, so all
   cards stay visible.
2. The scan sees only external events with fixed times. The scheduler can
   also place overlapping managed events. So run the full suite once with
   the cap forced to 2 at every width (a local change that you do not
   commit). List each test that fails because a clicked or counted `.ev`
   folded. Put the list in the pull request description. These tests
   depend on the cap of 3 at 1440 px.
3. Run the full suite with the shipping cap. It must pass.
4. If a test fails with the shipping cap, do not merge and do not edit the
   test. Report the cluster (test file and line, events, columns) and
   change this spec first.

## 3. Design tokens

### 3.1 Token block

PR 1 adds the motion tokens to the current `:root`. PR 2 replaces the
whole `:root` block of `src/web/styles.css` with this block. Type and
spacing are in `rem` and assume `html { font-size: 100% }` (TOK-3).
Calendar geometry stays in `px`.

```css
:root {
  color-scheme: light dark;

  /* Type: size, line height, weight and tracking go together */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --text-11: 0.6875rem; --lh-11: 0.875rem;  /* 11/14 captions, chips, hour labels, section labels */
  --text-12: 0.75rem;   --lh-12: 1rem;      /* 12/16 meta, event titles, small buttons, field labels */
  --text-13: 0.8125rem; --lh-13: 1.125rem;  /* 13/18 body, navigation, buttons, menus, task titles */
  --text-15: 0.9375rem; --lh-15: 1.25rem;   /* 15/20 week title, H2, dialog titles */
  --text-20: 1.25rem;   --lh-20: 1.625rem;  /* 20/26 page H1 */
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  --weight-brand: 700;      /* the "Tempoloom" wordmark only */
  --track-label: 0.04em;    /* 11 px uppercase labels */
  --track-title: -0.01em;   /* 15 px */
  --track-h1: -0.015em;     /* 20 px */

  /* Spacing: 4 px grid; 2 and 6 only inside dense controls */
  --sp-2: 0.125rem; --sp-4: 0.25rem; --sp-6: 0.375rem; --sp-8: 0.5rem;
  --sp-12: 0.75rem; --sp-16: 1rem; --sp-20: 1.25rem; --sp-24: 1.5rem;
  --sp-32: 2rem; --sp-40: 2.5rem;

  /* Radii: inner radius = outer radius - padding */
  --radius-xs: 4px;   /* chips, priority labels */
  --radius-sm: 6px;   /* event cards, menu items */
  --radius-md: 8px;   /* buttons, inputs, notices, rows, segmented groups */
  --radius-lg: 10px;  /* menus, popovers, list cards, toasts */
  --radius-xl: 14px;  /* dialogs, sheets */
  --radius-full: 999px;

  /* Sizes: px on purpose, E2E geometry reads some of them */
  --control-h: 32px;
  --control-h-sm: 28px;
  --hit-min: 24px;
  --hit-touch: 44px;
  --sidebar-w: 208px;
  --rail-w: 56px;
  --panel-w: 288px;
  --drawer-w: 320px;
  --toolbar-h: 56px;
  --bottom-bar-h: 56px;
  --gutter-w: 48px;
  --extra-gutter-w: 64px;
  --more-lane-w: 24px;
  --hour-px: 48px;          /* = HOUR_PX in week.tsx. E2E drags 48 px per hour. Do not change */
  --focus-width: 2px;

  /* Surfaces (light) */
  --bg-canvas: #f6f6f4;     /* sidebar: the heavier structural surface */
  --bg-surface: #ffffff;    /* main column, right column, cards, page background */
  --bg-raised: #ffffff;     /* menus, popovers, dialogs, toasts (elevation comes from the shadow) */
  --bg-sunken: #f1f2f4;     /* segmented tracks, buffers, code */
  --bg-hover: rgb(16 24 40 / 0.04);
  --bg-press: rgb(16 24 40 / 0.07);
  --bg-selected: color-mix(in srgb, var(--accent) 12%, var(--bg-surface));
  --grid-off: color-mix(in srgb, var(--text-primary) 3%, transparent);  /* weekend columns */

  /* Text, icons and lines (light) */
  --text-primary: #1d1f23;
  --text-secondary: #5f646d;
  --text-tertiary: #6b7079;   /* the lightest allowed text */
  --text-disabled: #9a9fa7;   /* disabled controls only */
  --icon-fg: #80868f;         /* icon color; --icon stays the mask URL of .lock-icon */
  --line: rgb(16 24 40 / 0.10);
  --line-strong: rgb(16 24 40 / 0.16);
  --chart-neutral: #c9ccd2;   /* stats only: the old --external gray */

  /* Roles (light) */
  --accent: #3b6fd8;          /* fills */
  --accent-hover: #3466cf;
  --accent-press: #2f5cbd;
  --accent-text: #2e63c9;     /* links, current navigation item, active tab */
  --on-accent: #ffffff;
  --focus-ring: #3b6fd8;
  --danger: #c2413a;          /* fills */
  --danger-text: #b8382f;
  --danger-soft: #fde8e7;
  --warning-text: #8a5a00;
  --warning-soft: #fdf0dc;
  --success-text: #1f7a52;
  --info-soft: #eef3fd;
  --info-text: #2c3e66;
  --info-muted: #4f5f86;
  --now: #d1343b;

  /* Event categories: bar color and ink (icon, selection ring) */
  --cat-task: #3b6fd8;     --cat-task-ink: #2e63c9;
  --cat-habit: #2f9e6e;    --cat-habit-ink: #1f7a52;
  --cat-focus: #7a52c7;    --cat-focus-ink: #6a43b3;
  --cat-meeting: #b7791f;  --cat-meeting-ink: #8a5a00;
  --cat-external: #c2477a; --cat-external-ink: #a8365f;
  --cat-buffer: #9aa0a8;   --cat-buffer-ink: #6b7079;
  --tint: 14%;             /* card background: color-mix(in srgb, var(--c) var(--tint), var(--bg-surface)) */

  /* Native select chevron (data URI colors cannot use variables) */
  --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%236b7079' d='M4.5 6 8 9.5 11.5 6l1 1L8 11.5 3.5 7z'/%3E%3C/svg%3E");

  /* Elevation: a semi-transparent ring plus a shadow, never a solid gray border */
  --ring: 0 0 0 1px rgb(16 24 40 / 0.08);
  --shadow-1: 0 0 0 1px rgb(16 24 40 / 0.10), 0 1px 2px rgb(16 24 40 / 0.06);
  --shadow-2: 0 0 0 1px rgb(16 24 40 / 0.06), 0 2px 6px -1px rgb(16 24 40 / 0.10), 0 1px 2px rgb(16 24 40 / 0.06);
  --shadow-3: 0 0 0 1px rgb(16 24 40 / 0.08), 0 4px 8px -2px rgb(16 24 40 / 0.08), 0 12px 28px -6px rgb(16 24 40 / 0.18);
  --shadow-4: 0 0 0 1px rgb(16 24 40 / 0.08), 0 8px 16px -4px rgb(16 24 40 / 0.10), 0 24px 56px -12px rgb(16 24 40 / 0.28);
  --scrim: rgb(10 12 16 / 0.32);

  /* Layers (the current values, with names) */
  --z-event: 1; --z-event-raised: 2; --z-now: 3; --z-drag: 4; --z-sticky: 5;
  --z-panel: 10; --z-popover: 20; --z-dialog: 30; --z-toast: 40;

  /* Motion (section 7) */
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);   /* drawers and sheets, used from PR 3 */
  --duration-press: 160ms;
  --duration-menu: 150ms;
  --duration-popover: 200ms;
  --duration-modal: 250ms;
  --duration-exit: 125ms;
  --duration-move: 250ms;
  --duration-collapse: 200ms;
  --duration-fade: 200ms;
  --duration-drawer: 200ms;                        /* used from PR 3 */
  --duration-toast: 400ms;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg-canvas: #111214;
    --bg-surface: #18191c;
    --bg-raised: #1f2124;   /* in dark, a raised surface is also lighter */
    --bg-sunken: #141517;
    --bg-hover: rgb(255 255 255 / 0.05);
    --bg-press: rgb(255 255 255 / 0.08);
    --bg-selected: color-mix(in srgb, var(--accent) 22%, var(--bg-surface));
    --grid-off: rgb(255 255 255 / 0.025);

    --text-primary: #ececee;
    --text-secondary: #a1a6ae;
    --text-tertiary: #8b919a;
    --text-disabled: #5d636c;
    --icon-fg: #8b919a;
    --line: rgb(255 255 255 / 0.08);
    --line-strong: rgb(255 255 255 / 0.14);
    --chart-neutral: #3a3f47;

    --accent: #2f6bd6;
    --accent-hover: #3a76e0;
    --accent-press: #2a60c2;
    --accent-text: #7aa7ff;
    --focus-ring: #7aa7ff;
    --danger-text: #f2777a;
    --danger-soft: color-mix(in srgb, #f2777a 16%, var(--bg-surface));
    --warning-text: #e5a33a;
    --warning-soft: color-mix(in srgb, #e5a33a 14%, var(--bg-surface));
    --success-text: #4cc38a;
    --info-soft: color-mix(in srgb, #7aa7ff 12%, var(--bg-surface));
    --info-text: #c9d8f5;
    --info-muted: #a1b3d6;
    /* --now stays #d1343b */

    --cat-task: #6ea0ff;     --cat-task-ink: #6ea0ff;
    --cat-habit: #4cc38a;    --cat-habit-ink: #4cc38a;
    --cat-focus: #a98bf0;    --cat-focus-ink: #a98bf0;
    --cat-meeting: #e5a33a;  --cat-meeting-ink: #e5a33a;
    --cat-external: #ef7fab; --cat-external-ink: #ef7fab;
    --cat-buffer: #6b7079;   --cat-buffer-ink: #8b919a;
    --tint: 22%;

    --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%238b919a' d='M4.5 6 8 9.5 11.5 6l1 1L8 11.5 3.5 7z'/%3E%3C/svg%3E");

    --ring: 0 0 0 1px rgb(255 255 255 / 0.08);
    --shadow-1: 0 0 0 1px rgb(255 255 255 / 0.10), inset 0 1px 0 rgb(255 255 255 / 0.04), 0 1px 2px rgb(0 0 0 / 0.4);
    --shadow-2: 0 0 0 1px rgb(255 255 255 / 0.08), 0 2px 8px -1px rgb(0 0 0 / 0.5);
    --shadow-3: 0 0 0 1px rgb(255 255 255 / 0.10), inset 0 1px 0 rgb(255 255 255 / 0.05), 0 12px 28px -6px rgb(0 0 0 / 0.6);
    --shadow-4: 0 0 0 1px rgb(255 255 255 / 0.10), inset 0 1px 0 rgb(255 255 255 / 0.06), 0 24px 56px -12px rgb(0 0 0 / 0.7);
    --scrim: rgb(0 0 0 / 0.55);
  }
}

/* High contrast: the user asks for more contrast */
@media (prefers-contrast: more) {
  :root {
    --text-tertiary: var(--text-secondary);
    --line: var(--line-strong);
    --tint: 10%;
    --focus-width: 3px;
    --shadow-1: 0 0 0 1px rgb(16 24 40 / 0.32), 0 1px 2px rgb(16 24 40 / 0.06);
  }
}
@media (prefers-contrast: more) and (prefers-color-scheme: dark) {
  :root {
    --tint: 16%;
    --shadow-1: 0 0 0 1px rgb(255 255 255 / 0.32), 0 1px 2px rgb(0 0 0 / 0.4);
  }
}

/* Forced colors (Windows high contrast): box-shadow does not paint */
@media (forced-colors: active) {
  .ev { border: 1px solid CanvasText; }
  .ev-selected { outline: 2px solid Highlight; }
  .switch { appearance: auto; }
  :focus-visible { outline-color: Highlight; }
}

/* Touch: bigger controls and no input zoom */
@media (pointer: coarse) {
  :root { --control-h: 44px; --control-h-sm: 40px; }
  input, select, textarea { font-size: 16px; }
}
```

- **TOK-1.** After PR 2, a hex color in a CSS file appears only inside
  the token blocks above. Check with
  `grep -nE '#[0-9a-fA-F]{3,8}\b' src/web/styles.css src/web/views/*.css`.
- **TOK-2.** After PR 2, no old token name (3.2) remains in `src/web`.
- **TOK-3.** Set `html { font-size: 100% }` and
  `body { font: var(--weight-regular) var(--text-13)/var(--lh-13) var(--font-sans) }`.
  Remove `font-size: 14px` from `:root` (`styles.css:18`).
- **TOK-4.** The app has no translucent or blurred surface. Do not add
  one. If one is added later, give it an opaque `--bg-surface` inside
  `@media (prefers-reduced-transparency: reduce)`.

### 3.2 Old to new tokens

| Old token | New token |
|---|---|
| `--bg` (page) | `--bg-surface`; the sidebar uses `--bg-canvas` |
| `--panel` | `--bg-surface` for cards and rows; `--bg-raised` for menus, popovers, dialogs, toasts |
| `--fg` | `--text-primary` |
| `--muted` | `--text-secondary` (labels, meta, status). Hour labels, section labels and placeholders use `--text-tertiary` |
| `--line` | `--line` (now an alpha value) |
| `--accent` | `--accent` for fills; `--accent-text` for text, links and the current item |
| `--danger` | `--danger` for fills; `--danger-text` for text |
| `--task`, `--habit`, `--focus`, `--buffer`, `--meeting` | `--cat-task`, `--cat-habit`, `--cat-focus`, `--cat-buffer`, `--cat-meeting` |
| `--external` | `--cat-external` for event cards; `--chart-neutral` in `stats.tsx:61`, `team-stats.tsx:66-67` |
| `--meeting` in `.warning` (`styles.css:317-319`) | `--warning-text` |
| `--radius` | `--radius-md` (buttons, inputs, rows); `--radius-sm` (cards, menu items) |

The inline styles in `tools.tsx:408`, `stats.tsx:58-66`,
`stats-extras.tsx:112` and `team-stats.tsx:58-67, 257, 284` use the old
names. Change them to the new names in PR 2.

### 3.3 Type scale

| Step | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|
| Caption | 11/14 | 400; 500 for counts; 600 for uppercase labels | 0; uppercase labels `--track-label` | Hour labels, chips, counts, section labels, now pill |
| Small | 12/16 | 400 (meta), 500 (labels, small buttons), 600 (event titles) | 0 | Meta lines, field labels, event titles, `.sm` buttons |
| Body | 13/18 | 400 (text), 500 (buttons, tabs), 600 (H3) | 0 | Body, navigation, buttons, menus, task titles |
| Title | 15/20 | 600 | `--track-title` | Week title, H2, dialog titles, event details title |
| H1 | 20/26 | 600 | `--track-h1` | Page titles |

- **TOK-10.** Use only these five sizes and the weights 400, 500 and 600.
  Use 700 only for the wordmark. Do not use 550 or 650.
- **TOK-11.** Headings: H1 20/26 600; H2 15/20 600; H3 13/18 600. One
  level has one style on every page (`styles.css:123, 398, 433, 717,
  832, 941, 984`, `parts.css:25`).
- **TOK-12.** Use `font-variant-numeric: tabular-nums` on hour labels,
  event times, the now pill, counts, the timer, "N planned" and
  "Showing N of M".
- **TOK-13.** No text is smaller than 11 px.

### 3.4 Contrast

WCAG ratios, computed from the hex values. Text needs 4.5:1. Icons, bars
that carry meaning and focus rings need 3:1.

| Pair | Light | Dark |
|---|---|---|
| `--text-primary` on `--bg-surface` | 16.50 | 14.90 |
| `--text-secondary` on `--bg-surface` / `--bg-canvas` | 5.95 / 5.50 | 7.18 / above 7 |
| `--text-secondary` / `--text-tertiary` on dark `--bg-raised` | – | 6.59 / 5.08 |
| `--text-tertiary` on `--bg-surface` / `--bg-canvas` | 4.98 / 4.60 | 5.54 / 5.90 |
| `--icon-fg` on `--bg-surface` | 3.67 | 5.54 |
| `--on-accent` on `--accent` | 4.72 | 5.01 |
| `--accent-text` on `--bg-surface` / on `--bg-selected` | 5.61 / 4.81 | 7.37 / 5.93 |
| `--danger-text` on `--bg-surface` / on `--danger-soft` | 5.76 / 4.90 | 6.44 / 5.05 |
| `--warning-text` on `--bg-surface` / on `--warning-soft` | 5.93 / 5.27 | 8.06 / 6.27 |
| `--info-text` / `--info-muted` on `--info-soft` | 9.49 / 5.70 | 10.01 / 6.80 |
| white on `--now` | 4.92 | 4.92 |
| `--text-primary` on a card tint (all categories) | 13.62 to 14.69 | 9.72 to 11.82 |
| `--text-secondary` on a card tint | 4.91 to 5.29 | 4.69 to 5.70 |
| `--text-tertiary` on a card tint | 4.11 to 4.43: fails | 3.61 to 4.39: fails |
| ink on its card tint | 4.43 (buffer) to 5.65 (focus) | 4.39 to 5.26 |
| past card: `--text-secondary` / `--text-tertiary` on a 6% tint | 5.49 to 5.66 / 4.59 to 4.74 | above 5 |

- **TOK-20.** On a card tint, use `--text-primary` and
  `--text-secondary` only. `--text-tertiary` fails there.
- **TOK-21.** The current app fails these pairs. The refresh removes
  them: `#9a9fa7` as text (2.66), white on the meeting fill `#d08a1e`
  (2.86), white on the buffer fill (2.64), white on the habit fill (3.37),
  the dark accent `#3b6fd8` on `#1c1f23` (3.51), the dark danger
  `#c2413a` (3.24), `.warning` text `#d08a1e` (2.86).

## 4. Component rules

### 4.1 States for every interactive element

- **CMP-1.** Every pressable element has five states: default, hover,
  pressed, focus-visible and disabled. Toggles also have a selected
  state.
- **CMP-2.** Put every `:hover` rule inside
  `@media (hover: hover) and (pointer: fine)`. This includes the current
  ungated rule at `styles.css:690`.
- **CMP-3.** Pressed state: buttons scale (MOT-10). Rows, tabs, menu
  items, segmented items and navigation links use
  `background-color: var(--bg-press)` with no transition. Event cards do
  not scale (MOT-60).
- **CMP-4.** Focus: `:focus-visible { outline: var(--focus-width) solid
  var(--focus-ring); outline-offset: 2px; }`. Inside rows, navigation
  links and menu items, use `outline-offset: -2px`. A focus ring appears
  at once. Never animate it.
- **CMP-5.** Disabled: `:disabled, [aria-disabled="true"] { opacity: 0.5;
  cursor: not-allowed; }`. A disabled button does not scale.
- **CMP-6.** Hit areas: 24×24 px or more with a fine pointer, 44×44 px
  or more with a coarse pointer. When the visible control is smaller,
  extend the hit area with `::before { content: ""; position: absolute;
  inset: -4px; }` (coarse: `inset: -14px`) on a `position: relative`
  element.
- **CMP-7.** Text that is a control is not selectable:
  `button, summary, [role="tab"], .nav a { user-select: none;
  -webkit-user-select: none; }`. Body text stays selectable.

### 4.2 Buttons

- **CMP-10.** Base for `button`, `a.button` and `.create-menu summary`:
  `display: inline-flex; align-items: center; justify-content: center;
  gap: var(--sp-6); min-height: var(--control-h); padding: 0
  var(--sp-12); font: var(--weight-medium) var(--text-13)/var(--lh-13)
  var(--font-sans); color: var(--text-primary); background:
  var(--bg-surface); border: 0; border-radius: var(--radius-md);
  box-shadow: var(--shadow-1); cursor: pointer; white-space: nowrap;`.
  Hover: `background: color-mix(in srgb, var(--text-primary) 4%,
  var(--bg-surface))`. Pressed: 7% in the same formula.
- **CMP-11.** Variants:

| Class | Look | Hover | Pressed | Use |
|---|---|---|---|---|
| `.primary` | `background: var(--accent); color: var(--on-accent); font-weight: 600; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 80%, black), inset 0 1px 0 rgb(255 255 255 / 0.12), 0 1px 2px rgb(16 24 40 / 0.12)` | `--accent-hover` | `--accent-press` | One per surface (CMP-12) |
| `.ghost` | `background: transparent; box-shadow: none` | `--bg-hover` | `--bg-press` | Toolbar icons, panel headers |
| `.danger` | Base look with `color: var(--danger-text)` | `background: var(--danger-soft)` | 7% formula | Destructive actions, the conflicts button |
| `.icon` | `width: var(--control-h); padding: 0`; a 16 px icon; `aria-label` is required | as its variant | as its variant | Week buttons, gear, Calendars, Log work, Sign out |
| `.sm` | `min-height: var(--control-h-sm); padding: 0 var(--sp-8); font-size: var(--text-12); line-height: var(--lh-12)` | as its variant | as its variant | Now bar, notices, row actions |
| `[aria-pressed="true"]`, toggles with `[aria-expanded="true"]` | `background: var(--bg-selected); color: var(--accent-text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 35%, transparent)` | no change | `--bg-press` | Toggle buttons |

- **CMP-12.** A surface (toolbar, panel, dialog) has at most one primary
  button. In the planner toolbar, "Plan now" is primary. While preview
  mode is on and "Review and apply changes" shows, that button is
  primary and "Plan now" uses the base look. "New task" in the sidebar is
  not primary (CMP-114); remove `class="primary"` at `main.tsx:206`.
- **CMP-13.** "Plan now" while planning: `disabled`, and the status text
  says "Planning…". No spinner (MOT-61).
- **CMP-14.** Rules that use button borders today get rings in PR 2:
  `button.preferred` (`styles.css:512-514`): `box-shadow: 0 0 0 1px
  color-mix(in srgb, var(--cat-habit) 60%, transparent)`;
  `button[data-mine="busy"]` (`styles.css:879-881`): `outline: 1px dashed
  var(--line-strong); outline-offset: -1px`; `button[aria-selected=
  "true"]` (`styles.css:496-500`): the tab style (CMP-110).
- **CMP-15.** Icons are 16×16 single-path SVGs drawn in this repository
  and painted with a CSS mask, like `.lock-icon` (`styles.css:180-196`).
  Use `aria-hidden="true"` on the icon element. Do not use text glyphs
  for icons. Replace "‹" and "›" (`planner.tsx:337, 347`), "⚙"
  (`planner-options.tsx:91`), "↑" (`planner-now.tsx:159`), "⏱"
  (`planner-now.tsx:290`) and "▾" (`account-menu.tsx:77`). Do not copy
  icons from another product.

### 4.3 Inputs and text areas

- **CMP-20.** Text inputs (`input` that is not a checkbox, radio, range,
  color or file), `select` and `textarea`: `min-height:
  var(--control-h); padding: 0 10px; font: var(--weight-regular)
  var(--text-13)/var(--lh-13) var(--font-sans); color:
  var(--text-primary); background: var(--bg-surface); border: 0;
  border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px
  var(--line-strong);`.
- **CMP-21.** Hover: `box-shadow: inset 0 0 0 1px color-mix(in srgb,
  var(--text-primary) 28%, transparent)`.
- **CMP-22.** Focus: `outline: none; box-shadow: inset 0 0 0 1px
  var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 25%,
  transparent)`.
- **CMP-23.** Invalid (`[aria-invalid="true"]`): ring in `--danger`.
  Disabled: `background: var(--bg-sunken); color: var(--text-disabled)`.
  Placeholder: `--text-tertiary`.
- **CMP-24.** `textarea`: `min-height: 72px; padding: var(--sp-8) 10px`.
- **CMP-25.** Field labels: 12/16 500 `--text-secondary`
  (`styles.css:71-76`). A label above its field has `display: grid; gap:
  var(--sp-4); grid-template-columns: minmax(0, 1fr)` (ROB-11).
- **CMP-26.** Inline errors keep `role="alert"` and stay next to their
  field. Do not move a tested error or status text into a toast.

### 4.4 Select

- **CMP-30.** Native `<select>` only. Do not replace a native select with
  a custom component: tests call `selectOption`.
- **CMP-31.** Look: CMP-20 plus `appearance: none; padding-inline-end:
  28px; background: var(--select-chevron) no-repeat right 8px center /
  16px 16px, var(--bg-surface)`. In RTL, use `left 8px center`.
- **CMP-32.** "View as" chip: the `<label>` holds `<span
  class="sr-only">View as</span>` and the select. The select is 32 px
  high, with an eye icon in a 16 px `::before` on the label at
  `inset-inline-start: 8px` and `padding-inline-start: 28px` on the
  select. It has `title="View as"`.

### 4.5 Checkbox and switch

- **CMP-35.** Checkboxes and radios stay native: `accent-color:
  var(--accent); width: 16px; height: 16px; margin: 0`. With a coarse
  pointer, the `<label>` around them is 44 px high.
- **CMP-36.** A switch is a native `<input type="checkbox"
  class="switch">` inside its `<label>`. Use it only for "Preview mode".
  Do not use a `role="switch"` element.

```css
.switch {
  appearance: none;
  position: relative;
  flex: none;
  width: 32px;
  height: 18px;
  margin: 0;
  border-radius: 9px;
  background: var(--line-strong);
  transition: background-color var(--duration-press) ease;
}
.switch::before {
  content: "";
  position: absolute;
  inset-block-start: 2px;
  inset-inline-start: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--on-accent);
  box-shadow: var(--shadow-1);
  transition: transform var(--duration-press) var(--ease-in-out);
}
.switch:checked { background: var(--accent); }
.switch:checked::before { transform: translateX(14px); }
:dir(rtl) .switch:checked::before { transform: translateX(-14px); }
.switch:focus-visible::before { transition-duration: 0ms; }
```

### 4.6 Menus and popovers

- **CMP-40.** Menus (account menu, event menu, Create list):
  `min-width: 200px; padding: 4px; border: 0; border-radius:
  var(--radius-lg); background: var(--bg-raised); box-shadow:
  var(--shadow-3); z-index: var(--z-popover)`.
- **CMP-41.** Menu items: `min-height: 28px; padding: 0 var(--sp-8); gap:
  var(--sp-8); border-radius: var(--radius-sm); font:
  var(--weight-regular) var(--text-13)/var(--lh-13) var(--font-sans);
  text-align: start`. Icons 16 px in `--icon-fg`. Highlight
  `--bg-press` only on hover or keyboard focus. When a pointer opens the
  menu, no item is highlighted. Destructive items: `--danger-text` with
  the highlight `--danger-soft`. Separator: 1 px `--line`, `margin: 4px
  -4px`. With a coarse pointer, items are 44 px high.
- **CMP-42.** Menu keyboard (with Base UI or hand-built, section 9): the
  trigger keeps `aria-haspopup="menu"` and `aria-expanded`. Enter, Space
  or ArrowDown opens the menu and focuses the first item. ArrowUp opens
  it and focuses the last item. In the menu, ArrowDown and ArrowUp move
  the focus and wrap. Home and End go to the first and last item. A
  printable character moves to the next item that starts with it.
  Enter or Space activates the item. Escape closes the menu and returns
  the focus to the trigger. Tab closes the menu. A pointer press outside
  the menu closes it.
- **CMP-43.** Popovers (planner options, calendars, "+N" list, apply
  summary, hours info): `padding: var(--sp-12); border: 0;
  border-radius: var(--radius-lg); background: var(--bg-raised);
  box-shadow: var(--shadow-3); min-width: min(260px, calc(100vw -
  32px)); max-width: min(460px, calc(100vw - 32px)); max-height:
  min(60dvh, 480px); overflow: auto; overscroll-behavior: contain`.
  Escape and a pointer press outside close them. Popovers stay
  hand-built (section 9).
- **CMP-44.** Every menu and popover has a known anchor and side. Its
  `transform-origin` is the corner nearest to its trigger (MOT-20).

### 4.7 Dialogs

- **CMP-50.** Dialog: `width: min(480px, calc(100vw - 32px)); max-height:
  calc(100dvh - 48px); overflow: auto; padding: var(--sp-20)
  var(--sp-24); border: 0; border-radius: var(--radius-xl); background:
  var(--bg-raised); box-shadow: var(--shadow-4)`. `.wide-dialog`:
  `width: min(720px, calc(100vw - 32px))`.
- **CMP-51.** Backdrop: `background: var(--scrim)`, `z-index:
  var(--z-dialog)`.
- **CMP-52.** Title 15/20 600. Actions in a row at the end, with
  `justify-content: flex-end` and the primary button last.
- **CMP-53.** At 640 px and below, a dialog is a bottom sheet:
  `align-self: end; width: 100%; max-width: none; border-radius:
  var(--radius-xl) var(--radius-xl) 0 0; padding-bottom: calc(20px +
  env(safe-area-inset-bottom, 0px))`.
- **CMP-54.** Focus (PR 4): when a dialog opens, the focus goes to the
  first focusable element in its body, or to the dialog with
  `tabindex="-1"`. Tab and Shift+Tab stay inside the dialog. Escape
  closes it. When it closes, the focus returns to the element that
  opened it. Every dialog has `aria-modal="true"` (add it at
  `preview.tsx:194`). Do not set `inert` or `aria-hidden` on the rest of
  the app.
- **CMP-55.** Keep one `role="dialog"` element per dialog with its
  current name. The nine dialogs are: `task-dialog.tsx:26`,
  `task-here.tsx:38`, `timer-dialog.tsx:50`, `preview.tsx:193`,
  `hours-review.tsx:30`, `account.tsx:42`, `mcp-section.tsx:85`,
  `settings-extra.tsx:210`, `lib/calendars.tsx:52`.

### 4.8 Notices

One `.note` component replaces four banner styles: `.banner`
(`parts.css:34-43`), `.hint` (`styles.css:786-792`), `.preview-banner`
(`styles.css:755-759`) and `.acting-banner` (`styles.css:646-658`). Keep
every test id, role and text.

- **CMP-60.** Card: `display: grid; grid-template-columns: 16px minmax(0,
  1fr) auto; column-gap: var(--sp-8); row-gap: var(--sp-6); min-height:
  36px; padding: 6px 8px 6px 12px; border-radius: var(--radius-md)`. No
  fixed height.
- **CMP-61.** Tones: `info` (`--info-soft` background, `--info-text`
  text, info icon); `warning` (`--warning-soft`, `--warning-text`,
  triangle icon; travel prompt, acting banner); `accent` (`--bg-selected`,
  `--text-primary`; preview banner on other pages).
- **CMP-62.** Line 1 is the icon and the message. The message is one line:
  `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`. The
  full message stays in the DOM and in a `title` attribute. Wrap the
  message text in `<span class="note-text">`.
- **CMP-63.** When the message does not fit (`scrollWidth >
  clientWidth`, checked on mount and with a `ResizeObserver`), show a
  24×24 icon button at the end of line 1: `aria-label="Show full text"`,
  `aria-expanded`. When expanded, the message wraps (`white-space:
  normal; overflow-wrap: anywhere`).
- **CMP-64.** Line 2 holds the controls (links, selects, `.sm` buttons).
  It wraps. It spans columns 2 and 3. A notice without controls has no
  line 2.
- **CMP-65.** One dismiss control per notice: the existing one ("Got
  it", "Not now"). Do not add a second "✕" control.

### 4.9 Toasts

PR 4 adds toasts (MOT-50, section 9 decides Sonner or CSS-only).

- **CMP-70.** One region, mounted once in `main.tsx` after `settled`,
  outside every dialog: `<section class="toaster"
  aria-label="Notifications">`. Each toast has `role="status"`. Do not
  use `role="alert"` in a toast: the E2E files call `getByRole("alert")`
  30 times.
- **CMP-71.** Place: bottom center of the viewport. `bottom: calc(16px +
  env(safe-area-inset-bottom, 0px))`; at 640 px and below, add
  `var(--bottom-bar-h)`. The region has `pointer-events: none`; each
  toast has `pointer-events: auto`.
- **CMP-72.** Toast: `width: min(360px, calc(100vw - 32px)); padding: 10px
  12px; border-radius: var(--radius-lg); background: var(--bg-raised);
  box-shadow: var(--shadow-3); font: var(--weight-regular)
  var(--text-13)/var(--lh-13) var(--font-sans)`. An action button uses
  `.sm`. A close icon button has `aria-label="Hide notification"`.
- **CMP-73.** At most 3 toasts are visible. The newest is at the bottom.
  The gap is 14 px. A toast closes after 4000 ms. The timer pauses on
  hover and while `document.hidden`.
- **CMP-74.** Toasts show only the results of the event menu (CMP-130).
  No existing test opens that menu, so no toast can cover a control
  that a test clicks. Do not show a toast for "Plan now", saves or
  errors. Inline messages stay inline.
- **CMP-75.** The chime hint (`alerts.tsx:123`) keeps its element, its
  place (bottom right, 16 px), `role="status"`, its test id and its
  text. It gets the toast enter motion only.

### 4.10 Event cards

- **CMP-80.** Category variables per kind:

```css
.ev-task, .ev-preview { --c: var(--cat-task);     --c-ink: var(--cat-task-ink); }
.ev-habit             { --c: var(--cat-habit);    --c-ink: var(--cat-habit-ink); }
.ev-focus             { --c: var(--cat-focus);    --c-ink: var(--cat-focus-ink); }
.ev-meeting           { --c: var(--cat-meeting);  --c-ink: var(--cat-meeting-ink); }
.ev-external          { --c: var(--cat-external); --c-ink: var(--cat-external-ink); }
.ev-buffer            { --c: var(--cat-buffer);   --c-ink: var(--cat-buffer-ink); }
.ev-staged            { --c: var(--accent);       --c-ink: var(--accent-text); }
```

- **CMP-81.** Card base: `position: absolute; border: 0; border-radius:
  var(--radius-sm); padding-block: 3px; padding-inline: 8px 18px;
  overflow: hidden; color: var(--text-primary); background:
  color-mix(in srgb, var(--c) var(--tint), var(--bg-surface));
  box-shadow: inset 3px 0 0 var(--c); font: var(--weight-regular)
  var(--text-12)/var(--lh-12) var(--font-sans); z-index: var(--z-event);
  touch-action: pan-y; user-select: none`. In RTL, the bar is `inset -3px
  0 0 var(--c)`. Movable kinds have `cursor: grab`.
- **CMP-82.** Each card is drawn 1 px inside its slot at the top and the
  bottom: `top: slotTop + 1px; height: slotHeight - 2px`. The slot
  height keeps its 14 px minimum (`week.tsx:97`).
- **CMP-83.** Title `.ev-title`: 12/16 600, one line with an ellipsis,
  `dir="auto"` (`week.tsx:378`). Time `.ev-time`: 11/14 400,
  `tabular-nums`, `--text-secondary`, text exactly `HH:MM–HH:MM` in the
  user's time format.
- **CMP-84.** `.ev-meta` is the place for extra facts. It is a sibling
  after `.ev-time`, in the same style, with a "·" separator drawn by
  `::before` (no text node). This refresh puts one fact there: the word
  "free" on cards with `busy: false`. Hide `.ev-meta` on one-line cards.
- **CMP-85.** Kind icon: `.ev::before { content: "" / ""; position:
  absolute; inset-block-start: 4px; inset-inline-end: 4px; width: 12px;
  height: 12px; background: var(--c-ink); mask: var(--kind-icon) center /
  contain no-repeat; }`. Icons: task (check in a square), habit (circular
  arrow), focus (target), meeting (two people), external (calendar). Buffers,
  staged, preview and pick cards have no icon. The icon adds no text.
- **CMP-86.** Lock: keep `.ev-locked::after` with `content: "" /
  "Locked"` and its mask (`styles.css:331-345`). Place it where the kind
  icon is (top 4 px, inline end 4 px, 12×12, `background: var(--c-ink)`).
  A locked card hides the kind icon (`.ev-locked::before { content:
  none; }`).
- **CMP-87.** Card states:

| State | Selector | Rule |
|---|---|---|
| Busy | `.ev` | CMP-81 |
| Free | `.ev-free` | `background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) var(--tint), var(--bg-surface)) 0 6px, var(--bg-surface) 6px 12px); box-shadow: inset 3px 0 0 var(--c), inset 0 0 0 1px color-mix(in srgb, var(--c) 35%, transparent)` |
| Locked | `.ev-locked` | CMP-86 |
| Past (ends before now) | `.ev-past` (new) | `background: color-mix(in srgb, var(--c) 6%, var(--bg-surface)); box-shadow: inset 3px 0 0 color-mix(in srgb, var(--c) 45%, var(--bg-surface))`; title `--text-secondary`; time `--text-tertiary`. No `opacity` |
| Pressed | `.ev-pressed` (new; set on `pointerdown`, removed on `pointerup` and `pointercancel`) | `box-shadow: inset 3px 0 0 var(--c), var(--shadow-2)`. No scale |
| Selected | `.ev-selected` (new; the event open in the details panel) | `box-shadow: inset 3px 0 0 var(--c), 0 0 0 2px var(--c-ink), var(--shadow-2); z-index: var(--z-event-raised); touch-action: none` |
| Conflict | `.ev-conflict` | `outline: 2px solid var(--danger); outline-offset: -2px` |
| Dragged | `.ev-drag` | `opacity: 1; box-shadow: inset 3px 0 0 var(--c), var(--shadow-3); z-index: var(--z-drag); cursor: grabbing` |
| Staged new | `.ev-staged-new` | Tint of `--accent`; `outline: 1.5px dashed var(--c-ink); outline-offset: -1.5px; z-index: var(--z-event-raised)`. No border (no layout shift) |
| Staged old place | `.ev-staged-from` | The past look. No `opacity` |
| Staged delete | `.ev-staged-deleted` | The past look; title `text-decoration: line-through` |
| Block preview | `.ev-preview` | Task tint; `outline: 1.5px dashed var(--cat-task-ink); outline-offset: -1.5px` |
| Picked range | `.ev-pick` | `background: color-mix(in srgb, var(--accent) 12%, transparent); outline: 1.5px dashed var(--accent); outline-offset: -1.5px` |
| Buffer | `.ev-buffer` | `background: var(--bg-sunken); box-shadow: inset 2px 0 0 var(--c)`; text 11/12 `--text-secondary`. Below 20 px the text can clip; keep it in the DOM |
| Overlapped (cluster with 2 or more columns) | `.ev-overlap` (new) | Title one line; no kind icon; the lock stays |

- **CMP-88.** One visual code per meaning. Dashed means "not on your
  calendar yet": staged, block preview, picked range, the next-up drop
  zone. Hatching means "free". Flat gray means "weekend" (LAY-34). The
  diagonal pattern of a busy all-day day (`week.tsx:45-48`) stays.
- **CMP-89.** Line layouts at 48 px per hour (visible height = slot − 2
  px):

| Card | Slot height | Layout |
|---|---|---|
| `ev-tiny` | below 20 px (under 25 min) | One line, time first, then the title. `padding-block: 0; font-size: 11px; line-height: 12px`. No icon, no meta |
| `ev-short` | below 36 px (under 45 min); includes every card of 30 min or less | One line, time first, then the title. The title truncates. CMP-90 |
| normal | 36 px to 55 px | Title on line 1 (ellipsis), time and meta on line 2 |
| `ev-tall` | 56 px or more (70 min or more) | Title clamps to 2 lines (`-webkit-line-clamp: 2; overflow-wrap: anywhere`), time and meta below |

  Set `TWO_LINES_PX` (`week.tsx:54`) to 36. Add `TALL_PX = 56` and
  `TINY_PX = 20`.
- **CMP-90.** One-line cards:

```css
.ev-short, .ev-tiny { display: flex; align-items: baseline; gap: var(--sp-6); white-space: nowrap; }
.ev-short .ev-time, .ev-tiny .ev-time { order: -1; flex: 0 1 auto; min-width: 0; overflow: hidden; }
.ev-short .ev-title, .ev-tiny .ev-title { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ev-short .ev-meta, .ev-tiny .ev-meta { display: none; }
```

  The full title stays in the card's `title` attribute (`week.tsx:369`).
  `planner-views.spec.ts:318-353` checks that the time is on the title
  line and inside the box. Time first keeps this true.

### 4.11 Task rows and list rows

- **CMP-100.** Task titles wrap to 2 lines, then clamp: `display:
  -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  overflow: hidden; overflow-wrap: anywhere`. The full title is in a
  `title` attribute and in the detail view. Put the title text in `<span
  class="task-title" dir="auto">`. Badges go after it, outside the clamp.
  Keep the badge text " next up" with its leading space
  (`tasks.tsx:644`).
- **CMP-101.** Tasks page rows keep the native checkbox as a direct child
  of the row, the body `div`, and `.actions` (`tasks.tsx:601`; geometry
  test `task-list.spec.ts:667-704`). Row padding is `10px 12px`.
- **CMP-102.** Right column task rows (`planner-now.tsx:79` `TaskRow`)
  have no checkbox. Do not add a check button: a name like "Mark {title}
  done" breaks tests (TST-9).
- **CMP-103.** Lists (`.list`): one card with `background:
  var(--bg-surface); box-shadow: var(--shadow-1); border-radius:
  var(--radius-lg)`. Rows inside it have no border and no radius. A 1 px
  `--line` separates rows. Clickable rows (`a.row`) get the hover and
  pressed states.
- **CMP-104.** Row grids (ROB-10): `.row { grid-template-columns:
  minmax(0, 1fr) auto; align-items: start; }` and `.task-row {
  grid-template-columns: auto minmax(0, 1fr) auto; }`.

### 4.12 Tabs and navigation

- **CMP-110.** Tabs (`role="tab"`, `.tabs a`): `min-height: 32px; padding:
  0 var(--sp-12); font: var(--weight-medium) var(--text-13)/var(--lh-13)
  var(--font-sans); color: var(--text-secondary); background: none;
  box-shadow: none; border-radius: 0`. Active (`aria-selected="true"`,
  `aria-current="page"`): `color: var(--text-primary); box-shadow: inset
  0 -2px 0 var(--accent)`. The weight does not change between states.
- **CMP-111.** Sidebar: `background: var(--bg-canvas); padding: var(--sp-12)
  var(--sp-8); border-inline-end: 1px solid var(--line)`. Wordmark
  15/20 700, `padding: 2px 8px 12px`.
- **CMP-112.** Links: `display: flex; align-items: center; gap:
  var(--sp-8); min-height: 30px; padding: 0 var(--sp-8); border-radius:
  var(--radius-md); font: var(--weight-regular)
  var(--text-13)/var(--lh-13) var(--font-sans); color:
  var(--text-primary)`. Icon 16 px in `--icon-fg`, `aria-hidden`. Current
  page (`aria-current="page"`): `background: var(--bg-selected); color:
  var(--accent-text); font-weight: 600`, icon in `--accent-text`. With a
  coarse pointer, links are 44 px high.
- **CMP-113.** Groups (PR 4). The links keep their names and order
  inside each group. Group labels are 11/14 600 uppercase,
  `--track-label`, `--text-tertiary`, `padding: 16px 8px 4px`. Each group
  is a `div` with `role="group"` and `aria-labelledby` its label.

| Group label | Links |
|---|---|
| (none) | Planner, Tasks, Priorities, Stats |
| Automate | Habits, Meetings, Meeting checks, Automations, Library |
| People | Booking links, Team, Policies |
| (footer, none) | Settings, Account, Help |

- **CMP-114.** Top row: "New task" (default variant, a `+` icon in
  `--accent-text`, fills the row width) and "Create" (`details` with
  `summary` styled as a 32 px button with a chevron icon). Hide the
  default marker: `summary::-webkit-details-marker { display: none; }`
  and `summary { list-style: none; }`. The open list is a popover menu
  (CMP-40) below the summary, origin `top left`. Escape and a press
  outside close it. "New task" can show `<kbd aria-hidden="true">C</kbd>`
  at its end, 11/14 `--text-tertiary`.
- **CMP-115.** Footer row: avatar 24 px (initials), then a column with the
  user's name (13/18 500) and the email (`data-testid="user-email"`,
  12/16 `--text-secondary`), both with `min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap` and a `title` with the
  full value. Then the "Account menu" button (`.icon.ghost`, chevron-up
  icon, `aria-label="Account menu"`) and the "Sign out" button
  (`.icon.ghost`, `aria-label="Sign out"`, `title="Sign out"`). The
  account menu opens upward, origin `bottom left`.

### 4.13 Side column

- **CMP-120.** `.side-column`: `display: flex; flex-direction: column;
  min-height: 0; background: var(--bg-surface); border-inline-start: 1px
  solid var(--line)`.
- **CMP-121.** `.side-scroll`: `flex: 1; min-height: 0; overflow-y: auto;
  overscroll-behavior: contain; scrollbar-gutter: stable; padding: 12px
  16px 24px`. Sections in it are 16 px apart.
- **CMP-122.** Section labels: 11/14 600 uppercase, `--track-label`,
  `--text-tertiary`. "At risk" uses `--danger-text`.
- **CMP-123.** Counts: 11/14 500 tabular `--text-tertiary`, `background:
  var(--bg-sunken); padding: 0 6px; border-radius: var(--radius-full)`.
  Hide a count of 0. Show "99+" above 99. Red only for conflicts and at-
  risk work.
- **CMP-124.** The details panel (`aside data-testid="event-drawer"`):
  header row with the title `h2` (15/20 600, `dir="auto"`,
  `overflow-wrap: anywhere`) and the "Close" button (`.sm.ghost`, text
  "Close") at the inline end. Then the meta lines (`.status`, 12/16
  `--text-secondary`, `overflow-wrap: anywhere`). Then the current
  content in the current order. "Ask the assistant" stays last, as a
  `.ghost` button.
- **CMP-125.** The assistant panel (`aside data-testid="assistant-panel"`,
  name "Assistant") fills the height of `.side-scroll`: `display: flex;
  flex-direction: column; height: 100%`. Its log scrolls inside it.

### 4.14 Now bar (right column header)

- **CMP-126.** `.now-bar` (`data-testid="now-bar"`): `display: flex;
  flex-wrap: wrap; align-items: center; gap: var(--sp-8); min-height:
  var(--toolbar-h); padding: 12px 16px; border-bottom: 1px solid
  var(--line); font: var(--weight-regular) var(--text-13)/var(--lh-13)
  var(--font-sans); white-space: normal`. It never scrolls sideways.
- **CMP-127.** Order in the DOM and on screen:
  1. Panel switch: a segmented group with the buttons "Tasks",
     "Priorities" and "Assistant" (`aria-expanded`). `planner.tsx`
     renders it, so it shows at once. Remove the "Tasks" and
     "Priorities" buttons from `NowBar` (`planner-now.tsx:274-287`) and
     the "Assistant" button from the toolbar (`planner.tsx:373-381`).
  2. The conflicts button (`.sm.danger`, text "1 conflict" or "N
     conflicts").
  3. "Hide panel" (`.icon.ghost`), at 1180 px and below only.
  4. `next-up`, `next-meeting`, `timer-bar`, `block-preview` and the error,
     each on its own row (`flex-basis: 100%`).
- **CMP-128.** Segmented group: `display: inline-flex; gap: 2px; padding:
  2px; background: var(--bg-sunken); border-radius: var(--radius-md)`.
  Items: `min-height: 28px; padding: 0 var(--sp-8); background:
  transparent; box-shadow: none; color: var(--text-secondary);
  font-weight: 500`. Expanded item: `background: var(--bg-surface);
  box-shadow: var(--shadow-1); color: var(--text-primary)`. No press
  scale. The weight does not change.
- **CMP-129.** Titles in the now bar (`strong` in `next-up` and
  `next-meeting`): `display: inline-block; max-width: 100%; overflow:
  hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align:
  bottom; font-weight: 500`, `dir="auto"`.

### 4.15 Event menu

- **CMP-130.** PR 4 adds an event menu. It holds the one-click actions of
  the details panel, with the same names and the same handlers:
  "Lock" or "Unlock" (not external, not a guest event), "Mark task done"
  (task with a source), "Skip this day" (habit with a source), a
  separator, "Ask the assistant". Items are `role="menuitem"`. There is
  no Delete. See `ui-refresh/planner-menu.png`.
- **CMP-131.** Open it with: the "⋯" button on the selected card
  (`aria-label="Event actions"`, `aria-haspopup="menu"`,
  `aria-expanded`); a right click on a card (select the event, open the
  menu at the pointer); Shift+F10 or the context-menu key on a focused
  card.
- **CMP-132.** The "⋯" button is one element in the grid, not inside
  the card. It shows only for the selected event and only when the card
  is 72 px wide or more. Place it at the card's top inline-end corner,
  2 px inside. It is 24×24 (44×44 with a coarse pointer) with a 16 px
  icon.
- **CMP-133.** Choosing an item closes the menu at once and runs the
  action. "Lock" and "Unlock" show the toast "Event locked" or "Event
  unlocked" with the action "Undo", which calls the inverse. "Mark task
  done" shows "Task marked done". "Skip this day" shows "Day skipped".

### 4.16 Now line and day header

- **CMP-140.** Now line (`.now-line`, today's column): 2 px `--now`.
  Add an 8 px dot (`.now-dot`) centered on the line at the inline start
  of today's column, and a 1 px line across all days (`.now-week`,
  `color-mix(in srgb, var(--now) 35%, transparent)`, under the cards).
  All have `pointer-events: none`.
- **CMP-141.** Now pill (`.now-pill`) in the hour gutter, inside `.hours`
  but without the class `hour-label`: 11/14 600 tabular, `color: var(--on-accent);
  background: var(--now); height: 16px; padding: 0 5px; border-radius:
  var(--radius-full); white-space: nowrap`, centered on the line. Text:
  `HH:MM` in 24-hour format; `h:mm` without AM or PM in 12-hour format.
- **CMP-142.** Day header `.day-name`: 12/16 500 `--text-secondary`,
  `padding: 12px 4px 8px`, centered. Today: weekday in `--accent-text`;
  the day number is a `<b>` pill (`background: var(--accent); color:
  var(--on-accent); padding: 0 6px; border-radius: var(--radius-full);
  font-weight: 600`). The text content stays `Mon 26`. `.day-name.focus`:
  `background: var(--bg-selected); border-radius: var(--radius-md)`.

## 5. Layout

### 5.1 Shell and columns

- **LAY-1.** `.shell { display: grid; grid-template-columns:
  var(--sidebar-w) minmax(0, 1fr); height: 100dvh; }`.
- **LAY-2.** `.main` stays a flex column. Shell banners (acting, preview
  on other pages, connect calendar) are `.note` cards at its top with
  `margin: 8px 16px 0`.
- **LAY-3.** The planner fills the rest of `.main`: `.planner { flex: 1;
  min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr)
  var(--panel-w); }`. Remove `height: 100vh` (`styles.css:491-495`).
- **LAY-4.** At 1440×900 the columns are 208 px, 944 px and 288 px. The
  hour gutter is 48 px, so each of 7 days is 128 px wide.
- **LAY-5.** Planner DOM:

```html
<div class="planner" data-testid="planner">
  <div class="planner-main">            <!-- flex column -->
    <div class="toolbar">…</div>
    <div class="notices">…</div>         <!-- only at 1180 px and below -->
    <div class="week">…</div>
  </div>
  <div class="side-column">
    <div class="now-bar" data-testid="now-bar">…</div>
    <div class="notices">…</div>         <!-- only above 1180 px -->
    <div class="side-scroll">
      <!-- the open panel: event-drawer | tasks-panel | priorities-panel | conflicts | assistant-panel -->
      <div class="overview">
        <!-- focus-progress, current-tasks, Issues/Recommendations, details.issues -->
      </div>
    </div>
  </div>
</div>
```

- **LAY-6.** Render the notices stack in exactly one place. A signal from
  `matchMedia("(max-width: 1180px)")` picks the place. Never render two
  copies: test ids must be unique.

### 5.2 Toolbar

- **LAY-10.** `.toolbar`: `display: flex; flex-wrap: wrap; align-items:
  center; column-gap: var(--sp-6); row-gap: var(--sp-8); min-height:
  var(--toolbar-h); padding: 12px 16px; border-bottom: 1px solid
  var(--line)`.
- **LAY-11.** Order: [Previous week] [Today] [Next week] (gap 4 px), the
  week title, then (pushed to the end with `margin-inline-start: auto`
  on the status) the status "N planned", the preview panel, View as,
  Calendars, Planner options, Log work, Plan now. At 1180 px and below,
  "Side panel" follows Plan now.
- **LAY-12.** Week title: 15/20 600, `--track-title`, tabular,
  `flex: 0 1 auto; min-width: 9ch; overflow: hidden; text-overflow:
  ellipsis; white-space: nowrap`.
- **LAY-13.** Preview panel in the toolbar
  (`section[data-testid="preview-panel"]`): `display: flex; align-items:
  center; gap: var(--sp-8); min-width: 0; position: relative`. Its
  sentence (`.status`) has `flex: 0 1 22ch; min-width: 0; white-space:
  nowrap; overflow: hidden; text-overflow: ellipsis` and a `title` with
  the full text. When preview mode is on, the section has `background:
  var(--bg-selected); border-radius: var(--radius-md); padding: 0 4px 0
  8px; min-height: 32px`. The apply summary and the error in the section
  open as a popover below it (`top: calc(100% + 8px);
  inset-inline-end: 0; width: 320px`).
- **LAY-14.** Shrink order when the toolbar is too narrow: first the
  preview sentence (to 0), then the week title (to 9ch), then the
  toolbar wraps to a second row. At 1440 px the toolbar holds one row in
  every state that the E2E suite reaches.
- **LAY-15.** The planner error (`planner.tsx:352`) stays inline. It takes
  its own row: `order: 99; flex-basis: 100%; overflow-wrap: anywhere`.
- **LAY-16.** The "Assistant" button moves from the toolbar to the now bar
  (CMP-127).

### 5.3 Right column: contents and order

- **LAY-20.** Order from top to bottom: the now bar (header); the notices
  stack; `.side-scroll` with the open panel and then the overview.
- **LAY-21.** Notices stack: `display: grid; gap: var(--sp-8); padding:
  8px 16px 0`. Order: travel prompt, hours review, then the hints
  (`hint-other-tools`, `hint-assistant-chat`, `hint-first-mirror`). All
  notices are visible at the same time. Keep the wrapper
  `data-testid="planner-hints"` with `data-loaded`.
- **LAY-22.** The open panel is the `sidePanel` mode
  (`lib/planner-signals.ts:22-24`): `details` (the event details, only
  when an event is selected), `tasks`, `priorities`, `conflicts` or
  `assistant`. Only one is open. Opening one closes the other (PLN-21).
  The panels are not popovers any more: remove their absolute
  positioning.
- **LAY-23.** The overview is always rendered below the open panel:
  focus progress, current tasks, Issues and Recommendations (tabs), then
  `details.issues` with the report. A test can reach every part at any
  time.
- **LAY-24.** At 1440 px no part of the right column covers the grid.

### 5.4 Week grid

- **LAY-30.** The day header stays outside `.week-scroll`. Both have
  `scrollbar-gutter: stable` so that the columns line up with classic
  scroll bars.
- **LAY-31.** The hour gutter is 48 px (`week.tsx:144`, `styles.css:255`). With a
  second zone, the second column is 64 px. Hour labels: 11/14 tabular
  `--text-tertiary`, `inset-inline-end: 8px`, `white-space: nowrap`,
  `transform: translateY(-50%)`.
- **LAY-32.** Hour lines: `linear-gradient(var(--line) 1px, transparent
  1px)` at `background-size: 100% var(--hour-px)`. Day separators: `1px
  solid var(--line)` at the inline start.
- **LAY-33.** The grid opens at 07:00 (`scrollTop = 7 * 48`,
  `week.tsx:135`).
- **LAY-34.** Weekend columns (ISO weekday 6 and 7) get `.day-off`
  (new) with `background: var(--grid-off)`. A busy all-day day keeps its
  pattern (`day-busy`), which wins.

### 5.5 Overlap

- **LAY-40.** A cluster is a set of events in one day that overlap in a
  chain (`layout()`, `week.tsx:67-108`). The cap is the number of columns
  that a cluster can show: 3 when `matchMedia("(min-width: 1440px)")`
  matches, else 2.
- **LAY-41.** When a cluster needs more columns than the cap, the events
  in columns with an index of cap or more fold. They are not rendered as
  `.ev`. The visible columns share the day width minus a 24 px lane
  (`--more-lane-w`) at the inline end of the cluster. A cluster that fits
  in the cap has no lane.
- **LAY-42.** The lane holds one button: `<button class="ev-more"
  aria-label="N more events">+N</button>` ("1 more event" for one). It
  sits at the top of the first folded event. It is 20 px high, 20 px or
  more wide, `padding: 0 4px`, 11/14 600 tabular `--text-secondary`,
  `background: var(--bg-sunken)`, `box-shadow: var(--shadow-1)`,
  `border-radius: var(--radius-full)`, with a 24×24 hit area (CMP-6).
- **LAY-43.** The button opens a popover (CMP-43, width 240 px) with one
  button per folded event: time first (`HH:MM–HH:MM`), then the title
  with an ellipsis, 28 px high. A choice selects the event (it opens the
  details panel) and closes the popover.
- **LAY-44.** Cards in a cluster with 2 or more visible columns get
  `.ev-overlap` (CMP-87).
- **LAY-45.** Unit tests in a new `tests/unit/week-layout.test.ts` cover:
  2 events, 3 events with caps 2 and 3, 8 events in one slot, a chain
  that ends and starts a new cluster, and the "+N" count.

### 5.6 Short and tiny events

- **LAY-50.** CMP-89 and CMP-90 apply. In a run of back-to-back 30-minute
  events with the same title start, the time comes first, so each card
  is different.
- **LAY-51.** A 1-minute event keeps the 14 px slot minimum. It can cover
  the top of the next event. This is accepted.

### 5.7 Breakpoints

Use media queries on the viewport width. Do not detect devices.

| Width | Layout |
|---|---|
| above 1180 px | Three columns (LAY-3) |
| 1180 px and below | **LAY-60.** The right column becomes an overlay drawer: `position: fixed; inset-block: 0; inset-inline-end: 0; width: min(var(--drawer-w), 100vw); box-shadow: var(--shadow-3); z-index: var(--z-panel)`. No scrim. The planner grid has one column. The notices stack moves above the week (LAY-6) with `max-height: 40vh; overflow: auto`. A toolbar icon button "Side panel" (`aria-expanded`) toggles the drawer. The drawer also opens when `sidePanel` becomes a mode. "Hide panel" in the now bar and Escape (focus inside) close it. A click on the grid does not close it |
| 1024 px and below | **LAY-61.** (PR 4) The sidebar becomes a 56 px icon rail. Link text moves into a `.sr-only` span, so link names stay the same. The wordmark becomes a "T" monogram. "New task" and "Create" become icon buttons with the same names. The footer shows the avatar and the two icon buttons; the email stays in the DOM in a `.sr-only` element with the same test id |
| 860 px and below | **LAY-62.** Three days: today and the next 2 days when the shown week holds today, else the first 3 days of the week. The week buttons are named "Previous 3 days" and "Next 3 days" and move by 3 days. The title stays "Week of {date}" for the week of the first shown day |
| 640 px and below | **LAY-63.** Day view: one day. The week buttons are named "Previous day" and "Next day" and move by 1 day. (PR 4) The sidebar is hidden, and a bottom bar, 56 px plus `env(safe-area-inset-bottom, 0px)`, holds: Planner (link), Tasks (link), New task (button), Side panel (button, planner only), Menu (button). "Menu" opens the sidebar as a drawer from the inline start (`width: min(280px, 85vw)`, `--scrim`, `role="dialog"`, `aria-modal="true"`, `aria-label="Navigation"`). The right column drawer is full width and ends above the bottom bar. Dialogs are bottom sheets (CMP-53) |

- **LAY-64.** At 200% zoom a 1280 px window is 640 CSS px wide, so it gets
  the Day view. Check it (ROB-6).

## 6. Platform (mobile-native)

- **MOB-1.** `index.html:5`: `<meta name="viewport"
  content="width=device-width, initial-scale=1, viewport-fit=cover,
  interactive-widget=resizes-content">`. Never add `user-scalable=no` or
  `maximum-scale`.
- **MOB-2.** `index.html`: add `<meta name="theme-color" media="(prefers-
  color-scheme: light)" content="#ffffff">`, the same for dark with
  `#18191c`, and `<meta name="color-scheme" content="light dark">`.
- **MOB-3.** `html { -webkit-tap-highlight-color: transparent;
  -webkit-text-size-adjust: 100%; overscroll-behavior: none; }`.
- **MOB-4.** Heights: `.shell` `100dvh` (`styles.css:87`); `.login`
  `min-height: 100svh` (`styles.css:149`); `.planner` `100dvh`
  (`styles.css:494`, until LAY-3 removes the height); `priorities.css:31`
  `calc(100dvh - 120px)`; `parts.css:17` `60dvh`; `parts.css:118`
  `90dvh`. No `100vh` remains.
- **MOB-5.** Inner scrollers get `overscroll-behavior: contain`:
  `.week-scroll`, `.side-scroll`, `.assistant-log`, `.popover`, dialogs,
  the drawers.
- **MOB-6.** With a coarse pointer, `input`, `select` and `textarea` are
  16 px (token block). iOS zooms into smaller inputs.
- **MOB-7.** `button, a, summary, [role="button"] { touch-action:
  manipulation; }` and CMP-7.
- **MOB-8.** Event cards: `touch-action: pan-y`, so a finger that starts
  on a card scrolls the week. The selected card has `touch-action: none`.
  On touch, the first tap selects; a drag on the selected card moves it.
- **MOB-9.** Hover-only parts (the "⋯" button) are always visible on the
  selected card with a coarse pointer.
- **MOB-10.** Safe areas: `env(safe-area-inset-*, 0px)` on the bottom bar,
  the drawers (`padding-bottom: calc(20px + env(safe-area-inset-bottom,
  0px))`), the bottom sheets and the toasts.
- **MOB-11.** Inputs set the keyboard: `type="email"` for emails,
  `inputmode="numeric"` for minute fields, `enterkeyhint="send"` in the
  assistant input, `autocapitalize="none"` on user names.
- **MOB-12.** Pointer safety in `week.tsx`:
  - `pickPast` (`week.tsx:154-180`) listens only for `pointerup`. Add a
    `pointercancel` listener that removes it, as `startPick` does
    (`week.tsx:244-253`). A scroll must never open Log work.
  - `startDrag` (`week.tsx:182-218`): return when `!e.isPrimary` or a drag
    is running. On `pointercancel`, reset the drag and clear the inline
    transform.
  - Start a drag only after 4 px of movement for a mouse and 10 px for
    touch or pen.
- **MOB-13.** These need a real phone. Emulation does not show them:
  sticky hover, the tap delay, `dvh` with the URL bar, input zoom, safe
  areas, the software keyboard, touch drag. Test on one iPhone (Safari)
  and one Android phone (Chrome) at least 3 years old before PR 4 merges.
  Record the result in the pull request.

## 7. Motion

### 7.1 Tokens

The motion tokens are in the token block (3.1). Curves:
`--ease-out` for enter, exit, press and drop; `--ease-in-out` for movement
on screen (replanned events, the switch thumb); `--ease-drawer` for
drawers and sheets. The keyword `ease` is for color changes, toasts and
reduced-motion fades. Never use `ease-in` on UI. Durations:

| Token | Value | Use |
|---|---|---|
| `--duration-press` | 160ms | Button press, switch thumb |
| `--duration-menu` | 150ms | Event menu (opened tens of times a day) |
| `--duration-popover` | 200ms | Account menu, Create list, popovers |
| `--duration-modal` | 250ms | Dialogs and their backdrop |
| `--duration-exit` | 125ms | Every overlay exit, removed events |
| `--duration-move` | 250ms | Replanned events, drop settle |
| `--duration-collapse` | 200ms | Notice collapse |
| `--duration-fade` | 200ms | Opacity-only replacement under reduced motion |
| `--duration-drawer` | 200ms | Right column drawer, navigation drawer |
| `--duration-toast` | 400ms | Toast enter and move (the one exception to "under 300 ms") |

### 7.2 Global rules

- **MOT-1.** Name the transitioned properties. Never use `transition:
  all`.
- **MOT-2.** Animate only `transform` and `opacity`. Exceptions:
  `background-color` (backdrop, switch track) and `height` (notice
  collapse).
- **MOT-3.** Enter with `@starting-style` and CSS transitions. Use
  transitions, not keyframes, for anything that a user can trigger twice
  in one second.
- **MOT-4.** Never animate from `scale(0)`. Start at 0.95 to 0.97 with
  `opacity: 0`.
- **MOT-5.** Exits are faster than enters (125 ms against 150 to 250 ms).
- **MOT-6.** No motion for keyboard actions. An overlay that opens from
  the keyboard (Enter or Space on its trigger, the `c` key, Shift+F10)
  opens at once. A click with `event.detail === 0` came from the
  keyboard. Set `data-instant` on the opened element:

```css
[data-instant], [data-instant] * {
  /* biome-ignore lint/complexity/noImportantStyles: an instant open must beat the component's transition */
  transition-duration: 0ms !important;
}
```

- **MOT-7.** No `will-change` until a dropped frame or a 1 px shift is
  seen.
- **MOT-8.** `src/web/lib/motion.ts` (new, about 25 lines). It reads the
  token values on first use, not at import:
  `easeOut()`, `easeInOut()`, `moveMs()`, `exitMs()`, `fadeMs()` from
  `getComputedStyle(document.documentElement)`;
  `motionOK = () => !matchMedia("(prefers-reduced-motion: reduce)").matches`;
  `byKeyboard = (e: MouseEvent) => e.detail === 0`.

### 7.3 Reduced motion and E2E

- **MOT-9.** Reduced motion means fewer and gentler motions, not zero.
  Fades and color changes stay. Movement, scale and size changes snap.
  Put static transform states (such as `:active` scale) inside
  `@media (prefers-reduced-motion: no-preference)`. Add this rule at the
  end of `styles.css`:

```css
@media (prefers-reduced-motion: reduce) {
  html {
    /* biome-ignore lint/complexity/noImportantStyles: no smooth scrolling under reduced motion */
    scroll-behavior: auto !important;
  }
  *, *::before, *::after {
    /* biome-ignore lint/complexity/noImportantStyles: the safety net must win over every component transition */
    transition-property: opacity, color, background-color, border-color !important;
  }
}
```

  WAAPI code checks `motionOK()` itself.
- **MOT-11.** PR 4 adds `tests/e2e/motion.spec.ts` with `test.use({
  reducedMotion: "no-preference" })`: open and close the account menu;
  open New task with the button (it animates) and with `c` (no
  animation on the first frame); Plan now with one moved event; drag one
  event and check its `data-start`. Before a test reads a box, it waits
  until the element is still: `await expect.poll(() => el.evaluate((n)
  => n.getAnimations().length)).toBe(0)`. PR 4 adds a note on this to
  `tests/e2e/README.md`.
- **MOT-12.** No UI state may wait for a timer that `page.clock` can
  freeze, except the toast close timer (toasts do not appear in existing
  tests, CMP-74). Exit code uses `animation.finished` and a
  `setTimeout(EXIT_MS + 50)` safety net, and under reduced motion it
  exits at once with no timer.
- **MOT-13.** `playwright.config.ts`: add `reducedMotion: "reduce",` to
  the `use` block, with the comment "The app's motion is off in E2E:
  boxes are where they end up on the first frame.
  tests/e2e/motion.spec.ts turns it on." This is a configuration change,
  not a test change.

### 7.4 Per-item specs

| Id | Item | Trigger | Properties | Duration and easing | Origin | Interrupt | Reduced motion | PR |
|---|---|---|---|---|---|---|---|---|
| MOT-10 | Button press | `:active` on `button:not(:disabled)`, `a.button`, `.create-menu summary`. Not menu items, segmented items, tabs or event cards | `transform: scale(0.97)` | 160 ms `--ease-out`, one transition both ways | center | CSS transition retargets | No scale (the rule is in `no-preference`) | 2 |
| MOT-15 | Switch | `checked` changes | thumb `transform: translateX(14px)`; track `background-color` | thumb 160 ms `--ease-in-out`; track 160 ms `ease` | – | CSS | Thumb snaps; track color fades | 2 |
| MOT-20 | Menus | mount | `opacity` 0→1, `scale` 0.95→1 (event menu 0.97→1) | 200 ms `--ease-out` (event menu 150 ms) | Account menu `bottom left` (opens up); Create list `top left`; event menu from "⋯": `top left` (`top right` when it opens to the left); right click: the pointer position | CSS | Opacity only | 3 (Create list and event menu: 4) |
| MOT-21 | Popovers | mount | `opacity`, `scale` 0.95→1 | 200 ms `--ease-out` | Planner options, Calendars: `top right`; hours info: `top left`; "+N" list: `top left` when it opens to the right of the pill, else `top right`; apply summary: `top right` | CSS | Opacity only | 3 |
| MOT-22 | Dialogs | mount | dialog `opacity` 0→1, `scale` 0.96→1; backdrop `background-color` from `rgb(0 0 0 / 0%)` to `--scrim` | 250 ms `--ease-out` | center | CSS | Opacity and backdrop color | 3 |
| MOT-23 | Bottom sheet (dialog at 640 px and below) | mount | `transform: translateY(100%)` → none | 250 ms `--ease-drawer` | bottom edge | CSS | Opacity 200 ms `ease` | 3 |
| MOT-30 | Right column drawer (1180 px and below) | open | `transform: translateX(100%)` → none (RTL: −100%) | 200 ms `--ease-drawer`; exit 125 ms `--ease-out` on the same path | inline-end edge | CSS | Opacity 0→1, 200 ms `ease` | 3 (exit 4) |
| MOT-31 | Navigation drawer (640 px and below) | open | `transform: translateX(-100%)` → none; scrim alpha | 200 ms `--ease-drawer`; exit 125 ms `--ease-out` | inline-start edge | CSS | Opacity only | 4 |
| MOT-40 | Replanned events glide | the event list changes while the same days show: Plan now, the 15 s poll, live updates, a move, lock, done, skip, hidden calendar, view as. Not on first render, not when the days change, not during a drag | moved: `translate(dx, dy)` → none; new: `opacity` 0 and `scale(0.97)` → settled; removed: a clone fades out | moved 250 ms `--ease-in-out`; new 200 ms `--ease-out`; removed 125 ms `--ease-out` | center | WAAPI: cancel running animations, then measure again | Moved and new cards fade in place, 200 ms `ease`; removed cards go at once | 3 |
| MOT-41 | Drag | pointer moves after 4 px (mouse) or 10 px (touch) | the card follows the pointer 1:1 with `el.style.transform`; a dashed ghost snaps to the 15-minute slot with no transition; the `drag` signal changes once per slot, not per `pointermove` | drop: settle from the pointer into the slot, 250 ms `--ease-out` (the MOT-40 routine with this card as the settle key); cancel: at once | – | the next render measures the live position | 1:1 tracking stays; the settle becomes a 200 ms `ease` fade in place | 4 |
| MOT-42 | Overlay exits | close by pointer | the enter values in reverse (`data-ending-style`) | 125 ms `--ease-out` | as enter | reopen during exit retargets | Exit at once | 4 |
| MOT-50 | Toasts | `toast()` | enter `translateY(100%)` and `opacity` 0 → settled; exit to the same edge; older toasts move up by `transform: translateY(-Npx)` set on each toast | transform 400 ms `ease`; opacity 400 ms `ease` on enter, 200 ms `ease` on exit | bottom edge | CSS transitions | Opacity only | 4 |
| MOT-51 | Notices | enter (first draw); dismiss | enter: `opacity` 0→1, no height; dismiss: `height` and `opacity` to 0, then unmount | enter 200 ms `--ease-out`; collapse 200 ms `--ease-out` | – | WAAPI from the current height | Fade in stays; collapse is at once | 3 (collapse 4) |

Rules that go with the table:

- **MOT-43.** Exiting overlays get `data-ending-style`, `aria-hidden="true"`
  and `inert` until they unmount, so role queries skip them. Choosing a
  menu item and pressing Escape close at once with no exit.
- **MOT-44.** Replan glide details (`week.tsx`): each card gets
  `data-box-key="{id}#{n}"`, where `n` counts the cards of that event in
  day order. (Do not use `data-key`, 2.3.) `WeekView` makes a signature
  from `id@start-end` of all events. With `useMemo` on the signature, it
  measures every card with `getBoundingClientRect()` during render
  ("first"), only when the days are the same as in the last render. A
  `useLayoutEffect` on the same signature cancels running animations on
  each card, measures again ("last") and animates the difference. A
  card whose size changed takes its new size at once and glides into
  place. A removed card becomes a clone with the class `ev-leaving`
  instead of `ev`, without `data-box-key`, `data-event-id` and `title`,
  with `aria-hidden="true"` and `inert`; the clone is removed when its
  fade ends. Write the card base rule as `:is(.ev, .ev-leaving)` and add
  `.ev-leaving { pointer-events: none; z-index: 0; }`. No stagger.
- **MOT-45.** Keep the class `ev-drag` on the dragged card. `data-start`
  updates when the state changes, not after the settle. The ghost has the
  class `ev-ghost` and not the class `ev`, so `.ev` locators and counts
  never see it. Style it like `.ev-pick` (CMP-87).

Code for MOT-10, MOT-20 to MOT-22 and MOT-50:

```css
@media (prefers-reduced-motion: no-preference) {
  button, a.button, .create-menu summary {
    transition: transform var(--duration-press) var(--ease-out);
  }
  :is(button:not(:disabled), a.button, .create-menu summary):active {
    transform: scale(0.97);
  }
  :is([role="menuitem"], [role="tab"], .panel-switch button):active {
    transform: none;
  }
}

.menu, .popover {
  transition:
    opacity var(--duration-popover) var(--ease-out),
    transform var(--duration-popover) var(--ease-out);
  @starting-style {
    opacity: 0;
    transform: scale(0.95);
  }
}
.account-menu .menu { transform-origin: bottom left; }
.create-menu .menu { transform-origin: top left; }
.toolbar .popover { transform-origin: top right; }
.hours-info .popover { transform-origin: top left; }
/* The event menu and the "+N" list set transform-origin inline, from their side or the pointer. */
.event-menu {
  transition-duration: var(--duration-menu);
  @starting-style {
    opacity: 0;
    transform: scale(0.97);
  }
}

.dialog-backdrop {
  transition: background-color var(--duration-modal) var(--ease-out);
  @starting-style { background-color: rgb(0 0 0 / 0%); }
}
.dialog {
  transform-origin: center;
  transition:
    opacity var(--duration-modal) var(--ease-out),
    transform var(--duration-modal) var(--ease-out);
  @starting-style {
    opacity: 0;
    transform: scale(0.96);
  }
}

.toast {
  transition:
    opacity var(--duration-toast) ease,
    transform var(--duration-toast) ease;
  @starting-style {
    opacity: 0;
    transform: translateY(100%);
  }
}
.toast[data-ending-style] {
  opacity: 0;
  transform: translateY(100%);
  transition:
    opacity 200ms ease,
    transform var(--duration-toast) ease;
}
```

### 7.5 Motion that this refresh rejects

Do not add these. Each fails the frequency rule (100 or more times a day,
or tens of times a day for something that does not need it), the purpose
rule, or the keyboard rule.

- The now line: no glide and no pulse.
- Week navigation, Today, the 3-day and day steps: no slide. The new
  events arrive after a fetch.
- Switching the right column panel, the Issues and Recommendations tabs,
  the task filters: instant.
- Event card hover, select and press: no motion, no scale (**MOT-60**). A
  card's edges show its start and end; a scale would show wrong times.
- The `c` shortcut and every keyboard open: instant.
- Focus rings: never animated.
- Skeletons, shimmer, a "Planning…" spinner or pulse (**MOT-61**): the
  planner is ready in about 90 ms, and the status text says "Planning…".
- Number tickers (counts, "N planned", the timer): static tabular digits.
- Stats charts that draw in.
- Animated height of parts that load later (`settled`): the week would
  glide, and `tests/e2e/helpers.ts:166-182` waits for those parts.
- The right column at more than 1180 px: no slide and no width
  animation. Its content changes at once.
- Hold-to-confirm on any action (TST-6). A tilt on a dragged card.
- Later, not in this refresh: accordions, the assistant reply entrance,
  the staged event fade, the "Saved" fade, the task check animation, the
  booking success stagger.

## 8. Robustness

### 8.1 Rules

- **ROB-1.** Minimum sizes: text 11 px; hit areas CMP-6; a card slot 14
  px; the week area `min-height: max(240px, 50vh)` when something is
  above it.
- **ROB-2.** Every text column in a flex or grid row has `min-width: 0`
  (`minmax(0, 1fr)` in a grid). Every fixed-size item (avatar, icon,
  badge, trailing button) has `flex-shrink: 0`.
- **ROB-3.** User text that can hold a long token (titles, emails, URLs,
  calendar names) has `overflow-wrap: anywhere`. Do not use
  `word-break: break-all`.
- **ROB-4.** Truncate, wrap or clamp, per field:

| Field | Rule |
|---|---|
| Event title in a card | One line with an ellipsis; 2 lines in `ev-tall`; full title in `title` |
| Task title in a list or in the right column | Wrap to 2 lines, then clamp; full title in `title` |
| Event details title | Wrap, no clamp |
| Notice message | One line with an ellipsis; "Show full text" expands it (CMP-63) |
| Email, user name in the sidebar | One line with an ellipsis; full value in `title` |
| Badge | `white-space: nowrap`; the long risk badge wraps with `box-decoration-break: clone` |
| Times, dates, counts, amounts | Never truncate |

- **ROB-5.** Empty and loading states are different. Show "No … yet" only
  after the data loaded. Show "Loading…" while it loads.
- **ROB-6.** Check each pull request at 1440, 1024, 768 and 390 px, at
  200% zoom (a 1280×800 window), and in the dark scheme.
- **ROB-7.** Plurals: use `plural()` (`preview.tsx:34`; move it to
  `src/web/lib/format.ts` to share it) or two strings.
  Never print "1 items". Exception: ROB-21.
- **ROB-8.** Numbers: `Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2 })`. Durations past 60 minutes: `h:mm:ss`.
- **ROB-9.** Bidirectional text: user titles get `dir="auto"` (event
  cards, task titles, the now bar `strong`, the details `h2`). Times and
  dates next to user text get `unicode-bidi: isolate`. New CSS uses
  logical properties (`inset-inline-*`, `padding-inline`,
  `margin-inline`, `border-inline-*`).
- **ROB-10.** Row grids: CMP-104. Below 1101 px, rows with actions put the
  actions under the body: `@media (max-width: 1100px) {
  .row:has(> .actions) { grid-template-columns: minmax(0, 1fr); }
  .task-row:has(> .actions) { grid-template-columns: auto minmax(0, 1fr);
  } .row > .actions { grid-column: -2 / -1; max-width: none;
  justify-content: flex-start; } }`. At 1440 px this rule does not apply,
  so `task-list.spec.ts:667-704` holds.
- **ROB-11.** Form labels: `label:not(.inline) { grid-template-columns:
  minmax(0, 1fr); }` and `label > input:not([type="checkbox"]):not([type=
  "radio"]), label > select, .field > select, label.inline > select {
  min-width: 0; max-width: 100%; }`.
- **ROB-12.** History lists paginate: 50 rows per page. Above 50 rows,
  show `<span class="status">Showing N of M</span>` (N is the number of
  rows on this page, for example "Showing 50 of 87") and the buttons
  "Previous page" and "Next page" (`.sm`, disabled at the ends). The
  lists: bookings (`links.tsx:654-663`) and report items
  (`planner.tsx:447`). When the list reloads, keep the page if it still
  exists, else show the last page.

### 8.2 Current-app fixes

File and line numbers refer to `src/web` at `a71564f`. "Text" says if the
fix changes visible text.

| Id | Problem | Fix | Text | PR |
|---|---|---|---|---|
| A1 | The week is 0 px high under notices and issues: `.planner{height:100vh}` (`styles.css:491-495`) and `.week{flex:1;min-height:0}` (`styles.css:224-229`); `.side-panel` has no CSS (`issues-panel.tsx:59`) | `.week{min-height:max(240px,50vh)}`; `.side-panel{flex:none;max-height:25vh;overflow:auto;margin:0;padding:4px 16px;border-top:1px solid var(--line)}`. PR 3 moves these parts to the right column | no | 1 |
| A2 | The now bar does not wrap (`styles.css:962-972`); Stop, Join and conflicts go off-screen | `.now-bar{flex:none;height:auto;min-height:38px;flex-wrap:wrap;row-gap:4px;padding-block:4px;white-space:normal}`; `.now-bar strong{display:inline-block;max-width:min(40ch,45vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}`; `.now-bar>span{min-width:0;max-width:100%}`; `.now-bar .popover{top:100%}`. `flex:none` is required | no | 1 |
| A3 | Toolbars do not wrap (`styles.css:127-133`); `span.inline` has no CSS (`planner-options.tsx:67`); BulkBar (`tasks.tsx:454`) and filters (`tasks.tsx:822`) overflow; the toolbar error is unbounded (`planner.tsx:352`) | `.toolbar{flex-wrap:wrap;row-gap:8px}`; `.toolbar .title{white-space:nowrap}`; `.toolbar .error{order:99;flex-basis:100%;overflow-wrap:anywhere}`; `span.inline{display:inline-flex;align-items:center;gap:6px}` | no | 1 |
| A4 | List rows use `1fr` (`styles.css:163-179`); long tokens push actions out. Same grid at `habits.tsx:331`, `links.tsx:224, 656`, `planner-now.tsx:79`, `issues-panel.tsx:89`, `settings.tsx:613, 780` | CMP-104, ROB-10, `.task-row>input[type=checkbox]{margin-top:3px}`, `.row>:not(.actions):not(button):not(.badge){overflow-wrap:anywhere}`, `.row>.actions{max-width:28rem;justify-content:flex-end}` | no | 1 |
| A5 | 8 overlapping events become 16 px slivers (`week.tsx:362`) | LAY-40 to LAY-45, and section 2.4 | adds "+N" | 1 (restyle 3) |
| A6 | Events of 15 minutes or less clip mid-glyph (`week.tsx:97`, `styles.css:283-297`) | `ev-tiny` when the slot is below 20 px (`week.tsx:366`): `padding-block:0;font-size:11px;line-height:12px` | no | 1 |
| A7 | Long titles stay one line in tall cards (`styles.css:357-363`) | Add the class `ev-tall` to cards with a slot of 56 px or more (`week.tsx:366`) and `.ev-tall .ev-title{white-space:normal;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2}`. PR 3 restyles it (CMP-89) | no | 1 |
| A8 | Truncated right-to-left titles show the end of the sentence | `dir="auto"` on `.ev-title` (`week.tsx:378`), task titles, the now bar `strong`, the details `h2` (`planner.tsx:458`) | no | 1 |
| A9a | `.hours` is both the hour gutter (`week.tsx:293, 301`) and the hours editor card (`styles.css:437-447`, `settings.tsx:139`) | Rename the editor class to `hours-card` (`settings.tsx:139` and `styles.css:437, 444`). Keep `.hours` on the gutter | no | 1 |
| A9b | `.preview` is both the planner preview panel (`preview.tsx:102`, `styles.css:744-748`) and the booking preview (`styles.css:943-947`, `link-personalize.tsx:407`) | Change `styles.css:943` to `.wide.preview` | no | 1 |
| A10 | A buffer on both sides shows only the minutes after (`settings.tsx:616-618`) | `b.side === "both" ? \`${b.minutes_before} min before, ${b.minutes_after} min after\` : …` | yes, for "both" rows; no test reads it | 1 |
| A11 | Selects and date inputs overflow forms (`styles.css:71-76`, `buffer-editor.tsx:294-295`) | ROB-11 | no | 1 |
| A12 | Badges break ("next / up") (`styles.css:197-203`, `tasks.tsx:679-684`) | `.badge{white-space:nowrap}`; `.badge.risk{white-space:normal;-webkit-box-decoration-break:clone;box-decoration-break:clone}`. Keep the leading space in `tasks.tsx:644, 647` | no | 1 |
| A13 | Row actions stretch to 80 px (`styles.css:479-483`) | `.actions{align-items:center}` | no | 1 |
| A14 | The focus row drops Delete to row 2 (`settings.tsx:780-801`) | Wrap `<FocusNotes/>` and Delete in `<div class="actions">` | no | 1 |
| A15 | The event drawer has no overflow; Close is unreachable at 200% zoom (`styles.css:382-396`, `planner.tsx:458, 471-473`) | `.drawer{overflow-y:auto;max-width:100vw;overscroll-behavior:contain}`; `.drawer h2,.drawer .status{overflow-wrap:anywhere}` | no | 1 |
| A16 | 12-hour labels of a second zone wrap (`week.tsx:309`, `parts.css:63-68`) | `.hour-label{white-space:nowrap}`; the second column 64 px (`week.tsx:144`), labels 11 px; `.zone-head{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}` | no | 1 |
| A17 | At 390 px the sidebar takes half the width; popovers are wider than the main column (`styles.css:84-88`, `parts.css:15`) | Stopgap: `.popover{max-width:min(460px,calc(100vw - 32px))}`. LAY-60 to LAY-63 replace it | no | 1 (layout 3, 4) |
| A18 | The timer prints `1264:00`, has proportional digits and a "⏱" glyph (`planner-now.tsx:182-193, 290`) | `m:ss` under 60 min, `h:mm:ss` from 60 min; `tabular-nums`; a mask icon | yes, past 60 min; `task-timer.spec.ts` reads the title only | 4 |
| A19 | "1 items need attention" (`planner.tsx:445`) | "1 item needs attention" for one | yes, at 1 | 4 |
| A20 | The report silently shows 50 of N (`planner.tsx:447`) | ROB-12 | adds text | 4 |
| A21 | "No open tasks." and "No habits yet." show while loading (`tasks.tsx:903-905`, `habits.tsx:375`); with filters on, the empty text is wrong | `{loaded && list.length === 0 && …}` with the existing `loaded` (`tasks.tsx:531`, `habits.tsx:98`). With a filter on: "No {state} tasks match these filters." | yes; no test reads it | 4 |
| A22 | The links page is blank while loading (`links.tsx:178`) | `<p class="status">Loading…</p>`, as `settings.tsx:228-235` | adds text | 4 |
| A23 | Custom hours names are lowercased in "Save …" (`settings.tsx:203`) | Lowercase only the built-in names. Keep "Save work hours", "Save personal hours", "Save meeting hours" exactly (tests click them) | yes, custom names only | 4 |
| A24 | The hours set name input has no limit (`settings.tsx:506-510`); the server rejects 101 characters | `maxLength={100}` | no | 4 |
| A25 | `.focus-progress`, `.current-tasks` and `.side-panel` have no padding; `.hint` touches the edges | The right column (LAY-20 to LAY-23, CMP-121) and the notice card (CMP-60) replace these parts | no | 3 |
| A26 | The sidebar email and the acting banner do not wrap (`main.tsx:215`, `styles.css:646-654`) | CMP-115; `.acting-banner{flex-wrap:wrap}`; `.acting-banner>span{min-width:0;overflow-wrap:anywhere}` | no | 4 |
| A27 | Day labels shift with classic scroll bars (`week.tsx:259-285`) | LAY-30 | no | 3 |
| A28 | The agenda draft does not wrap (`issues-panel.tsx:104-106`) | `white-space:pre-wrap;overflow-wrap:anywhere` | no | 4 |
| A29 | Bookings are not paginated (`links.tsx:655-663`) | ROB-12 | adds text | 4 |
| A30 | The focus goal prints `10.25 h` (`settings.tsx:782`) | ROB-8 | no | 4 |

- **ROB-21.** Do not pluralize "Preview: N work blocks for …"
  (`planner-now.tsx:298`). `disconnected-items.spec.ts:376` reads "work
  blocks for Report" with one block.

## 9. Libraries and spikes

- **LIB-1.** clsx 2.1.1: adopt in PR 1. Use it for the class string of
  event cards (`week.tsx:366`) and for the other template-literal class
  strings (`week.tsx:277`, `priorities.tsx:245, 290`,
  `automations.tsx:180, 349`, `tasks.tsx:866`,
  `book-inspector.tsx:145, 158`). It gives the same class names.
- **LIB-2.** The `manualChunks` rule in `vite.config.ts` puts every file
  from `node_modules` into the `base` chunk, which the cold load reads.
  Before a library that must load on demand is added, change the rule to
  match only `/node_modules/(preact|@preact|clsx)/` and the listed
  `src/web/lib` files. Measure the cold load after the change (TST-12).
- **LIB-3.** Base UI (`@base-ui/react`): one spike, time-boxed to one
  working day (8 hours), before PR 3. Scope: Menu (account menu, event
  menu) and Dialog only. Not Select, not Switch, not Checkbox, not
  Popover, not Tooltip. The spike passes only if all of these are true:
  1. It runs under Preact 11 through `preact/compat` (the aliases of
     `@preact/preset-vite`), and `npm run typecheck` passes with
     `compilerOptions.paths` for `react` and `react-dom` that point to
     `preact/compat`, without `@types/react`.
  2. Menu keyboard works as CMP-42 says, in Chrome, with Preact 11.
  3. Dialog focus works as CMP-54 says: focus in, Tab stays in, Escape
     closes, focus returns.
  4. The roles and names stay: `role="menu"`, `role="menuitem"`, the
     trigger "Account menu" with `aria-haspopup` and `aria-expanded`;
     one `role="dialog"` per dialog with its name. Base UI does not set
     `aria-hidden` or `inert` on the rest of the app.
  5. `data-starting-style` and `data-ending-style` work, so MOT-20,
     MOT-22 and MOT-42 work.
  6. The cold-load files grow by 300 bytes gzip or less (LIB-2).
  7. The full E2E suite passes.
  If any item fails, keep the menus and dialogs hand-built and add the
  behavior of CMP-42 and CMP-54. Record the result and the chunk sizes in
  the PR 3 description.
- **LIB-4.** Sonner 2.0.8: one spike, time-boxed to 4 hours, before PR 4.
  Load it on demand after `settled`. Use `toast.custom()` with the markup
  and classes of CMP-72, `position="bottom-center"`, `visibleToasts={3}`,
  `duration={4000}`, gap 14 px, offset 16 px. It passes only if all of
  these are true:
  1. It works with Preact 11 through `preact/compat` (it needs
     `flushSync`).
  2. It is not in the cold-load files; they grow by 200 bytes gzip or
     less.
  3. The full E2E suite passes two times in a row with no new failure.
  4. Toasts use `role="status"`, never `role="alert"` (CMP-70).
  If adopted, add one CSS override so that toasts still fade under
  reduced motion (Sonner turns all toast transitions off). If any item
  fails, build the CSS-only toast: a `toast(message, { action?, id? })`
  function backed by a signal (a second call with the same id updates
  the toast), the region of CMP-70 to CMP-73 and the motion of MOT-50.
- **LIB-5.** motion: not needed. CSS transitions, `@starting-style` and
  WAAPI cover every item. Revisit only for touch gestures with momentum.
- **LIB-6.** dnd kit (vanilla `@dnd-kit/dom`) and cmdk: later, not in this
  refresh.
- **LIB-7.** NumberFlow, recharts, Virtuoso and zustand: do not use. The
  app has signals for state; numbers stay static; stats keep their CSS
  bars (`pomodoro-stats.spec.ts:132` reads their text).

## 10. Delivery plan

### 10.1 Checks for every pull request

1. `npm run lint` (Biome) passes. A `!important` has a `biome-ignore`
   comment with a reason.
2. `npm run typecheck` passes.
3. `npm test` passes.
4. `npm run build` passes.
5. The full E2E suite on CalDAV passes: `scripts/e2e-run.sh`.
6. TST-2 prints nothing.
7. The cold-load sizes (TST-12) are in the pull request description,
   with the difference from `main`.
8. Screenshots of the planner with the same data, in the pull request
   description: 1440×900 light, 1440×900 dark, 390×844 light. PR 3 and
   PR 4 add 1024×768 and the worst-case data at 1440×900. Compare them
   with the reference images.
9. The checks of ROB-6.

### 10.2 PR 1: current-app fixes, mobile basics, motion foundation

- Scope: A1 to A17 (section 8.2); MOB-1 to MOB-8, MOB-10 (for the
  current `.drawer` and `.toast`) and MOB-12; the motion tokens (7.1, without `--ease-drawer` and
  `--duration-drawer`), MOT-6, MOT-8, MOT-9, MOT-13; LIB-1.
- No component motion. No markup change except: `week.tsx` (overlap cap,
  `ev-tiny`, `ev-tall`, `ev-selected` for MOB-8 with a new `selectedId`
  prop, `dir="auto"`, the second-zone column, pointer safety),
  `settings.tsx` (A9a, A10, A14), `tasks.tsx` and `planner-now.tsx` (A8),
  `planner.tsx` (A8 on the details `h2`, the `selectedId` prop),
  `index.html` (MOB-1, MOB-2). LIB-1 changes only how class strings are
  built, not the class names.
- Files: `src/web/index.html`, `src/web/styles.css`,
  `src/web/views/parts.css`, `src/web/views/priorities.css`,
  `src/web/views/week.tsx`, `src/web/views/settings.tsx`,
  `src/web/views/tasks.tsx`, `src/web/views/planner-now.tsx`,
  `src/web/views/planner.tsx`, the other LIB-1 files
  (`src/web/views/priorities.tsx`, `automations.tsx`,
  `book-inspector.tsx`), `src/web/lib/motion.ts` (new),
  `src/web/lib/media.ts` (new: a `matchMedia` signal for `(min-width:
  1440px)`),
  `playwright.config.ts`, `package.json`, `package-lock.json`,
  `tests/unit/week-layout.test.ts` (new).
- Acceptance: 10.1; section 2.4 done and its list in the description;
  with reduced motion emulated in DevTools,
  `getComputedStyle(document.body).transitionProperty` is `opacity,
  color, background-color, border-color`.
- Risks: the overlap cap hides an event that a test needs (2.4). The
  `100dvh` change on old browsers (no fallback is needed: the
  supported Chrome has `dvh`).

### 10.3 PR 2: tokens, type, component states, hit areas

- Scope: the token block (3.1) and the token migration (3.2, TOK-1, TOK-2);
  TOK-3, TOK-10 to TOK-13; CMP-1 to CMP-14 (CMP-12 here: "New task"
  loses `.primary`), CMP-20 to CMP-26, CMP-30 to CMP-31, CMP-35,
  CMP-36 (style only), CMP-40, CMP-41, CMP-43 (look only), CMP-50 to
  CMP-52, CMP-60 to CMP-62 and CMP-64 for the banners in their current
  places, CMP-103, CMP-110 to CMP-112; MOT-10, MOT-15.
- No layout change: no element moves, no column changes. Event cards get
  only the new color tokens; their redesign is PR 3.
- Files: `src/web/styles.css`, `src/web/views/parts.css`,
  `src/web/views/priorities.css`, `src/web/views/tools.tsx`,
  `src/web/views/stats.tsx`, `src/web/views/stats-extras.tsx`,
  `src/web/views/team-stats.tsx`, `src/web/main.tsx` (CMP-12), and the
  banner markup that needs the
  `.note` classes (`hints.tsx`, `planner-now.tsx`, `preview.tsx`,
  `account-menu.tsx`, `connect.tsx`).
- Acceptance: 10.1; TOK-1 and TOK-2 greps are clean; every pressable
  element shows the five states (compare with
  `ui-refresh/states.png`); a screenshot of the public booking page at
  390 px.
- Risks: the 13 px body (from 14 px) changes text widths, and a test can
  read wrapped text. A border that carried meaning disappears (CMP-14).

### 10.4 PR 3: planner layout

- Scope: LAY-1 to LAY-6, LAY-10 to LAY-16, LAY-20 to LAY-24, LAY-30 to
  LAY-34, LAY-40 to LAY-44 (restyle), LAY-50, LAY-51, LAY-60, LAY-62,
  LAY-63 (planner part: Day view and the step buttons); CMP-15 for the
  toolbar icons; CMP-32, CMP-36 on "Preview mode", CMP-42 for the
  account menu, CMP-43 (Escape and outside press for the popovers),
  CMP-60 to CMP-65 (notices in the right column), CMP-80 to CMP-90,
  CMP-120 to CMP-129, CMP-140 to CMP-142; MOT-20 (without the event
  menu), MOT-21, MOT-22, MOT-23, MOT-30 (enter), MOT-40, MOT-44, MOT-51
  (enter); `--ease-drawer` and `--duration-drawer`; LIB-3 result.
- Spec updates in the same pull request (the docs say where the parts
  are):
  - `planning-planner.md` PLN-4: a free managed event is hatched; dashed
    marks staged and preview events.
  - `planning-planner.md` PLN-7, `planning-next-up.md` lines 67 and 90,
    `events-external-priority.md` line 37, `focus-time.md` line 145,
    `timezones-home-and-travel.md` line 46: "the line above the week" or
    "above the week" becomes "the planner's right column" (or "the
    notices at the top of the right column").
  - `platform-current-version.md` line 39: the Issues and Recommendations
    panel is in the planner's right column, not under the week.
- Files: `src/web/views/planner.tsx`, `week.tsx`, `planner-now.tsx`,
  `planner-options.tsx`, `preview.tsx`, `hints.tsx`, `issues-panel.tsx`,
  `planner-extras.tsx`, `assistant.tsx`, `account-menu.tsx`, `main.tsx`
  (`data-instant` for `c`), `task-dialog.tsx` (`instant` prop),
  `src/web/lib/planner-signals.ts` (drawer state), `src/web/lib/media.ts`
  (add signals for 1180, 860 and 640 px),
  `src/web/lib/motion.ts`, `src/web/styles.css`,
  `src/web/views/parts.css`, the docs above.
- Acceptance: 10.1; at 1440×900 the grid starts right under the toolbar
  (56 px) in every state of 2.2, and no part covers it; the toolbar is one row
  in the states of 2.2; notices are all visible; keyboard-opened menus
  and dialogs open with no animation; the feel checks of MOT-40 at 10%
  playback (no card flashes at its new place before it moves; a second
  Plan now during a glide continues from the current place; a week switch
  does not animate), and a second look on the next day.
- Commit order (each commit builds and passes the unit tests): tokens for
  the drawer; right column skeleton with the existing parts; toolbar;
  notices; event cards and line layouts; overlap restyle and now line;
  breakpoints; menu and dialog motion; replan glide; spec updates.
- Risks: this is the largest change. Parts that load after `settled`
  move the week's position less (they are in the right column now), but
  `weekInPlace` still waits for them. The toolbar can overflow at 1440
  px in a state that the suite does not reach. The external event color
  changes from gray to `--cat-external`, which users will notice.

### 10.5 PR 4: lists, secondary pages, navigation, toasts, remaining items

- Scope: CMP-100 to CMP-104 on the tasks, habits, links and settings
  pages (settings sections: H2 15/20 600, 32 px between sections);
  CMP-113 to CMP-115 (navigation groups, icons, top row, footer);
  LAY-61, LAY-63 (bottom bar and navigation drawer); CMP-130 to CMP-133
  (event menu, with CMP-42); CMP-54 and CMP-55 (dialog focus, with
  Base UI or hand-built); CMP-70 to CMP-75 (toasts, after LIB-4);
  ROB-12; A18 to A24, A26, A28 to A30; keyboard access to events
  (cards get `tabindex="0"`, Enter or Space selects, MOT-6 applies); MOT-20 (event menu),
  MOT-30 (exit), MOT-31, MOT-41, MOT-42, MOT-43, MOT-45, MOT-50, MOT-51
  (collapse), MOT-11; the scroll-edge shadow under the day header
  (`::after` 8 px `linear-gradient(rgb(16 24 40 / 0.06), transparent)`,
  shown when `.week-scroll` `scrollTop > 0`, set by a passive scroll
  listener); hide an hour label within 10 minutes of the now pill with
  `visibility: hidden`; MOB-11, MOB-13; `docs/performance.md` new
  numbers.
- Keyboard access to events needs a check first. Give cards
  `role="button"` only if no test queries a button name that is a part
  of an event title in the same test (TST-9 against the titles in 2.2
  and in the `hasText` filters). If a name collides, use `tabindex="0"`
  and Enter or Space without a role, and record it in the description.
- Files: `src/web/main.tsx`, `account-menu.tsx`, `tasks.tsx`,
  `habits.tsx`, `links.tsx`, `settings.tsx`, `planner.tsx`,
  `planner-now.tsx`, `week.tsx`, `alerts.tsx`, the nine dialog files
  (CMP-55), `src/web/views/event-menu.tsx` (new),
  `src/web/lib/toast.ts` (new, CSS-only path) or the Sonner wiring,
  `src/web/lib/presence.ts` (new: keeps a closing overlay mounted for
  its exit), `src/web/styles.css`, `src/web/views/parts.css`,
  `tests/e2e/motion.spec.ts` (new), `tests/e2e/README.md`,
  `docs/performance.md`.
- Acceptance: 10.1; MOB-13 done; `motion.spec.ts` passes; the TST-12
  totals for the four pull requests are within budget.
- Commit order: navigation; lists and pages; pagination and P2 fixes;
  dialog focus; exits; event menu; toasts; drag; motion spec; docs.
- Risks: this pull request has many parts. Dialog focus can break a test
  that works behind an open dialog. The event menu and keyboard access
  add new names (TST-9).

## 11. Open risks

1. Base UI and Sonner support React, not Preact. Their peer dependencies
   list React 18 or 19. The spikes (LIB-3, LIB-4) decide; the fallback is
   ready in both cases.
2. At 1440 px, some E2E tests can depend on the third overlap column
   (2.4). At narrower widths the same data folds into "+N". The suite
   does not cover that.
3. When preview mode has staged changes, the toolbar at 1440 px holds one
   row only because the preview sentence and the week title shrink
   (LAY-14). A longer label or date format makes it wrap, which moves
   the week down.
4. The cold-load budget (TST-12) has little room. The tokens, the dark
   set and the layout add CSS. Remove the old rules in the same pull
   request.
5. Mobile behavior needs real phones (MOB-13). Emulation does not show
   the problems of section 6.
6. Dark-mode category colors pass the computed contrast (3.4). Check them
   on a real screen.
7. The replan glide is the largest motion. Its feel (250 ms over up to 4
   columns, the size snap before the glide) needs a second look on the
   next day.
8. One-line notices hide most of their text. "Show full text" is one
   click away. Watch for users who miss a notice.
9. The right column is long: the open panel and then the overview. The
   tests need every part in the DOM, so the overview cannot hide.
10. Weekends are Saturday and Sunday. Users with other off days get no
    flat column. Work hours per day would need a new request.
11. PR 3 and PR 4 are large. Review them commit by commit, in the commit
    order of 10.4 and 10.5.
