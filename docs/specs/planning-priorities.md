# Priorities

Spec id: SPEC-PLANNING-04
Evidence: E-0068 (ev_6d15ce331135), E-0077 (ev_38c8b46b5b57), E-0083 (ev_fd7912136937), E-0088 (ev_4fa475edc582), E-0090 (ev_4a54fa9f235a), E-0104 (ev_173e10d4937f), E-0108 (ev_42940293d611), E-0120 (ev_796e1e3fe2ef), E-0139 (ev_28aa8ef849b8), E-0141 (ev_d12320a15a83), E-0142 (ev_8d542e73bb87), E-0043 (ev_d7b30359b03e), E-0051 (ev_936bc1052a22), E-0176 (ev_eba8295888d0), E-0200 (ev_cd6d6a5e88d5), E-0209 (ev_28b6d44e4b68), E-0212 (ev_7a9bb324e265), E-0226 (ev_0dc4ddadd24f)
Status of evidence: public docs only

## Summary

Every managed item and every external event has a priority from P1 (critical)
to P4 (low). The scheduler gives time to higher-priority items first, and a
higher-priority managed item can take the time of a lower-priority managed
item, which then moves. External events and booking-link meetings are never
taken by managed items. The user sets priorities on each item, in a
priorities page, and by ranking items inside a level.

## Concepts and inputs

| Level | Name | Meaning |
|---|---|---|
| P1 | critical | Gets time first. Can take time from P2 to P4 managed items. |
| P2 | high | Before P3 and P4. Gives way to P1. |
| P3 | medium | Before P4. Gives way to P1 and P2. |
| P4 | low | Placed last, in the time that is left. Gives way to all others. |

Items with a priority (E-0090, E-0141):

| Item | Default priority | Notes |
|---|---|---|
| Task | P2 | user default, `planning-tasks.md` |
| Habit | Proposed default: P3 | set per habit; habit spec |
| Flexible meeting | Proposed default: P2 | set per meeting; flexible meeting spec |
| Buffer | Proposed default: P3 | set per buffer automation; buffer spec |
| Focus time | fixed | placed as P4 after all others; placed events act as P2 (PRI-20) |
| Booking link | Proposed default: P2 | controls offered availability; booking link spec |
| External event | P1 | the user can lower it on the primary calendar (PRI-30) |

Stack rank: inside one priority level, each habit, flexible meeting, buffer
automation and focus time automation has a rank. Rank 1 is first (E-0141,
E-0043).

Task urgency mode (user setting, legacy evidence, E-0068):

| Value | Effect |
|---|---|
| `priority-only` | Due date and remaining work have little effect beyond priority. |
| `due-date` | Due date has a strong effect; remaining work has little effect. |
| `due-date-and-work` (default) | Both due date and remaining work have a strong effect. |

## Behavior

### Ordering

- **PRI-1.** The scheduler gives time to items in priority order, P1 first
  (E-0141, E-0090).
- **PRI-2.** Current reference: inside one level, the item with the better
  stack rank gets time first. Example: two P1 habits, "Lunch" ranked above
  "Planning", compete for one slot; "Lunch" gets it (E-0141, E-0043, E-0176).
- **PRI-3.** Legacy reference: inside one level, flexible meetings go first,
  then habits, then tasks (legacy evidence, E-0088, E-0090, E-0142, E-0209).
  Rule PRI-2 and PRI-3 combine in `planning-scheduler.md`, section
  "Processing order".
- **PRI-4.** Tasks of the same level go in order of due date, soonest first
  (legacy evidence, E-0090, E-0209). Example: P1 due Friday; P2 due Tuesday;
  P2 due Thursday; P2 due Friday; P3 due Thursday.
- **PRI-5.** With urgency mode `due-date` or `due-date-and-work`, a task with
  a near due date (and much remaining work, in the second mode) can go before
  a task of a higher level that is due later (legacy evidence, E-0068, E-0088,
  E-0090). The scheduler may raise an item's priority internally so that
  low-priority items do not wait forever (legacy evidence, E-0209). The exact
  rule is a proposal in `planning-scheduler.md`, section "Effective priority".
- **PRI-6.** Tasks in the next-up queue go before all other tasks; see
  `planning-next-up.md` (legacy evidence, E-0209, E-0212).

### Taking time (overbooking)

- **PRI-10.** If a managed item wants a slot held by an unlocked managed
  item of a lower level, the scheduler gives the slot to the higher item and
  moves the lower item to another time inside its rules (E-0141, E-0088).
- **PRI-11.** A managed item never takes the time of an external event, at
  any priority of either one (E-0141, E-0104, E-0209, E-0142).
- **PRI-12.** A managed item never takes the time of a meeting booked through
  a booking link, at any priority (E-0141, E-0090).
- **PRI-13.** A locked managed item never moves, whatever the priority of the
  item that needs its time (E-0209, E-0108; `planning-locks.md`).
- **PRI-14.** The free or busy status of a managed event has no effect on
  rule PRI-10. A busy chunk moves the same as a free chunk (legacy evidence,
  E-0120).

### Focus time

- **PRI-20.** The scheduler places focus time after all habits, tasks,
  flexible meetings and buffers, at any of their priorities. Focus time
  automations are fixed at P4 for this purpose (E-0077, E-0141, E-0090,
  E-0200).
- **PRI-21.** After placement, a focus time event counts as P2 for booking
  links: only a P1 booking link offers its time (E-0077, E-0141).
- **PRI-22.** Work tasks and work habits count toward the weekly focus time
  goal (legacy evidence, E-0090, E-0083). Focus time spec owns the goal rules.

### Booking links and priority

- **PRI-30.** A booking link of level L offers as available the time of
  managed events with a level lower than L, and of external events whose
  level the user lowered below L (E-0141, E-0088, E-0090).
- **PRI-31.** When an invitee books such a time, the scheduler moves the
  managed item that held it (E-0141, E-0088).
- **PRI-32.** Proposed default: a booking link never offers the time of a
  locked managed event.
- **PRI-33.** Booking link details: booking link spec.

### External event priority

`events-external-priority.md` owns the priority of external events. This
section restates its rules for the engine; if the two differ, that spec wins.


- **PRI-40.** Every external event starts at P1 (E-0141, E-0104, E-0088).
- **PRI-41.** The user can lower the level of an external event from its
  detail panel in the planner. For a recurring event, Tempoloom asks whether
  the change applies to this event or to all events in the series (legacy
  evidence, E-0104).
- **PRI-42.** Only events on the primary calendar can change level. Events
  from calendar mirroring and from other connected calendars stay P1 (legacy
  evidence, E-0104).
- **PRI-43.** A lowered external event affects only booking links (PRI-30).
  Habits, tasks, flexible meetings, buffers and focus time still treat it as
  untouchable (E-0141, E-0104).
- **PRI-44.** When two external events overlap, Tempoloom moves neither. It
  reports the overlap as an issue with a suggested fix (E-0141).
- **PRI-45.** Proposed default: the level of an external event is stored in
  Tempoloom only. Tempoloom does not change the Google event, so attendees
  get no notice.

### Setting priorities

- **PRI-50.** The user sets the level on the create and edit form of each
  item (E-0141, E-0209, E-0142).
- **PRI-51.** A priorities page shows four columns, P1 to P4. The user drags
  an item to another column, or opens a level menu on the item, to change its
  level (legacy evidence, E-0090, E-0200).
- **PRI-52.** The priorities page can filter by item kind and by hours set,
  and the user can set the column width (legacy evidence, E-0090).
- **PRI-53.** The planner side panel has a priorities view: items grouped by
  level and then by kind, with the same level menu and drag and drop, a
  search box and an edit button (legacy evidence, E-0090, E-0139).
- **PRI-54.** The automation list in the planner groups automations by level,
  P1 at the top. The user drags an automation to another level or to another
  rank in its level, and can filter the list by kind (E-0141, E-0043).
- **PRI-55.** In the Google Calendar add-on, the user can change the level of
  tasks and habits only. Flexible meetings, booking links and external events
  change level only in Tempoloom (legacy evidence, E-0090).

### Priority from task integrations (legacy evidence, E-0209)

| Source app | Source values | Tempoloom level |
|---|---|---|
| ClickUp | Urgent, High, Normal, Low | P1, P2, P3, P4 |
| Asana | High, Medium, Low | P1, P2, P3 |
| Asana | Custom | the user picks a level when the task is created |
| Todoist | Priority 1, 2, 3, 4 (as shown in Todoist) | P1, P2, P3, P4 |
| Linear | Urgent, High, Medium, Low | P1, P2, P3, P4 |
| Jira | Highest, High, Medium, Low, Lowest | P1, P2, P3, P4, P4 |

Google Tasks has no priority field; the level comes from text syntax in the
task (integration spec). Editing rules for synced tasks: `planning-tasks.md`
TSK-46.

## Outputs

- Changing a level re-runs the scheduler within 15 seconds; managed events
  may move.
- The priorities page, the planner priorities view and the automation list
  show the new level and rank.
- No change to external events in Google Calendar.

## Edge cases

1. Many items at P1: lower items may find no time. The unplaced report gives
   the reason "taken by higher priority" (E-0226).
2. Two items of the same level and rank: Proposed default: the older item
   (earlier creation time) goes first, then the lower id.
3. A user lowers a recurring external event for "this event": only that
   instance changes; later instances stay P1.
4. A booking link at P4: it offers no managed time, because no level is
   lower than P4.
5. An external event on a non-primary connected calendar: the level menu is
   disabled.

## Observed API shapes

Not yet observed.

## Open questions

1. Defaults for habits, flexible meetings, buffers and booking links are not
   in the evidence. Proposed defaults are in the table.
2. How do legacy kind order (PRI-3) and current stack rank (PRI-2) combine
   when the user never reorders? Proposed default in `planning-scheduler.md`.
3. Does the reference notify attendees when the user lowers an external
   event? The FAQ question exists but its answer was not captured.
4. Can a booking link offer time held by a locked managed event? Proposed
   default: no (PRI-32).
5. The Asana row of the mapping table has four source values and four levels;
   the mapping of "Custom" is read as "user picks".

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Higher priority takes the slot.** Setup: P3 habit "AT-R1 Walk",
   60 minutes, Tuesday W, window 14:00 to 15:00 only; work hours otherwise
   full of P1 external events on Tuesday except 14:00 to 16:00. Action:
   create P1 task "AT-R1 Fix", 120 minutes, split off, `startAfter` Tuesday
   W 00:00, due Tuesday W 16:00.
   Expected within 60 s: "AT-R1 Fix" is Tuesday 14:00 to 16:00; the habit
   event is not on Tuesday 14:00 to 15:00 (it moved or was reported
   unplaced). Reload: same.
2. **External event is never taken.** Setup: an external event "AT-R2 Sync"
   Monday W 09:00 to 17:00, lowered to P4. Action: create P1 task "AT-R2",
   60 minutes, due Monday W 17:00. Expected: no "AT-R2" event overlaps
   "AT-R2 Sync"; the task is placed after its due date and is busy, or is
   reported. Reload: same.
3. **Stack rank decides inside a level.** Setup: P1 habits "AT-R3 A" and
   "AT-R3 B", both 60 minutes, Wednesday W window 12:00 to 13:00, rank A
   above B. Expected: "AT-R3 A" is 12:00 to 13:00. Action: drag B above A.
   Expected within 60 s: "AT-R3 B" is 12:00 to 13:00 and "AT-R3 A" is not.
   Reload: the automation list shows B first.
4. **Same-level tasks by due date.** Setup: P2 tasks "AT-R4 late" (due
   Friday W) and "AT-R4 soon" (due Tuesday W), each 120 minutes, split off,
   urgency mode `priority-only`. Expected: "AT-R4 soon" starts before
   "AT-R4 late". Reload: same.
5. **Focus time goes last.** Setup: focus time goal 10 hours per week; P4
   task "AT-R5", 480 minutes. Expected: all "AT-R5" chunks are placed; focus
   events fill only time that is left. Reload: same.
6. **Primary-only priority edit.** Setup: an event on a connected secondary
   calendar. Action: open its detail panel. Expected: the level shows P1 and
   the control is disabled.
