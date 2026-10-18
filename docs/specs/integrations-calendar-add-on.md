# Google Calendar add-on

Spec id: SPEC-INT-15
Evidence: E-0136 (ev_caafaaaf01b4), E-0160 (ev_a0598dea5be2)
Status of evidence: public docs only

## Summary

The calendar add-on is a Google Workspace add-on. It adds a Tempoloom panel
to the Google Calendar side bar. From the panel, the user sees priorities,
tasks, habits, flexible meetings and booking links, and acts on them. When
the user opens a managed event or a mirrored copy in Google Calendar, the
panel shows its details and actions, checks its sync state, and offers a
repair. All evidence is legacy.

## Concepts and inputs

Add-on install: from the Google Workspace Marketplace, per user, or by a
Google Workspace admin for the whole domain or for chosen groups.

Authorization: two steps. First the Google account authorizes the add-on
(Google's consent). Then the user links the Tempoloom account in the panel.
The Google account email should be the same as the Tempoloom login email.

Panel tabs:

| Tab | Content |
|---|---|
| Priorities | The user's items in priority order (same as the priorities view in the web app). |
| Tasks | All tasks, with search and "New task". |
| Habits | Enabled habits, with search. |
| Flexible meetings | All flexible meetings, with search. |
| Booking links | All booking links. |

Event context card: shown when the user opens an event in Google Calendar.

## Behavior

### Install and link

1. The user installs the add-on from the Marketplace listing and grants the
   Google permissions. The add-on icon appears in the Google Calendar side
   bar.
2. On first open, the panel asks the user to link the Tempoloom account.
   This opens Tempoloom login in a new window when the user is not signed
   in.
3. For a self-hosted instance, the panel first asks for the instance URL.
   (Proposed default.)
4. A Google Workspace admin sees an admin install option in the listing and
   can install it for every user of the domain, or only for chosen groups. Users then get
   the add-on even before they have a Tempoloom account.

### Tabs

5. Priorities tab: lists items in priority order. From the list, the user
   can copy a booking link URL, and start a task or habit. Clicking an item
   opens its details and more actions.
6. Tasks tab: lists and searches tasks. "New task" opens a task form.
   Clicking a task shows its details and actions, such as start and add
   time.
7. Habits tab: lists and searches enabled habits. Clicking a habit shows its
   details and actions, such as start.
8. Flexible meetings tab: lists and searches flexible meetings. Clicking one
   shows its details and actions, such as reschedule.
9. Booking links tab: lists links. Each has "Copy URL" and "Personalize and
   share" (the one-off link and shared times flow of
   `booking-links-sharing.md`).
10. The add-on gives most of the actions that the Planner gives for these
    items. The action set per item is the Planner's set (`planning-planner.md`).

### Event context card

11. The user opens a managed event in Google Calendar, such as a task
    chunk, habit event, flexible meeting or buffer. The panel then shows the
    item's details and its Planner actions, such as start, reschedule or add
    time.
12. The user opens a copy made by calendar mirroring. The panel then shows
    the source event's title, time, calendar and description, as far as the
    user may see them. This lets the user hide the copies'
    details without losing access to them.
13. On each opened event, the add-on runs a sync check. When the check finds
    a problem, the card shows a notice and a Repair button.
14. Repair runs the sync again for that one event: it re-reads the source
    and rewrites the managed event or copy. The card then shows the new
    state. (What the check covers: Proposed default, see open questions.)

### Gmail

15. The add-on can also send and customize booking links from Gmail. That
    flow belongs to `booking-links-sharing.md`.

## Outputs

- Side panel cards in Google Calendar (and Gmail for booking links).
- Item actions with the same effects as in the Planner.
- Repaired managed events or mirrored copies.

## Edge cases

1. The Google account email differs from the Tempoloom login: Proposed
   default: allow the link, and show the linked Tempoloom email at the top
   of the panel.
2. The user opens an external event (not managed, not a copy): the card
   shows "Not managed by Tempoloom" and, when the event is busy, offers no
   actions. (Proposed default.)
3. The user opens a mirrored copy whose source was deleted: the sync check
   reports it, and Repair deletes the orphan copy. (Proposed default.)
4. The add-on token expires: the panel shows the link step again.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version still offer the add-on, and with which tabs?
2. Which problems does the sync check detect, and what exactly does Repair
   do?
3. Which actions does each tab offer in the current version?
4. Does the add-on also run in Gmail for anything besides booking links?

## Acceptance tests

Common setup: Google Workspace test domain; the add-on installed for the
test user; Tempoloom linked; Google Calendar test account with one task
that has chunks, one habit and one booking link.

1. Start a task from the Tasks tab.
   - Action: open the add-on, Tasks tab, choose the task, click Start.
   - Expected: the task shows as in progress in the web app, as if started
     in the Planner. Google Calendar shows the change that the Planner
     action makes (`planning-tasks.md`).
   - Reload: reload Google Calendar and the web app; the state remains.
2. Context card for a task chunk.
   - Action: open a task chunk event in Google Calendar.
   - Expected: the panel shows the task title, its due date, and actions.
     "Add time" of 30 minutes adds a 30-minute chunk in Google Calendar.
   - Reload: reload Google Calendar; the new chunk remains.
3. Source details of a mirrored copy.
   - Setup: calendar mirroring from a second test calendar, copies with
     hidden details.
   - Action: open a copy in the main calendar.
   - Expected: the panel shows the source event's title and time.
   - Reload: same after reload.
4. Repair.
   - Setup: edit a mirrored copy's time by hand in Google Calendar so it no
     longer matches its source.
   - Action: open the copy; click Repair.
   - Expected: the copy's time again matches the source.
   - Reload: reload Google Calendar; the copy keeps the source time.
5. Copy a booking link.
   - Action: Booking links tab, Copy URL on a link.
   - Expected: the clipboard holds the URL; it opens the booking page.
   - Reload: not applicable.
