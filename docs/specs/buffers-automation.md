# Buffer automation (prep and recovery)

Spec id: SPEC-BUFFERS-01
Evidence: E-0051 (ev_936bc1052a22), E-0052 (ev_3db8b91a422f), E-0049 (ev_6802f9e5e02c), E-0069 (ev_56fad64360d1), E-0009 (ev_46057eca8fbd), E-0019 (ev_2718e098a9ce), E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83), E-0087 (ev_7a786863692c)
Status of evidence: public docs only

## Summary

A buffer automation adds a managed event before, after, or around
each calendar event that matches a filter. Users create one buffer automation
per need, for example prep before external meetings or a recovery buffer after
interviews. The buffer follows its event when the event moves. When another
event takes the time, the buffer is removed, or kept as a conflict if the user
chose that. Travel buffers and break buffers have their own specs:
`buffers-travel.md` and `buffers-breaks.md`.

## Concepts and inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `name` | string | template name | Shown in the automation list (E-0043, E-0051). |
| `title` | string | template title | Event title. May contain emoji (E-0043). |
| `side` | `before`, `after`, `both` | from template | E-0051. |
| `minutes_before` | int | Proposed default: 15 | 5 to 240, step 5 (Proposed range). Used when `side` is `before` or `both`. |
| `minutes_after` | int | Proposed default: 15 | 5 to 240, step 5. Used when `side` is `after` or `both`. |
| `show_as` | `busy` or `free` | Proposed default: `busy` | E-0043. |
| `visibility` | `calendar_default`, `public`, `private` | `calendar_default` | `private` shows only "Busy" to others (E-0052, E-0049). |
| `reminders` | list of minutes, or off | calendar default | The user can turn reminders off (E-0051). |
| `priority` | P1 to P4 | Proposed default: P3 | P1 gives the strongest protection (E-0051). |
| `rank` | int | end of its priority group | E-0043. |
| `filter` | event filter | from template | Which events get the buffer. See below. |
| `calendar_scope` | one calendar id or `all` | `all` | E-0051. |

Tempoloom decision: `name` and `title` are one field, Title. A new buffer has
no reminders and the calendar's default visibility; a travel or airport
buffer is public and uses the calendar default reminders (`buffers-travel.md`
outputs, `planning-notifications.md` table). The user can change both in the
buffer's form.
| `on_conflict` | `remove` or `keep_as_conflict` | `remove` | E-0051. |

### Event filter

A filter is a list of conditions. An event matches when it meets every
condition (logical AND). A condition with a list of values matches when any
value matches (logical OR). Proposed combination rule; the evidence says only
that filters "can be combined" (E-0051).

| Condition | Values | Matches when |
|---|---|---|
| `text` | list of strings, and the fields to search (`title`, `description`, `location`) | A chosen field contains a string, case-insensitive. |
| `attendee` | list of names or emails | An attendee or the organizer matches. |
| `organizer` | list of names or emails | The organizer matches. |
| `participants` | comparator (`=`, `>=`, `<=`) and int | The attendee count, including the user, meets the comparison. |
| `category` | set of `team_meeting`, `external_meeting`, `one_on_one`, `personal`, `flight`, `travel` | The event category (see `events-categories-and-colors.md`) is in the set. |
| `length` | comparator and minutes | The event length meets the comparison. |
| `exact_title` | string | The title equals the string, case-insensitive, ignoring title markers. |
| `tag` | list of tags | The title, description or RSVP note contains the tag (see `events-tags.md`). |
| `has_video_link` | bool | The event has a video conference link. Legacy recovery setting "video meetings only" (E-0052). |

Tempoloom decisions for the event filter:

- One condition, "with people", covers `attendee` and `organizer`: it matches
  when an attendee address equals a value (case-insensitive), or ends with a
  value that starts with "@" (anyone at that domain). On CalDAV and Google the
  organizer is in the attendee list. Names are not matched.
- Comparisons also include `>` and `<` ("longer than", "fewer than").
- `run_longer_than_minutes` (library entry 27): matching events with no gap
  between them (the next starts at or before the previous end) form one run.
  Each run longer than the value is one anchor from the run's start to its
  end, so buffers sit before or after the whole run. One event longer than the
  value is a run of one.
- `calendar_scope`: with one calendar, only events on that calendar are
  anchors. Tempoloom's own mirror copies on that calendar are anchors as the
  copy shows them (`buffers-travel.md` rule 13), unless their source event is
  itself an anchor of the same automation.

### Templates

| Template | Side | Default length (Proposed unless noted) | Default filter |
|---|---|---|---|
| Recovery | after | 15 min | meetings with at least one other attendee (legacy option: video meetings only) |
| Meeting prep | before | 15 min | external meetings |
| Travel time | both | see `buffers-travel.md` | events with a physical address or the travel tag |
| Airport time | both | 120 min before, 60 min after (observed, E-0207, E-0203) | flight category or the flight tag |

The templates exist in the library (E-0051). The default lengths of the
recovery and prep templates are not in the evidence.

## Behavior

### Creating and editing

1. The user can create any number of buffer automations (E-0051).
2. The user can create one from a library template, from the "create" button, or through the assistant chat, for example "give me a 15-minute prep block ahead of each external meeting" (E-0051).
3. The filter editor shows the list of upcoming events that match the current filter, and updates it on every change (E-0051).
   Tempoloom decision: the list covers the scheduling window from now, shows the number of matches and at most 50 events, and follows every change of the conditions and of `calendar_scope`.
4. The user can type a plain-language description of the events. The assistant turns it into filter conditions that the user can review and edit (E-0051).
   Tempoloom decision: no assistant and no language model. A fixed grammar reads the description and replaces the form's conditions with what it names; words it does not know are named in an error and nothing changes. Phrases, case-insensitive, separated by spaces, commas, "and" or "or":
   - `with <address>` or `with anyone at @<domain>`, several joined by "or", "and" or commas: people.
   - `with N or more people`, `with at least N`, `with at most N`, `with N or fewer`, `with more than N`, `with fewer than N`, `with N people` (or attendees, guests, participants): the attendee count.
   - `longer than`, `shorter than`, `at least`, `at most`, `lasting`, `exactly` or `of` with a length in minutes (min, m) or hours (h, hours): the length.
   - `titled "X"`, `called "X"`, `named "X"`: the exact title. `containing "X"` or `with "X" in the title`: title text. `mentioning "X"`: text in the title, description or location.
   - `tagged #a and #b`, `with #a`, or a bare `#a`: tags.
   - `external meetings`, `one-on-ones` (or `1:1s`), `team meetings`, `personal events`: categories. `flights`: flight events. `at an address` or `with a location`: travel events (`buffers-travel.md` rules 1 and 2).
   - `back-to-back meetings longer than D in a row` or `runs of meetings longer than D`: a run of meetings.
   - The words "meetings", "events", "calls", "appointments", "all", "my", "any", "every", "each" and "the" carry no condition.
5. Saving a new or edited buffer automation stages the buffers it will add, move or remove in preview mode (`assistant-preview-mode.md`). Tempoloom writes nothing until the user applies them (E-0051, E-0043).
6. Disabling a buffer automation deletes its future buffer events. Past events stay. Removing the automation does the same and deletes its settings (E-0043).

### Placement

7. An anchor is an event inside `calendar_scope` that matches `filter`, is busy, is not declined by the user, and is not all-day. Anchors may be external events, booking-link meetings or flexible meetings. Habits, tasks, focus events and buffers are never anchors (Proposed; legacy travel evidence requires busy anchors, E-0052).
8. For each anchor in the scheduling window, Tempoloom places a buffer that ends exactly at the anchor start (`before`) and one that starts exactly at the anchor end (`after`), with the configured lengths.
9. A buffer never overlaps its own anchor.
10. Tempoloom does not place a buffer whose range overlaps a busy external event, a booking-link meeting or a locked event. It does not shorten the buffer to fit. Example: when a meeting starts right after another meeting, the first meeting gets no `after` buffer (E-0052, E-0069). Proposed: no partial buffers (open question 2).
11. When two buffers from different automations would overlap, Tempoloom keeps the one with the higher priority, then the higher rank. Proposed.
12. When the anchor moves, the buffer moves with it in the same scheduler run (E-0052).
13. When the anchor is deleted, declined, becomes free, or stops matching the filter, Tempoloom deletes the buffer.
14. When the user changes the length of a buffer event in the planner or Google Calendar, Tempoloom keeps the new length for that anchor occurrence and does not reset it (legacy travel evidence, E-0052; Proposed for all buffers).
15. When the user deletes a buffer event, Tempoloom does not add it again for that anchor occurrence. Proposed (open question 3).

### Conflicts

16. When a new external event or booking-link meeting overlaps a buffer, `on_conflict` applies (E-0051):
    - `remove`: Tempoloom deletes the buffer.
    - `keep_as_conflict`: Tempoloom keeps the buffer in place, overlapping, and marks it with "⚠️" in the title.
17. When a flexible managed item (habit, task chunk, flexible meeting, focus event) and a buffer need the same time, the item with the higher priority wins; equal priority uses rank. If the buffer wins, the item moves by its own rules. If the item wins, rule 16 applies to the buffer (E-0051, E-0141).
18. Legacy recovery behavior (legacy evidence, E-0069): a recovery buffer may overlap a habit or task event that is still free. When that habit or task event has no other slot and switches to busy, Tempoloom deletes the recovery buffer. The current version may replace this with rule 17 (open question 4).

### Company buffer policy (marketing evidence)

19. An organization can set buffer standards per team, role or level, mapped from directory attributes. A member who changes team gets the new standard (E-0019).
20. Standards can include prep before chosen meeting types, follow-up time after chosen meeting categories, and a minimum daily break (E-0019).
21. The policy model, its scope and its coverage reports are in `teams-policies.md`. A policy produces ordinary buffer automations, and every rule in this spec applies to them.

### Scheduler interaction

22. Buffers are placed relative to anchors. The scheduler never moves a buffer to a time that is not adjacent to its anchor.
23. Order: the scheduler computes anchors from fixed events first (external events, booking-link meetings, locked events). Then it places buffers and flexible items together by priority and rank (rule 17). Buffers anchored to flexible meetings are recomputed after the meeting is placed.
24. A buffer never takes time from an external event, a booking-link meeting or a locked event, at any priority.
25. For booking links, a buffer has its own priority. A booking link of higher priority may offer the buffer's time. If someone books it, rule 16 applies (E-0051, E-0141).
26. A buffer with `show_as=free` still blocks managed items of lower priority. It does not block other people. Proposed.
27. Buffers do not count toward the focus goal or toward meeting hours.
28. When a buffer cannot be placed, the scheduler does not list it as unplaced in the planner. Proposed: the anchor's event card shows "buffer skipped: no free time" (helps "why is my buffer missing", E-0051).

## Outputs

- One Google Calendar event per buffer: title from `title`, on the calendar of the anchor if writable, else on the primary calendar (Proposed). Transparency from `show_as`. Visibility from `visibility`. Reminders from `reminders`. Description: the managed-event footer and the anchor title (Proposed).
- Category: recovery and travel buffers use travel and logistics (E-0087). Prep buffers: Proposed solo work.
- Planner: the automation in the sidebar; buffer events drawn next to their anchors; a skipped-buffer note on the anchor card.

## Edge cases

1. Back-to-back meetings: the first gets no `after` buffer and the second gets no `before` buffer when the gap is shorter than the buffer (E-0069).
2. A recurring anchor: each occurrence gets its own buffer events. Proposed: write them as single events, not as a recurring series.
3. An anchor on a calendar outside `calendar_scope`: no buffer.
4. The anchor is on a read-only calendar: the buffer goes to the primary calendar.
5. An anchor shorter than 1 minute or all-day: no buffer.
6. The user edits the filter so an anchor no longer matches: its future buffers are deleted.
7. A buffer reaches into a time outside working hours: allowed. Buffers do not use hours sets. Proposed.

## Observed API shapes

Not yet observed.

## Open questions

1. How are filter conditions combined (AND, OR, groups)?
2. Can a buffer shrink to fit a smaller gap?
3. Does a deleted buffer come back?
4. Does the current version keep the legacy recovery overlap behavior (rule 18)?
5. Default lengths, default `show_as` and default priority for each template.
6. Which calendar receives a buffer for an anchor on a mirrored calendar?
7. Are buffers limited to hours sets?

## Acceptance tests

Common setup: Google Calendar test account, a second test account for
invitations, home time zone America/New_York, work hours Monday to Friday
09:00 to 17:00, scheduling window 2 weeks. Test day is a weekday at least
2 days ahead.

1. **Prep before external meetings.**
   Setup: create an external meeting 14:00 to 15:00 with an attendee from another domain. Create a meeting 10:00 to 11:00 with only same-domain attendees.
   Action: create a buffer automation "External prep": side `before`, 15 minutes, filter category = external meeting, busy. Apply the staged changes in preview mode.
   Expected: one opaque event "External prep" 13:45 to 14:00. No event before 10:00.
   Reload: the buffer persists with the same id. No duplicates.

2. **Buffer follows its anchor.**
   Setup: scenario 1 done.
   Action: move the external meeting to 15:00 to 16:00.
   Expected: within 60 seconds, the buffer is at 14:45 to 15:00. The old buffer is gone.
   Reload: the same.

3. **Conflict removes the buffer.**
   Setup: scenario 2 done, `on_conflict=remove`.
   Action: create an own busy event 14:40 to 14:55.
   Expected: the buffer is deleted.
   Reload: no buffer before the external meeting.

4. **Conflict kept.**
   Setup: as scenario 3 but `on_conflict=keep_as_conflict`.
   Action: same as scenario 3.
   Expected: the buffer stays at 14:45 to 15:00 with title "⚠️ External prep".
   Reload: the same.

5. **No buffer between back-to-back meetings.**
   Setup: recovery automation, side `after`, 15 minutes, filter participants >= 2.
   Action: create meetings 10:00 to 11:00 and 11:00 to 12:00, each with another attendee.
   Expected: no buffer at 11:00. One buffer 12:00 to 12:15.
   Reload: the same.

6. **Priority against a habit.**
   Setup: a habit "Walk" P3, one-off window 12:00 to 12:30 on the test day, 15 minutes, ideal 12:00. A recovery automation P1, 15 minutes after meetings with participants >= 2.
   Action: create a meeting 11:00 to 12:00 with another attendee.
   Expected: the recovery buffer is at 12:00 to 12:15. "Walk" moves to 12:15 to 12:30.
   Reload: both persist.

7. **Anchor removed.**
   Setup: scenario 1 done.
   Action: delete the external meeting.
   Expected: within 60 seconds, the buffer is deleted.
   Reload: no buffer remains.
