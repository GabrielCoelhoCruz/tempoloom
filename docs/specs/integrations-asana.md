# Asana integration

Spec id: SPEC-INT-07
Evidence: E-0143 (ev_8cd26d7dd2ad), E-0025 (ev_16b2fdb71929), E-0044 (ev_f6427c0cc84a), E-0184 (ev_25c8fdea3ad4)
Status of evidence: public docs only

## Summary

The user connects an Asana workspace. Tempoloom imports Asana tasks so that
they can get time on the calendar before their due dates, sized by their
estimates and ordered by priority. In the legacy version, the user syncs
each Asana task by hand with a button inside Asana. The current version
reads the user's assigned Asana tasks after an OAuth connect. Shared rules
are in `integrations-task-sync.md`.

## Concepts and inputs

Connection (per user): Asana user id, Asana workspace or organization id,
OAuth token.

Current version (2.0): the user chooses one Asana workspace or organization
on connect. Proposed default scope: all incomplete Asana tasks assigned to
the user in that workspace.

Legacy version (1.0) scheduler widget in Asana. Fields of the sync form
that opens from the task details:

| Field | Type | Required | Default |
|---|---|---|---|
| Time estimate | duration | yes | none |
| Earliest schedule date | date | no | none (task default start delay) |
| Hours set | hours set id | yes | work hours (Proposed default) |
| Due date | date | no | none |
| Priority | P1 to P4 | only when the Asana priority is "Custom" | |

Field mapping:

| Asana field | Task field | Direction |
|---|---|---|
| Name | Title | Asana to Tempoloom |
| Project | Source container; prefix of event title | Asana to Tempoloom |
| Estimate (current) or form time estimate (legacy) | Duration | Asana to Tempoloom |
| Due date (current) or form due date (legacy) | Due date | Asana to Tempoloom |
| Form earliest schedule date (legacy) | Start-after date | Asana to Tempoloom |
| Form hours set (legacy) | Hours set | Asana to Tempoloom |
| Priority | Priority (see rule 9) | Asana to Tempoloom only |
| Assignee | Import scope | Asana to Tempoloom |

## Behavior

### Connect (current version)

1. The user connects from Settings > Integrations, signs in to Asana,
   chooses a workspace or organization, and approves. Asana can require
   admin approval of the app first.
2. Tempoloom reads the Asana tasks in scope and imports them. They appear in
   the task list with project and label filters (task sync spec rules 34 and
   35).
3. Current marketing: Asana estimates set the duration, Asana due dates set
   the due date, and Asana priority orders the work.

### Legacy flow (legacy evidence)

4. The user installs the app in each Asana project from the project's
   Customize > Apps panel. This works only in a web browser, not in the
   Asana desktop app. A browser pop-up blocker can stop the install; the
   install page then waits for authorization without end.
5. In a task's details, the user clicks "Schedule with Tempoloom". The sync
   form opens. The user enters the time estimate (required), and optionally
   the earliest schedule date, hours set and due date. The user clicks Sync.
6. Without a due date in the form, the task imports with no due date. With a
   due date, that date is the task due date.
7. The Asana task then shows its sync state in the widget.
8. Other project members who want the same task on their own calendars use
   a link from the widget to authenticate their own accounts. Each member
   then syncs the task for themselves.

### Priority

9. Asana priority maps to task priority. The legacy table lists Asana
   values High, Medium, Low and Custom next to P1, P2, P3 and P4. It also
   says that "Custom" makes the form ask the user to pick a priority. Proposed
   default: High to P2, Medium to P3, Low to P4, no priority to the user's
   default priority, and Custom to the value the user picks (default P2).
   See open questions.
10. A priority change in Tempoloom does not change Asana.

### Display

11. Chunk events are titled `<project>: <title>`. The event description has
    a link to the Asana task.

### Completion and deletion

12. Proposed defaults (no evidence):
    - completing the Asana task marks the task done and removes future
      chunks;
    - marking the task done in Tempoloom completes the Asana task;
    - deleting the Asana task deletes the task.

### Disconnect

13. The user disconnects in Settings > Integrations. In Asana, an admin can
    deauthorize the app under Settings > Apps, which ends the sync for all
    users. To remove the legacy widget from a project, an admin removes the
    app from that project's Customize > Apps panel.
14. Tasks and chunks in Tempoloom stay (overview spec).

## Outputs

- Tasks with an Asana source link.
- Chunk events titled `<project>: <title>` with an Asana link.
- Legacy: sync state shown in the Asana widget.

## Edge cases

1. An Asana task has no estimate: current version: Proposed default: use the
   user's default duration and mark the task "no estimate" in the task list.
   Legacy: the form blocks Sync until the user enters an estimate.
2. The task is reassigned to another person: the task stops syncing for the
   first user (task sync spec rule 2).
3. The user has several Asana workspaces: the current version connects one;
   see open questions.
4. An Asana task belongs to several projects: Proposed default: use the
   first project for the event title.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the exact Asana-to-task priority mapping? The legacy table
   alignment is not clear.
2. Which Asana tasks does the current version import: all assigned tasks, or
   tasks in chosen projects?
3. Which Asana field holds the estimate that the current version reads?
4. What do completion and deletion do in each direction?
5. Can the current version connect more than one Asana workspace?

## Acceptance tests

1. Import an assigned task (current version).
   - Setup: Google Calendar test account; Asana test workspace connected.
   - Action: create an Asana task assigned to the user, in project "Launch",
     due in 3 work days, estimate 2 hours, priority Medium.
   - Expected: a task with 2 hours, due date as set, priority P3 (Proposed
     mapping). Chunks totaling 2 hours appear in Google Calendar before the
     due date, titled `Launch: <task name>`, with an Asana link in the
     description.
   - Reload: reload Tempoloom and Google Calendar. The task and chunks
     remain.
2. Priority stays one-way.
   - Setup: test 1 state.
   - Action: change the task to P1 in Tempoloom.
   - Expected: the Asana task still shows Medium. The scheduler treats the
     task as P1.
   - Reload: same after reload.
3. Unassigned task does not import.
   - Action: create an Asana task with no assignee.
   - Expected: no task in Tempoloom within 10 minutes.
   - Reload: still none after reload.
