# Flexible meetings

Spec id: SPEC-MEET-01
Evidence: E-0176 (ev_eba8295888d0), E-0177 (ev_6290cf97a8b4), E-0006 (ev_1d8755394446), E-0046 (ev_00791bd5172f), E-0073 (ev_6f2e72b724b9), E-0092 (ev_e2b256d2eb91), E-0113 (ev_9189933f86ee), E-0131 (ev_c3f09cf6de63), E-0039 (ev_b60e2bdfb98d), E-0018 (ev_28527173bd6f), E-0223 (ev_ee2fc58160f0), E-0167 (ev_a812e5ee818f), E-0045 (ev_b090cc25cd53), E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83), E-0104 (ev_173e10d4937f), E-0088 (ev_4fa475edc582), E-0090 (ev_4a54fa9f235a), E-0172 (ev_d2989bf32eaf), E-0168 (ev_8dc3c6fd18f7), E-0161 (ev_e23f32e22a66), E-0201 (ev_182273bc4ff5), E-0097 (ev_6cb070bba30b), E-0165 (ev_24e80a7bfae3), E-0163 (ev_aa5715921a1a), E-0105 (ev_3a08a4245510)
Status of evidence: public docs only

## Summary

A flexible meeting is a recurring meeting between the user and one or more
other people, for example a weekly 1:1 or a team sync. The user sets rules:
how often, how long, in which hours, and at which priority. Tempoloom puts
each occurrence at the best time that all required attendees share, and moves
it when a conflict appears. Each occurrence stays an instance of one real
recurring Google Calendar event, so the invitation, notes and agenda
attachments stay with the series.

Related specs:

- `meetings-flexible-rescheduling.md` (SPEC-MEET-02): automatic moves,
  manual actions, locks, disable and delete, failure reporting.
- `meetings-start-intervals.md` (SPEC-MEET-03): allowed start minutes.
- `planning-scheduler.md` (group A): global processing order and the
  planning window.
- Other group specs this spec relies on: `planning-hours.md` (hours sets and
  item-specific hours), `planning-priorities.md`, `planning-defense.md`,
  `planning-locks.md`, `planning-calendar-edits.md`,
  `planning-event-content.md`, `planning-notifications.md`,
  `events-external-priority.md`, `events-tags.md`,
  `events-out-of-office.md`, `focus-time.md`, `habits-automation.md`,
  `integrations-video-conferencing.md`, `teams-policies.md`.

Version note: current evidence (E-0176, E-0043) attaches meeting rules to a
recurring meeting that already exists on the calendar. Legacy evidence
(E-0177, E-0046) creates a new series from a form. This spec covers both
paths.

## Concepts and inputs

### Meeting fields

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `title` | string | adopted: series title; created: required | 1 to 255 characters (Proposed limit) | E-0177 |
| `source` | enum | `adopted` | `adopted`, `created` | E-0176; `created` is legacy evidence (E-0177) |
| `series` | Google calendar id + recurring event id | set by adopt or create | a series that the user organizes | E-0176 |
| `organizer` | Tempoloom user | the creator | one user | E-0113 |
| `attendees` | list of attendee records (below) | adopted: the series guests, all required | at least 1 person other than the organizer | E-0177, E-0223 |
| `frequency` | enum + interval | adopted: from the series recurrence rule | `daily`, `weekly`, `monthly`, `custom` (every N days, weeks or months, N 1 to 52) | E-0177 (legacy evidence) |
| `idealDays` | weekdays (weekly), or day of month or Nth weekday (monthly) | adopted: the series day | at least 1 day | E-0177 |
| `idealTime` | local time of day | adopted: the series start time | 00:00 to 23:55 | E-0177, E-0176 |
| `duration` | minutes | adopted: the series duration | 5 to 480, step 5 (Proposed range) | E-0177, E-0176 |
| `canShortenTo` | minutes | equal to `duration` (no shortening) | 5 to `duration`, step 5 | E-0176, E-0223 |
| `hoursMode` | enum | Proposed: `everyone` | `everyone`, `organizer`, `itemSpecific` | E-0176 |
| `organizerHours` | hours set id | meeting hours | any hours set of the organizer | E-0177, E-0172 |
| `itemHours` | item-specific hours (`planning-hours.md`): weekly windows, one or more ranges per day | none | used only when `hoursMode` is `itemSpecific` | E-0176, E-0172 |
| `startDate` | date | today | today or later; a future date pauses placement until that date | E-0177 (legacy evidence) |
| `priority` | P1 to P4 | P2 | P1, P2, P3, P4 | E-0113, E-0177 |
| `rank` | integer | last in its priority group | order inside one priority level | E-0176, E-0043 |
| `defense` | enum | Proposed: `adaptive` | `adaptive`, `busy`, `free` | E-0043; `adaptive` is legacy evidence (E-0092, E-0177) |
| `visibility` | enum | `default` | `default`, `private`, `public` | E-0043 |
| `reminders` | Google reminder overrides | calendar default | Google limits | E-0043 |
| `description` | markdown text | adopted: series description | up to 8 KB (Proposed limit) | E-0177, E-0039 |
| `location` | tagged value | adopted: series location and conference | `none`, `googleMeet`, `zoom`, `address` (text), `room` (Google Workspace resource), `custom` (text or URL) | E-0177 |
| `targetCalendar` | calendar id | adopted: the series calendar; created: main account, primary calendar | a primary calendar of any connected account, not a secondary calendar; fixed after creation | E-0177 |
| `dependencies` | view of habit dependencies that name this meeting | none | stored on the habit; relations `before`, `notAfter` (`habits-automation.md` rule 18) | E-0177 (legacy evidence) |
| `enabled` | boolean | true | | E-0097, E-0043 |

The rescheduling rules (`minimumLeadTime`, `autoReschedulePolicy`,
`autoLock`, `ifNoTime`) are defined in SPEC-MEET-02.

### Attendee record

| Field | Type | Default | Notes |
|---|---|---|---|
| `email` | string | | required |
| `required` | boolean | true | `false` makes the attendee optional (E-0177, E-0223) |
| `hoursOverride` | weekly windows | none | the organizer's hours choice for this attendee (E-0177, E-0223, legacy evidence) |
| `class` | enum, computed | | `user`, `freebusy` or `none`, see below |

Attendee class, computed each time the meeting is placed:

- `user`: the email belongs to a Tempoloom user on this instance whose
  calendar is connected. Tempoloom reads that user's events, hours sets,
  managed events, priorities and time zone (E-0073).
- `freebusy`: not a Tempoloom user, but a Google free/busy query from the
  organizer's account returns busy intervals for the email. Tempoloom reads
  busy intervals and the time zone when Google exposes it (E-0073, E-0176).
- `none`: the free/busy query returns no data for the email. Tempoloom cannot
  see this person's availability or time zone (E-0073).

### Terms

- Period: the time unit in which exactly one occurrence must happen. Daily:
  one day. Weekly: one week, starting on the user's week start day.
  Monthly: one calendar month. Custom: N units, counted from `startDate`.
- Occurrence: one instance of the series in one period.
- Effective priority: the priority of an occurrence on one person's
  calendar (rule 14).

## Behavior

### Setup

1. The user can attach meeting rules to an existing recurring series that the
   user organizes. Tempoloom lists the user's recurring series. On selection
   it copies the title, guests, start time, duration, recurrence, description
   and location into the fields (E-0176).
2. The user can also create a meeting from an empty form. Tempoloom then
   creates a new recurring series on `targetCalendar` with the attendees as
   guests (E-0177, E-0046) (legacy evidence).
   Tempoloom decision: at the first plan run that places the meeting,
   Tempoloom writes one series master: an RRULE from `frequency` (one
   instance per period: weekly on the first ideal day, daily, or monthly on
   the ideal day; day 29 to 31 is the last day of a shorter month), DTSTART at
   `idealTime` on the ideal day of the first planned period, in the user's
   time zone (TZID with a VTIMEZONE, so the local time stays across DST), the
   length `duration`, and the private properties `tl`, `tl_user` and
   `tl_meeting`. The master takes the fields of the last planned occurrence,
   as the instances after the planning window will be (rule 20). Each
   occurrence is an instance of the series: a move or a resize is an override
   (RECURRENCE-ID), a skip or `remove` is an EXDATE, and a period that gets an
   occurrence again gets an RDATE with an override. A meeting saved before
   this change keeps its single events; its series begins in the first
   planned period, with an EXDATE for each period that already has its own
   event, so no period has two events. Turning the meeting off, deleting it,
   or a new frequency or start date in the form ends the series (RRULE UNTIL
   at that time): past instances stay, later ones go; locked later instances
   stay (each as an RDATE with its override), except on delete. The next run
   after a turn-on or a new frequency writes a new series. An instance counts
   by its start (an override's own start, else its rule time): ending the
   series removes a moved occurrence that starts later and keeps one that
   started before. A new length or ideal time in the form also starts a new
   series; a new title or guest list goes to the master and to the
   occurrences in the planning window. A period whose rule instance starts
   after the planning window moves that instance; it never gets a second one.
   An occurrence that comes back at its rule time loses its EXDATE; one at
   another time gets an RDATE. If the organizer deletes the whole series in a
   calendar app, the meeting turns off and keeps its rules (edge case 5 of
   SPEC-MEET-02). Only the calendar decides that the series is gone: a "not
   found" answer for the series object, never an empty read window. The run
   that finds it writes nothing more for the meeting (no single events, so no
   invitations), and the change log says "series deleted in the calendar". A
   form edit is saved at once; the next plan run writes it to the series. If
   the organizer also edits the series in a calendar app before that run, each
   field keeps its newer value: a field the calendar edit changed takes the
   calendar's value, and a form change of another field (the title too) is
   still written; a calendar value equal to the form edit counts as written.
   Only an HTTP 404 or 410 for the series object means "gone"; a server error,
   a refused login or a lost connection changes nothing, and turning off or
   deleting the meeting then fails and keeps the meeting as it was. The rule is written in the user's home zone: DTSTART, BYDAY
   and the EXDATEs are all in that zone. A trip (travel zone) does not change
   the rule: the plan moves the occurrences of the trip with overrides. A new
   home zone ends the series, and the next run writes one in the new zone. A
   calendar backend without series support (no instance list) keeps one event
   per occurrence.
   Known gaps on Google Calendar (not proven; the rows are "done (CalDAV)"):
   Tempoloom writes the series there too, but it reads no series edit back
   (no master facts), so a "this and following" or "all events" edit counts as
   edits of single occurrences; it has no instance add, so a period that comes
   back gets a single event; and ending a series drops the locked later
   instances.
3. Only series organized by the user can be adopted. A series where the user
   is only a guest is not listed (Proposed; E-0046 requires the user to own
   the series).
   Tempoloom decision: the list shows recurring series on a calendar Tempoloom
   can write, organized by the user, with at least one guest, that no meeting
   manages yet. The form copies the next instance: title, guests (all
   required), local start time, duration, weekday, description and location;
   the frequency comes from the gap between the next two instances. Saving
   writes the private properties `tl`, `tl_user` and `tl_meeting` (the
   meeting id) on the series, so its instances count as managed events. On
   CalDAV, Tempoloom moves an instance by writing an override (RECURRENCE-ID)
   in the series object and cancels one with an EXDATE; it never writes a new
   event for an adopted series. Turning the meeting off or deleting it removes
   those properties and keeps the series as a normal recurring event
   (SPEC-MEET-02 open question 1).
4. When the user adds an attendee of class `none`, the form shows a warning:
   Tempoloom cannot see this person's availability or time zone. The user can
   still save (E-0073).
5. The form shows the time zone of each attendee (E-0177).
6. The form shows an availability map: for each weekday, the hours of each
   required attendee, converted to the organizer's time zone, and the
   overlap of all of them (E-0177, E-0223) (legacy evidence).
7. The organizer can set `hoursOverride` for an attendee to fix a low
   overlap (E-0177, E-0223) (legacy evidence).
8. Before the rules are saved, Tempoloom shows a preview of the calendar
   changes (E-0043). Proposed: list the next 4 occurrences with their planned
   start, end and any displaced managed events.
9. Saving starts placement at once, unless `startDate` is in the future
   (E-0177).

### Placement

10. Each period gets one occurrence, unless the period is skipped (SPEC-MEET-02).
11. The allowed window of an occurrence depends on `hoursMode` (E-0176,
    E-0177, E-0073):
    - `everyone`: the intersection of the organizer's `organizerHours` and,
      for each required attendee of class `user`, that attendee's
      `hoursOverride` or, if empty, the attendee's meeting hours.
      Attendees of class `freebusy` and `none` add no hours limit (Proposed).
    - `organizer`: the organizer's `organizerHours` only.
    - `itemSpecific`: `itemHours` only.
    Each hours set is read in its owner's calendar time zone (E-0172).
12. The start minute of an occurrence must be in the organizer's start-time
    intervals (SPEC-MEET-03, E-0167).
13. A candidate slot is free for a required attendee when none of these
    overlap it (E-0131, E-0113, E-0104, E-0141, E-0165):
    - a busy external event that the attendee organizes or has answered yes
      or maybe;
    - an external event whose priority the user lowered (flexible meetings
      never take time from external events);
    - an event created by a booking link;
    - a locked managed event;
    - a managed event whose priority is equal to or higher than the
      occurrence's effective priority for that attendee;
    - for an attendee of class `freebusy`: any busy interval from the
      free/busy query;
    - time marked as out of office (`events-out-of-office.md` rule 1;
      E-0006 lists time off as a conflict).
    An invitation that the attendee has not answered, or has declined, does
    not block (E-0131). An event marked free does not block. An event with
    `#tl_free` is busy, so it blocks. An event with `#tl_busy` is free, so it
    does not block a meeting (Proposed; the tags block tasks and habits only,
    E-0161, E-0201).
14. Effective priority: on the organizer's calendar, the occurrence has the
    meeting's `priority`. On the calendar of each attendee of class `user`,
    the occurrence counts as P1 (E-0113) (legacy evidence).
15. A candidate slot may overlap managed events of the organizer, or of an
    attendee of class `user`, when their priority is strictly lower than the
    effective priority. After placement, the scheduler moves those managed
    events (E-0113, E-0177, E-0073).
16. Tempoloom picks the best candidate in the period in this order:
    1. a slot with the full `duration` before a shortened slot (E-0223, E-0176);
    2. a slot on an ideal day before a slot on another day (Proposed order);
    3. the slot whose start is closest to `idealTime` (E-0177, E-0176);
    4. Proposed tie-break: fewer displaced managed events, then the earlier start.
17. When no slot in the period fits the full `duration`, Tempoloom tries
    shorter durations in 5-minute steps down to `canShortenTo` and takes the
    longest one that fits (E-0223, E-0176). The 5-minute step is Proposed.
18. Cadence: when an occurrence moved away from its ideal day, Tempoloom
    tries to keep the next occurrence from being too close to it (E-0131)
    (legacy evidence). Proposed rule: in the next period, skip candidates
    that start less than half a period after the previous occurrence's start,
    if another candidate exists.
19. When no candidate exists, Tempoloom applies the `ifNoTime` rule and
    records a reason code (SPEC-MEET-02).
20. Tempoloom places occurrences only for periods inside the planning window
    (`planning-scheduler.md`). Occurrences beyond the window keep the time from
    the series recurrence rule and are not changed.
21. All times are computed in UTC. Hours sets follow each owner's time zone
    and its daylight-saving changes (E-0177, E-0223).
22. Dependencies (legacy evidence, E-0177): the meeting form can add or
    remove a habit dependency on this meeting. Tempoloom stores it on the
    habit, and `habits-automation.md` rule 18 defines it: the habit comes
    before the meeting, or never after it, on the same day. The
    dependency is a constraint on the habit's placement only; it never
    moves the meeting (Proposed).

### Scheduler and other calendars

23. The scheduler handles items in priority order, P1 first. Inside one
    priority level, the user's rank order decides (E-0176, E-0043). Legacy
    evidence: at equal priority, flexible meetings go before habits, and
    habits before tasks (E-0088, E-0090, E-0113; `planning-priorities.md`
    PRI-3). `planning-scheduler.md` owns the final order.
24. Flexible meetings are placed before focus time, whatever their priority
    (E-0090 legacy, E-0141; `focus-time.md` rule 29).
25. A flexible meeting can push tasks, habits and other flexible meetings of
    lower priority to other times. It never displaces external events,
    booking-link events or locked events, even at P1 (E-0113, E-0104,
    E-0141; `events-external-priority.md` rule 9).
26. A booking link whose priority is higher than an occurrence's priority can
    offer the occurrence's time to bookers. When someone books it, the
    occurrence moves under SPEC-MEET-02 (`booking-links-availability.md`,
    E-0163, E-0165).
27. Only the organizer's Tempoloom account places and moves the series.
    For an attendee of class `user`, the attendee's own scheduler treats each
    occurrence as a fixed P1 item: it never moves it, and it moves the
    attendee's lower-priority managed events away from it (E-0113, E-0073).
28. Tempoloom reads other people's calendars only through: the stored tokens
    of Tempoloom users on this instance, and the Google free/busy query for
    other emails. It never writes to an attendee's calendar. Attendees get
    the occurrence through the Google invitation.
29. When a team fragmentation policy is on, its scoring and each member's
    `member_flexibility` also shape where Tempoloom places and how far it
    moves flexible meetings (`teams-policies.md` rule 23).

### Defense

30. `adaptive` (legacy evidence, E-0092, E-0177): Tempoloom writes a new
    occurrence as free. It changes it to busy when one of these is true:
    - the start is less than 12 hours away (E-0092; `planning-defense.md`
      DEF-30). E-0177 says 24 hours; see Open questions;
    - only one valid slot is left for the occurrence on its day;
    - the occurrence is locked (E-0092, E-0045).
31. `busy` and `free` write a fixed free/busy value (E-0043).
32. Tempoloom owns the visibility and free/busy of each occurrence. If someone
    changes them in Google Calendar, Tempoloom writes its value back at the
    next sync (E-0131).

### Organizer and attendees

33. Only the organizer can change the rules and the priority (E-0113, E-0177).
34. Attendees do not need a Tempoloom account (E-0073, E-0176).
35. Optional attendees are written as optional guests. Tempoloom ignores their
    availability and their responses (E-0177, E-0223, E-0131).
36. Tempoloom sets no limit on the number of flexible meetings per user.
    The reference limits organizers by plan; attendees are never limited
    (E-0073).
37. A meeting with 2 people is a 1:1. A meeting of 3 people or more is a
    group meeting. SPEC-MEET-02 lists the actions that differ (E-0177).

### Description, agenda and location

38. Tempoloom writes `description` to every occurrence. Markdown rendering
    follows `planning-event-content.md` (E-0177, E-0039).
39. Tempoloom changes an occurrence only by patching that instance. It never
    deletes and recreates the series or an instance. So attachments,
    conference data, linked meeting notes and third-party agenda links
    (for example Google Docs meeting notes, Lattice, Fellow) stay attached
    after a move (E-0039, E-0176).
40. When a patch writes fields, Tempoloom keeps all fields it does not own.
    It owns: start, end, free/busy, visibility, and the fields the user edits
    in the Tempoloom form.
41. Location `googleMeet` creates one Meet conference for the series.
    `zoom` uses the Zoom integration (`integrations-video-conferencing.md`
    rules 12 and 13).
    `address` and `custom` fill the event location. `room` adds the
    Workspace resource as a guest (E-0177).
42. A meeting can be saved with no location. The user can add one later in
    Google Calendar (E-0177).
43. When the series-level location or conference changes, the new value
    applies to all future occurrences, including occurrences that Tempoloom
    moved. Proposed: Tempoloom copies the series value onto the moved
    instances it created, so a link added to the series reaches every
    future occurrence (E-0131, E-0168).

## Outputs

- Google Calendar, organizer's `targetCalendar`: one recurring event.
  - Guests: all attendees; optional attendees have the optional flag.
  - Each placed occurrence: the instance with the chosen start and end.
    A shortened occurrence has a shorter end.
  - Each skipped or removed occurrence: the instance with status cancelled.
  - Free/busy per `defense`; visibility per `visibility`; reminders per
    `reminders`; description; location and conference data.
  - A private extended property `tlMeetingId` on the series (Proposed), so
    Tempoloom can find its series after a restart.
- Locked occurrences show the lock marker defined by `planning-locks.md`
  (legacy evidence shows a lock emoji in the title, E-0105).
- Attendees' calendars: the Google invitation and its updates. Google sends
  update emails only when the user setting "send updates" is on
  (SPEC-MEET-02).
- Planner: each occurrence with the meeting's title and priority. An
  occurrence kept in conflict shows a warning marker (E-0176).
- Meeting detail view: the list of periods with the planned time, the
  skipped periods with their reason (E-0092), the change log of each
  occurrence (E-0092, E-0223), and the availability map (rule 6).
- Rules list: meetings grouped by priority and ordered by `rank`. The user
  can drag a meeting to change its rank or priority (E-0176, E-0043).

## Edge cases

1. All attendees other than the organizer are optional: Tempoloom uses only
   the organizer's availability.
2. An attendee of class `none` is required: Tempoloom places the meeting
   from the organizer's side only and keeps the warning on the meeting
   (E-0073).
3. The hours intersection is empty in every period: no occurrence fits;
   reason `noHoursOverlap` (E-0223).
4. Hours that cross midnight in another attendee's time zone: the window is
   split at the date line of each zone, then intersected in UTC.
5. A daylight-saving change between two periods: `idealTime` stays the same
   local time for the organizer.
6. Monthly on day 29, 30 or 31: in a shorter month, the ideal day is the last
   day of the month (Proposed).
   Tempoloom decision: a month without its ideal day (an Nth weekday the month
   does not have, such as a 5th Thursday) has no occurrence, as for monthly
   habits (`habits-automation.md`). A month whose ideal day is before today or
   before `startDate` gets no new occurrence; an occurrence already placed in
   that month stays. When the ideal day has no room, the occurrence goes to
   the day with room nearest to the ideal day, then nearest `idealTime`.
7. The adopted series already has moved or cancelled instances: Tempoloom
   keeps them as they are. A moved instance counts as locked (Proposed,
   consistent with manual moves in SPEC-MEET-02).
8. The organizer loses access to `targetCalendar`: placement stops and the
   meeting goes to the attention list (Proposed).
9. Two flexible meetings of the same organizer with the same priority want
   the same slot: the one with the lower `rank` number wins (E-0176).
10. A `room` resource is busy at the chosen time: see Open questions.
11. A free/busy query fails for a transient reason: Tempoloom treats the
    attendee as class `freebusy` with unknown busy time for that run and does
    not move existing occurrences (Proposed).
12. The organizer removes all other guests in Google Calendar: the meeting
    has no attendees; Tempoloom keeps the rules and places the series on the
    organizer's calendar only (Proposed).
13. A conflicting invitation that one attendee has not answered: it does not
    block until that attendee answers yes or maybe (E-0131).

## Observed API shapes

Not yet observed.

## Open questions

1. Can the current version still create a meeting from an empty form, or
   only adopt an existing series? E-0176 shows only adoption.
   Proposed: support both.
2. Which `hoursMode` is the default in the current version? Proposed:
   `everyone`.
3. The adaptive defense threshold: E-0092 says 12 hours, E-0177 says 24
   hours. Does the current version keep adaptive defense, or only a fixed
   busy or free choice (E-0043)?
4. Does an attendee of class `user` still see each occurrence as P1, as the
   legacy page says (E-0113)?
5. Whose start-time intervals apply: the organizer's only, or also those of
   attendees of class `user`? Proposed: the organizer's only.
6. Is a `room` resource treated as a required attendee when Tempoloom moves
   an occurrence? Proposed: yes, through a free/busy query on the resource.
7. What is the placement order inside a period: ideal day first, or nearest
   time first? The evidence only asks for a start near the ideal time.
8. How exactly is the cadence kept after a move (rule 18)?
9. Does the current version keep the dependency feature (rule 22)?
10. Which limits apply to `duration` and to the number of attendees?
11. Does the reference send its own email to attendees in addition to the
    Google invitation? Legacy evidence says it sends a one-time
    confirmation and a sign-up prompt (E-0131, E-0046). Proposed: Google
    invitations only.
12. Team policies for agendas (detection, reminders, auto-decline without
    agenda, agenda templates, generated agendas, E-0018) belong to
    `teams-policies.md`. Do they change how flexible meetings are
    placed? E-0018 says meetings without agendas can be shortened,
    moved or lowered in priority.

## Acceptance tests

Test accounts: A is a Tempoloom user (organizer). B is a second Google test
account, not a Tempoloom user, that shares free/busy with A. C is a third
Google test account that is a Tempoloom user on the same instance. D is an
email address with no free/busy access. A's meeting hours are Monday to
Friday, 09:00 to 17:00, in A's calendar time zone. A's start-time intervals
are :00 and :30. All dates are in the next calendar week.

1. Adopt an existing series
   - Setup: in A's Google Calendar, create a weekly series "Sync A-B" on
     Tuesday 10:00 to 10:30 with guest B. No other events on Tuesday.
   - Action: in Tempoloom, attach meeting rules to "Sync A-B" with default
     values.
   - Expected: next Tuesday's instance stays at 10:00 to 10:30. The series
     id does not change. The series has the private property `tlMeetingId`.
   - Reload: reload Tempoloom and Google Calendar. The meeting shows in the
     rules list at P2. The instance is unchanged.
2. Move around an accepted conflict
   - Setup: test 1 done. In B's calendar, create a busy event Tuesday 09:00
     to 11:00 (B is the organizer of it).
   - Action: trigger a sync in Tempoloom.
   - Expected: next Tuesday's instance moves to 11:00 to 11:30 (closest free
     slot on the ideal day). Other weeks are unchanged.
   - Reload: the new time persists in A's and B's calendars after reload.
3. An unanswered invitation does not block
   - Setup: test 1 done. From D, invite B to a busy event on Tuesday 09:00 to
     11:00. B does not answer.
   - Action: trigger a sync.
   - Expected: the instance stays at 10:00. Then B answers yes; after the next
     sync the instance moves to 11:00.
   - Reload: both states persist after reload.
4. Optional attendee is ignored
   - Setup: test 1 done; mark B as optional. Create B's busy event on Tuesday
     10:00 to 11:00.
   - Action: trigger a sync.
   - Expected: the instance stays at 10:00. B is an optional guest on the
     event.
   - Reload: unchanged after reload.
5. Hours of a Tempoloom attendee
   - Setup: C's meeting hours are 13:00 to 17:00. Create a weekly meeting
     from A with C, ideal time Tuesday 10:00, `hoursMode` `everyone`.
   - Action: save.
   - Expected: the occurrence is at 13:00 to 13:30 on Tuesday.
   - Reload: unchanged after reload; C's calendar shows the invitation.
6. Priority displacement of a managed event
   - Setup: A has a P3 habit placed on Tuesday 11:00 to 12:00. A's calendar
     has an external busy event 09:00 to 11:00. Meeting "Sync A-B" at P1,
     ideal 10:00.
   - Action: trigger a sync.
   - Expected: the meeting is at 11:00 to 11:30. The habit moved to another
     free time. The external event did not change.
   - Reload: all three events keep these times after reload.
7. External event with lowered priority still blocks
   - Setup: as test 6, but A lowered the external event's priority to P4 and
     there is no habit.
   - Action: trigger a sync.
   - Expected: the meeting is at 11:00, not 10:00.
   - Reload: unchanged after reload.
8. Shortening
   - Setup: meeting "Sync A-B", duration 60, `canShortenTo` 30. Next week,
     A's busy external events leave only gaps shorter than 30 minutes in A's
     meeting hours, except one gap on Tuesday 15:00 to 15:30.
   - Action: trigger a sync.
   - Expected: the occurrence is on Tuesday 15:00 to 15:30.
   - Reload: unchanged after reload.
9. Warning for an attendee without free/busy access
   - Setup: none.
   - Action: create a meeting with D as attendee.
   - Expected: the form shows the warning before save. After save, the
     series exists with guest D at the ideal time.
   - Reload: the warning still shows on the meeting detail after reload.
10. Patching keeps attachments
    - Setup: test 1 done. Attach a Google Doc to next Tuesday's instance in
      Google Calendar.
    - Action: create B's conflict as in test 2 and sync.
    - Expected: the instance moves and still has the attachment and the same
      conference link.
    - Reload: the attachment is present after reload.
