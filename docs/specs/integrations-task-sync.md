# Task integrations: shared import and sync rules

Spec id: SPEC-INT-04
Evidence: E-0192 (ev_d71469f89e0b), E-0149 (ev_d29fa94e9488), E-0154 (ev_80048adfa431), E-0143 (ev_8cd26d7dd2ad), E-0146 (ev_97c8101e3db1), E-0151 (ev_1f3ad2991e11), E-0025 (ev_16b2fdb71929), E-0028 (ev_1f7e221043fd), E-0030 (ev_3222a99a870b), E-0031 (ev_004433cbccd6), E-0032 (ev_2cff8970c05c), E-0036 (ev_7cf8747bcd55), E-0067 (ev_ba8230fd84c8), E-0096 (ev_85b1184aa43b), E-0197 (ev_8506fbd9dd45), E-0187 (ev_ca0148184c9e), E-0057 (ev_55e593f1790f), E-0185 (ev_a4ec0e22d4a0), E-0044 (ev_f6427c0cc84a), E-0118 (ev_5fb2b8ba3faf), E-0122 (ev_96b047a97dd0), E-0175 (ev_a882fe6f4503), E-0062 (ev_6a4045895d23)
Status of evidence: public docs only

## Summary

Task integrations bring work items from external task apps into Tempoloom
as tasks. This spec gives the rules that all of them share. They cover
which items import, how fields map, which side wins on an update, and what
completion and deletion do. It also defines the title options grammar
that several integrations and the Slack and Raycast clients use.

## Concepts and inputs

### Scope and evidence

The task model itself (fields, chunks, states) is in `planning-tasks.md`
(group A). Each app has its own spec: `integrations-google-tasks.md`,
`integrations-todoist.md`, `integrations-asana.md`,
`integrations-clickup.md`, `integrations-jira.md`,
`integrations-linear.md`.

### Version note

The two reference versions use imported items in different ways.

- Current version (2.0): imported items join the user's single task list.
  The reference does not create a calendar event for each task by default.
  It recommends tasks ("relevant now", "at risk") during focus time and
  habit events. A saved task search can be attached to a focus time or a
  habit. Search filters: source, keyword, due date, and for integrations
  also project and label. The current integration pages for Asana, ClickUp,
  Google Tasks, Linear and Todoist describe this model.
- Legacy version (1.0): each imported item becomes a task that the
  scheduler splits into chunks and places before the due date.
- The current marketing pages for each integration still describe time
  blocks sized from estimates and placed before due dates.

The Tempoloom glossary defines a task as work that the scheduler splits
into chunks. Group A decides if imported tasks get chunks, recommendations,
or both. This spec gives the import mapping, which both models need.

### Fields

Source link (stored on each imported task):

| Field | Type | Notes |
|---|---|---|
| `kind` | enum | google_tasks, todoist, asana, clickup, jira, linear |
| `connection_id` | id | The connection (overview spec). |
| `external_id` | string | Stable id in the external app. |
| `external_url` | URL | Deep link to the item. |
| `container` | string | Project, list, space or team name. |
| `labels` | list of strings | Labels or tags. |
| `assignee` | string or null | External user id. |
| `external_updated_at` | timestamp | Last change seen in the external app. |
| `write_back_ref` | string or null | Id of the comment, attachment or panel that Tempoloom maintains. |
| `state` | enum | `linked`, `skipped` (with reason), `disconnected` |

Task fields that integrations set, with their names in `planning-tasks.md`:

| This spec says | `planning-tasks.md` field |
|---|---|
| title | `title` |
| notes | `notes` |
| duration (total) | `totalMinutes` |
| minimum and maximum chunk duration | `minChunkMinutes`, `maxChunkMinutes` |
| no-split flag | `splitUp` = false |
| start-after date | `startAfter` |
| due date | `dueAt` |
| priority | `priority` (P1 to P4) |
| hours set | `hoursSet` |
| next up flag | `nextUp` |
| source kind | `source` (the integration name) |
| done state | task state (see "States and filters") |

The user's task defaults (default duration, priority, due-in, start delay,
hours set) come from the same spec. In the reference, the default priority
is P2. Tasks made from a Slack message or a mail message use
`quickTaskMinutes` (TSK-4).

Sync rule (Todoist and ClickUp, legacy evidence):

| Field | Type | Default |
|---|---|---|
| `order` | integer | Position in the list. The user drags to reorder. |
| `containers` | list of project or space ids, or "all" | empty |
| `labels` | list of label or tag names | empty |
| `action` | enum `sync`, `dont_sync` | `sync` |
| `hours_set` | hours set id | work hours |
| `include_without_due_date` | bool | false |

Fallback rule (Todoist and ClickUp, legacy evidence): `dont_sync`, or
`sync` during one chosen hours set.

## Behavior

### Import scope

1. An external item imports only when all of these are true:
   - it belongs to the connected account and is assigned to the user, or it
     is in a personal list with no assignee;
   - it matches the integration's scope settings (sync rules, label, team,
     list or manual sync button, per app spec);
   - it has the fields that the app spec requires;
   - it is not in a done, closed or cancelled state.
2. When a linked item stops meeting rule 1 for a reason other than
   completion, Tempoloom stops syncing it. Proposed default: the task stays
   and its source link state becomes `skipped`.
3. Tempoloom keeps a list of items that matched the scope but were skipped
   for a missing field. The integration settings page shows each skipped
   item with its reason, such as "no estimate". (Proposed default; Jira
   shows the reason in the issue itself.)

### Sync rules (Todoist, ClickUp; legacy evidence)

4. A rule must select at least one container or one label. The UI blocks
   saving a rule with neither.
5. A rule matches an item as follows:

   | Containers selected | Labels selected | Matches |
   |---|---|---|
   | yes | yes | Items in a selected container that also have a selected label. |
   | no | yes | All items that have a selected label. |
   | yes | no | All items in a selected container. |

6. Tempoloom checks rules in `order`. The first matching rule decides.
   With `sync`, the item imports into the rule's hours set. With
   `dont_sync`, the item does not import.
7. When no rule matches, the fallback rule decides. This also covers a
   label or container that was deleted in the external app.
8. A due date is required unless the deciding rule has
   `include_without_due_date` true.
9. Rule changes save automatically and apply on the next sync run.
10. On first connect, Tempoloom creates two labels in the external app:
    `tempoloom` (work hours) and `tempoloom_personal` (personal hours), and
    two rules that use them. The user may delete them. The reference
    creates the same pair with its own product name.

### Field mapping

11. Title: the external title, without the options block (rule 25) and
    without duration brackets. Tempoloom removes these from the title it
    stores and from the titles of task events.
12. Event title of task chunks: `<container>: <title>` for project-based
    apps (Todoist, Asana, ClickUp legacy evidence). Plain `<title>` for
    Google Tasks. Proposed default for Jira and Linear: `<issue key>
    <title>`.
13. Event description: the task notes, then a link to the external item.
14. Duration: from the external estimate or duration field, then the
    options block, then the user's default duration (app spec gives the
    exact order). Current marketing pages give 1 hour as the fallback for
    Todoist.
15. Due date: the external due date. In many apps the due date means "do on
    this date"; in Tempoloom it means "finish before this date". Tempoloom
    uses the external date as the task due date without shifting it. The
    time-of-day rule for date-only due dates is the task model's rule.
16. Start-after date: the external start date when the app has one, or the
    options block `not before`.
17. Priority: from the table below. When the external item has no priority,
    the task gets the user's default priority.

    | App | P1 | P2 | P3 | P4 |
    |---|---|---|---|---|
    | Todoist | Priority 1 | Priority 2 | Priority 3 | Priority 4 |
    | ClickUp | Urgent | High | Normal | Low |
    | Jira | Highest | High | Medium | Low (Lowest: open question) |
    | Linear | Urgent | High | Medium | Low |
    | Asana | see `integrations-asana.md` | | | |
    | Google Tasks | options block only | | | |

    Todoist labels: Priority 1 is the highest priority as the Todoist UI
    shows it. Map by the UI label, not by the raw API number.
18. Hours set: from the deciding sync rule, the options block `type`, the
    app's own selector (Asana), or the user's default hours set.
19. Project and labels: stored on the source link. The task list can filter
    and search by them.

### Updates

20. External changes: on each sync run, Tempoloom applies every external
    change of a mapped field to the task.
21. Tempoloom changes: a field change in Tempoloom is written back only when
    the app spec lists that field as two-way. In all apps in the reference,
    a priority change in Tempoloom is not written back, except in Google
    Tasks. Conflict to settle: the integration pages (E-0197, E-0057, E-0118,
    E-0044) say that the user may edit a synced task's priority in
    Tempoloom, without write-back. `planning-tasks.md` TSK-46 (other legacy
    pages) says that only Asana tasks allow this, and that the others can
    change priority only in the source app. Until this is settled, the
    implementer follows TSK-46. See open question 7.
22. When both sides changed the same field since the last sync, the later
    change wins by timestamp. (Proposed default.)

### Completion, reopening and deletion

23. Each app spec defines what completes, reopens and deletes the task.
    Shared rules:
    - an external done state marks the task done and removes its future
      chunks;
    - rescheduling a chunk of a done task, or adding time to it, reopens the
      external item (Todoist and ClickUp, legacy evidence);
    - deleting the external item deletes the task (Google Tasks, Jira,
      Linear).
24. Proposed default: deleting an imported task in Tempoloom does not delete
    the external item, except in Google Tasks. Tempoloom adds the item to an
    ignore list so that it does not import again.

### Title options grammar

25. An options block is text in parentheses at the end of a title. Tokens
    are separated by spaces or commas. Tokens are case-insensitive.
    Observed tokens:

    | Token | Meaning | Seen in |
    |---|---|---|
    | `type work`, `type personal` | Hours set: work hours or personal hours. | Google Tasks |
    | `due <date>`, `due:<date>` | Due date. | Google Tasks, Todoist, Slack |
    | `not before <date>` | Start-after date. | Google Tasks, Todoist |
    | `priority:<level>` | Priority. Levels: `critical`, `high`, `medium`, `low`, `p1`, `p2`, `p3`, `p4`. | Google Tasks, Todoist |
    | `critical`, `high`, `medium`, `low` | Priority, without the prefix. | Slack |
    | `duration:<n><unit>`, `duration <n><unit>` | Total duration. | Google Tasks, Slack |
    | `[<n><unit>]` anywhere in title or description | Total duration. | Todoist |
    | `nextup` | Add to next up. The reference uses its own token for this. | Google Tasks, Todoist, Slack |
    | `nosplit` | Place the whole duration as one chunk. | Google Tasks, Todoist |

    Raycast quick task uses other words (`integrations-raycast.md`):
    `for <duration>`, `by <date>`, `snooze <duration or date>`.
26. Units: `m` (minutes), `h` (hours), `d` (days), and the words `min`,
    `mins`, `minutes`, `hour`, `hours`. Units are case-insensitive.
27. Date expressions: a weekday (`monday`), `next <weekday>`, `tomorrow`, a
    month and day (`August 7th`), a relative offset (`in 1d`), `M/D`
    (`9/22`), `next <month>`, and an exact date `MM/DD/YYYY`. A time can
    follow (`11am`). An exact date must use `MM/DD/YYYY`.
28. Tempoloom parses the block when the item is created or changed, applies
    the values, and removes the block from the stored title.
29. When the user later changes the duration text and saves the item, the
    new value applies.
30. Unknown tokens are ignored. Proposed default: the block is still
    removed and the unknown tokens go to the end of the task notes.

### Write-back

31. Tempoloom keeps one write-back object per linked item (comment,
    attachment or issue panel, per app spec). It edits that object; it does
    not add a new one per change.
32. The write-back shows: a link to the task in Tempoloom, the start time of
    the next chunk, progress (time logged against total duration), and an
    "at risk" marker when the task may miss its due date.

### Sync timing

33. Legacy evidence (Google Tasks): the reference syncs every 5 minutes on
    the free plan and within seconds on paid plans. Proposed default for
    Tempoloom: use the app's webhooks where they exist; else poll every 5
    minutes. Push Tempoloom-side changes within 30 seconds.

### Current task list

34. Imported tasks appear in the Tasks panel with tasks created in
    Tempoloom. The panel can filter by source, keyword, due date, project
    and label, and marks which tasks are overdue, active or completed.
35. The user can save a filter as a task search and attach it to a focus
    time or a habit (`focus-time.md`, `habits-automation.md`). The focus time or habit then shows the
    matching tasks during its events.

### Teammates

36. Current marketing pages say that assigning an item to a teammate in the
    external app blocks time on the teammate's calendar. This follows from
    rule 1 when the teammate has connected the same integration. Tempoloom
    needs no extra rule.

### Disconnect

37. Disconnect follows the overview spec. Imported tasks and their chunks
    stay. Proposed default: their source link state becomes `disconnected`
    and they become local tasks.

## Outputs

- Tasks with source links; task chunks per the task model.
- Chunk event title and description per rules 12 and 13.
- Write-back objects in the external app (rule 31).
- Labels created in Todoist and ClickUp on first connect.
- Skipped items list in integration settings.

## Edge cases

1. An item moves from one container to another: re-evaluate the rules; it
   can change hours set or stop syncing.
2. The options block is not at the end of the title: Proposed default:
   still parse the last parenthesized block that contains a known token.
3. A title has parentheses that are not options, such as "Call (Anna)":
   no known token, so the text stays in the title.
4. Duration `4d`: see open questions.
5. External estimate is zero: treat as missing.
6. The external app returns the same change twice: the second one makes no
   change (idempotent by `external_updated_at`).
7. An item is assigned to two people: the app spec decides; ClickUp
   (legacy evidence) skips it.

## Observed API shapes

Not yet observed.

## Open questions

1. In the current reference version, do imported tasks get chunks on the
   calendar, or only recommendations inside focus time and habits?
   (Group A decision; logged-in observation needed.)
2. Do sync rules still exist in the current version? The current Linear page
   says there is no separate scheduling settings page, but the current
   marketing pages say the user picks which items sync.
3. How many hours is a `d` unit: 24 hours, or one work day?
4. What does the reference do when the title block and a native field set
   the same value (for example the due date)?
5. Does deleting an imported task in the reference delete the external item?
6. What does "at risk" mean exactly in the write-back?
7. May the user edit a synced task's priority in Tempoloom (rule
   21)? The legacy pages disagree.

## Acceptance tests

1. Options block parsing.
   - Setup: Google Calendar test account; Google Tasks connected.
   - Action: create a Google Task titled `Write the docs (type work
     duration:30m due 12/18/2026 not before 12/14/2026 priority:critical
     nextup)`.
   - Expected: a task "Write the docs" with 30 minutes, due 18 December
     2026, start-after 14 December 2026, P1, work hours, next up. Its chunks
     appear in Google Calendar between those dates. Event titles are "Write
     the docs".
   - Reload: reload the web app and Google Calendar. The values remain.
2. Rule order (Todoist, legacy rules).
   - Setup: rule 1: label `deep`, personal hours. Rule 2: project "Work",
     work hours. Fallback: don't sync.
   - Action: create a task in project "Work" with label `deep`, due in 3
     days. Create a second task in another project with no label.
   - Expected: the first task imports in personal hours. The second does not
     import. Its chunks appear only inside personal hours.
   - Reload: same result after reload.
3. Priority follows the source app.
   - Setup: a ClickUp task imported with priority High (P2).
   - Action: set it to Urgent in ClickUp.
   - Expected: the task becomes P1 and its chunks move as the scheduler
     decides for P1. ClickUp still shows Urgent.
   - Reload: same values after reload.
4. Write-back comment.
   - Setup: a Todoist task imported with a 2-hour duration.
   - Action: wait for the chunks; log 1 hour of work.
   - Expected: the Todoist task has one comment with a task link, the next
     chunk time and 1 of 2 hours logged. No second comment.
   - Reload: reload Todoist; still one comment.
