# Todoist integration

Spec id: SPEC-INT-06
Evidence: E-0154 (ev_80048adfa431), E-0036 (ev_7cf8747bcd55), E-0197 (ev_8506fbd9dd45), E-0096 (ev_85b1184aa43b), E-0187 (ev_ca0148184c9e)
Status of evidence: public docs only

## Summary

The user connects a Todoist account. Tempoloom imports the Todoist tasks
that match the user's sync rules, with priority, due date and duration
taken from Todoist. Tempoloom keeps one comment on each linked Todoist task
with the schedule and progress.

## Concepts and inputs

### Scope and evidence

Most rules come from legacy evidence. The current pages confirm connect
and disconnect, and that the integration uses project, priority, due date
and estimate data. Shared rules are in `integrations-task-sync.md`.

### Fields

Connection (per user): Todoist user id, OAuth token.

Settings:

| Field | Type | Default | Notes |
|---|---|---|---|
| `rules` | ordered list of sync rules | two rules for the default labels | Task sync spec, rules 4 to 10. Containers are Todoist projects; labels are Todoist labels. |
| `fallback` | `dont_sync`, or `sync` with an hours set | `dont_sync` (Proposed default) | |

Default labels created in Todoist on connect: `tempoloom` (work hours) and
`tempoloom_personal` (personal hours).

Field mapping:

| Todoist field | Task field | Direction |
|---|---|---|
| Content (title, without block and brackets) | Title | two-way |
| Description | Notes; also searched for `[<duration>]` | Todoist to Tempoloom |
| Duration field (Todoist paid plans) | Duration | Todoist to Tempoloom |
| `[<n><unit>]` in title or description | Duration | Todoist to Tempoloom |
| Due date only | Due date | two-way |
| Due date and deadline | Due date becomes start-after; deadline becomes due date | two-way |
| Priority (Priority 1 to 4) | Priority (P1 to P4) | Todoist to Tempoloom only |
| `priority:` in options block | Priority | Todoist to Tempoloom |
| `not before`, `nextup`, `nosplit` in options block | Start-after, next up, no-split | Todoist to Tempoloom |
| Project | Source container; prefix of event title | Todoist to Tempoloom |
| Labels | Source labels; used by sync rules | Todoist to Tempoloom |
| Completed | Done state | see rules 13 to 15 |

## Behavior

### Connect

1. The user connects from Settings > Integrations (overview spec rules) and
   agrees to the Todoist consent screen. The browser returns to the Todoist
   settings page in Tempoloom. The free Todoist plan works.
2. On connect, Tempoloom creates the two default labels and two default
   rules (task sync spec rule 10).
3. The settings page shows a warning: if the user also uses Todoist's own
   Google Calendar connection, each task can show twice. The user should
   turn off one of them.

### Import

4. A Todoist task imports when (legacy evidence):
   - the deciding sync rule says `sync` (or the fallback does);
   - it has a due date, unless the deciding rule includes tasks without due
     dates;
   - in a shared project, it is assigned to the user;
   - it is not a recurring task. The reference does not import recurring
     Todoist tasks.
5. Hours set: the deciding rule's hours set. Todoist tasks do not use the
   `type` token.
6. Duration order: the Todoist duration field when it has a value, then a
   `[<n><unit>]` token in the title or description, then the user's default
   duration. Current marketing gives 1 hour as the default. (The legacy page
   does not state the order between the field and the token; see open
   questions.)
7. Due date: when the task has only a due date, it becomes the task due
   date. When it has a due date and a deadline, the due date becomes the
   start-after date and the deadline becomes the task due date.
8. A due date change in either app goes to the other app.
9. Priority: Todoist Priority 1 to 4 map to P1 to P4 (task sync spec rule
   17). An options block `priority:` value wins over the Todoist field.
   (Order: Proposed default.) A priority change in Tempoloom does not change
   Todoist.
10. Changes to other synced fields in either app go to the other app.

### Display and write-back

11. Chunk events are titled `<project>: <title>`. The event description has
    a link to the Todoist task.
12. When a task links, Tempoloom adds one comment to the Todoist task. The
    comment has a link to the task in Tempoloom and the date and time of the
    next chunk. Tempoloom edits the same comment as time is logged. It marks
    the task as at risk when it may miss the Todoist due date (task sync
    spec rules 31 and 32).

### Completion

13. Tempoloom completes the Todoist task when the user marks the task done
    in Tempoloom. Chunks that pass do not complete the Todoist task.
14. When the user completes the Todoist task in Todoist, Tempoloom marks the
    task done and removes future chunks. (Inferred from the two-way rule;
    see open questions.)
15. When the user reschedules a chunk of a done task, or adds time to it,
    Tempoloom reopens the Todoist task. It shows again as not completed in
    its project.

### Disconnect

16. The user disconnects in Settings > Integrations (current version) or at
    the bottom of the Todoist settings page (legacy evidence), or revokes the
    app in Todoist under Settings > Integrations. Todoist tasks stay in
    Todoist. Tasks and chunks in Tempoloom stay (overview spec).

## Outputs

- Tasks with a Todoist source link.
- Chunk events titled `<project>: <title>` with a Todoist link in the
  description.
- One Tempoloom comment per linked Todoist task.
- Labels `tempoloom` and `tempoloom_personal` in Todoist.
- Todoist tasks completed or reopened by Tempoloom.

## Edge cases

1. Todoist parses a date that the user types in the options block and moves
   it into the due date field. The block then lacks that date. Tempoloom uses
   what it receives. The settings page tells the user to disable Todoist's
   smart date parsing or to undo the highlight.
2. A label used by a rule is deleted in Todoist: the rule no longer matches;
   the fallback decides (task sync spec rule 7).
3. A task in a shared project is reassigned to another person: the task
   stops syncing (task sync spec rule 2).
4. A task becomes recurring after import: Proposed default: it stops syncing.
5. The Todoist comment is deleted by the user: Proposed default: Tempoloom
   creates a new one at the next change.

## Observed API shapes

Not yet observed.

## Open questions

1. In the current version, do sync rules and default labels still exist?
2. When both the Todoist duration field and a `[<duration>]` token exist,
   which wins?
3. Does completing a task in Todoist mark the task done in Tempoloom? The
   legacy page states only the other direction.
4. Does the current version import recurring Todoist tasks?
5. Which Todoist fields go back from Tempoloom besides the due date and
   completion?

## Acceptance tests

1. Import with deadline.
   - Setup: Google Calendar test account; Todoist connected; default rules.
   - Action: create a Todoist task `Quarterly review [3h]` with label
     `tempoloom`, Priority 1, due date in 2 work days, deadline in 5 work
     days.
   - Expected: a task "Quarterly review", 3 hours, P1, work hours, start-
     after on the due date, due on the deadline. Chunks totaling 3 hours
     appear in Google Calendar between the two dates, titled
     `<project>: Quarterly review`. The Todoist task has one comment with a
     task link and the next chunk time.
   - Reload: reload Tempoloom, Google Calendar and Todoist. All values remain.
2. Due date is required.
   - Action: create a task with label `tempoloom` and no due date.
   - Expected: it does not import. After the user turns on "include tasks
     without due dates" on the rule, it imports with no due date.
   - Reload: same result after reload.
3. Done in Tempoloom completes Todoist.
   - Setup: test 1 state.
   - Action: mark the task done in Tempoloom.
   - Expected: the Todoist task is completed; future chunks are removed.
   - Reload: same after reload.
4. Adding time reopens Todoist.
   - Setup: test 3 state.
   - Action: add 1 hour to the task in Tempoloom.
   - Expected: the Todoist task is not completed again; a new chunk appears.
   - Reload: same after reload.
5. Personal label.
   - Action: create a task with label `tempoloom_personal`, due in 3 days.
   - Expected: its chunks appear only inside personal hours.
   - Reload: same after reload.
