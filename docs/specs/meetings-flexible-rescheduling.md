# Flexible meeting rescheduling and management

Spec id: SPEC-MEET-02
Evidence: E-0176 (ev_eba8295888d0), E-0131 (ev_c3f09cf6de63), E-0046 (ev_00791bd5172f), E-0045 (ev_b090cc25cd53), E-0092 (ev_e2b256d2eb91), E-0097 (ev_6cb070bba30b), E-0105 (ev_3a08a4245510), E-0113 (ev_9189933f86ee), E-0177 (ev_6290cf97a8b4), E-0223 (ev_ee2fc58160f0), E-0039 (ev_b60e2bdfb98d), E-0006 (ev_1d8755394446), E-0167 (ev_a812e5ee818f), E-0043 (ev_d7b30359b03e), E-0088 (ev_4fa475edc582), E-0108 (ev_42940293d611), E-0172 (ev_d2989bf32eaf), E-0125 (ev_c3865619996c)
Status of evidence: public docs only

## Summary

This spec defines when Tempoloom moves an occurrence of a flexible meeting by
itself, the limits on those moves, and what the user can do by hand: move,
resize, reschedule, skip, lock, unlock, disable and delete. It also defines
how Tempoloom reports occurrences it cannot place. Placement itself is in
`meetings-flexible.md` (SPEC-MEET-01).

## Concepts and inputs

### Rescheduling rules (per meeting)

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `minimumLeadTime` | hours | Proposed: 12 | 0 to 168 (Proposed range) | E-0176 |
| `autoReschedulePolicy` | enum | `moderate` | `none` (0 moves), `conservative` (1 move), `moderate` (3 moves), `aggressive` (5 moves), counted per 24 hours | E-0176 |
| `autoLock` | enum | `day` | `off`, `day`, `week` (same values as `planning-locks.md`) | E-0176; values are legacy evidence (E-0045, E-0046, E-0108) |
| `ifNoTime` | enum | Proposed: `keepConflicting` | `remove`, `keepConflicting` | E-0176, E-0131, E-0177 |

### User notification settings

| Field | Type | Default | Evidence |
|---|---|---|---|
| `meetingChangeEmails` | owned by `planning-notifications.md` | on (Proposed there) | E-0223, E-0125 |
| `meetingChangeDaysAhead` | owned by `planning-notifications.md` | 7 (Proposed there) | E-0125 |
| `atRiskDigest` | boolean | Proposed: true | E-0223 |

### Terms

- Automatic move: a change of an occurrence's start or end that Tempoloom
  makes without a user action.
- Lock: an occurrence that Tempoloom never moves by itself
  (`planning-locks.md` owns the general lock rules).
- Attention list: the list of items that need the user's decision.
- Reason code: a fixed identifier that says why an occurrence moved, was
  skipped or was not placed.

## Behavior

### Triggers for an automatic move

1. Conflict: when a blocking item (SPEC-MEET-01 rule 13) starts to overlap a
   future, unlocked occurrence for a required attendee, Tempoloom moves the
   occurrence (E-0131, E-0176, E-0006). This includes a higher-priority
   managed item or a booking that takes the time.
2. Decline: when the organizer or a required attendee declines one
   occurrence, Tempoloom places it again at the best remaining slot
   (E-0131, E-0046). The new slot cannot be the declined time.
   A decline by an optional attendee changes nothing (E-0131).
   Tempoloom decision: Tempoloom reads each guest's answer on the organizer's
   copy of the occurrence (CalDAV PARTSTAT, as a server with scheduling writes
   it when a guest replies; Google responseStatus). A moved occurrence asks
   every guest again (their answers reset), so one decline moves it once.
3. A decline also unlocks a locked occurrence before the move (E-0045;
   `planning-locks.md` LCK-40) (legacy evidence).
4. Rule change: when the user changes the frequency, duration, hours,
   priority or ideal time, Tempoloom places all future unlocked occurrences
   again (E-0105, E-0088).
5. Hours change: when the organizer or an attendee of class `user` changes
   an hours set that the meeting uses, Tempoloom places future unlocked
   occurrences again (E-0172).
6. A change of the start-time intervals does not move existing occurrences.
   It applies when an occurrence is next placed (E-0167).

### Limits on automatic moves

7. Tempoloom never moves a locked occurrence by itself (E-0176, E-0045).
8. Lead time: the new start of an automatic move must be at least
   `minimumLeadTime` hours after the time of the move (E-0176).
9. Move budget: Tempoloom counts the automatic moves of one meeting in the
   last 24 hours. When the count equals the policy limit, Tempoloom stops
   moving the meeting and flags the conflict (E-0176). Proposed: the window
   is rolling, and the count is per meeting, not per occurrence.
   Tempoloom decision: the count uses the change log: moves with reason
   `conflict` or `declined`. Moves after a rule change do not count. A flag
   with reason `budgetReached` or `policyNone` is raised only when another
   time exists; with no time at all, `ifNoTime` applies as usual (rule 13).
10. Policy `none`: Tempoloom never moves the meeting by itself. On a
    conflict it flags the occurrence and suggests other times (E-0176).
11. A flag is an entry in the attention list. It holds the occurrence, the
    reason code and up to 3 suggested slots (Proposed number). The
    organizer can apply a suggestion with one action. An applied suggestion
    is a manual move (rule 17).
    Tempoloom decision: the flag shows on the meeting in the Meetings page. The
    suggestions are the 3 best full-length starts in the occurrence's period,
    in placement order, without the lead time; the occurrence keeps its time
    and gets the conflict marker meanwhile.
12. An automatic move keeps the occurrence inside its own period (Proposed).
13. When no slot exists, `ifNoTime` decides (E-0176, E-0131, E-0177, E-0223):
    - `remove`: Tempoloom cancels the instance. The period shows as skipped
      with the reason code.
    - `keepConflicting`: the instance stays at its current time and gets a
      warning marker in the Planner and an attention-list entry. Legacy
      evidence leaves the occurrence on its ideal time and adds a warning
      emoji to the event (E-0131, E-0177).
14. Auto-lock (E-0176, E-0045, E-0046, E-0108):
    - `day`: every day, at a fixed local time early in the day, Tempoloom
      locks every occurrence of that day.
    - `week`: at the same local time on the first day of the week,
      Tempoloom locks every occurrence of that week.
    - `off`: no automatic lock.
    The lock job and its time follow `planning-locks.md` LCK-30 and LCK-31,
    in the organizer's time zone. The legacy pages give two times: between
    01:00 and 02:00 (E-0045) and 04:00 (E-0108).
15. An occurrence that Tempoloom places after the auto-lock ran for its day
    or week is not locked by that run (E-0045; `planning-locks.md` LCK-32)
    (legacy evidence).
16. Priority boost (E-0113, E-0177) (legacy evidence): when a period ends
    with no held occurrence because no slot was found, the next period uses
    a priority one level higher. After two such periods in a row it uses P1.
    The boost ends when an occurrence is held. The stored `priority` does
    not change.

### Manual actions by the organizer

17. Move: when the organizer drags an occurrence in the Planner or moves it
    in Google Calendar, Tempoloom keeps the new time and locks the
    occurrence (E-0131, E-0176, E-0046, E-0105). A locked occurrence is busy.
18. Resize: a duration change of one occurrence applies to that occurrence
    only. A change applied in Google Calendar to "following" or "all"
    events updates `duration` for the matching occurrences (E-0131).
    Proposed: a resize of one occurrence also locks it.
19. Reschedule action (Planner, organizer): the user picks one of two
    options (E-0131, E-0046) (legacy evidence):
    - a different time, same day;
    - another day in the same period.
    Tempoloom places the occurrence at the best slot that matches the option
    and is not the current slot. Proposed: the result stays unlocked.
20. Skip action: the Planner menu has a skip action. Deleting the occurrence
    in Google Calendar by the organizer has the same effect. Tempoloom
    cancels the instance and places nothing else in that period. The next
    period is placed as usual (E-0131, E-0046; `planning-calendar-edits.md`
    CED-26). This differs from tasks and habits, where a delete means
    "place again" (E-0105).
21. Lock and unlock actions in the Planner. Unlock returns the occurrence to
    automatic management under all limits above (E-0176, E-0046, E-0045).
22. Edits in Google Calendar by the organizer (E-0131; general rules in
    `planning-calendar-edits.md`):
    - Tempoloom keeps changes to title, description, location, duration,
      time, recurrence, color, RSVP note and guest list.
    - Tempoloom writes back its own value for visibility and free/busy.
    - The scope the user picks in Google (one occurrence, the occurrence
      and later ones, or the whole series) decides which occurrences
      change.
    - Proposed: a series-level time change sets a new `idealTime`; a
      recurrence change sets a new `frequency`; a new guest is required.
23. A description edit in the Tempoloom form applies to the chosen
    occurrence and all following ones. To change one occurrence only, or
    all past ones too, the user edits in Google Calendar (E-0039) (legacy
    evidence).
24. Moving all meetings of a week (for example for a conference) is done
    through the assistant chat with a preview of the changes (E-0176).
    `assistant-chat.md` and `assistant-preview-mode.md` own this action.

### Actions by attendees

25. Any attendee can decline an occurrence in Google Calendar; rule 2
    applies.
26. In a 1:1, an attendee of class `user` can also use the reschedule and
    skip actions from that attendee's Planner (E-0177, E-0088) (legacy
    evidence). In a group meeting, attendees can only answer the
    invitation (Proposed).

### Disable and delete

27. Disable (organizer only): Tempoloom cancels all future occurrences and
    removes them from all calendars. It keeps the rules. Enable starts
    placement again (E-0097, E-0043). See Open questions for adopted series.
28. Delete (organizer only): Tempoloom cancels all future occurrences,
    removes them from all calendars and deletes the rules. Before delete,
    Tempoloom asks whether Google should notify the attendees (E-0097).
29. Past occurrences stay on the calendars after disable or delete
    (Proposed). Tempoloom ends the series by setting its end date to the
    last past occurrence.
30. A `startDate` in the future works as a pause until that date (E-0177)
    (legacy evidence).

### Reporting

31. Every automatic or manual change writes a change-log entry on the
    occurrence: time of change, old start and end, new start and end, actor
    (Tempoloom, organizer, attendee) and reason code (E-0092, E-0223).
    Tempoloom decision: the log shows on each meeting in the Meetings page.
    Tempoloom writes the codes `conflict`, `declined` (actor: the guest who
    declined), `ruleChanged`, `noFreeSlot`, `manualMove` and `manualSkip`. A
    decline that cannot move yet stays in the log with no new time.
32. Reason codes (Proposed set, from the causes in E-0223 and E-0176):
    `conflict`, `declined`, `ruleChanged`, `hoursChanged`, `noHoursOverlap`,
    `noFreeSlot`, `budgetReached`, `policyNone`, `lockedConflict`,
    `attendeeUnknown`, `manualMove`, `manualSkip`, `priorityBoost`.
33. The attention list shows each unplaced or conflicting occurrence with its
    reason code (E-0223).
34. The meeting detail shows the periods that were skipped because no slot
    was found (E-0092).
35. At-risk digest: when `atRiskDigest` is on, Tempoloom sends one email per
    day. It lists each meeting that has an occurrence in the next 14 days
    that is unplaced or kept in conflict (E-0223). Proposed: send at 07:00
    in the user's time zone, and send nothing when the list is empty.
    E-0223 lists this email as available; E-0125 lists it as planned
    (`planning-notifications.md` NTF-30). Proposed: build it.
    Tempoloom decision: built. It lists each occurrence kept in conflict with
    its time, and each period with no time. Its time is a setting ("Send daily
    emails at", default 07:00), shared with the new recurring meeting email.
36. Guest update emails for moves and cancellations follow
    `planning-notifications.md` NTF-20 to NTF-22 (`meetingChangeEmails`,
    `meetingChangeDaysAhead`) (E-0223, E-0125).

### Scheduler and other calendars

37. An automatic move is a scheduler run for the organizer. It reads the
    same inputs as placement (SPEC-MEET-01 rules 11 to 15), including other
    attendees' calendars through stored tokens or the free/busy query.
38. After a move, the scheduler of each attendee of class `user` treats the
    new time as a fixed P1 item and moves that attendee's lower-priority
    managed events (SPEC-MEET-01 rule 27).
39. A booking-link event that takes an occurrence's time never moves. If the
    occurrence cannot move (lock, budget, policy `none`, lead time), it stays
    in conflict with the booking and is flagged (rules 7 to 11).

## Outputs

- Google Calendar: patched instance times; cancelled instances for skip,
  `remove` and delete; series end date on delete; free/busy changes on lock.
- Guest emails from Google per `planning-notifications.md` NTF-20 to NTF-22.
- Planner: lock marker on locked occurrences; warning marker on occurrences
  kept in conflict (E-0176).
- Attention list entries with reason code and up to 3 suggested slots.
- Change log on each occurrence.
- Daily at-risk digest email.

## Edge cases

1. A conflict appears less than `minimumLeadTime` hours before the
   occurrence and no slot exists after the lead time in the period: apply
   `ifNoTime`.
2. Two conflicts on the same day and policy `conservative`: the first moves
   the occurrence; the second is flagged (budget reached).
3. The organizer declines a locked occurrence: legacy evidence unlocks and
   moves it (rule 3).
4. The organizer moves an occurrence into another period: Tempoloom keeps
   it, locks it, and does not place a second occurrence in the target
   period (Proposed).
5. The organizer deletes the whole series in Google Calendar: Tempoloom
   treats it as delete without guest emails and keeps the rules disabled
   (Proposed).
6. An attendee removes the occurrence from the attendee's own calendar
   without declining: no change (Proposed).
7. The auto-lock run time falls in a daylight-saving gap: run at the next
   valid local minute (Proposed).
8. Disable, then enable in the same period: Tempoloom places a new
   occurrence for the current period if a slot exists after the lead time.
9. A priority boost makes the occurrence displace a managed event that the
   user ranked higher: the boosted priority wins, because priority is
   compared before rank.

## Observed API shapes

Not yet observed.

## Open questions

1. For an adopted series (current version), does disable or delete cancel
   future occurrences, or only stop management and leave the series as a
   normal recurring event? Proposed: ask the user; the default is "stop
   managing and keep the series".
2. Default values of `minimumLeadTime` and `ifNoTime` in the current
   version.
3. Is the move budget per meeting or per occurrence, and is the 24-hour
   window rolling or fixed?
4. Which `autoLock` values does the current version offer, and at which
   local time does it lock? (Shared with `planning-locks.md`.)
5. Does the current version keep the priority boost? Does a user skip count
   as a missed period?
6. Does any edit in Google Calendar lock an occurrence, or only a time
   change? E-0108 (legacy) says any change locks the event.
7. Does the reschedule action still exist in the current version, and which
   options does it offer?
8. How many suggested slots does a flag show, and from which hours?
9. Can an attendee in a group meeting reschedule or skip?

## Acceptance tests

Test accounts and settings are the same as in SPEC-MEET-01. Meeting "Sync
A-B" is weekly on Tuesday 10:00 to 10:30, guest B, P2, policy `moderate`,
`minimumLeadTime` 0, `autoLock` `off`, `ifNoTime` `keepConflicting`.

1. Decline moves the occurrence
   - Setup: "Sync A-B" placed for next Tuesday 10:00.
   - Action: B declines next Tuesday's instance in Google Calendar; sync.
   - Expected: the instance moves to another free slot in that week, and B
     is invited to the new time. The change log has reason `declined`.
   - Reload: the new time and the log entry persist after reload.
2. Manual move locks
   - Setup: as test 1, before the decline.
   - Action: A drags the instance to Wednesday 14:00 in the Planner.
   - Expected: Google shows the instance on Wednesday 14:00 to 14:30, busy.
     Then create a busy event for A on Wednesday 14:00; sync. The instance
     does not move.
   - Reload: the instance is still on Wednesday 14:00 and locked.
3. Skip by delete
   - Setup: "Sync A-B" placed for the next two Tuesdays.
   - Action: A deletes next Tuesday's instance in Google Calendar; sync.
   - Expected: no instance in next week. The instance in the week after is
     unchanged. The period shows as skipped with reason `manualSkip`.
   - Reload: same state after reload.
4. Move budget
   - Setup: policy `conservative`.
   - Action: create B's busy event at the current instance time; sync. Then
     create another B busy event at the new time; sync.
   - Expected: the first sync moves the instance. The second sync does not
     move it; the attention list shows reason `budgetReached` with
     suggested slots.
   - Reload: same state after reload.
5. Policy none suggests and applies
   - Setup: policy `none`. Create B's busy event at 10:00 next Tuesday.
   - Action: sync; then apply the first suggested slot.
   - Expected: after sync the instance stays at 10:00 and is flagged. After
     applying, the instance is at the suggested time and locked.
   - Reload: same state after reload.
6. Remove when no time
   - Setup: `ifNoTime` `remove`. A has busy external events covering all
     meeting hours next week.
   - Action: sync.
   - Expected: next week's instance is cancelled; reason `noFreeSlot`.
   - Reload: the instance is still cancelled after reload.
7. Keep conflicting when no time
   - Setup: as test 6 with `ifNoTime` `keepConflicting`.
   - Action: sync.
   - Expected: the instance stays at 10:00 with a warning marker in the
     Planner and an attention-list entry.
   - Reload: same state after reload.
8. Lead time
   - Setup: `minimumLeadTime` 12. Today, at least 13 hours before an
     occurrence that is today or tomorrow, create a conflict for B at the
     occurrence time.
   - Action: sync.
   - Expected: the new start is at least 12 hours after the sync time.
   - Reload: same state after reload.
9. Auto-lock
   - Setup: `autoLock` `day`; an occurrence today after the lock run.
   - Action: create B's busy event at the occurrence time; sync.
   - Expected: the occurrence does not move; it is flagged `lockedConflict`.
   - Reload: same state after reload.
10. Delete with notification choice
    - Setup: "Sync A-B" with occurrences in the next 3 weeks and 1 past
      occurrence.
    - Action: delete the meeting in Tempoloom and choose "do not notify".
    - Expected: no future instances on A's or B's calendar; the past
      instance remains; B got no cancellation email.
    - Reload: the meeting is gone from the rules list after reload.
