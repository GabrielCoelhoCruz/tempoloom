# Title markers and emoji

Spec id: SPEC-EVENTS-04
Evidence: E-0085 (ev_afb3719f0f6f), E-0089 (ev_e7262cc4064c), E-0082 (ev_908de7baa80e), E-0181 (ev_4f6cc83d5d58), E-0196 (ev_96353e46340f), E-0043 (ev_d7b30359b03e)
Status of evidence: public docs only (legacy evidence for the marker list)

## Summary

Tempoloom puts a short emoji marker in front of managed event titles so that
the user can read an event's state in any calendar app: free, busy, locked,
done, in conflict, or a travel or flight event. Users may also put their own
emoji in titles; Tempoloom keeps it after the marker. Paid plans can change
which markers are used and where they appear. `planning-event-content.md`
owns the full title and description format; this spec owns the marker set
and user emoji. If the two disagree, fix one of them in the same change.

## Concepts and inputs

### Marker table

| Marker | Meaning | Applies to |
|---|---|---|
| `🆓` | Tempoloom set the event to free (E-0085, E-0089). | Habits, task chunks, flexible meetings. |
| `🛡️` | Tempoloom set the event to busy (E-0085, E-0089). | Habits, task chunks, flexible meetings. |
| `🔒` | The event is locked: it does not move and it is busy (E-0085, E-0181). | Any managed event. |
| `👍` | A past task chunk is done, but the task still has time left (E-0085). | Task chunks. |
| `✅` | A past event is done: the task is fully scheduled, or the habit or flexible meeting is done for that day (E-0085). | Task chunks, habits, flexible meetings. |
| `⚠️` | The event could not get a legal slot and is kept as a conflict (E-0082). | Habits, buffers, task chunks. |
| `🏠` | A mirrored copy that uses the "personal commitment" privacy (E-0085). | Mirrored copies. |
| `✈️` | Tempoloom classed the event as a flight (E-0085). | Flight events that Tempoloom may edit. |
| `🚌` | A travel buffer (E-0085). | Travel buffers. |

### Settings

| Field | Type | Default | Notes |
|---|---|---|---|
| `marker_free`, `marker_busy`, `marker_locked` | single emoji or empty | as in the table | Plan-gated (E-0085). Empty means no marker. |
| `marker_task_partial`, `marker_done` | single emoji or empty | as in the table | Plan-gated (E-0085). |
| `marker_position` | `start` or `end` | `start` | Plan-gated (E-0085). |

## Behavior

1. A managed event title is built as `<marker> <user title>` when `marker_position=start`, and `<user title> <marker>` when `end`. One space separates them (E-0085).
2. An event shows at most one state marker. Proposed priority, highest first: `⚠️`, `🔒`, `✅`, `👍`, `🛡️`, `🆓`. Travel `🚌` and flight `✈️` are type markers and come before the state marker. Proposed.
3. Users may put their own emoji in the title of habits, tasks, flexible meetings and buffers, for example "🍱 Lunch". Tempoloom keeps it after the marker: `🛡️ 🍱 Lunch` (E-0085, E-0043).
4. Library templates may come with an emoji in the title. The user can remove it in the form with a clear control (E-0085).
5. When an event changes state, Tempoloom rewrites only the marker part of the title in the same scheduler run.
6. When the user lock is set from any client, the `🔒` marker appears within 30 seconds (E-0181).
7. When the user edits a managed event title in Google Calendar, Tempoloom strips any leading or trailing known marker from the new text and stores the rest as the user title. Proposed. Whether a title edit also locks the event is defined in `planning-scheduler.md`.
8. Tempoloom never adds markers to external events, except `✈️` on flight events it is allowed to edit. Proposed.
9. When the chat app status integration is on, the status emoji comes from the event's own emoji if it has one, else from the integration default (E-0085). Details are in `integrations-slack.md`.

### Scheduler interaction

10. Markers are output only. The scheduler never reads a marker to decide state. It stores state in its own data.
11. A marker change alone never moves an event.

## Outputs

- Event titles in Google Calendar with markers.
- Settings page section for marker choices (paid plans).

## Edge cases

1. The user title starts with an emoji that is also a marker, for example "🔒 Vault check": Proposed: Tempoloom stores the user title separately, so it never confuses it with a state marker.
2. All markers set to empty: titles equal the user title.
3. A title longer than the calendar limit after adding a marker: Tempoloom shortens the user title, not the marker. Proposed.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version still write state markers into titles, or only show state in the planner (E-0081 mentions only the dotted border)?
2. Do focus events get a marker?
3. What is the order when several markers apply?
4. Which plans include the marker settings? (E-0085 names the paid tiers.)

## Acceptance tests

Common setup: Google Calendar test account, home time zone America/New_York,
work hours Monday to Friday 09:00 to 17:00, default marker settings. A habit
"🍱 Lunch" every weekday 11:30 to 14:00, 30 to 60 minutes, ideal 12:00,
default defense.

1. **Free and busy markers.**
   Expected: a weekday with free time shows "🆓 🍱 Lunch". Block 11:30 to 13:00 with an external event on Wednesday. Expected: Wednesday shows "🛡️ 🍱 Lunch" at 13:00 to 14:00.
   Reload: titles persist.

2. **Lock marker.**
   Action: lock Thursday's lunch in the planner.
   Expected: within 30 seconds, the Google Calendar title is "🔒 🍱 Lunch".
   Reload: the same.

3. **Done marker.**
   Setup: run on a day where a lunch occurrence has ended.
   Expected: the past occurrence title is "✅ 🍱 Lunch".
   Reload: the same.

4. **Marker position (paid plan).**
   Action: set `marker_position=end`.
   Expected: titles become "🍱 Lunch 🆓" and so on, for all future habit events.
   Reload: the same.

5. **Title edit keeps markers clean.**
   Action: in Google Calendar, rename Friday's "🆓 🍱 Lunch" to "🆓 🍱 Long lunch".
   Expected: the planner shows user title "🍱 Long lunch" for that occurrence, and the calendar title has exactly one marker.
   Reload: the same.
