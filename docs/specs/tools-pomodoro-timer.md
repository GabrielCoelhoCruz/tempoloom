# Pomodoro timer

Spec id: SPEC-TOOLS-01
Evidence: E-0016 (ev_1953d09b4745), E-0115 (ev_3b88c377e0e8)
Status of evidence: public docs only

## Summary

A free, public timer page for focused work in fixed intervals with breaks.
The user runs a 25-minute work session, then a short break, and a long
break after every fourth session. A small task list sits next to the timer.
The page counts sessions and shows simple focus stats. In the reference,
the timer is a separate public web tool, not part of the planner. Users
paste its link into the description of focus time, task or habit events.

## Concepts and inputs

### Phases

| Phase | Default length | Setting |
|---|---|---|
| Work session ("pomodoro") | 25 minutes | `work_minutes` |
| Short break | 5 minutes | `short_break_minutes` |
| Long break | 15 minutes | `long_break_minutes` |
| Sessions before a long break | 4 | fixed (see open question 3) |

### Settings

| Field | Type | Default | Allowed |
|---|---|---|---|
| `work_minutes` | integer | 25 | 1 to 180 (proposal) |
| `short_break_minutes` | integer | 5 | 1 to 60 (proposal) |
| `long_break_minutes` | integer | 15 | 1 to 120 (proposal) |
| `auto_start_next` | boolean | false (proposal) | |
| `alarm_sound` | enum of sound ids | first sound in the list | At least 3 sounds (proposal). |
| `play_sound` | boolean | true | |
| `background_audio` | boolean | false | |
| `background_track` | enum of track ids | first track | At least 2 ambient tracks (proposal). |

### Task list item

| Field | Type | Default |
|---|---|---|
| `text` | text | required |
| `done` | boolean | false |
| `done_at` | timestamp | empty |

### Storage

No account is needed. Proposed: the page keeps settings, tasks and session
history in browser local storage on that device.

## Behavior

### Layout

1. The top bar shows four counters: today, week, month, streak. They start
   at 0. It also has buttons for stats, settings and a menu.
2. The timer area has three tabs: work session (selected by default), short
   break, long break.
3. The timer shows minutes and seconds (for example "25 00"), a line
   "sessions to long break n/4", a progress bar, a Start button and a Reset
   button.
4. The task area has a text box, an "Add task" button, and the task list.

### Timer

5. Start begins the countdown of the selected phase.
6. The browser tab title shows the remaining time while a phase runs.
7. Reset stops the countdown and sets the current phase back to its full
   length. A reset of a running work session counts as a started session
   that was not completed.
8. The user can switch phases at any time with the tabs. Switching sets the
   timer to the full length of the chosen phase.
9. When a work session reaches 0: the alarm plays (if `play_sound`), the
   session counts as completed, and the timer moves to the next phase. The
   next phase is a long break after every fourth completed session;
   otherwise a short break.
10. When a break reaches 0: the alarm plays (if `play_sound`) and the timer
    moves to a work session. After a long break, "sessions to long break"
    resets to 0/4.
11. With `auto_start_next` on, the next phase starts counting at once. With
    it off, the next phase waits for Start.
12. Pause: see open question 1. Proposed: the Start button becomes Pause
    while running; Pause keeps the remaining time.
13. A mini window action opens a small always-visible timer (browser
    picture-in-picture where supported).
14. With `background_audio` on, the chosen track plays during work sessions
    (proposal: work sessions only).

### Tasks

15. Typing text and selecting "Add task" adds an item to the end of the
    list. Empty text adds nothing.
16. Checking an item marks it done and records `done_at`.

### Stats

17. The stats view shows:
    - completed sessions today, this week, this month;
    - work-session time today (hours and minutes);
    - average work-session time per day over the last 30 days;
    - tasks checked off today;
    - a focus hours chart by day, week or month;
    - streak: the number of days in a row, up to today, with at least one
      completed session;
    - average completed sessions per day over the last 30 days;
    - average work-session length;
    - completion rate: completed sessions divided by started sessions, last
      30 days;
    - breaks today and break minutes today.
18. A completed break counts toward breaks today. Proposed: a break counts
    only when its countdown reaches 0.

### Link from managed events

19. The timer page has a stable public URL on the Tempoloom instance
    (proposed `/tools/pomodoro`). A user can paste it into the description
    template of a focus time, task or habit automation. Every managed event
    from that automation then carries the link. Markdown link text works
    where event descriptions support markdown (`planning-event-content.md`).

## Outputs

- Timer page state, sounds, tab title.
- Stats view.
- No calendar events change, except that managed events carry the link
  when the user adds it to a description template.

## Edge cases

1. The tab is in the background: the countdown must stay accurate. Compute
   from the start time, not from timer ticks.
2. The device sleeps during a session: on wake, if the end time passed, the
   session counts as completed at its end time, and the alarm plays once.
3. The user changes `work_minutes` during a running session: proposed, the
   change applies from the next session.
4. Midnight passes during a session: the session counts on the day it
   ended (proposal).
5. Week boundary for "this week": proposed, the browser locale's first day
   of week.
6. Local storage is cleared: all history and tasks are lost; counters show
   0.

## Observed API shapes

Not yet observed. Not applicable: the reference timer runs in the browser.

## Open questions

1. Is there a pause? The capture shows only Start and Reset.
2. Is `auto_start_next` off by default? The legacy help says the timer
   moves to the break by itself; it is not clear if the break starts
   counting.
3. Can the user change the number of sessions before a long break?
4. Which sounds and tracks exist?
5. Does the reference store history only in the browser?
6. Should Tempoloom put the timer inside the planner (for example a timer
   on the current focus event)? The reference keeps it separate.

## Acceptance tests

Common setup: a browser with a controllable clock (test harness) and the
timer page open. A Google test account U for T5.

### T1. Default cycle

- Setup: common setup, defaults.
- Action: select Start; advance the clock 25 minutes.
- Expected calendar state: not applicable (no calendar access).
- Reload check: the alarm played once, the timer shows the short break at
  "05 00", today counter = 1, sessions to long break = 1/4. After a page
  reload, today counter is still 1.

### T2. Long break after four sessions

- Setup: common setup, `auto_start_next = true`.
- Action: select Start; advance the clock through 4 work sessions and 3
  short breaks (4 × 25 + 3 × 5 = 115 minutes).
- Expected calendar state: not applicable.
- Reload check: the timer shows the long break running from "15 00".
  After reload, today counter = 4.

### T3. Reset counts toward completion rate

- Setup: common setup, empty history.
- Action: complete one session; start a second and select Reset after 10
  minutes.
- Expected calendar state: not applicable.
- Reload check: after reload, completion rate shows 50 percent and today
  counter shows 1.

### T4. Tasks

- Setup: common setup.
- Action: add "Draft intro" and "Fix chart"; check "Draft intro".
- Expected calendar state: not applicable.
- Reload check: after reload, both tasks are listed, "Draft intro" is done,
  and tasks checked off today = 1.

### T5. Link in managed events

- Setup: U has a focus time automation.
- Action: U adds the timer URL to the focus automation's description
  template and saves.
- Expected calendar state: each focus managed event on U's Google calendar
  has the timer URL in its description.
- Reload check: after refreshing Google Calendar, the link is still present
  and opens the timer page.
