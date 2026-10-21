# Hours sets

Spec id: SPEC-PLANNING-05
Evidence: E-0077 (ev_38c8b46b5b57), E-0081 (ev_dfcc5d3b7c8c), E-0088 (ev_4fa475edc582), E-0098 (ev_cefc23278fd5), E-0172 (ev_d2989bf32eaf), E-0176 (ev_eba8295888d0), E-0193 (ev_68ba14aa780b), E-0199 (ev_9b5fb0c6b1ba), E-0222 (ev_ab1116c8b050), E-0226 (ev_0dc4ddadd24f)
Status of evidence: public docs only

## Summary

An hours set is a named group of weekly time windows. Each managed item uses
one hours set, and the scheduler places the item only inside it. Tempoloom
has three built-in sets (work, meeting, personal) and users can add custom
sets. Habits, flexible meetings, booking links and focus time can also use
item-specific hours; tasks cannot.

## Concepts and inputs

### Hours set

| Field | Type | Default | Range |
|---|---|---|---|
| `id` | id | generated | |
| `kind` | `work`, `meeting`, `personal`, `custom` | | built-in sets exist once each |
| `title` | text | "Work hours", "Meeting hours", "Personal hours" for built-in sets | 1 to 80 characters, custom sets only |
| `description` | text | empty | custom sets only |
| `allowedFor` | set of item kinds | all kinds for built-in sets | custom sets: chosen at creation |
| `days` | 7 entries, Monday to Sunday | see defaults | each: `enabled` and a list of ranges |
| `taskCalendarId` | calendar id | Proposed default: primary calendar | any connected calendar with write access |

A range is `start` and `end` in local wall-clock time, `HH:MM`, with
`start` < `end` and `end` at most `24:00`. Proposed default: times use
15-minute steps, ranges on one day do not overlap, and each range is at least
15 minutes.

Proposed default contents (the evidence has no values):

| Set | Days | Ranges |
|---|---|---|
| Work hours | Monday to Friday | 09:00 to 17:00 |
| Meeting hours | Monday to Friday | 09:00 to 17:00 |
| Personal hours | Monday to Friday | 17:00 to 21:00 |
| Personal hours | Saturday, Sunday | 09:00 to 21:00 |

### Which items use which set (E-0172)

| Set | Used by default for |
|---|---|
| Work hours | work tasks, work habits, work flexible meetings, some booking links; calendar mirroring when the user limits it to work hours |
| Meeting hours | flexible meetings and booking-link meetings |
| Personal hours | personal tasks and habits, and meetings or links that the user sets to personal |
| Custom set | the item kinds listed in `allowedFor` |

### Item-specific hours

Habits, flexible meetings, booking links and focus time can use a private set
of ranges instead of a named set. It is not saved as a named set and other
items cannot use it. Tasks cannot use item-specific hours (E-0172, E-0077,
E-0081, E-0176).

Tempoloom decision: habits, focus time, flexible meetings and booking links
have item-specific hours: the chosen weekdays, each with one range (stored
hours with more ranges stay until the user changes the range). Tempoloom
keeps them as a hidden set that no hours menu or hours page lists and no
other item can use; it goes with its item. On a booking link each person
(organizer or pool member) has their own item-specific hours.

## Behavior

- **HRS-1.** The scheduler places an item only inside the ranges of its hours
  set, in the user's time zone (E-0088, E-0172).
- **HRS-2.** A placed event lies fully inside one range. It never spans the
  gap between two ranges. Proposed default; the evidence is silent.
- **HRS-3.** The user edits a set on the hours settings page: turn each
  weekday on or off, and set one or more ranges for each day that is on
  (E-0172).
- **HRS-4.** A plus button adds a range to a day and a minus button removes
  one (E-0172).
- **HRS-5.** "Copy to all" copies the ranges of the first day in the list to
  every day that is on (E-0172).
- **HRS-6.** Tempoloom saves each change at once, with no save button
  (E-0172).
- **HRS-7.** A change to a set applies to existing and future managed events.
  The scheduler runs again and moves unlocked events that no longer fit
  (E-0172).
- **HRS-8.** The user creates a custom set with a "+ Custom hours" button,
  enters title and description, picks the item kinds that may use it, saves,
  and then sets its days and ranges (E-0172).
- **HRS-9.** A custom set appears in the hours menu of every item of the kinds
  in `allowedFor`, for existing and new items (E-0172).
- **HRS-10.** To delete a custom set, the user opens its menu and picks
  delete. If items use the set, Tempoloom first asks the user to choose
  another set for them (E-0172).
  Tempoloom decision: the replacement can be any other named set. Tasks,
  habits, focus time and flexible meetings that use the set move to it and
  are placed again; booking links that used it fall back to the meeting
  hours. A set that no item uses goes after a plain confirmation.
- **HRS-11.** In an item's editor, the hours menu lists the built-in sets,
  the custom sets allowed for that kind, and (except for tasks)
  "item-specific hours". An info icon next to the menu shows a preview of the
  chosen set's ranges and a link to the hours page (E-0172).
  Tempoloom decision: the preview lists each weekday with its ranges ("off"
  for a day without hours) and a link "Edit hours" to the hours section of
  Settings. Task and habit editors have it.
- **HRS-12.** Each set has a "calendar for task chunks" menu. Task chunks that
  use the set go to that calendar (E-0172, E-0193; `planning-tasks.md`
  TSK-50).
- **HRS-13.** The hours page shows the time zone in which all ranges apply.
  Tempoloom takes it from the user's Google Calendar setting (E-0172,
  E-0199).
- **HRS-14.** When the user has an active travel time zone, the scheduler
  uses it instead of the home time zone. Time zone spec owns travel zones
  (E-0222).
- **HRS-15.** First run: after the user connects the primary calendar,
  Tempoloom asks the user to review work, meeting and personal hours
  (E-0098).
  Tempoloom decision: the line above the planner's week asks a new user to
  review the hours. "Review hours" opens the three built-in sets in a
  dialog; "Done", or "Looks right" on that line, records the review, and the
  question does not come back.
- **HRS-16.** Ranges are wall-clock times. On a day with a daylight-saving
  change, a range keeps its wall-clock start and end. Proposed default.

### Plan note

In the reference product, custom hours sets need a paid plan (E-0172).
Tempoloom has no plans; custom sets are always available.

## Outputs

- Managed events move into the new ranges after a change (HRS-7).
- Hours page: one panel per set with days, ranges, time zone label and the
  task calendar menu.
- Item editors: the hours menu and the preview.

## Edge cases

1. A set with no enabled day: items that use it cannot be placed; the
   unplaced report gives "no hours" (E-0226).
2. A range shorter than the item's minimum duration: the item cannot use it
   (E-0226).
3. A set's ranges are too narrow for the item: the item is reported
   unplaced, reason "hours too narrow" (E-0226).
4. The user removes a kind from a custom set's `allowedFor` while items of
   that kind use it: Proposed default: Tempoloom asks for a replacement set,
   as in HRS-10.
5. The task calendar of a set is removed from the account: Proposed default:
   chunks go to the primary calendar and the hours page shows a warning.
6. The browser reports UTC because of an extension or privacy setting:
   Tempoloom must not change the home time zone from the browser without the
   user's confirmation. Proposed default; E-0222 shows the reference can set
   a wrong zone this way.
   Tempoloom decision: the home zone changes only in Settings. The planner's
   travel prompt (`timezones-home-and-travel.md` rule 11) says that an
   extension or a privacy setting can make a browser report UTC. The hours
   page names the zone in which hours apply now; during a trip it names the
   travel zone and the trip's last date, so a forgotten trip is found.

## Observed API shapes

Not yet observed.

## Open questions

1. Default ranges of the built-in sets are not in the evidence.
2. The evidence conflicts on the source of the home time zone: Google
   Calendar setting (E-0172, E-0199) or the browser (E-0222). Proposed
   default: Google Calendar setting; the browser only triggers a prompt.
3. Can a custom set be used for item-specific hours of a single item?
4. Which booking links use work hours by default ("select" links in
   E-0172)?

## Acceptance tests

Fixture F0 from `planning-scheduler.md`.

1. **Changing hours moves events.** Setup: task "AT-H1", 60 minutes, split
   off, placed Monday W 09:00. Action: set Monday work hours to 13:00 to
   17:00. Expected within 60 s: "AT-H1" starts at 13:00 or later on Monday,
   or on another weekday inside 09:00 to 17:00. Reload: the hours page shows
   Monday 13:00 to 17:00.
2. **Two ranges in one day.** Setup: Tuesday work hours 09:00 to 12:00 and
   14:00 to 17:00, other weekdays off. Action: create task "AT-H2",
   300 minutes, chunks 60 to 120, `startAfter` Tuesday W. Expected: no
   "AT-H2" event overlaps 12:00 to 14:00, and no event spans it. Reload: same.
3. **Custom set.** Action: create custom set "AT-Evening" for tasks, Monday
   to Friday 19:00 to 21:00; create task "AT-H3", 60 minutes, hours
   "AT-Evening". Expected: the event is inside 19:00 to 21:00 on a weekday.
   Reload: the set and the event remain.
4. **Delete a set in use.** Setup: test 3. Action: delete "AT-Evening".
   Expected: Tempoloom asks for a replacement; after the user picks work
   hours, "AT-H3" moves into 09:00 to 17:00 within 60 s. Reload: the set is
   gone.
5. **Copy to all.** Action: set Monday work hours 08:00 to 16:00 and press
   "Copy to all". Expected: Tuesday to Friday show 08:00 to 16:00. Reload:
   same.
6. **No item-specific hours for tasks.** Action: open the task form hours
   menu. Expected: no "item-specific hours" choice. Open a habit form:
   the choice exists.
7. **Time zone label.** Setup: Google Calendar time zone Europe/Berlin.
   Expected: the hours page shows Europe/Berlin and a task placed at 09:00
   Berlin time shows 09:00 in Google Calendar viewed in Berlin.
