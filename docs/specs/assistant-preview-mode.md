# Preview mode

Spec id: SPEC-ASSIST-02
Evidence: E-0158 (ev_5682619fc975), E-0133 (ev_05d15af3feda), E-0183 (ev_000dae433420), E-0043 (ev_d7b30359b03e), E-0022 (ev_e1d1358af158), E-0148 (ev_e7b99cd896e0)
Status of evidence: public docs only

## Summary

Preview mode is a sandbox for the calendar. Changes proposed by assistant
chat, by connected AI tools, or by a new or edited automation are staged
first. The planner shows what the week would look like. The user accepts or
discards each change, then confirms a final list. Only then does Tempoloom
write to the calendar and notify attendees. The integration specs call this
feature the "change preview"; it is the same thing.

## Concepts and inputs

### Staged change

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `source` | enum `assistant_chat`, `mcp_client`, `automation_edit`, `manual` | Who proposed it. |
| `kind` | as in `assistant-chat.md` | |
| `target` | id or empty | |
| `before` | snapshot | Values at staging time. |
| `after` | values | |
| `state` | enum `pending`, `accepted`, `discarded`, `applied`, `failed`, `stale` | |
| `created_at` | timestamp | |

### Preview mode switch

| Field | Type | Default |
|---|---|---|
| `preview_on` (per user, per planner session) | boolean | off; turns on when a change is staged (proposal) |

Tempoloom decision: `preview_on` is stored per user, so every planner session
of the user sees the same switch. A staged change turns it on. Preview mode
that a staged change turned on turns off again when no change is left to
review; preview mode the user turned on by hand stays on until the user
turns it off.

## Behavior

### Staging

1. Every change from assistant chat, from an MCP client, or from creating or
   editing an automation becomes a staged change in state `pending`. Nothing
   is written to the calendar at this point.
2. When the user creates or edits an automation, the system stages the
   calendar impact of that automation (the managed events it would create,
   move or delete).

   Tempoloom decision: creating or editing a habit, focus time goal or buffer
   (including turning it on or off) is staged only while preview mode is on;
   with preview mode off the change applies at once, as before. The impact is
   the difference between the plan the scheduler makes now and the plan it
   would make with the change, computed without saving anything. Apply saves
   the automation through the same action as the form, and the next plan
   writes its events.
3. The user can turn preview mode on by hand. While it is on, manual edits
   in the planner become staged changes with `source = manual` (proposal;
   the evidence shows a toggle and a "try a change in preview" step).

   Tempoloom decision: in preview mode, dragging a planned event in the
   planner is staged. Other planner actions (lock, skip, mark done, category)
   apply at once.

### Display

4. With preview mode on, the planner shows the week with staged changes
   applied, and marks each changed event so the user can tell staged from
   live (proposal for the marking: dashed outline for new or moved events,
   strike-through for deleted events).
5. Each staged change shows its reason, if the source gave one.

### Decision

6. For each pending change the user can accept it, discard it (other
   changes stay), or reply in assistant chat to ask for a different change.

   Tempoloom decision: the planner shows each change's source ("AI tool"
   with the API key's name, "Automation edit", "Your edit"), its reason and
   the number of calendar events it creates, moves and removes. A change from
   assistant chat has "Reply in chat", which opens the chat panel with a reply
   about that change in the draft.
7. A "Review and apply changes" action opens a final list of all accepted
   and pending changes. In that list the user can remove single items, then
   confirm.

   Tempoloom decision: removing an item from the final list discards it. To
   keep a change for later, close the list without confirming.
8. On confirm, the system writes the changes to the calendars and
   automations, in the order they were staged, and sets each to `applied`.
9. Attendee invitations, updates and cancellations go out only at step 8.
   Staging never notifies anyone.

   Tempoloom decision: CalDAV servers do not have to deliver invitations, so at
   apply Tempoloom sends each guest of a created, moved or deleted event one
   plain email through the instance's SMTP server ("Invitation", "Updated" or
   "Cancelled", with the time in the organizer's time zone). It asks the
   calendar provider not to send its own.
10. Closing the review, or turning preview mode off, leaves the changes
    pending. Pending changes stay for later.
11. Proposed: pending changes persist across reloads and browser restarts
    for 7 days, then expire and are deleted. (The reference FAQ asks whether
    changes survive closing the browser; the answer is not captured.)

### Validity

12. Before writing a change, the system checks that the target still
    matches `before`. When it does not, the change becomes `stale`, is not
    written, and the user sees which changes were skipped and why.

    Tempoloom decision: apply reads the calendars first. An event matches
    when its start, end and title are as they were at staging time; a
    planned event matches when Tempoloom has not moved it since; an
    automation matches when its rules have not changed since.
13. When a write fails (for example a calendar API error), the change becomes
    `failed` and the user sees the error. Other changes still apply.

## Outputs

- Planner overlay of staged changes.
- Final review list.
- Calendar writes and attendee notifications at confirm time only.
- A summary after apply: applied, skipped as stale, failed.

## Edge cases

1. The same event has two staged changes: proposed, the later one replaces
   the earlier one in `pending` state.
2. An automation runs while changes are pending (normal rescheduling): see
   open question 1. Proposed: automations keep running on live data; staged
   changes that touch an event an automation moved become `stale`.
3. A staged event creation overlaps a live event created after staging: it
   still applies; the conflict appears in the next review.
4. The user deletes a staged-created event's automation before apply: the
   change becomes `stale`.
5. Two planner sessions of the same user: both show the same pending
   changes; the first confirm wins.

## Observed API shapes

Not yet observed.

## Open questions

1. Do automations run while preview mode is on? The FAQ asks this; the
   answer is not captured.
2. Does preview mode have limits (number of changes, time)?
3. How are staged changes marked in the reference planner?
4. Do pending changes survive closing the browser?
5. Is the order of writes at apply time significant in the reference?

## Acceptance tests

Common setup: Google test account U with assistant chat on and a 60-minute
meeting tomorrow 10:00 to 11:00 with attendee V (another test account).

### T1. Staging writes nothing and notifies no one

- Setup: common setup.
- Action: U asks assistant chat to move tomorrow's meeting to 14:00.
- Expected calendar state: Google Calendar for U and V still shows the
  meeting at 10:00. V has no update email.
- Reload check: after reload, preview mode shows the staged move to 14:00.

### T2. Apply writes and notifies

- Setup: T1 done.
- Action: U accepts the change, opens review and apply, confirms.
- Expected calendar state: the meeting is at 14:00 on both calendars. V
  gets one update.
- Reload check: after reload, no staged changes remain.

### T3. Remove one item in the final list

- Setup: common setup. U asks to create two focus events tomorrow (09:00 to
  10:00 and 15:00 to 16:00).
- Action: U opens review and apply, removes the 15:00 item, confirms.
- Expected calendar state: only the 09:00 event exists on Google Calendar.
- Reload check: same after reload.

### T4. Pending changes survive reload

- Setup: common setup. U asks to delete tomorrow's meeting and closes the
  review without applying.
- Action: U closes the browser, opens it again, opens the planner.
- Expected calendar state: the meeting still exists on Google Calendar.
- Reload check: the staged delete is still pending (proposed rule 11).

### T5. Stale change is skipped

- Setup: common setup. U stages a move of the meeting to 14:00.
- Action: U moves the meeting to 16:00 directly in Google Calendar (outside
  Tempoloom). Then U applies the staged change in Tempoloom.
- Expected calendar state: the meeting stays at 16:00.
- Reload check: after reload, the apply summary listed the change as
  skipped (stale), and no staged change remains.

### T6. New automation shows its impact first

- Setup: U has no habits.
- Action: U creates a daily habit "Walk", 30 minutes, from the automation
  form.
- Expected calendar state: no "Walk" events on Google Calendar before
  apply; after apply, one "Walk" event per day in the scheduling window.
- Reload check: after reload, the habit exists and its events are on the
  calendar.
