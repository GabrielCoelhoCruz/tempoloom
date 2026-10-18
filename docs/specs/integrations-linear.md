# Linear integration

Spec id: SPEC-INT-10
Evidence: E-0151 (ev_1f3ad2991e11), E-0032 (ev_2cff8970c05c), E-0122 (ev_96b047a97dd0), E-0123 (ev_4ea8f7bc1c0e), E-0116 (ev_74a6228dd776), E-0121 (ev_59a74e047576), E-0186 (ev_c033cdf15da7)
Status of evidence: public docs only

## Summary

The user connects a Linear workspace, and Tempoloom imports the Linear
issues assigned to the user as tasks. The Linear estimate sets the duration
through a fixed table, and the earlier of due date and cycle end sets the
due date. Linear workflow states drive completion and deletion, and
Tempoloom moves an issue to Started when its first chunk begins.

## Concepts and inputs

### Scope and evidence

Most rules come from legacy evidence. Shared rules are in
`integrations-task-sync.md`.

### Fields

Connection (per user): Linear user id, Linear workspace id, OAuth token.
One Linear workspace per connection: the one that is selected in Linear
during consent (legacy evidence).

Settings (legacy evidence; the current version has no separate settings
page, see rule 3):

| Field | Type | Default | Notes |
|---|---|---|---|
| `teams` | list of Linear team ids | all teams (Proposed default) | Teams that the integration reads. |
| `sync_mode` | enum `all`, `label` | `all` | `all`: every issue with an estimate and a cycle or due date. `label`: only issues with the label `Tempoloom`. |
| `include_without_due_date` | bool | false (Proposed default) | When true, issues without a due date or cycle import too. |

Estimate to duration table (hours). Each row is one estimate step; the
column is the estimate scale that the Linear team uses.

| T-shirt | Fibonacci | Linear | Exponential | Duration (h) |
|---|---|---|---|---|
| XS | 1 | 1 | 1 | 0.5 |
| S | 2 | 2 | 2 | 1 |
| M | 3 | 3 | 4 | 4 |
| L | 5 | 4 | 8 | 8 |
| XL | 8 | 5 | 16 | 24 |
| XXL | 13 | 6 | 32 | 40 |
| XXXL | 21 | 7 | 64 | 64 |

Field mapping:

| Linear field | Task field | Direction |
|---|---|---|
| Title | Title | Linear to Tempoloom |
| Estimate | Duration (table above) | Linear to Tempoloom |
| Due date, cycle end date | Due date (earlier of the two; see rule 11) | Linear to Tempoloom |
| Priority | Priority (Urgent P1, High P2, Medium P3, Low P4) | Linear to Tempoloom |
| Assignee | Import scope | Linear to Tempoloom |
| Workflow state | Import scope and done state (rules 13 to 17) | both, see rules |
| Labels | Source labels; `Tempoloom` label for `label` mode | Linear to Tempoloom |

## Behavior

### Connect

1. The user connects from Settings > Integrations, signs in to Linear,
   chooses the workspace, and approves. Linear can require admin approval
   of the app.
2. Legacy evidence: the Linear workspace must have estimates and cycles
   turned on for the teams that use the integration.
3. Current version: after connect, Tempoloom suggests the issues assigned to
   the user; there is no separate scheduling settings page. Proposed
   default: Tempoloom keeps the legacy settings above with their defaults,
   on the Linear settings page.

### Import

4. An issue imports when (legacy evidence):
   - it is assigned to the user and belongs to a selected team;
   - it has an estimate;
   - it has a priority other than No priority;
   - it has a due date or belongs to a cycle, unless
     `include_without_due_date` is true;
   - it is not in the Backlog state;
   - in `label` mode, it has the label `Tempoloom`.
5. Duration: the estimate converted with the table above.
6. When the estimate changes, the duration changes to the new value.
7. Priority: the mapping table above. The issue needs a priority to import.

### Due dates and cycles

8. Due date: the issue due date or the cycle end date. When the issue has
   both, Tempoloom uses the earlier one.
9. When the due date or cycle changes, the task due date changes and the
   scheduler places chunks again.
10. Issues without a due date or cycle import only when
    `include_without_due_date` is true. They have no due date.
11. For issues in a cycle, Tempoloom sets an earlier due date for higher
    priorities, so that more important work comes first in the cycle. The
    higher the priority, the earlier the date. Proposed default: due at the
    cycle end minus a share of the cycle length: Urgent 50 %, High 25 %,
    Medium 10 %, Low 0 %. Never earlier than the cycle start plus the task
    duration.

### Workflow states

12. Linear's canonical state types: Backlog, Unstarted, Started, Completed,
    Canceled.
13. Backlog: the issue does not import. When a linked issue moves to
    Backlog, it stops syncing (task sync spec rule 2).
14. Started: when the first chunk of a linked issue begins, Tempoloom moves
    the issue to the team's first Started state. (Only if the issue is in an
    Unstarted state: Proposed default.)
15. Completed: when the issue moves to a Completed state, Tempoloom marks
    the task done and removes future chunks.
16. When all chunks of the task have passed, Tempoloom does not move the
    issue to Completed.
17. Canceled or deleted: when the issue moves to a Canceled state or is
    deleted, Tempoloom deletes the task, but only if no time was logged on
    it. Proposed default: when time was logged, Tempoloom marks the task
    done and keeps the logged time.

### Display

18. Tempoloom adds one link attachment to each linked issue. It shows the
    task status and the next scheduled time. Clicking it opens the task
    editor in Tempoloom.
19. Proposed default: chunk events are titled `<issue identifier>
    <title>`, with a Linear link in the description.

### Private projects (legacy evidence)

20. Issues in private Linear teams or projects are not visible to the
    standard connection. To include them, the user creates a webhook in
    Linear workspace settings (API section) with these values:
    - URL: the Linear webhook URL of this Tempoloom instance, shown on the
      Linear settings page with a copy button;
    - data types: all, except issue SLA;
    - scope: custom, with the private team or project selected.
21. After the webhook exists, Tempoloom imports issues from that private
    team or project with the normal rules.

### Disconnect

22. The user disconnects in Settings > Integrations, or removes the app in
    Linear workspace settings. Tasks and chunks in Tempoloom stay.

## Outputs

- Tasks with a Linear source link.
- Chunk events with a Linear link.
- Linear issue state changed to Started.
- One link attachment per linked issue.

## Edge cases

1. The estimate value is not in the table (for example a custom scale):
   Proposed default: treat it as 1 hour per point and mark the task "check
   estimate".
2. The estimate is 0: the issue does not import.
3. The issue moves to another cycle: the due date follows the new cycle.
4. The user selected a different workspace in Linear before consent: the
   connection uses that workspace. To change it, the user disconnects and
   connects again.
5. The issue is canceled after time was logged: rule 17.
6. The webhook for a private project is deleted: those issues stop syncing
   at the next run.

## Observed API shapes

Not yet observed.

## Open questions

1. How much earlier is the due date for each priority inside a cycle?
2. Does the current version still use the estimate table, the label mode,
   and the private-project webhook?
3. Does the reference move an issue to Started only from Unstarted, or from
   any state?
4. What does the reference do with an issue that is canceled after time was
   logged?
5. What does the Unstarted state do? The legacy page has an empty heading
   there.

## Acceptance tests

1. Import from a cycle.
   - Setup: Google Calendar test account; Linear test workspace with cycles
     and the Fibonacci estimate scale; Linear connected; `sync_mode` =
     `all`.
   - Action: create an issue assigned to the user in the current cycle,
     estimate 3, priority Medium, state Todo.
   - Expected: a task with 4 hours, P3, due on or before the cycle end.
     Chunks totaling 4 hours appear in Google Calendar before that date. The
     issue has a Tempoloom link attachment.
   - Reload: reload Tempoloom, Google Calendar and Linear; values remain.
2. Started on first chunk.
   - Setup: test 1 state.
   - Action: wait until the first chunk begins.
   - Expected: the issue is in the Started state in Linear.
   - Reload: same after reload.
3. Completed in Linear.
   - Action: move the issue to Done.
   - Expected: the task is done; future chunks are removed.
   - Reload: same after reload.
4. Canceled with no logged time.
   - Setup: a second imported issue with no passed chunks.
   - Action: cancel it in Linear.
   - Expected: the task and its chunks are deleted.
   - Reload: same after reload.
5. Backlog and No priority do not import.
   - Action: create one issue in Backlog with an estimate and due date, and
     one in Todo with No priority.
   - Expected: neither imports within 10 minutes.
   - Reload: same after reload.
6. Earlier date wins.
   - Action: give the cycle issue of test 1 a due date before the cycle end.
   - Expected: the task due date is that date.
   - Reload: same after reload.
