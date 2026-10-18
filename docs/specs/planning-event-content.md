# Managed event content: description, visibility, title source

Spec id: SPEC-PLANNING-12
Evidence: E-0043 (ev_d7b30359b03e), E-0056 (ev_aa85baa4a4a9), E-0068 (ev_6d15ce331135), E-0081 (ev_dfcc5d3b7c8c), E-0085 (ev_afb3719f0f6f), E-0130 (ev_9c04afccf625), E-0190 (ev_39d8d5ed64d6), E-0193 (ev_68ba14aa780b), E-0195 (ev_d38da34b29c8), E-0206 (ev_0d0d234ca9d4)
Status of evidence: public docs only

## Summary

This spec defines the content of a managed event in Google Calendar: the
description written from the item's notes, the visibility to other people,
and where the title comes from. The status markers in titles (free, busy,
locked, done) are owned by `events-title-emoji.md`.

## Concepts and inputs

### User settings

| Setting | Values | Default |
|---|---|---|
| `eventTips` | on, off | Proposed default: on |

Marker settings (marker choice and position) are in `events-title-emoji.md`.

### Item fields used

- `title`: the item name, which may start with an emoji chosen by the user.
- `notes`: markdown text.
- `visibility`: see "Visibility".

## Behavior

### Title

- **CNT-1.** The event title is the item's `title` plus the state marker.
  The marker table, the marker order, the position setting and the user
  emoji rules are in `events-title-emoji.md` (E-0085). This spec does not
  repeat them.
- **CNT-2.** The task list uses two state icons: 👍 for a task in
  `time-used` and ✅ for a task marked done (legacy evidence, E-0190). Event
  titles follow `events-title-emoji.md`, where 👍 marks a past chunk of a task
  with work left (E-0085). Evidence note: the two pages use the icons in
  slightly different ways.

### Description

- **CNT-10.** The description of a managed event holds the item's `notes`,
  followed by a link that opens the item in the Tempoloom planner (E-0193,
  E-0206, E-0130).
- **CNT-11.** Notes use markdown. Supported elements: bold, italic, headings
  level 1 to 3, numbered list, bullet list, checklist, link, and image from an
  `http` or `https` address (E-0206).
- **CNT-12.** The planner renders the markdown (E-0206).
- **CNT-13.** Google Calendar does not render markdown. Tempoloom writes the
  notes to the Google description as plain markdown text. Link addresses stay
  in the text, so Google can still make them clickable (E-0206).
- **CNT-14.** A link target may use an app link scheme, for example a link to
  a note or an issue in a desktop app (notes apps, issue trackers, task
  apps), not only `http` or `https` (E-0206).
- **CNT-15.** With `eventTips` on, Tempoloom adds a short tip to managed event
  descriptions, for example how to reschedule or skip a flexible meeting from
  Google Calendar (legacy evidence, E-0068). Proposed default: the tip goes
  after the notes and before the planner link.

### Visibility

- **CNT-20.** Task visibility is `private` or `calendar-default`. The user
  sets a default in task settings and can change it per task (legacy
  evidence, E-0056, E-0193).
- **CNT-21.** A habit's visibility decides what other people get: the full
  event, or a block marked busy with no title. Default: the primary
  calendar's default visibility (E-0081).
- **CNT-22.** Each automation (habit, focus time, buffer, flexible meeting)
  has a visibility setting in its event settings (E-0043).
- **CNT-23.** A recovery buffer can show its title and emoji, or show as
  "Busy" with no details (E-0195).
- **CNT-24.** Tempoloom maps `private` to Google event visibility "private"
  and `calendar-default` to "default". Proposed default.
- **CNT-25.** In the reference, these visibility choices for habits, mirroring
  copies and recovery buffers need a paid plan; free users get fixed defaults
  (E-0195). Tempoloom has no plans.

## Outputs

- Google event `summary` per CNT-1 (`events-title-emoji.md`).
- Google event `description` per CNT-10 to CNT-15.
- Google event `visibility` per CNT-24.
- Planner: rendered notes in the details panel.

## Edge cases

1. Notes longer than Google's description limit: Proposed default: Tempoloom
   cuts the notes and keeps the planner link.
2. An image address that is not `http` or `https`: shown as plain text.
3. Empty notes and `eventTips` off: the description holds only the planner
   link.
4. A past chunk of a task that was later deleted: the event is gone
   (`planning-tasks.md` TSK-42).

## Observed API shapes

Not yet observed.

## Open questions

1. E-0085 and E-0190 use 👍 and ✅ in slightly different ways (CNT-2).
2. The exact text and placement of event tips are not in the evidence.
3. Which visibility defaults do focus time and buffer events use?
4. Does the planner link appear in descriptions of every managed kind, or
   only some? The evidence shows it for habits and tasks.

## Acceptance tests

Fixture F0 from `planning-scheduler.md`. Marker tests are in
`events-title-emoji.md`.

1. **Markdown notes.** Action: create task "AT-C1", 60 minutes, with notes
   `**Plan** see [doc](https://example.com/doc)`. Expected: the Google
   description contains that exact markdown text and a link to the planner
   item; the planner shows "Plan" in bold and a link "doc". Reload: same.
2. **Private task.** Action: create task "AT-C2" with visibility `private`.
   Expected: the Google event `visibility` is "private". Reload: same.
3. **Event tips off.** Setup: a flexible meeting "AT-C3" with account B.
   Action: turn `eventTips` off. Expected within 60 s: the description of
   future "AT-C3" events has no tip text. Reload: same.
4. **Recovery buffer without details.** Setup: a recovery buffer automation
   set to show as busy with no details. Expected: its events have visibility
   "private" (Proposed default CNT-24), and account B sees only busy time.
   Reload: same.
