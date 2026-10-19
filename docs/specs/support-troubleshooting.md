# Troubleshooting, diagnosis and event history

Spec id: SPEC-SUPPORT-01
Evidence: E-0159 (ev_d04a46f0a50a), E-0221 (ev_17e14c8c5999), E-0213 (ev_d480d5778567), E-0140 (ev_e2f7ecfc412e), E-0224 (ev_ce8adc3fab27), E-0117 (ev_55dd368fbb66), E-0219 (ev_ce66f6da76cc), E-0100 (ev_fdd737785142), E-0128 (ev_afe6c26b79bd), E-0160 (ev_a0598dea5be2)
Status of evidence: public docs only

## Summary

Users need a way to find out why an event did not appear, appeared twice, or
came back after they deleted it. Tempoloom gives a troubleshooting index, a
re-sync action, a way to look up one event by its calendar link, and a
history of what Tempoloom did to each event. It also explains the problems
that come from the calendar provider or the device, not from Tempoloom.

## Concepts and inputs

- **Event link**: the URL of the provider's edit page for one event.
- **Diagnosis view**: a Tempoloom page that shows what Tempoloom knows about
  one event.
- **Change log**: Tempoloom's record of each write it made to a calendar
  event.

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| diagnosis input | string | empty | An event link or a provider event id. |
| change log retention | days | Proposed default: 90 | 30 to 365. Proposed. |

## Behavior

### Troubleshooting index

1. A help page lists common problems in groups: flexible meetings, booking
   links, calendar mirroring, focus time, tasks, buffers and settings and
   colors, general, and support contact. Each entry links to a page with the
   fix (E-0159).
2. The mirroring group has entries for: missing copies,
   duplicates, missing details, and repairing one event (E-0159).
3. The general group has entries for: an item that does not get placed,
   events placed at the wrong hours, chat status not set, and alerts on
   Apple devices (E-0159).

   Tempoloom decision: the help page is `/help`, with one page per entry at
   `/help/<topic>`. The general group also links "Events come back after you
   delete them" (rules 19-20), "Turn off other scheduling tools"
   (`platform-current-version.md` rule 17) and the event lookup. It has no
   entry for chat status, because the Slack status sync is not built.
4. The last group says how to contact support (E-0159). Proposed for a
   self-hosted install: a link that the operator sets, with the project
   issue tracker as default.

   Tempoloom decision: the operator sets the link with the environment
   variable `SUPPORT_URL`. Without it, the group tells users to ask the
   person who runs the server; the project has no public issue tracker
   address yet.

### Mirroring not working: first steps

5. The help page for missing copies gives this order (E-0221):
   1. Turn the policy off, wait a few minutes, and turn it on again. This
      runs a full reconcile (see `sync-calendar-mirroring.md` rule 9).
   2. If the problem stays, send the event link to support.
6. The help page warns that fast, repeated toggles can make the provider slow
   down the account (E-0128, E-0221).

### Look up one event

7. The diagnosis view accepts an event link or an event id and finds the
   event (E-0221, E-0213). Implementation note, not from the evidence: on
   Google, the last path segment of the edit link is a base64 string of the
   event id and the calendar id, separated by a space.

   Tempoloom decision: on a CalDAV server the event link is the address of
   the event object (it ends in `.ics`). The view also accepts the object
   name alone, a provider event id, and the id of an event in the planner.
   The page is `/help/lookup?q=<link or id>`, so a lookup can be linked and
   survives a reload. It reads Tempoloom's copy of the calendar; it does not
   ask the provider.
8. When the event was deleted, the help text tells the user to restore it
   from the provider's trash first, to get its link (E-0213).
9. Proposed: the diagnosis view shows:
   - whether Tempoloom manages the event, and which item or mirroring
     policy it belongs to;
   - for a source event, each policy and the copy-decision rule that
     decided (copied, or skipped and why);
   - for a copy, its source event and policy;
   - the last sync time and the last error.
10. Proposed: the diagnosis view has a "repair" action that re-runs the copy
    decision for that one event and writes the result. (The reference has a
    repair button in its calendar add-on, E-0160, legacy evidence.)

### Event history

11. In Google Workspace, an admin can search the calendar audit log by event
    id. Each entry shows which app changed the event (E-0213). Tempoloom
    uses an OAuth client display name of "Tempoloom", so these entries name
    it. Proposed.
12. Proposed: Tempoloom writes a change log entry for each create, update and
    delete it makes on a calendar event. Each entry has: time, event id,
    calendar id, action, the item or policy, the reason (for example
    "source moved" or "copy restored"), and the acting user (owner or
    delegate). The diagnosis view shows the entries for the event.

    Tempoloom decision: the reasons are "placed", "moved", "details changed",
    "no longer planned" and "event restored" for planned events; "source
    copied", "source moved", "source changed", "source removed" and "copy
    restored" for copies; "moved in the planner" for a drag; and "applied
    from preview mode". The entry also keeps the event's title and time.
    The acting user is named when it is a delegate. Retention is a fixed 90
    days; there is no setting yet.

### Invitations hidden by Google anti-spam (legacy evidence)

13. Google can keep invitations from unknown senders off the attendee's
    calendar until the attendee accepts by email, and the invitation email
    can land in spam (E-0140). (legacy evidence)
14. Tempoloom does not set an invitee's response to "accepted" on events
    that people book through a booking link. The invitee answers in their
    own calendar (E-0140). (legacy evidence)
15. The help text explains the fix (E-0140) (legacy evidence):
    - In Google Calendar event settings, set automatic adding of invitations
      to "from everyone".
    - Ask attendees to make the same change.
    - When Google shows an unknown-sender notice on an invitation, choose
      the option that marks the sender as known.
16. The help text points to the booking-link reminder email, which reaches
    attendees even when the invitation is hidden (E-0140). The booking link
    spec owns the reminder email.

### Alerts for copies on Apple devices

17. Copies never alert (see `sync-calendar-mirroring.md` rule 30). Apple
    Calendar can still alert, because its device-wide default alert time
    can override the event setting (E-0224).
18. The help text gives the device fix (E-0224):
    1. In the device calendar settings, set the default alert time for
       events to none.
    2. Turn off the calendar account on the device and delete its local
       data.
    3. Turn the calendar account on again and wait for the full download.

### Events that come back after delete

19. When the user deletes a managed event (habit, focus time, task chunk) in
    the calendar app, Tempoloom treats it as a skip for that time and places
    the item at another time (E-0117). `planning-scheduler.md` owns this
    rule.
20. The help text says how to stop an item for good (E-0117):
    - Habit: delete or turn off the habit.
    - Focus time: turn focus time off.
    - Task: delete it (Tempoloom removes all its events, past ones too) or
      mark it done (past events stay).
    - Mirrored copy: decline or delete the source event, or add
      `#tl_nosync` to it.

### Details missing on copies

21. The help text covers missing details for copies (E-0219). See
    `sync-calendar-mirroring.md` rules 44 to 46.

## Outputs

- Troubleshooting help index with grouped links.
- Diagnosis view and repair action (Proposed).
- Change log entries per event (Proposed).
- Help texts for provider and device problems.

## Edge cases

1. A pasted link from another provider, or a malformed link: the diagnosis
   view says it cannot read the link and asks for the event id.
2. An event link for a calendar that is not in any added account: the view
   says Tempoloom cannot see that calendar.
3. An event that Tempoloom never touched: the view says Tempoloom does not
   manage it, and lists which connected calendar it is on, if any.
4. A change log entry for an event that the user later deleted: the entry
   stays until the retention period ends.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version have a diagnosis or repair feature in the web
   app, or only in the calendar add-on?
2. Does the reference show users any history of its changes?
3. Does the current version still avoid accepting booked events for the
   invitee (rule 14)?
4. What does the current troubleshooting index contain? The captured page is
   from late 2025.

## Acceptance tests

Common setup: Google test account G1 is the main email of user U1, with main
calendar M. G2 is added, with primary calendar P2. Policy P2 to M exists,
label only. "Reload check" means reload the web app and read the state
again.

### AT-1 Look up a copy by its link

1. Setup: on P2, create "Dentist" tomorrow 10:00 to 11:00, busy. Wait for
   the copy on M.
2. Action: in Google Calendar, open the copy's edit page, copy the URL, and
   paste it into the diagnosis view.
3. Expected: the view shows that the event is a copy, names the policy
   P2 to M, and names the source event "Dentist" on P2.
4. Reload check: the same result after reload.

### AT-2 Skipped event shows its reason

1. Setup: on P2, create "Gym #tl_nosync" tomorrow 07:00 to 08:00.
2. Action: paste the source event link into the diagnosis view.
3. Expected: the view shows that policy P2 to M skipped the event because of
   the no-sync tag.
4. Reload check: same after reload.

### AT-3 Change log after a source move

1. Setup: AT-1 state.
2. Action: move "Dentist" to 14:00 to 15:00. Wait for sync.
3. Expected: the copy's change log has an "update" entry with the reason
   "source moved" and the new time.
4. Reload check: the entry is still there after reload.

### AT-4 Re-sync restores a deleted copy

1. Setup: AT-1 state.
2. Action: delete the copy on M in Google Calendar. Turn the policy off,
   wait 3 minutes, and turn it on.
3. Expected: the copy is back on M within 2 minutes after the policy is on.
4. Reload check: the copy is on M after reload.

### AT-5 Booked invitee is not auto-accepted

1. Setup: U1 has a booking link. G3 is not a Tempoloom user.
2. Action: book a slot as G3.
3. Expected: on the event on M, the attendee G3 has response status
   `needsAction`, not `accepted`.
4. Reload check: same status after reload.
