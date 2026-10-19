# Calendar mirroring

Spec id: SPEC-SYNC-01
Evidence: E-0053 (ev_4544cc9fe82d), E-0064 (ev_b0d6bf1dfe89), E-0084 (ev_ee3af4976965), E-0091 (ev_c47ae0c39522), E-0128 (ev_afe6c26b79bd), E-0202 (ev_1847c23db93e), E-0208 (ev_1ea7d141b6ff), E-0100 (ev_fdd737785142), E-0058 (ev_acd07768510e), E-0109 (ev_2aae067eff33), E-0059 (ev_43fd142018d9), E-0086 (ev_d7e7264ef13c), E-0126 (ev_ca8ff3917d0d), E-0117 (ev_55dd368fbb66), E-0219 (ev_ce66f6da76cc), E-0221 (ev_17e14c8c5999), E-0224 (ev_ce8adc3fab27), E-0188 (ev_efb8d0523b4e), E-0008 (ev_818c3198e239), E-0203 (ev_6fcb5f8189d7), E-0074 (ev_b5ca2d13ca39), E-0003 (ev_fdf25af08b9c), E-0029 (ev_2cd9b977c6e8), E-0033 (ev_448e7d295296), E-0104 (ev_173e10d4937f), E-0111 (ev_da4073591415), E-0136 (ev_caafaaaf01b4)
Status of evidence: public docs only

## Summary

Calendar mirroring copies events from one calendar (the source) to another
calendar (the destination). Each copy is a separate event that Tempoloom
writes and keeps up to date. People who look at the destination calendar see
that the user is busy, and by default they do not see what the original event
is about. One mirroring policy works in one direction only. The user
combines policies for two-way setups and for setups with many calendars.

## Concepts and inputs

### Terms

- **Source calendar**: the calendar that Tempoloom reads for a policy.
- **Destination calendar**: the calendar where Tempoloom writes copies for a
  policy.
- **Source event**: an event on a source calendar.
- **Copy**: an event that Tempoloom wrote on a destination calendar for one
  source event under one policy. A copy is a managed event of kind `mirror`.
- **Mirroring policy** (or "policy"): the settings that link a single source
  calendar to a single destination calendar.
- **Source owner**: the person whose calendar is the source. For a person's
  primary calendar this is the account email. For a calendar that is not a
  person (a shared or secondary calendar), there is no source owner.
- **Owner response**: the attendee response of the source owner on a source
  event: `none` (no reply yet), `accepted`, `tentative` or `declined`.

### Policy fields

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `source` | (added account id, calendar id) | none (required) | A calendar that the added account can read and write (rule 5). |
| `destination` | (added account id, calendar id) | none (required) | A calendar that the added account can read and write. Must differ from `source`. Must not be the main calendar of another Tempoloom account (rule 4). |
| `calendar_type` | enum | Proposed default: `personal` | `business`, `personal`, `travel`. Controls copy labels (rule 27) and categories (rule 28). |
| `color_override` | event color id or none | none | One color from the provider's event color list (Google: 11 colors). |
| `visibility` | enum | `label_only` (legacy evidence, E-0074) | `label_only`, `busy_only`, `details_private`, `details_default`. See rule 26. |
| `all_day_mode` | enum | `none` (E-0064) | `none`, `busy_only`, `all`. |
| `copy_outside_work_hours` | bool | Proposed default: `true` | When `false`, only events that touch the user's work hours are copied (rule 20). |
| `enabled` | bool | `true` | Status toggle. |

### Account-level setting

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `no_reply_copies` | enum | `free` (E-0091) | `free`, `busy`. Free/busy of a copy when the owner response is `none`. It lives in general settings, not in each policy. |

### Plan limits in the reference

- Free plan: 1 policy. Paid plans: no limit. One pricing card shows 3
  policies for the lowest paid plan; the comparison table shows no limit
  (E-0003). See open questions.
- Tempoloom decision: Tempoloom has no plans. The operator can set the
  instance limit `max_mirrors` (off by default; see
  `plans-feature-inventory.md`). It counts every policy of a person, on or
  off.
- Free plan: `visibility` is limited to the label option, with the label set
  to the personal or the work label for all copies (E-0064).

## Behavior

### Policy management

1. The user creates a policy in two steps. Step 1: pick the source account
   and calendar, then the destination account and calendar. Step 2: set
   `calendar_type`, `color_override`, `visibility`, `all_day_mode` and
   `copy_outside_work_hours`. A final "start" action saves the policy with
   `enabled = true` (E-0064, E-0202).
2. The account picker lists every added account. The calendar picker lists
   every calendar that the chosen account can see, including calendars that
   other people shared with that account (E-0109).
3. The source and the destination can be in different added accounts and in
   different providers (Google and Microsoft) (E-0053, E-0008).
4. When the chosen destination is the main calendar of another Tempoloom
   account, Tempoloom shows an error and does not save the policy (E-0202).
   Tempoloom decision: the destination is another account's main calendar
   when another Tempoloom account has, as its main email, an account whose
   primary calendar has the same calendar id (on CalDAV, the same calendar
   URL). The policy form shows: "This calendar is the main calendar of
   another Tempoloom account. Choose another destination."
5. Tempoloom must have read and write access to both calendars. The pickers
   do not offer calendars with free/busy-only access (E-0053, E-0106).
6. The policy list shows all policies of the user. One tab per added account
   filters the list to policies where the source or the destination belongs
   to that account. An "All" tab shows every policy (E-0128).
   Tempoloom decision: the tabs follow the order in which the accounts were
   added. A policy is under an account's tab when its source or its
   destination calendar belongs to that account.
7. The user opens a policy to see all its fields. The user can change any
   field and save (E-0128). Proposed: a change of `source` or `destination`
   removes the old copies and creates new copies, as if the policy were
   deleted and created again.
8. The status toggle sets `enabled`. Next to the toggle, Tempoloom shows a
   note that each toggle writes many events and that the user should wait a
   few minutes between toggles, because the provider can slow down the
   account (E-0128).
   Tempoloom decision: the note reads "Each switch writes many events. Wait a
   few minutes between switches."
9. Turning a policy off and on again runs a full reconcile of that policy.
   After the reconcile, every copy matches the current source state
   (E-0221).
10. The edit screen has a delete action at the bottom. Tempoloom asks for
    confirmation and states that delete cannot be undone (E-0128).
11. Onboarding offers to create a first policy, with a single source and a
    single destination (E-0128; E-0188 legacy evidence).
12. A calendar can be the source of many policies and the destination of many
    policies. A set of N calendars where each must block all others needs
    N x (N - 1) policies, because copies never chain (rule 15). Example: 5
    calendars with one private personal calendar that receives nothing needs
    16 policies (E-0058).
13. Settings of two policies are independent. In a two-way setup, the A to B
    policy and the B to A policy can have different types, colors and
    visibility (E-0202).

### Copy decision

For each enabled policy and each source event in the window, Tempoloom
applies rules 14 to 23 in order. The first rule that decides wins.

14. Window: Tempoloom keeps copies for source events that end after the
    current time and start less than 12 months after the current time
    (E-0003 shows a 12-month range for mirroring). Proposed: Tempoloom does
    not create, change or delete copies of events that ended in the past.
    Tempoloom decision: 12 months is 365 days. Tempoloom reads the calendars
    of enabled policies 380 days ahead, whatever the scheduling window.
15. No chaining: skip a source event that is a copy written by Tempoloom
    under any policy. With policies A to B and B to C, events from A do not
    reach C (E-0202).
16. No-sync tag: skip a source event whose title or description contains
    `#tl_nosync` (E-0064, E-0126, E-0203). Google out-of-office events have no
    description, so for them only the title counts (E-0208). Tag matching
    follows the match rule in `events-tags.md`. Proposed: the owner's RSVP
    note also counts, as for the other event tags.
17. Destination already invited: skip a source event when the destination
    calendar id (its email) is an attendee of the source event. The event is
    already on the destination, so a copy would be a duplicate (E-0084).
    Tempoloom decision: the destination's address is its calendar id and, for
    a primary calendar, the email of its account (CalDAV calendar ids are
    URLs, so only the account email can match there).
18. Declined: skip a source event when the owner response is `declined`. If
    a copy exists, delete it (E-0091).
19. All-day events: with `all_day_mode = none`, skip all-day events. With
    `busy_only`, copy an all-day event only when it shows as busy. With `all`, copy
    all all-day events, free or busy (E-0064, E-0084).
20. Work hours: with `copy_outside_work_hours = false`, skip a source event
    that is fully outside the user's work hours (E-0064). Proposed: an event
    that overlaps work hours by 1 minute or more is copied in full.
21. Free/busy of the copy. The first matching line decides:
    1. The provider created the event from an email (such as a flight or
       a restaurant booking found in Gmail): busy, even when the source
       event is free (E-0084).
       Tempoloom decision: an event is made from an email when Google gives
       it the event type `fromGmail`. CalDAV servers have no such type.
    2. The source owner is the organizer and is not in the attendee list:
       busy (E-0091).
    3. The owner response is `accepted` or `tentative`: busy (E-0091).
    4. The owner response is `none`: the value of `no_reply_copies`, default
       free (E-0091).
    5. All other cases: the free/busy of the source event (E-0084).
22. Free events and private labels: when line 21.5 gives free and
    `visibility` is `label_only` or `busy_only`, skip the event. With
    `details_private` or `details_default`, copy the event as free (E-0084).
23. In all other cases, create the copy, or update it when it exists.

### Copy appearance

24. Time: the copy has the same start, end and time zone as the source event.
    A copy of an all-day event is an all-day event (E-0053).
25. Free/busy: from rule 21.
26. Content by `visibility` (E-0064, E-0074, E-0008):

    | `visibility` | Title | Description, location, conference | Provider visibility |
    |---|---|---|---|
    | `label_only` | Label from rule 27 | None (marker only, rule 32) | public |
    | `busy_only` | `Busy` | None (marker only) | Proposed: default (see open questions) |
    | `details_private` | Source title | Copied from source | private |
    | `details_default` | Source title | Copied from source | default (the calendar's sharing decides) |

    With `details_private`, people who have "make changes" rights on the
    destination calendar, and domain admins, can still see the details. The
    policy form shows a warning about this (E-0064, E-0100).
27. Label table for `label_only`. Rows are the category of the source event
    (from the automatic category rules). Columns are the policy
    `calendar_type` (E-0064):
    Tempoloom decision: the source category comes from the automatic
    category rules on the source event itself (its title, description, event
    type and guests), or from a category the user set on that event. The
    policy's calendar type does not change it. "Meeting" means team meeting,
    one-on-one or external meeting; "Vacation" is out-of-office time longer
    than 8 hours.

    | Source category | `personal` | `business` | `travel` |
    |---|---|---|---|
    | Vacation | PTO | (no entry) | (no entry) |
    | Travel | Travel | Travel | Travel |
    | Flight | Flight | Flight | Flight |
    | Meeting | (no entry) | Meeting | (no entry) |
    | Solo work | (no entry) | Work commitment | (no entry) |
    | Any other | Personal commitment | Work commitment | Travel |

    Proposed: a "(no entry)" cell uses the "Any other" row of the same
    column.
28. `calendar_type` limits the categories that the color rules can give to
    copies (E-0064):
    - `business`: one-on-one, external meeting, solo work, travel and
      logistics.
    - `personal`: personal, travel and logistics.
    - `travel`: travel and logistics.
29. Color: when `color_override` is set, every copy of the policy gets that
    color and the color rules do not run for these copies. Tempoloom still
    stores the category of each copy for stats (E-0064). When
    `color_override` is not set, the color rules decide.
30. Reminders: a copy never alerts the user. On Google, set
    `reminders.useDefault = false` with no overrides (E-0224).
    Tempoloom decision: when a copy gets an alert on the calendar (a CalDAV
    VALARM, or Google reminders), Tempoloom writes the copy again without it
    on the next sync.
31. Proposed: a copy has no attendees, and Tempoloom sends no invitation or
    update email for a copy. (The evidence says only that copies never
    notify.)
32. The copy description contains a line that says Tempoloom created the
    event (E-0188, legacy evidence). Proposed text: "Copy made by Tempoloom.
    Change the original event, not this copy." Proposed: Tempoloom stores
    the policy id, source calendar id and source event id in private
    extended properties of the copy, and never shows them to others.
33. The Planner shows a copy and its source event to the owner as one item,
    with the source details (E-0100). The calendar add-on shows, for a copy,
    the source title and a link that opens the source event (E-0100; E-0136
    legacy evidence).
34. Copies and other events on connected calendars count as P1 for the
    scheduler, and the user cannot change that priority (E-0104, legacy
    evidence). See `accounts-connected-calendars.md`.

### Updates and deletes

35. When a source event changes (time, title, description, location,
    free/busy, owner response, tags), Tempoloom updates the copy (E-0053,
    E-0188). The reference describes near real-time updates (E-0008, E-0029,
    E-0033). Proposed: a copy matches its source no later than 2 minutes
    after the source change. Use provider push notifications plus
    incremental sync.
36. When a source event is deleted or cancelled, Tempoloom deletes the copy
    (E-0188, legacy evidence).
37. When a source event stops matching a skip rule (for example the owner
    changes the response from `declined` to `accepted`), Tempoloom creates
    the copy (E-0126). Proposed: when a source event starts to match a skip
    rule (for example the user adds `#tl_nosync`), Tempoloom deletes the
    existing copy.
38. The source event is the source of truth. When the user changes or deletes
    a copy on the destination calendar, Tempoloom puts the copy back in the
    state that the source and the policy give. This happens no later than
    the next full reconcile (E-0100, E-0117, E-0126).
39. A full reconcile of all enabled policies runs twice a day (E-0126). It
    compares every source event in the window with every copy and creates,
    updates or deletes copies to match.
    Tempoloom decision: the interval is the operator setting
    `MIRROR_RECONCILE_SECONDS` (default 43200, twice a day). The full
    reconcile reads every calendar of an enabled policy in full and also puts
    back the time and color of each copy; a normal sync puts back the title,
    description and free/busy at once. Turning a policy on (rule 9) starts a
    full reconcile on the next run. The settings page shows the time of the
    last full reconcile.
40. To remove a copy for good, the user declines or deletes the source
    event, or adds `#tl_nosync` to it (E-0117, E-0126). The help text and the
    copy description (rule 32) tell the user this.
41. Proposed: when the user turns a policy off, Tempoloom deletes its copies
    in the window. When the user turns it on, Tempoloom creates them again
    (rule 9). The evidence implies this because a toggle writes many events
    (E-0128).
42. Proposed: when the user deletes a policy, Tempoloom deletes its copies
    in the window.
43. When the user saves new policy settings, Tempoloom rewrites the existing
    copies to match, for example the new color or label (E-0064: changes
    show "in a few moments").

### Source details and external calendars

44. The reference can share a source calendar with the user's main account,
    so the user can open source details from the main calendar view
    (E-0219). The trigger is not in the evidence (see open questions).
45. When the source calendar is in a Google Workspace domain whose external
    sharing setting blocks details, the user sees only busy blocks for the
    shared source. The help text tells the user to ask the domain admin to
    allow external sharing of full details (E-0219).
46. Events that Gmail created on the source calendar show details to others
    only when the source calendar's Gmail-event visibility setting allows it.
    The help text names this setting (E-0219).
47. Calendars hosted by other services (for example iCloud) work only after
    the user adds them to a Google or Microsoft account. Changes from such
    calendars can arrive many hours late. Tempoloom has no control over
    this delay and says so in the help text (E-0053, E-0059).

## Outputs

- Copies on destination calendars, as described in rules 24 to 33.
- Deleted copies when rules 18, 36, 37, 41 or 42 apply.
- Policy list with account tabs, status toggle per policy, and the toggle
  warning (rules 6 and 8).
- Error message when the destination is the main calendar of another
  Tempoloom account (rule 4).
- Warning in the policy form for `details_private` and `details_default`
  (rule 26).
- No notifications for copies (rule 30).

## Edge cases

1. Two-way setup (A to B and B to A): an event on A gets one copy on B. That
   copy does not come back to A (rule 15).
2. A source event that already has the destination calendar as attendee gets
   no copy (rule 17). This avoids a duplicate in a two-way setup between two
   people's primary calendars.
3. One source with three destinations: each destination gets one copy per
   source event.
4. Three sources into one destination: the user can set a different
   `color_override` on each policy to tell copies apart (E-0064).
5. Recurring source events: see open questions. Proposed: one copy per
   instance inside the window, so that instance changes and declines map
   one to one.
6. A source event changes from timed to all-day, or the reverse: re-run the
   copy decision. Delete the copy if `all_day_mode` now skips it.
7. A source event moves out of the 12-month window: delete its copy.
8. The destination becomes read-only, or the added account loses its tokens:
   the policy shows an error state and Tempoloom stops writes for it.
   Proposed.
9. The user removes an added account: its calendars can no longer be used in
   policies (E-0041). Proposed: Tempoloom turns off and deletes every policy
   that uses one of its calendars, and deletes copies it can still reach.
10. Many fast toggles: the provider can throttle writes. Tempoloom retries
    with backoff and shows the policy as "catching up" (E-0128). Proposed.
11. A source on a shared family calendar puts other family members' events
    on the work calendar. The user declines events that do not concern them,
    or the family adds `#tl_nosync`; the copy goes away and does not come
    back (E-0126).
12. Apple Calendar on a phone can show alerts for copies because a device
    default alert setting overrides the event setting. This is outside
    Tempoloom. The help text gives the device fix (E-0224).
13. A source calendar with no person behind it (a shared team calendar): there is
    no owner response, so rule 21 uses line 21.5.
14. Proposed: Tempoloom rejects a policy whose source equals its destination,
    and a second policy with the same source and destination as an existing
    one.
    Tempoloom decision: the message names both calendars: "A mirroring
    policy from Private to Work already exists."
15. A source event that is private on the source calendar, with
    `details_default`: see open questions. Proposed: copy it as
    `details_private` so that a private event never becomes visible by
    mirroring.
16. A user sees duplicates when the source and the destination are both
    shown in the calendar app. This is by design (E-0100). The help text
    suggests hiding the source calendar in the calendar app.
    Tempoloom decision: the mirroring section of Settings shows three tips:
    how a copy goes away for good (rule 40), the family calendar case (edge
    case 11) and this duplicate view.
17. An out-of-office event on the vacation calendar mirrored into the main
    calendar counts as time off only when `all_day_mode` lets it through
    (E-0111).

## Observed API shapes

Not yet observed.

## Open questions

1. Recurring source events: does the reference write one recurring copy or
   one copy per instance? What happens to a copy when one instance is moved
   or declined?
2. Does a copy with no owner response (rule 21.4, free) also get skipped
   under `label_only` and `busy_only` like other free events (rule 22)? The
   two help pages do not agree on this case.
3. With `all_day_mode = all` and `label_only`, does a free all-day event get
   a free copy, or does rule 22 skip it?
4. `busy_only`: is the copy title exactly "Busy", and is its provider
   visibility public, default or private?
5. What happens to existing copies when a policy is turned off or deleted?
   Rules 41 and 42 are proposals.
6. Default `calendar_type` and default `copy_outside_work_hours` in the
   current version.
7. For `copy_outside_work_hours = false`, how is an event that crosses the
   edge of work hours treated? Which hours set counts as "working hours"?
8. Does adding `#tl_nosync` to an event that already has a copy delete the
   copy? Does the no-sync tag also work in the RSVP note, like the other
   event tags (E-0203)?
9. Exact text of the creator marker in the copy description in the current
   version. Does the copy contain a link back to the source?
10. When and how does the reference share a source calendar with the main
    account (rule 44)? Is it automatic, or a user choice?
11. Exact free plan limits: 1 policy on the free plan; 3 or unlimited on the
    lowest paid plan (E-0003 conflicts with itself).
12. How fast does a changed or deleted copy come back: at once, or only at
    the twice-daily reconcile?
13. How does the reference treat Google out-of-office and focus-time event
    types in the source: as normal busy copies, or as the same event type?
14. Does the "private event on source" case (edge case 15) copy details?
15. Does the reference copy past events, and how far back?

## Acceptance tests

Common setup for all scenarios:

- Google test account G1 is the main email of Tempoloom user U1. M is the
  primary calendar of G1 (the main calendar).
- Google test account G2 is added to U1. P2 is the primary calendar of G2.
- Google test account G3 is not added to U1. G3 sends invitations.
- U1 work hours: Monday to Friday, 09:00 to 17:00, in the account time zone.
- "Wait for sync" means: poll the Google Calendar API every 10 seconds for
  up to 2 minutes (Proposed SLA, rule 35).
- "Reload check" means: reload the Tempoloom web app and fetch the events
  again from the Google Calendar API, then compare.

### AT-1 Create a policy and copy a busy event as a label

1. Setup: no policies. Create policy P2 to M with `calendar_type =
   personal`, `visibility = label_only`, all other fields default.
2. Action: on P2, create "Dentist", tomorrow 10:00 to 11:00, busy.
3. Expected: after wait for sync, M has exactly one new event, tomorrow
   10:00 to 11:00, title "Personal commitment", busy (opaque), visibility
   public, no location, no attendees, `reminders.useDefault = false` with no
   overrides, and a description with the creator marker. P2 is unchanged.
4. Reload check: the policy shows in the list as on. M still has exactly one
   copy. The Planner shows one item at 10:00 with the title "Dentist".

### AT-2 Source changes and deletion

1. Setup: AT-1 done.
2. Action: move "Dentist" to tomorrow 14:00 to 15:30 and change its title to
   "Dentist checkup". Wait for sync. Then delete "Dentist checkup" on P2.
3. Expected: after the move, the copy on M is at 14:00 to 15:30 and its
   title is still "Personal commitment". After the delete, the copy is gone
   from M.
4. Reload check: M has no copy for this event after reload.

### AT-3 Free events and visibility

1. Setup: policy P2 to M with `label_only`.
2. Action: on P2, create "Read" tomorrow 12:00 to 13:00, free. Wait for sync.
   Then change the policy to `details_private` and save. Wait for sync.
3. Expected: with `label_only`, M has no copy of "Read". With
   `details_private`, M has a copy titled "Read", free (transparent),
   visibility private, with the source description and location. The
   "Dentist"-style busy copies are rewritten with source titles and private
   visibility.
4. Reload check: values stay the same after reload.

### AT-4 Owner response decides free/busy

1. Setup: policy P2 to M, `details_private`. `no_reply_copies = free`.
2. Action: G3 invites G2 (only G2) to "Vendor call" tomorrow 15:00 to 15:30.
   Wait for sync. G2 answers "maybe". Wait. G2 answers "yes". Wait. G2
   answers "no". Wait.
3. Expected: no reply: copy exists on M and is free. Maybe: copy is busy.
   Yes: copy is busy. No: copy is deleted.
4. Action 2: set `no_reply_copies = busy`. G3 invites G2 to "Sync 2".
5. Expected 2: the copy of "Sync 2" on M is busy.
6. Reload check: after reload, M has the copy of "Sync 2" (busy) and no copy
   of "Vendor call".

### AT-5 All-day modes

1. Setup: policy P2 to M, `details_private`, `all_day_mode = none`.
2. Action: on P2, create all-day "Holiday" (busy) and all-day "Birthday"
   (free), both next Monday. Wait. Set `all_day_mode = busy_only`, save,
   wait. Set `all_day_mode = all`, save, wait.
3. Expected: `none`: no all-day copies on M. `busy_only`: only "Holiday" is
   copied, as a busy all-day event. `all`: both are copied; "Birthday" is
   free.
4. Reload check: the `all` state stays after reload.

### AT-6 No-sync tag

1. Setup: policy P2 to M, `label_only`.
2. Action: on P2, create "Kid pickup #tl_nosync" tomorrow 16:00 to 16:30,
   busy. Create "Gym" tomorrow 07:00 to 08:00, busy, with `#tl_nosync` in
   the description. Wait for sync. Then remove the tag from "Gym". Wait.
3. Expected: no copy of either event on M while tagged. After the tag is
   removed from "Gym", M has its copy.
4. Reload check: M has one copy ("Gym") after reload.

### AT-7 Destination already invited

1. Setup: policy P2 to M.
2. Action: G3 invites both G2 and G1 to "All hands" tomorrow 11:00 to 12:00.
   G2 accepts.
3. Expected: after wait for sync, M has only the invitation event of G1. M
   has no copy of "All hands".
4. Reload check: same after reload.

### AT-8 Two-way setup and no chaining

1. Setup: policies P2 to M and M to P2. Calendar S is a secondary calendar
   of G1, connected.
2. Action: create "Lunch" on P2, busy. Create "Review" on M, busy. Wait.
   Then add policy M to S. Wait.
3. Expected: M has one copy of "Lunch". P2 has one copy of "Review". P2 has
   no copy of the "Lunch" copy, and M has no copy of the "Review" copy.
   After M to S exists, S has a copy of "Review" and no copy of "Lunch".
4. Reload check: counts stay the same after reload and after one full
   reconcile.

### AT-9 Deleted or changed copy comes back

1. Setup: AT-1 state with a fresh "Dentist" event.
2. Action: in Google Calendar, delete the copy on M. In a second run, change
   the copy title to "Free time". Then run the full reconcile job (test hook)
   or wait up to 12 hours.
3. Expected: after the reconcile, the copy exists again on M with title
   "Personal commitment" and the source time.
4. Reload check: the copy is present after reload.

### AT-10 Destination is another account's main calendar

1. Setup: Tempoloom user U3 has G3 as main email. Add G3 to U1 as a
   secondary account.
2. Action: in U1, try to create policy P2 to the primary calendar of G3.
3. Expected: Tempoloom shows an error. No policy is saved. No event is
   written to the G3 primary calendar.
4. Reload check: the policy list of U1 does not contain the policy.

### AT-11 Color override

1. Setup: policy P2 to M with no override and two copies on M.
2. Action: set `color_override` to Google color id 11 and save. Wait.
3. Expected: both copies on M have `colorId = 11`. New copies also get 11.
4. Reload check: colors stay after reload. Stats still show the copies in
   the personal category.

### AT-12 Work-hours limit

1. Setup: policy P2 to M with `copy_outside_work_hours = false`.
2. Action: on P2, create "Dinner" tomorrow 19:00 to 20:00 (busy) and "Call"
   tomorrow 16:30 to 17:30 (busy). Wait for sync.
3. Expected: no copy of "Dinner". "Call" is copied in full, 16:30 to 17:30
   (Proposed overlap rule).
4. Reload check: same after reload.

### AT-13 Turn off, turn on, delete

1. Setup: policy P2 to M with three copies on M.
2. Action: turn the policy off. Wait. Turn it on. Wait. Delete it and
   confirm.
3. Expected: off: the three copies are gone (Proposed, rule 41). On: the
   three copies are back. Delete: the copies are gone and the policy is not
   in the list.
4. Reload check: the policy list is empty after reload. M has no copies.

### AT-14 Shared calendar as source

1. Setup: G3 shares calendar "Team rota" with G2 with "make changes"
   rights.
2. Action: in U1, open the new-policy form and choose account G2.
3. Expected: "Team rota" is in the calendar list. Create policy "Team rota"
   to M. An event on "Team rota" gets a copy on M, and its free/busy comes
   from the event itself (no source owner).
4. Reload check: the policy and the copy stay after reload.
