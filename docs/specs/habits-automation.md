# Habits

Spec id: SPEC-HABITS-01
Evidence: E-0081 (ev_dfcc5d3b7c8c), E-0082 (ev_908de7baa80e), E-0004 (ev_8959a94c0b12), E-0181 (ev_4f6cc83d5d58), E-0072 (ev_b8e011b22c94), E-0130 (ev_9c04afccf625), E-0142 (ev_8d542e73bb87), E-0196 (ev_96353e46340f), E-0048 (ev_55efef88be5e), E-0083 (ev_fd7912136937), E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83), E-0089 (ev_e7262cc4064c), E-0085 (ev_afb3719f0f6f), E-0045 (ev_b090cc25cd53), E-0108 (ev_42940293d611), E-0172 (ev_d2989bf32eaf)
Status of evidence: public docs only

## Summary

A habit is an automation for a recurring routine, such as lunch or weekly
planning. The user gives a window of days and hours, an ideal time, and a
duration range. Tempoloom places one managed event per occurrence, keeps it
near the ideal time, and moves or shortens it when the calendar changes. The
event shows as free while other good slots exist and switches to busy when
the routine is at risk.

## Concepts and inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `title` | string | none (required) | 1 to 255 characters. May contain emoji. See `events-title-emoji.md`. |
| `enabled` | bool | `true` | A new habit starts enabled (observed, E-0072). |
| `priority` | P1 to P4 | Proposed default: P3 | See glossary "Priority". |
| `rank` | int | end of its priority group | Order inside one priority group in the automation list (E-0043, E-0141). |
| `category` | `work` or `personal` | `work` | Drives stats and focus-goal counting. |
| `color` | event color id or `category` | `category` | One of the 12 calendar event colors, or follow the color rule. See `events-categories-and-colors.md`. |
| `hours` | hours set id or one-off window | work hours if `category=work`, personal hours if `personal` (Proposed default) | The days and time ranges where the habit may be placed. A one-off window is a set of weekday time ranges that belongs to this habit only (E-0172). |
| `ideal_time` | local time (HH:MM) | Proposed default: start of the first range of `hours` | Must fall inside `hours` on at least one allowed day. Save fails otherwise (E-0082). |
| `duration_max` | minutes | Proposed default: 60 | The ideal length. 15 to 720, step 15 (Proposed range). |
| `duration_min` | minutes | equal to `duration_max` | The shortest length Tempoloom may use on a busy day. 15 to `duration_max`, step 15 (Proposed range). |
| `frequency` | object | daily | See "Frequency" below. |
| `ideal_days` | set of weekdays | all days of `hours` | Used by weekly frequency. |
| `starting` | date or `asap` | `asap` | First date that may hold an occurrence (E-0082). Also used to snooze (E-0072). |
| `when_unplaceable` | `keep_as_conflict` or `remove` | Proposed default: `keep_as_conflict` | What to do when an occurrence has no legal slot (E-0082, E-0081). |
| `notes` | markdown | empty | Copied into the description of each habit event (E-0082). |
| `visibility` | `calendar_default`, `public`, `private` | `calendar_default` | `private` shows only "Busy" to others. Current default follows the primary calendar's default visibility (E-0081). |
| `defense_mode` | `always-free`, `adaptive`, `always-busy` | `adaptive` | Same enum as `planning-defense.md`. The current form shows it as a "busy or free" choice plus smart defense (E-0081); the legacy form shows three modes (E-0196). |
| `target_calendar` | calendar id | primary calendar | Any writable connected calendar. Can be set only at creation (E-0082). |
| `guests` | list of email | empty | Added as attendees. Tempoloom does not check their availability and does not notify them (E-0082). |
| `avoid_duplicate_keywords` | list of string | empty | Words that mean "the routine already happens today" (E-0082). |
| `auto_decline` | object | off | `{enabled: bool, message: string or default}`. Declines invitations that overlap the habit while it is busy (E-0082). |
| `reminders` | list of minutes before start, or off | calendar default | Event notifications (E-0043). |
| `location` | string | empty | Copied to each event (marketing evidence, E-0004). |
| `task_filter` | task filter or none | none | Tasks to show while the habit runs (E-0081). |
| `dependencies` | list | empty | Order rules relative to other habits and flexible meetings (legacy evidence, E-0082). |

Defense modes (E-0196, E-0081):

| `defense_mode` | Legacy label | Current form | Status | Length versus time trade-off |
|---|---|---|---|---|
| `always-free` | most flexible | free, smart defense off | always free | Prefer the ideal time over the full length. |
| `adaptive` (default) | system decides | free, smart defense on | free, then busy when at risk | Decided by priority and free time. |
| `always-busy` | most defensive | busy | always busy | Prefer the full length over the ideal time. |

### Frequency

| `frequency.period` | Extra fields | Meaning |
|---|---|---|
| `daily` | none | One occurrence on every day that `hours` allows. |
| `weekly` | `ideal_days` | One occurrence on each ideal day. |
| `monthly` | `day_of_month` (1 to 31) or `nth_weekday` (`{n: 1..5 or last, weekday}`) | One occurrence per month, for example the 15th, or the 2nd Friday. |
| `custom` | `interval` (int ≥ 1), `unit` (`day`, `week`, `month`), plus the fields of that unit | Every N days, weeks or months. |

Frequency values are observed (E-0082, legacy evidence). The current help page
names the same idea as "can move within" days and hours (E-0081).

Tempoloom decision: `day_of_month` 29 to 31 in a shorter month selects the
month's last day. `nth_weekday` with `n=5` selects nothing in a month without
a fifth such weekday; `last` always selects the month's last such weekday.

## Behavior

### Creation and editing

1. The user can create a habit from a blank form, from a template in the automation library, from the top-bar "create" button, or through the assistant chat (E-0081, E-0043).
2. Saving a new or edited habit stages the events it would add, move or remove in preview mode (`assistant-preview-mode.md`). Tempoloom writes no event until the user applies the staged changes. Discarding them writes nothing (E-0081, E-0043).
3. Saving a habit with `ideal_time` outside every range of `hours` fails with a field error.
4. Saving a habit with `duration_min > duration_max` fails with a field error.
5. The user can edit any field except `target_calendar` at any time. Edits apply to future occurrences only. Past events do not change.
6. The user can open the habit editor from a habit event in the planner and from the automation list (E-0082).
7. The automation list has a search box that filters habits by title (legacy evidence, E-0082).
8. The user can turn a recurring external event into a habit from the planner ("make a habit"). The form opens pre-filled with the series title, length, weekdays and start time as `ideal_time`. This works only when the user is the only attendee. For a series with other attendees, the planner offers a flexible meeting instead (E-0081).
   Tempoloom decision: the planner's details panel of a recurring event has a "Make a habit" button when no attendee other than the user's own addresses is on the event. It opens the habit editor with the title, the start time as `ideal_time`, the length rounded up to the next 15 minutes as both `duration_min` and `duration_max`, and the weekdays of the series' occurrences that Tempoloom has read. Saving creates an ordinary habit. The original series stays as it is (edge case 8). For a series with other attendees, the panel says so and links to flexible meetings.

### Placement

9. For each date in the scheduling window that the frequency selects, and on or after `starting`, Tempoloom tries to place exactly one occurrence.
10. An occurrence must start and end inside one time range of `hours` on its day, in the user's active time zone (see `timezones-home-and-travel.md`).
11. An occurrence length is between `duration_min` and `duration_max`, in 15-minute steps (Proposed step).
12. Tempoloom places the occurrence so that its start is nearest to `ideal_time` (E-0082, E-0081). On a tie, the earlier start wins (Proposed).
13. When the full length does not fit near the ideal time, the defense mode decides the trade-off:
    - `always-free`: keep the start nearest the ideal time and shorten toward `duration_min`.
    - `always-busy`: keep the full length and move the start further from the ideal time.
    - `adaptive`: Proposed default: act as `always-free` while the occurrence is free and as `always-busy` once it is busy.
14. For a weekly habit, when an ideal day has no legal slot, Tempoloom may move that occurrence to another day of the same week that `hours` allows and that holds no other occurrence of this habit (E-0081 "move within days"; legacy E-0130 "another day").
15. For a daily habit, an occurrence never moves to another day. Proposed: a monthly or custom habit may move up to 6 days later within the same period (open question 3).
    Tempoloom decision: a monthly occurrence moves only to later days of the same month, at most 6 days after its date, and only to days that `hours` allows.
16. When the user lists `avoid_duplicate_keywords`, Tempoloom skips the occurrence on a day where an external event overlaps the habit's window on that day and its title contains one of the keywords (case-insensitive substring match). Managed events never count for this check (E-0082).
17. When no legal slot exists, `when_unplaceable` applies:
    - `keep_as_conflict`: Tempoloom keeps or creates the event at the best slot inside the window, even though it overlaps another event, and prefixes the title with "⚠️" (E-0082).
    - `remove`: Tempoloom deletes the occurrence from the calendar and shows it as unplaced in the planner (E-0082, E-0081).
18. Dependencies (legacy evidence, E-0082): a habit may require that it comes before, or never after, another habit or a flexible meeting on the same day, or that it never shares a day with another habit. Tempoloom treats each dependency as a hard placement constraint.

### Defense (free or busy)

19. With `always-busy`, the occurrence is always busy (E-0196).
20. With `always-free`, the occurrence is always free, unless it is locked (E-0196).
21. With `adaptive`, a new occurrence starts free (E-0196, E-0181).
22. With `adaptive`, the occurrence switches to busy when it is at risk. Two inputs decide this (E-0196): the free time that remains in the habit's window, and the time left before the occurrence starts. The evidence also says the habit's priority plays a part (E-0196). The formula is `planning-defense.md` DEF-20 to DEF-23; this spec adds no other threshold.
23. Proposed: once an `adaptive` occurrence is busy, it stays busy until it ends, unless the user changes `defense_mode` or the occurrence moves to another day.
24. A locked occurrence is always busy (E-0089, E-0085).
25. The planner draws a free occurrence with a dotted border and a busy one with a solid fill (E-0081, E-0089).

### Actions on one occurrence

26. Lock: the occurrence stops moving and shows as busy. Unlock returns it to automatic placement, and Tempoloom may move it in the next run (E-0181, E-0081).
27. Moving an occurrence by drag in the planner or by changing its time in Google Calendar locks it at the new time (E-0081, E-0130, E-0181). Lock rules: `planning-locks.md`.
28. Skip: Tempoloom removes the occurrence and places no replacement for that date (E-0081, E-0130).
29. Deleting the event in Google Calendar asks for another time. Tempoloom places the occurrence again at another legal slot, never at the deleted slot. If that day has no other slot, rule 14 applies (E-0081, E-0130). To drop the occurrence, the user uses Skip.
30. Reschedule: the user picks a target time. Tempoloom places the occurrence at the legal slot nearest to that time on the same day (E-0130, E-0181).
    Tempoloom decision: the user picks a time of day in the planner's details panel. The chosen time replaces `ideal_time` for that one date, so later runs keep the occurrence there while the slot stays legal; a tie goes to the earlier start. Rescheduling a locked occurrence unlocks it. Other dates do not change.
31. Snooze: the user picks a "not before" time. Tempoloom places the occurrence at the first legal slot at or after that time on the same day (E-0181). Proposed snooze choices: 15 minutes, 30 minutes, 1 hour, 2 hours, later today.
32. Log work: on a past date, the user drags or clicks a time range, picks a habit, and confirms. Tempoloom records the time against the habit and writes a past event for it (legacy evidence, E-0082, E-0130).
33. Start mode (legacy evidence, E-0048). A user-level setting chooses one of:
    - Start when placed (default): an occurrence counts as done when its end passes.
    - Start manually: an occurrence counts as not started until the user presses Start. Pressing Start at time T moves the event start to T. If the user does not press Start before the end, Tempoloom re-places the occurrence at the next legal slot later the same day.

### Lifecycle

34. Disable: Tempoloom stops placing the habit and deletes all its future events. Past events stay. Enable resumes placement (E-0072, E-0043).
35. Snooze the habit: the user sets `starting` to a future date. Tempoloom deletes the habit's future events before that date and resumes on that date (E-0072).
36. Delete: the user confirms in a dialog. Tempoloom deletes the habit and all its future events. Past events stay. A deleted habit cannot be restored (E-0072).

### Auto-decline

37. When `auto_decline.enabled=true`, Tempoloom declines an external invitation whose time overlaps a busy occurrence of this habit. It sends the default message or the custom message as the decline note (E-0082).
38. Tempoloom never auto-declines while the overlapped occurrence is free.
39. The settings form warns that this sends declines to other people.

### Task filter

40. A habit can carry a task filter. While an occurrence runs, the planner and "next up" show only the tasks that match the filter. Filters are per habit (E-0081, E-0077).

### Scheduler interaction

These rules tell `planning-scheduler.md` how habits take part in each run. They agree with `planning-priorities.md` (PRI-1 to PRI-22) and `planning-defense.md`.

41. Inputs: each enabled habit adds one placement request per selected date, with its window, length range, ideal start, priority and rank.
42. Order: the scheduler handles flexible items by priority, P1 first. Inside one priority, it uses the automation `rank` (E-0043, E-0141). Legacy order inside one priority was flexible meetings, then habits, then tasks (E-0142, E-0090). Whether tasks share the rank list with automations is open (open question 1).
43. A habit may take time from a managed event of lower priority (task chunk, other habit, flexible meeting, buffer, focus event). That event then moves by its own rules (E-0142, E-0141).
44. A habit never takes time from: an external event, at any priority; a booking-link meeting; a locked event; a time block with `#tl_busy` (E-0142, E-0141, E-0104, E-0161).
45. A habit treats a busy external event that has `#tl_free` as free time (see `events-tags.md`).
46. All habits are placed before focus events, whatever their priority (E-0078, E-0077).
47. A habit with `category=work` counts toward the focus goal (see `focus-time.md`).
48. A habit respects the break buffer gap to adjacent task and habit events (see `buffers-breaks.md`).
49. The scheduler moves an unlocked occurrence when a higher-priority item or a new external event needs its time, when the user changes habit fields, or when hours change. It never moves a locked or past occurrence.
50. When an occurrence cannot be placed, the scheduler reports it to the planner as unplaced, with the reason "no room in window", and applies rule 17.

## Outputs

- One Google Calendar event per occurrence on `target_calendar`.
  - Title: `<state marker> <title>`, for example `🆓 🍱 Lunch` when free, `🛡️ 🍱 Lunch` when busy, `🔒 🍱 Lunch` when locked, `⚠️ 🍱 Lunch` when kept as a conflict, and `✅ 🍱 Lunch` after a done occurrence ends (E-0085, E-0082). Marker rules are in `events-title-emoji.md`.
  - Transparency: `transparent` when free, `opaque` when busy or locked.
  - Description: `notes` rendered as markdown, plus the standard managed-event footer with a link to the planner (format owned by `planning-event-content.md`).
  - Visibility: from `visibility`.
  - Color: from `color` or the category color rule.
  - Attendees: `guests`, written without sending notifications.
  - Location and reminders from the habit.
- Planner: the habit appears in the automation sidebar, in its priority group and rank. Each occurrence shows its state. Unplaced occurrences show in a list with the reason.
- Tempoloom decision for the done marker: with the default start mode, an occurrence is done when its end passes. The next run writes the done marker in place of the state marker; the lock and conflict states end with the occurrence. An occurrence that the user moved to a time that has passed is done for its date, and no other occurrence is placed for that date. Occurrences that ended more than 7 days before the run keep their title. The planner's details panel shows "Done" on an ended occurrence.
- Decline responses with a note, when auto-decline is on.

## Edge cases

1. The window is shorter than `duration_min` on a day: the day gets no occurrence and the planner shows "no room in window".
2. `ideal_time` is inside `hours` on some allowed days only: placement uses the nearest legal start on the other days.
3. The user moves an occurrence outside the window in Google Calendar: Tempoloom keeps it there, locked, and does not count it as a rule violation.
4. The user deletes a locked occurrence: it unlocks and rule 29 applies (E-0045 says delete unlocks).
5. A habit event on a calendar that the user later removes from Tempoloom: Proposed: the habit is disabled and the planner shows an error.
6. Two habits with the same priority and an equal claim on one slot: the higher-ranked habit wins (E-0043).
7. An all-day busy event or out-of-office event covers the whole window: no occurrence that day. See `events-out-of-office.md`.
8. A recurring external series converted to a habit: the original series stays unchanged until the user deletes it (Proposed, open question 6).
9. `avoid_duplicate_keywords` matches an event outside the habit window on the same day: no effect (E-0082).
10. The user changes the habit's `hours` so a locked occurrence is now outside it: the locked occurrence stays.

## Observed API shapes

Not yet observed.

## Open questions

1. In the current version, do tasks share the same priority-and-rank list as automations, and how are tasks ordered against habits of equal priority?
2. What is the exact free-to-busy switch formula, and how does priority change it? The public docs give only the two inputs (see `planning-defense.md` open question 1).
3. Can a monthly or custom habit move to another day? How far?
4. Is there an "N times per week" frequency, with free choice of days? Marketing text implies it; the help docs do not show it.
5. Is there an end date or occurrence count for a habit?
6. What happens to the original recurring event after "make a habit"?
7. Does a deleted occurrence move to another day, or only to another time on the same day? Current and legacy pages differ in detail.
8. Does the avoid-duplicates check read descriptions as well as titles?
9. Where does the task filter list show: planner card, next up, notifications?
10. What are the snooze and reschedule choices in the current planner?
11. Are dependencies present in the current version?
12. Team admins can recommend habit templates to new members (E-0170, E-0004). The template model is in `teams-settings-templates.md`. Can a team template lock any habit field?

## Acceptance tests

Common setup for all scenarios: a Google Calendar test account connected to
Tempoloom. Home time zone America/New_York. Work hours Monday to Friday
09:00 to 17:00. Scheduling window 2 weeks. No other managed items. Test week
starts on a Monday at least 2 days in the future.

1. **Create a lunch habit.**
   Setup: empty calendar.
   Action: create habit "Lunch", hours one-off window Monday to Friday 11:30 to 14:00, ideal time 12:00, duration 30 to 60 minutes, P3, default defense. Apply the staged changes in preview mode.
   Expected: for each weekday in the window, one event "🆓 Lunch" from 12:00 to 13:00, transparent.
   Reload: reload the planner and re-read Google Calendar. The same events exist with the same ids. No duplicates.

2. **Move within the window when blocked.**
   Setup: scenario 1 done.
   Action: in Google Calendar, create an external busy event Wednesday 11:30 to 13:00.
   Expected: within 60 seconds, Wednesday's lunch moves to 13:00 to 14:00. It is the only legal slot, so its title is "🛡️ Lunch" and it is opaque.
   Reload: reload the planner. Wednesday shows the moved event. Other days are unchanged.

3. **No room: keep as conflict.**
   Setup: scenario 1 done, `when_unplaceable=keep_as_conflict`.
   Action: create an external busy event Thursday 11:00 to 14:30.
   Expected: Thursday's lunch stays in the window, overlaps the meeting, and has title "⚠️ Lunch". The planner lists it as unplaced with "no room in window".
   Reload: the conflict marker and planner message persist.

4. **No room: remove.**
   Setup: as scenario 3 but `when_unplaceable=remove`.
   Action: same as scenario 3.
   Expected: Thursday has no lunch event. The planner lists the occurrence as unplaced.
   Reload: Thursday still has no lunch event.

5. **Drag locks the occurrence.**
   Setup: scenario 1 done.
   Action: in Google Calendar, move Tuesday's lunch to 13:30 to 14:30. Then create an external busy event Tuesday 13:30 to 14:00.
   Expected: Tuesday's lunch stays at 13:30 to 14:30, title "🔒 Lunch", opaque. It overlaps the new meeting.
   Reload: the event is still locked and in place. In the planner, unlock it. Expected: within 60 seconds it moves to a free slot in the window.

6. **Skip versus delete.**
   Setup: scenario 1 done.
   Action A: in the planner, Skip Monday's lunch. Action B: in Google Calendar, delete Friday's lunch.
   Expected: Monday has no lunch event and no replacement. Friday gets a new lunch event at a different slot than the deleted one.
   Reload: Monday stays empty. Friday's new event persists.

7. **External events are never overbooked.**
   Setup: habit "Deep work" P1, hours one-off window Monday 09:00 to 11:00, duration 120 to 120 minutes, most defensive, `when_unplaceable=remove`. The Monday occurrence is placed 09:00 to 11:00.
   Action: create an external busy event Monday 09:00 to 10:00.
   Expected: within 60 seconds, the Monday occurrence is removed and listed as unplaced. The external event keeps its time, title and transparency.
   Reload: the external event is unchanged and Monday has no "Deep work" event.

8. **Priority and rank.**
   Setup: habits "A" P1 and "B" P2, both Monday 10:00 to 11:00, duration 60 minutes, `remove` when unplaceable.
   Action: save both.
   Expected: "A" holds 10:00 to 11:00. "B" is unplaced. Then set both to P1 with "B" ranked above "A". Expected: "B" holds the slot and "A" is unplaced.
   Reload: the final placement persists.

9. **Disable, enable and delete.**
   Setup: scenario 1 done and at least one past lunch event exists (run the test across one past day, or log work on yesterday).
   Action: disable the habit. Then enable it. Then delete it and confirm.
   Expected: after disable, no future lunch events; past events stay. After enable, future events return. After delete, no future events; past events stay; the habit is gone from the list.
   Reload: the state after each step persists.

10. **Avoid duplicates.**
    Setup: scenario 1 habit with keyword "lunch".
    Action: create an external event "Team lunch" Wednesday 12:30 to 13:30.
    Expected: Wednesday has no habit lunch event. Other days are unchanged.
    Reload: Wednesday stays without a habit event.

11. **Snooze the habit.**
    Setup: scenario 1 done.
    Action: set `starting` to the Thursday of the test week.
    Expected: Monday to Wednesday have no lunch events. Thursday onward has them.
    Reload: the same.
