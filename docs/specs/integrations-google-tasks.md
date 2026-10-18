# Google Tasks integration

Spec id: SPEC-INT-05
Evidence: E-0149 (ev_d29fa94e9488), E-0030 (ev_3222a99a870b), E-0080 (ev_e7c9f46f0550), E-0067 (ev_ba8230fd84c8)
Status of evidence: public docs only

## Summary

The user connects the Google account where their Google Tasks live.
Tempoloom imports the to-dos as tasks and keeps both sides in step: create,
edit, complete, reopen and delete work in both directions. Google Tasks has
few fields, so the user can add duration, priority, hours set and other
values in a title options block. Shared rules are in
`integrations-task-sync.md`.

## Concepts and inputs

Connection (per user and Google account): Google account email, Google
Tasks scope (read and write tasks).

Settings:

| Field | Type | Default | Notes |
|---|---|---|---|
| `lists` | list of Google Tasks list ids | the Tempoloom list only (legacy evidence) | Current version: see rule 3. |
| `no_due_date_mode` | enum `use_default`, `none` | `use_default` (Proposed default) | Legacy evidence. |

Tempoloom list: a Google Tasks list that Tempoloom creates on connect, named
`🗓 Tempoloom`. The reference creates a list with its own name and a
calendar emoji.

Field mapping:

| Google Tasks field | Task field | Direction |
|---|---|---|
| Title (without options block) | Title | two-way |
| Options block in title | Duration, priority, hours set, start-after, next up, no-split, due date | Google Tasks to Tempoloom; block removed after parsing |
| (none) | Priority | Tempoloom to Google Tasks, see rule 11 |
| Due date | Due date | two-way |
| Details (notes) | Notes | two-way |
| Completed | Done state | two-way |
| Deleted | Task deleted | two-way |
| Repeat rule | None (see rule 16) | none |

## Behavior

### Connect

1. The user connects from Settings > Integrations (overview spec rules) and
   grants Google Tasks read and write access. The grant is per Google
   account, not per list.
2. Legacy evidence: on connect, Tempoloom creates the Tempoloom list and one
   sample task in it. Only tasks in that list sync. Tasks in other lists are
   ignored.
3. Current version: the task list shows Google Tasks from the account, and a
   saved task search can filter by Google Tasks list. Proposed default: the
   settings page lets the user pick the synced lists; the Tempoloom list is
   picked by default.
4. Legacy evidence: the user can connect more than one Google account to the
   integration. Each account syncs its own Tempoloom list.
5. Tempoloom advises the user to hide the Google "Tasks" calendar in Google
   Calendar. Otherwise each to-do shows twice: once as a Google task and
   once as a chunk event.

### Import and two-way sync

6. The only required field is the title. The title is also the title of the
   task and of its chunk events.
7. A task created in Tempoloom is also created in the first synced Google
   Tasks list. A to-do created in a synced list is created in Tempoloom.
8. Each field in the mapping table syncs in its direction. Marking done in
   either app marks done in both and removes future chunks. Marking not done
   in either app reopens in both and lets the scheduler place chunks again.
   Deleting in either app deletes in both.
9. Due date: when the to-do has no due date, `no_due_date_mode` decides:
   `use_default` sets the user's default due date; `none` imports with no
   due date.
10. Duration: the options block `duration:` value, or the user's default
    duration.
11. Priority: the options block value, or the user's default priority (P2 in
    the reference). Legacy evidence: a priority change in Tempoloom shows in
    Google Tasks too. This is the only task integration where priority is
    two-way. Google Tasks has no priority field, and the evidence does not
    say where the value goes. Proposed default: Tempoloom keeps one managed
    last line `Priority: P<n>` in the Google task details.
12. After parsing, Tempoloom removes the options block from the Google
    task title (legacy evidence), so that the to-do and the chunk events
    show only the title. To change a value later, the user adds a new block
    and saves; Tempoloom parses it and removes it again. (One legacy page
    tells the user to edit the duration text in place, which suggests the
    text can stay; see open questions.)
13. Hours set: options block `type work` or `type personal`, or the user's
    default hours set.
14. Notes: the Google Tasks details go into the task notes and into the
    description of chunk events. The user can edit notes in Tempoloom; the
    change goes back to Google Tasks.
15. Gmail: a user can add a Gmail message to Google Tasks. When it lands in
    a synced list, it imports like any to-do and its notes keep Google's
    link to the email. Legacy evidence: such a task gets 1 hour and a due
    date 3 days later, unless the user changes them.

### Repeating to-dos

16. Google Tasks creates a new to-do for each repeat. Tempoloom imports each
    new to-do as a new, separate task.
17. Legacy evidence: the reference removes the options block from the first
    to-do. The repeats copy the stripped title, so they lose the options.
    Proposed default: Tempoloom stores the parsed options of a repeating
    to-do and applies them to its later repeats.
18. To stop a repeat, the user must remove the repeat rule in Google Tasks.
    Deleting the task in Tempoloom does not stop the repeat.

### Disconnect

19. Current version: the user disconnects in Settings > Integrations, or
    revokes the Google grant in the Google account security settings. Both
    stop sync for all lists.
20. Legacy evidence: deleting the Tempoloom list in Google Tasks also
    disconnects. The card can show "connected" for a few minutes; a
    background check (about every 5 to 10 minutes) then changes it.
21. Tasks and chunks that already exist stay (overview spec).

## Outputs

- Tasks with a Google Tasks source link.
- Chunk events titled with the plain task title; description has the notes
  and a link to the to-do.
- Google Tasks list `🗓 Tempoloom` with a sample task (legacy evidence).
- Google Tasks titles without the options block after parsing.
- A managed priority line in the Google task details (Proposed default).

## Edge cases

1. The user edits the options block in Google Tasks after import: the new
   values apply (task sync spec rule 29).
2. The user moves a to-do out of a synced list: the task stops syncing
   (task sync spec rule 2).
3. Google Tasks due dates have no time: Tempoloom uses the task model's
   date-only rule.
4. The Tempoloom list is renamed by the user: keep syncing it by list id.
5. A completed repeating to-do creates the next repeat: Tempoloom imports
   the repeat even though the previous task is done.

## Observed API shapes

Not yet observed.

## Open questions

1. In the current version, which Google Tasks lists sync? Is the dedicated
   list still created?
2. Does the current version still offer the no-due-date setting?
3. Which wins when the Google due date and a `due` token differ?
4. Does the reference always remove the options block from the Google task
   title? The legacy pages disagree.
5. Where does the reference write a priority change back in Google Tasks?

## Acceptance tests

1. Two-way create and complete.
   - Setup: Google Calendar test account; Google Tasks connected; work
     hours Monday to Friday 09:00 to 17:00.
   - Action: in Google Tasks, add `Board slides (duration:2h priority:high)`
     to the synced list with a due date 3 work days ahead.
   - Expected: a task "Board slides", 2 hours, P2, appears in Tempoloom.
     Chunks totaling 2 hours appear in Google Calendar before the due date,
     titled "Board slides". The Google task title becomes "Board slides".
   - Action: mark the to-do done in Google Tasks.
   - Expected: the task is done; future chunks are gone from Google
     Calendar.
   - Reload: reload Tempoloom and Google Calendar. The task is done; no
     future chunks.
2. Reopen from Tempoloom.
   - Setup: test 1 end state.
   - Action: mark the task not done in Tempoloom.
   - Expected: the to-do is not done in Google Tasks; chunks appear again.
   - Reload: same after reload.
3. Delete from Tempoloom.
   - Action: delete the task in Tempoloom.
   - Expected: the to-do is gone from Google Tasks; chunks are gone from
     Google Calendar.
   - Reload: same after reload.
4. No due date.
   - Setup: `no_due_date_mode` = `none`.
   - Action: add a to-do with no due date.
   - Expected: the task has no due date. With `use_default`, a second to-do
     gets the default due date.
   - Reload: same after reload.
5. Priority write-back.
   - Action: change an imported task from P2 to P1 in Tempoloom.
   - Expected: the Google task details end with the line `Priority: P1`
     (Proposed default mechanism).
   - Reload: reload Google Tasks; the line remains.
