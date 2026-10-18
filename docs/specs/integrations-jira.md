# Jira integration

Spec id: SPEC-INT-09
Evidence: E-0150 (ev_2053d3900b43), E-0031 (ev_004433cbccd6), E-0118 (ev_5fb2b8ba3faf), E-0119 (ev_2abe21834c55)
Status of evidence: public docs only

## Summary

The user connects a Jira Cloud site, and Tempoloom imports the Jira issues
assigned to the user as tasks. The original estimate sets the duration,
and the earliest of due date, fix version date and sprint end sets the due
date. In the legacy version, Tempoloom logs work in Jira as chunks run. In
the current version, the connection goes through the Atlassian Rovo MCP
server, and AI tools can also use the Jira data.

## Concepts and inputs

### Scope and evidence

Shared rules are in `integrations-task-sync.md`.

### Fields

Connection (per user): Atlassian account id, one or more Jira sites, OAuth
token. Legacy evidence: one Atlassian login per Tempoloom user; several
sites under that login are allowed.

Settings (per Jira site; legacy evidence):

| Field | Type | Default | Notes |
|---|---|---|---|
| `sync_mode` | enum `manual`, `automatic` | `manual` (Proposed default) | Manual: only issues the user sends with the issue button. Automatic: all issues that have the required fields. |
| `include_without_due_date` | bool | false (Proposed default) | When true, issues with no due date, fix version or sprint import too. |

Field mapping:

| Jira field | Task field | Direction |
|---|---|---|
| Summary | Title | Jira to Tempoloom |
| Original estimate | Duration | Jira to Tempoloom |
| Due date, fix version release date, sprint end date | Due date: the earliest of those present | Jira to Tempoloom |
| Start date, else sprint start date, else user default start delay | Start-after date | Jira to Tempoloom |
| Priority | Priority (Highest P1, High P2, Medium P3, Low P4, Lowest: open question) | Jira to Tempoloom only |
| Assignee | Import scope | Jira to Tempoloom |
| Status category Done | Done state | Jira to Tempoloom |
| Deleted | Task deleted | Jira to Tempoloom |
| Work log | Time logged in chunks | Tempoloom to Jira |

Current marketing says that all Jira estimate types (story points,
hours, t-shirt sizes) set the block size. The conversion is not documented.

## Behavior

### Connect (current version)

1. Before users in an Atlassian organization can connect, an Atlassian
   admin adds Tempoloom's MCP callback domain to the allowed domains of the
   Rovo MCP server in the Atlassian admin console. The organization must
   have Rovo turned on.
2. The settings page shows the exact callback URL of this Tempoloom
   instance, with a copy button, for the admin. (Proposed default; each
   self-hosted instance has its own URL.)
3. The user clicks Connect Jira and accepts the Atlassian consent screens.
   The reference flow has three confirmations. No Compass product is needed.
4. After connect, Tempoloom can use the user's Jira projects and issues for
   scheduling, and AI tools connected to Tempoloom can use them too
   (`integrations-ai-tools.md`).

### Legacy install (legacy evidence)

5. Only Jira Cloud sites work. Self-managed Jira is not supported.
6. A Jira admin installs the Tempoloom app from the Atlassian Marketplace
   for each site. A non-admin can request the install.
7. Each user then opens any Jira issue and clicks the Tempoloom button. The
   button can be inside the "..." menu. The user allows access, accepts the
   Atlassian consent, and returns to the Jira settings page in Tempoloom.
8. Each project's default issue screen must show these fields: Log work,
   Time tracking, Original estimate (for team-managed projects), and due
   date or fix version or sprint.

### Import

9. An issue imports when:
   - it has an original estimate;
   - it has a due date, fix version or sprint, unless
     `include_without_due_date` is true;
   - its assignee's email belongs to a Tempoloom user who connected Jira;
   - in `manual` mode, the user clicked "Schedule with Tempoloom" on it.
10. When an issue lacks a required field, the Tempoloom panel in the issue
    lists the missing fields.
11. Due date: the earliest of the due date, fix version release date and
    sprint end date. When any of them changes, the task due date changes and
    the scheduler places chunks again.
12. Start-after date: the issue start date. When the field is absent or
    empty, the sprint start date. When that is absent too, the user's
    default start delay.
13. Current marketing: issues get time inside the current sprint, ahead of
    their due dates, higher priority first. Rules 11 and 12 give this
    result.

### Issue panel

14. The Tempoloom panel in a Jira issue shows a link to the task and the
    time of the first scheduled chunk. The user opens the panel once per
    issue to see it. The user may need to refresh the browser to see a new
    state.

### Work logging and completion (legacy evidence)

15. When a chunk of a linked issue begins, Tempoloom logs the work in the
    issue's time tracking. Proposed default: it logs the chunk's duration at
    the chunk end, and corrects the log when the user edits logged time.
16. When the issue moves to a Done status, Tempoloom marks the task done,
    keeps the work already logged, and removes future chunks. Example: an
    issue with a 4-hour estimate moves to Done after 2 hours of chunks.
    Jira keeps 2 hours of logged work, and the remaining 2 hours of chunks
    are removed.
17. When the user marks the task done in Tempoloom, Tempoloom does not move
    the issue to Done. The issue panel shows the task as done on the
    Tempoloom side, and the work log is updated.
18. When the issue is deleted in Jira, Tempoloom deletes the task.

### Several sites

19. When the user has several Jira sites, the settings page has a site
    selector, and each site has its own settings.

### Disconnect

20. The user disconnects in Settings > Integrations. A Jira admin can remove
    the app from the site. Tasks and chunks in Tempoloom stay.

## Outputs

- Tasks with a Jira source link.
- Chunk events (Proposed title `<issue key> <summary>`) with a Jira link.
- Jira work log entries.
- Tempoloom issue panel content.

## Edge cases

1. Issue estimate changes after some work is logged: the new total
   duration applies; logged work stays.
2. Issue reassigned to another Tempoloom user: the first user's task stops
   syncing; the second user's task imports in their account.
3. Sprint ends with the issue not done and the issue moves to the next
   sprint: the due date becomes the new sprint end.
4. Issue moved back from Done to an open status: Proposed default: the task
   reopens and the scheduler places the remaining time.
5. Assignee email differs from the Tempoloom login email: the issue does
   not import. The panel says why.

## Observed API shapes

Not yet observed.

## Open questions

1. In the current version, which issues import, and do the legacy settings
   (manual or automatic, issues without due dates) still exist?
2. Does the current version still log work in Jira?
3. How does the reference turn story points or t-shirt sizes into hours?
4. Which task priority does Jira "Lowest" map to?
5. When exactly does the reference log work: at chunk start, at chunk end,
   or both?

## Acceptance tests

1. Import with sprint end as due date.
   - Setup: Google Calendar test account; Jira Cloud test site connected;
     `sync_mode` = `automatic`; an active sprint ending in 5 work days.
   - Action: create an issue assigned to the user in that sprint, original
     estimate 4 hours, priority High, no due date.
   - Expected: a task with 4 hours, P2, due at the sprint end, start-after
     the sprint start. Chunks totaling 4 hours appear in Google Calendar
     before the sprint end.
   - Reload: reload Tempoloom and Google Calendar; values remain.
2. Earliest date wins.
   - Setup: test 1 state.
   - Action: set the issue due date 2 work days before the sprint end.
   - Expected: the task due date changes to that date; chunks move before
     it.
   - Reload: same after reload.
3. Done in Jira.
   - Setup: test 1 state after one 2-hour chunk has passed.
   - Action: move the issue to Done.
   - Expected: the task is done; Jira shows 2 hours logged; the future
     chunks are gone from Google Calendar.
   - Reload: same after reload.
4. Done in Tempoloom does not close Jira.
   - Action: mark another imported task done in Tempoloom.
   - Expected: the issue status does not change; the issue panel shows the
     task as complete.
   - Reload: same after reload.
5. Missing estimate.
   - Action: create an issue assigned to the user with no estimate.
   - Expected: no task; the issue panel lists "Original estimate" as
     missing.
   - Reload: same after reload.
