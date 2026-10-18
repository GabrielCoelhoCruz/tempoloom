# ClickUp integration

Spec id: SPEC-INT-08
Evidence: E-0146 (ev_97c8101e3db1), E-0028 (ev_1f7e221043fd), E-0057 (ev_55e593f1790f), E-0185 (ev_a4ec0e22d4a0)
Status of evidence: public docs only

## Summary

The user connects one or more ClickUp workspaces. Tempoloom imports ClickUp
tasks that match the user's sync rules as tasks, sized by the ClickUp time
estimate and due by the ClickUp due date. ClickUp status groups decide
completion in both directions, and Tempoloom keeps one comment on each
linked task. Most rules come from legacy evidence. Shared rules are in
`integrations-task-sync.md`.

## Concepts and inputs

Connection (per user and ClickUp workspace): ClickUp user id, workspace id,
OAuth token. The user can connect several workspaces when they use the same
email.

Settings:

| Field | Type | Default | Notes |
|---|---|---|---|
| `rules` | ordered list of sync rules | two rules for the default tags | Task sync spec, rules 4 to 10. Containers are ClickUp spaces; labels are ClickUp tags. |
| `fallback` | `dont_sync`, or `sync` with an hours set | `dont_sync` (Proposed default) | |

Default tags created in ClickUp on connect: `tempoloom` (work hours) and
`tempoloom_personal` (personal hours).

Required ClickUp features (ClickApps) in the workspace: Tags, Time
Estimates, Time Tracking (legacy evidence).

ClickUp status groups: every ClickUp status belongs to one of the groups
Active, Done or Closed. Default statuses: TO DO (Active), IN PROGRESS
(Active), COMPLETE (Closed).

Field mapping:

| ClickUp field | Task field | Direction |
|---|---|---|
| Name | Title | ClickUp to Tempoloom only |
| Time estimate | Duration | two-way |
| Due date (end date) | Due date | two-way |
| Start date | Start-after date | two-way |
| Priority | Priority (Urgent P1, High P2, Normal P3, Low P4) | ClickUp to Tempoloom only |
| Assignee | Import scope | ClickUp to Tempoloom |
| Space, list | Source container; prefix of event title | ClickUp to Tempoloom |
| Tags | Source labels; used by sync rules | ClickUp to Tempoloom |
| Status group | Done state | two-way, see rules 11 to 14 |

"Two-way" for estimate and dates comes from the legacy statement that all
fields except title and priority sync both ways.

## Behavior

### Connect

1. The user connects from Settings > Integrations, signs in to ClickUp,
   chooses workspaces, and approves. ClickUp can require admin approval of the
   app. The current version can show a second consent for AI tool access
   (overview spec rule 7).
2. Tempoloom checks the three required ClickApps. When one is off, the
   settings page names it and explains where to turn it on. (Check: Proposed
   default.)
3. On connect, Tempoloom creates the default tags and two default rules.

### Import

4. A ClickUp task imports when (legacy evidence):
   - the deciding sync rule says `sync` (or the fallback does);
   - it has exactly one assignee, and that assignee is the user;
   - it has a due date, unless the deciding rule includes tasks without due
     dates;
   - it has a time estimate;
   - its status is in the Active group.
5. Tasks with more than one assignee never import.
6. Current marketing: the user can track time on ClickUp tasks from the
   calendar. Proposed default: when a chunk ends, Tempoloom adds a ClickUp
   time entry for the chunk's duration.

### Updates

7. Changes in ClickUp go to Tempoloom for all mapped fields.
8. Changes in Tempoloom go to ClickUp for all mapped fields except title and
   priority. The user changes those in ClickUp.
9. Chunk events are titled `<project>: <title>`, where project is the
   ClickUp list (Proposed default; the evidence says "project"). The event
   description has a link to the ClickUp task.
10. Tempoloom adds one comment to each linked ClickUp task, with the task
    link, the next chunk time, progress and an at-risk marker (task sync
    spec rules 31 and 32).

### Completion

11. When the ClickUp task moves to a status in the Done or Closed group,
    Tempoloom marks the task done and removes future chunks.
12. When the user marks the task done in Tempoloom, Tempoloom gives the
    ClickUp task the status that comes first in the Closed group (by
    default COMPLETE).
13. When the user reschedules a chunk of a done task, or adds time to it,
    Tempoloom reopens the ClickUp task. Proposed default: it gets the status
    that comes first in the Active group.
14. Proposed default: deleting the ClickUp task deletes the task.

### Disconnect

15. The user disconnects in Settings > Integrations, or revokes the app in
    the ClickUp workspace settings. Tasks and chunks in Tempoloom stay.

## Outputs

- Tasks with a ClickUp source link.
- Chunk events titled `<project>: <title>` with a ClickUp link.
- One Tempoloom comment per linked ClickUp task.
- Tags `tempoloom` and `tempoloom_personal` in ClickUp.
- ClickUp status changes on done and reopen; time entries (Proposed
  default).

## Edge cases

1. A second assignee is added after import: the task stops syncing.
2. The user removes the time estimate: the task stops syncing (task sync
   spec rule 2).
3. A custom status workflow has several Closed statuses: Tempoloom uses the
   first one in the workflow order.
4. A tag used by a rule is deleted: the fallback decides.
5. Two connected workspaces have spaces with the same name: the rule editor
   shows the workspace name next to each space.

## Observed API shapes

Not yet observed.

## Open questions

1. Do sync rules and default tags still exist in the current version?
2. Which ClickUp level is the "project" in event titles: space, folder or
   list?
3. Does the reference write ClickUp time entries, and when?
4. Which status does a reopened ClickUp task get?
5. What does the reference do when a ClickUp task is deleted?

## Acceptance tests

1. Import by tag.
   - Setup: Google Calendar test account; ClickUp test workspace with the
     three ClickApps on; ClickUp connected; default rules.
   - Action: create a ClickUp task in list "Sprint", assigned only to the
     user, tag `tempoloom`, estimate 90 minutes, due in 3 work days,
     priority Urgent.
   - Expected: a task with 90 minutes, P1, work hours. Chunks appear in
     Google Calendar before the due date, titled `Sprint: <name>`. The
     ClickUp task has one Tempoloom comment.
   - Reload: reload all three apps; values remain.
2. Status group completes the task.
   - Setup: test 1 state.
   - Action: set the ClickUp status to COMPLETE.
   - Expected: the task is done; future chunks are gone.
   - Reload: same after reload.
3. Done in Tempoloom closes ClickUp.
   - Setup: a second imported task.
   - Action: mark it done in Tempoloom.
   - Expected: the ClickUp task has status COMPLETE.
   - Reload: same after reload.
4. Two assignees.
   - Action: create a matching task with two assignees.
   - Expected: no task in Tempoloom within 10 minutes.
   - Reload: still none.
5. Title is one-way.
   - Action: rename an imported task in Tempoloom.
   - Expected: the ClickUp name does not change. Renaming it in ClickUp
     changes the task title in Tempoloom.
   - Reload: same after reload.
