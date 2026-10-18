# Automations: shared model and list

Spec id: SPEC-AUTO-01
Evidence: E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83), E-0081 (ev_dfcc5d3b7c8c), E-0077 (ev_38c8b46b5b57), E-0070 (ev_d2afff8cfe08), E-0051 (ev_936bc1052a22), E-0134 (ev_86c342a26f3c), E-0015 (ev_5930c31b8eb4), E-0090 (ev_4a54fa9f235a), E-0072 (ev_b8e011b22c94), E-0001 (ev_034166f1e6c8)
Status of evidence: public docs only

## Summary

An automation is a saved rule that Tempoloom runs in the background for the user.
Each automation has one job: place a habit, reach a focus goal, cap meeting
load, add buffers, move a flexible meeting, or check meeting quality. All
automations share one form layout, one preview step (preview mode), and one list in the
planner sidebar, ordered by priority. The order in that list decides who gets
time first.

## Concepts and inputs

### Automation types

| Type | Job | Spec |
|---|---|---|
| `habit` | Place a recurring routine. | `habits-automation.md` |
| `focus_time` | Reach a weekly focus goal. | `focus-time.md` |
| `meeting_overload` | Cap meeting hours and protect the rest as focus. | `focus-time.md` |
| `buffer` | Add time before or after matching events. | `buffers-automation.md`, `buffers-travel.md` |
| `flexible_meeting` | Move an internal recurring meeting to the best common time. | `meetings-flexible.md` |
| `meeting_check` | Flag problems with upcoming meetings. | `automations-meeting-quality.md` |

(E-0043.)

### Shared fields

| Field | Type | Notes |
|---|---|---|
| `id` | id | |
| `type` | enum above | Fixed after creation. |
| `name` | string | Shown in the list and on events (E-0043). |
| `enabled` | bool | Default `true`. |
| `priority` | P1 to P4 | Fixed at P4 for `focus_time` and `meeting_overload` (E-0077, E-0070, E-0141). Not used by `meeting_check`. |
| `rank` | int | Position inside its priority group (E-0043, E-0141). |
| `event_settings` | object | Title with optional emoji, ideal time and length, busy or free, visibility, reminders. The fields depend on the type (E-0043). |
| `rules` | object | Type-specific limits, such as the window, the shortest length, or the event filter (E-0043). |
| `template_id` | id or none | The library template it came from. |

## Behavior

### Creating

1. The user can create an automation in three ways: from the library, from the top-bar "create" button, or by asking the assistant chat (E-0043).
2. The library groups templates by type: habits, buffers, focus, flexible meetings and meeting quality (E-0043). A template that the user has already added shows an "added" badge (E-0043). The library catalog and its presets are in `automations-library.md`.
3. The user may add the same template more than once. Proposed (several buffer automations are expected, E-0051).
4. Saving a new automation, or saving changes to one, stages its effect in preview mode: the managed events that Tempoloom will add, move or remove in the scheduling window. The user applies or discards the staged changes as defined in `assistant-preview-mode.md`. Discarding all of them leaves the calendar unchanged (E-0043, E-0081, E-0077, E-0070, E-0051).
5. An automation created through the assistant chat also goes through preview mode before it changes the calendar (E-0015 "approvals"; E-0043).

### The list

6. The planner has an "Automations" sidebar. It shows four groups, P1 (critical) at the top, then P2, P3, P4 (E-0043, E-0141).
7. Inside a group, the order is the rank. The user drags an automation to change its rank or to move it to another group, which changes its priority (E-0043, E-0141).
8. Focus automations stay in the P4 group. The user cannot drag them to another group, but can rank them inside P4. Proposed for rank (E-0077).
9. Meeting quality automations show in their own "Meeting quality" section below the priority groups (E-0134).
10. The user can filter the list by type (E-0043).
11. Each list entry offers edit, change priority, disable or enable, and remove (E-0043).
12. Disable pauses the automation and keeps its settings. Tempoloom deletes its future managed events. Past events stay (E-0043, E-0072).
13. Remove deletes the automation and its future managed events after a confirm dialog. Past events stay.

### Scheduler interaction

14. The scheduler takes placement requests from all enabled automations in this order: priority P1 to P4, then rank inside each priority (E-0043, E-0141).
15. Focus automations are placed after every other placement request, whatever their position in the list (E-0077, E-0090).
16. When two automations need the same time and there is not enough for both, the earlier one in rule 14 keeps the time. The later one moves, shrinks within its rules, or is reported as unplaced (E-0043, E-0141).
17. No automation takes time from an external event, a booking-link meeting or a locked event (E-0141).
18. Every saved change to an automation, its priority or its rank triggers a scheduler run.
19. To stage the impact (rule 4), the scheduler runs in a dry-run mode on a copy of the state and returns the diff of managed events. The dry run writes nothing.

## Outputs

- Planner sidebar list with groups, ranks, type filter and actions.
- Staged changes in preview mode (`assistant-preview-mode.md`).
- Managed events, as defined by each type's spec.

## Edge cases

1. The user discards all staged changes: the automation is not saved (new) or keeps its old settings (edit). Proposed.
2. The user drags an automation into the group it is already in: only the rank changes.
3. Two browser tabs reorder the list at the same time: Proposed: last write wins, and the other tab refreshes.
4. A dry run takes longer than 10 seconds: Proposed: the dialog shows progress and the user may cancel.

## Observed API shapes

Not yet observed.

## Open questions

1. Do tasks appear in this list and share its priority ranks in the current version?
2. Where do flexible meetings rank against habits of the same priority when the user has never reordered them?
3. Is there a limit on the number of automations per user or per plan?
4. Does the preview also show buffers and focus events that move as a side effect?

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00. Test day is a weekday at least
2 days ahead.

1. **Preview then apply.**
   Action: create a habit "Read" one-off window 09:00 to 10:00 on the test day, 60 minutes. In preview mode, check that one new event 09:00 to 10:00 is staged. Discard it.
   Expected: no event in Google Calendar. No "Read" in the list.
   Action: repeat and apply the staged change.
   Expected: the event 09:00 to 10:00 exists.
   Reload: the list shows "Read" in P3 (or its chosen group); the event persists.

2. **Rank decides between equal priorities.**
   Setup: habits "A" and "B", both P2, both one-off window 13:00 to 14:00 on the test day, 60 minutes, `when_unplaceable=remove`. "A" ranks above "B".
   Expected: "A" holds 13:00 to 14:00, "B" is unplaced.
   Action: drag "B" above "A".
   Expected: within 60 seconds, "B" holds the slot and "A" is unplaced.
   Reload: the list order and placement persist.

3. **Focus is pinned to P4.**
   Setup: a focus goal automation.
   Action: try to drag it into the P1 group.
   Expected: the drop is refused. It stays in P4.
   Reload: the same.

4. **Disable and enable.**
   Setup: scenario 1 applied.
   Action: disable "Read". Then enable it.
   Expected: after disable, the event is deleted and the settings remain. After enable, the event returns.
   Reload: the final state persists.
