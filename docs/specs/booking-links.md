# Booking links

Spec id: SPEC-LINK-01
Evidence: E-0163 (ev_aa5715921a1a), E-0063 (ev_1f870480468c), E-0162 (ev_a6662888f654), E-0173 (ev_cc5ae996c9b1), E-0165 (ev_24e80a7bfae3), E-0217 (ev_cec6f530162a), E-0138 (ev_9d7dfaf21591), E-0164 (ev_e9f6693710f9), E-0205 (ev_e2940d16a99b), E-0214 (ev_62d8c6933ca7), E-0055 (ev_4afbb658ac95), E-0066 (ev_e85176d32a5d), E-0113 (ev_9189933f86ee), E-0141 (ev_d12320a15a83), E-0104 (ev_173e10d4937f), E-0088 (ev_4fa475edc582), E-0090 (ev_4a54fa9f235a), E-0172 (ev_d2989bf32eaf), E-0003 (ev_fdf25af08b9c), E-0065 (ev_02ad624a317c), E-0198 (ev_b7863b5cff36), E-0007 (ev_e10aa7cec1e9)
Status of evidence: public docs only

## Summary

A booking link is a public page where other people book a meeting with the
user, or with several users of one team. The user sets the rules: who
attends, which hours, which durations, how much notice, how far ahead, how
many bookings per day or week, and the priority. The priority decides how
much of the user's flexible time the link may offer. A booking creates a
busy Google Calendar event that Tempoloom never moves, and Tempoloom moves
lower-priority managed events out of its way (E-0007, E-0163).

Related specs:

- `booking-links-availability.md` (SPEC-LINK-02): which times are offered.
- `booking-links-booking-page.md` (SPEC-LINK-03): what bookers see; branding.
- `booking-links-team.md` (SPEC-LINK-04): team links and round-robin links.
- `booking-links-sharing.md` (SPEC-LINK-05): link groups, one-off links,
  shared times, embeds, sending from calendar and mail.
- `integrations-webhooks.md` (SPEC-INT-13, group F): webhooks for bookings
  (endpoints, delivery, payload, signature, custom data).
- Other group specs this spec relies on: `planning-hours.md`,
  `planning-priorities.md` (PRI-30 to PRI-33), `events-external-priority.md`,
  `events-tags.md`, `events-out-of-office.md`, `focus-time.md`,
  `buffers-automation.md`, `buffers-travel.md`,
  `integrations-video-conferencing.md` (SPEC-INT-03),
  `integrations-calendar-add-on.md` (SPEC-INT-15), `teams-membership.md`.
- `meetings-start-intervals.md` (SPEC-MEET-03): allowed start minutes.

## Concepts and inputs

### Link fields

| Field | Type | Default | Allowed values | Evidence |
|---|---|---|---|---|
| `title` | string | required | 1 to 120 characters (Proposed) | E-0063, E-0163 |
| `description` | text | empty | up to 4 KB (Proposed) | E-0063, E-0163 |
| `eventTitleTemplate` | string | Proposed: `<title> with {attendee}` | text with the variables `{organizer}` and `{attendee}` | E-0063, E-0163 |
| `slug` | string | derived from `title` | `a-z`, `0-9`, `-`; 1 to 64 characters; unique inside its page | E-0063 |
| `page` | page id | `main` | `main`, `hidden`, or a link group id | E-0063, E-0163, E-0205 |
| `organizers` | list of organizer records | the creator, required, host | members of the creator's team only | E-0063, E-0066, E-0163 |
| `roundRobinPool` | list of pool records | empty | see SPEC-LINK-04 | E-0065, E-0163 |
| `durations` | list of minutes | Proposed: [30] | 1 to 3 distinct values; each 5 to 480, step 5 (Proposed range) | E-0063, E-0162, E-0163, E-0217 |
| `defaultDuration` | minutes | first value of `durations` | one of `durations` | E-0138 |
| `targetCalendar` | calendar id | host's main account, primary calendar | a primary calendar of any connected account of the host | E-0063 |
| `priority` | P1 to P4 | Proposed: P2 | P1, P2, P3, P4 | E-0063, E-0163, E-0165 |
| `rangeStart` | tagged value | Proposed: rolling 4 hours | `rolling` (amount + unit: minutes, hours or days), `nextDay`, `nextWeek`, `date` | E-0063, E-0163 |
| `rangeEnd` | tagged value | Proposed: rolling 30 days | `rolling` (1 to 100 days), `date` | E-0063, E-0163 |
| `bufferBefore` | minutes | 0 | 0 to 120 (Proposed range) | E-0163 |
| `bufferAfter` | minutes | 0 | 0 to 120 (Proposed range) | E-0163 |
| `useRecoveryBuffer` | boolean | true | | E-0063, E-0138 (legacy evidence) |
| `useTravelBuffer` | boolean | true | | E-0063, E-0138 (legacy evidence) |
| `maxPerDay` | integer or null | null (no limit) | 1 to 50 | E-0063, E-0163, E-0198 |
| `maxPerWeek` | integer or null | null (no limit) | 1 to 200 | E-0063, E-0163, E-0198 |
| `locations` | list of location options | Proposed: [`googleMeet`] | 0 to 10 options (Proposed limit) | E-0063, E-0163, E-0173, E-0217 |
| `defaultLocation` | index | 0 | an index of `locations` | E-0063 |
| `reminder` | {enabled, hoursBefore, message} | disabled | `hoursBefore` 1 to 168 (Proposed range); `message` up to 1 KB | E-0063, E-0163, E-0138 |
| `redirectUrl` | URL or null | null | must start with `https://` | E-0063, E-0163 |
| `questions` | list of question records | empty | up to 10 (Proposed limit) | E-0063, E-0163, E-0173 |
| `branding` | enum | `sameAsGroup` | see SPEC-LINK-03 | E-0055, E-0163 |
| `webhook_endpoint_ids` | list of webhook endpoint ids (name from SPEC-INT-13) | empty | endpoints of the owner's team | E-0214, E-0163 |
| `shareMessage` | text | Proposed: `Book a time with me: {link}` | text with the variable `{link}` | E-0164 |

### Organizer record

| Field | Type | Default | Notes |
|---|---|---|---|
| `userId` | Tempoloom user | | must be a member of the link owner's team (E-0066, E-0163) |
| `hours` | hours set id, or item-specific hours (`planning-hours.md`) | the user's meeting hours | E-0063, E-0066, E-0172, E-0173 |
| `required` | boolean | true | `false`: invited, but not used for availability (E-0063, E-0066, E-0163) |
| `isHost` | boolean | true for the creator | exactly one organizer is host when `organizers` is not empty (E-0063) |

The host is the organizer of the Google event. Tempoloom uses the host's
conference integrations (for example Zoom) for the booked event (E-0063).
The main organizer is the user who created the link.

### Location option

| Kind | Data | What the booked event gets | Evidence |
|---|---|---|---|
| `googleMeet` | none | a new Meet conference | E-0063, E-0173 |
| `zoom` | none | a Zoom meeting from the host's Zoom integration (SPEC-INT-03 rules 12 and 13) | E-0063, E-0173 |
| `gong` | none | a Gong link, for hosts with the Gong integration (SPEC-INT-03 rules 21 and 22) | E-0063 |
| `address` | one or more address strings | the chosen address as event location | E-0063, E-0217 |
| `phone` | phone number | the number in the location field | E-0063 |
| `custom` | text or URL | the text in the location field | E-0063, E-0217 |


### Question record

| Field | Type | Default | Notes |
|---|---|---|---|
| `label` | string | required | the question text |
| `responseType` | enum | `singleLine` | `singleLine` is observed (E-0173); `multiLine` and `choice` are Proposed |
| `options` | list of strings | empty | only for `choice` (Proposed) |
| `required` | boolean | false | E-0173 |

## Behavior

### Setup and link list

1. On the first visit to the booking links page, the user claims a root
   slug. Tempoloom creates the user's main booking page at that slug. The
   user can change the slug later (E-0162, E-0173).
2. After the slug is claimed, Tempoloom creates three starter links that
   the user can edit or delete (E-0162, E-0173). Proposed set: "Important
   meeting" (P1, 30 min), "Quick meeting" (P3, 15 and 30 min), "Meeting"
   (P2, 30 and 60 min).
3. The user creates a link from the links page or from the global create
   menu. The form has the sections: event details, organizers, location,
   eligible times (hours), scheduling (priority, durations, range, buffers,
   limits), URL and page, booking page options (reminder, branding,
   questions, redirect), webhooks (E-0163).
4. The default `slug` is the title in lowercase, with each run of other
   characters replaced by one `-`, and leading and trailing `-` removed
   (Proposed algorithm). If it is taken, Tempoloom adds `-2`, `-3`, and so
   on. The user can change it (E-0063).
5. The links page shows one card per link, grouped by page. Each card shows
   the title, durations and priority, and has actions: edit, copy URL,
   change priority, open booking page, personalize (SPEC-LINK-05) and share
   (SPEC-LINK-05) (E-0173, E-0165).
6. A link on the `hidden` page is listed on no booking page. Its direct URL
   works (E-0063, E-0163, E-0205).
7. Tempoloom sets no limit on the number of links. The reference limits
   links by plan (E-0003).
8. Every organizer of a link can see and edit it. SPEC-LINK-04 lists the
   fields that only the main organizer can change (E-0063, E-0066, E-0065).
9. Settings changes apply to availability at once. They do not change
   existing booked events, except for the reminder (rule 21) (Proposed).

### Booking

10. The booker picks a duration, a date and a start time on the booking
    page, then fills the details form (SPEC-LINK-03).
11. On submit, Tempoloom checks the slot again with the same rules as the
    page (SPEC-LINK-02). If the slot is no longer offered, the page shows an
    error and the new list of times, and no event is created (Proposed).
12. Tempoloom creates one Google event on `targetCalendar` of the host and
    asks Google to send invitations (E-0063):
    - title: `eventTitleTemplate` with `{organizer}` replaced by the main
      organizer's display name, and `{attendee}` replaced by the booker's
      name (E-0063);
    - start and end: the chosen slot;
    - guests: the booker, the booker's CC addresses, all organizers
      (optional organizers with the optional flag), and the round-robin
      assignee (SPEC-LINK-04);
    - description: the booker's message, the answers to the questions, and
      two links for the booker: reschedule and cancel (E-0217);
    - location: the chosen location option; conference data for
      `googleMeet` and `zoom` (E-0063, E-0217);
    - free/busy: busy (E-0088);
    - a private extended property `tlBookingId` (Proposed).
13. Tempoloom stores the booking: link id, event id, host, assignee, booker
    name, email, time zone, CC list, message, answers, chosen location,
    custom data (SPEC-INT-13 rule 18), and the times of creation, reschedule and
    cancellation.
14. Emails: on create, reschedule and cancel, Tempoloom emails the
    organizers and the booker (E-0217). Proposed: when the instance has no
    mail server configured, Tempoloom relies on the Google invitation emails
    only.
15. The page then shows the confirmation (SPEC-LINK-03). With a
    `redirectUrl`, the page goes to that URL 7 seconds after the booking
    (E-0217).

### Reschedule and cancel

16. Reschedule by the booker: the confirmation page and the event
    description have a reschedule link. It opens the booking page of the
    same link in reschedule mode. A new time patches the same Google event
    (same event id) and sends update emails (E-0217).
17. In reschedule mode, the booking being moved does not count as a
    conflict and does not count against `maxPerDay` or `maxPerWeek`
    (Proposed).
18. Cancel by the booker: the confirmation page and the event description
    have a cancel link. Tempoloom cancels the Google event with guest
    notifications and sends cancel emails (E-0217). Proposed: the booker may
    add an optional reason.
19. Proposed: when the host moves the booked event in Google Calendar,
    Tempoloom records a reschedule; when the host deletes it, Tempoloom
    records a cancel. Both fire the matching webhook (SPEC-INT-13).
20. Proposed: deleting a link keeps its booked events. Their reschedule and
    cancel links keep working until the event start.

### Reminder email

21. When `reminder.enabled` is true, Tempoloom emails the booker
    `hoursBefore` hours before the start, with `reminder.message` (E-0063).
    The setting applies to all future bookings of the link. A booking that
    already exists gets the reminder only if its reminder time is still in
    the future when the setting is saved (E-0063).

### Scheduler and other calendars

22. A booked event is a fixed constraint for the scheduler of every
    organizer and of the assignee. No managed item is ever placed over it,
    whatever its priority (E-0165, E-0141, E-0113, E-0090;
    `events-external-priority.md` rule 11).
23. After a booking or a reschedule, Tempoloom runs the scheduler for each
    organizer and assignee whose managed events overlap the booked event
    or its buffers. Those managed events move to their next valid time
    under their own rules (E-0141, E-0162, E-0088).
24. A booking over an external event whose priority the user lowered does
    not change that external event. Both events stay on the calendar
    (E-0104, E-0165; `events-external-priority.md` rule 5).
25. A booking over a flexible meeting occurrence makes the occurrence move
    under SPEC-MEET-02. If the occurrence cannot move, it stays in conflict
    and is flagged.
26. Tempoloom reads each organizer's calendars through that organizer's
    stored tokens. It writes the event only to the host's `targetCalendar`.
    Other organizers get the event through the Google invitation. Proposed:
    Tempoloom matches the invitation copy on their calendars by iCalUID and
    treats it as the booked event in their scheduler.
27. The booking horizon (`rangeEnd`, up to 100 days) does not depend on the
    planning window. Beyond the planning window there are no managed
    events, so only external and booked events limit the times there
    (E-0003).
28. With `useRecoveryBuffer` and `useTravelBuffer` on, the buffer rules
    (`buffers-automation.md`, `buffers-travel.md`) place recovery and travel
    buffers around the booked event, which is a buffer anchor (E-0063). `bufferBefore` and `bufferAfter` are checked by availability
    (SPEC-LINK-02). Proposed: they create no event.

## Outputs

- Google Calendar of the host: one busy event per booking, as in rule 12.
- Google Calendar of other organizers and the booker: the invitation.
- Emails from Tempoloom: confirmation, update and cancel to organizers and
  booker; the reminder to the booker.
- Managed events of organizers moved after a booking.
- Links page: cards grouped by page, with the actions of rule 5.
- Webhook requests for create, reschedule and cancel (SPEC-INT-13).

## Edge cases

1. Two bookers submit the same slot concurrently: the first write wins.
   The second gets the "no longer available" error (rule 11) (Proposed).
2. The host disconnects the account of `targetCalendar`: the link offers no
   times and the links page shows an error on the card (Proposed).
3. An organizer leaves the team: the link stops offering times until the
   main organizer removes that organizer (Proposed).
4. `durations` change while a booker has the page open: the submit check
   (rule 11) rejects a duration that is no longer allowed.
5. `{organizer}` on a link with no organizers (round robin only): it uses
   the assignee's display name (Proposed).
6. The booker's email equals an organizer's email: the booking is allowed;
   the guest list has no duplicate (Proposed).
7. Reminder time already passed when the booking is made (booking less than
   `hoursBefore` before start): no reminder is sent.
8. A `redirectUrl` that does not start with `https://`: the form refuses to
   save (E-0063).

## Observed API shapes

Not yet observed.

## Open questions

1. Default values of `priority`, `durations`, `rangeStart`, `rangeEnd` and
   `eventTitleTemplate` in the current version.
2. Which calendars count for availability: all connected calendars of each
   organizer, or a chosen subset? E-0173 suggests both are possible.
   Proposed: all connected calendars.
3. Are `bufferBefore` and `bufferAfter` written as events, or only kept
   free?
4. Which response types do questions support, and can a question be
   required? E-0173 shows a single-line type and a required question.
5. Does the reference send a webhook and emails when the host moves or
   deletes the booked event in the calendar?
6. What are the three starter links in the current version?
7. Does a link have an on/off switch apart from delete?
8. Does the booker get to add a reason when cancelling?

## Acceptance tests

Test accounts: A is a Tempoloom user (host). A's meeting hours are Monday to
Friday 09:00 to 17:00 in A's calendar time zone, start intervals :00 and :30.
The booker uses a private browser window and the test email address E.
All dates are in the next calendar week.

1. Book a slot
   - Setup: link "Intro" (P4, duration 30, no limits, location Meet). A's
     calendar is empty on Tuesday.
   - Action: open the booking page, pick Tuesday 10:00, enter name "Test
     Booker" and email E, confirm.
   - Expected: A's calendar has a busy event Tuesday 10:00 to 10:30 with
     guest E, a Meet link, and reschedule and cancel links in the
     description.
   - Reload: the booking page no longer offers Tuesday 10:00; the event is
     still in A's calendar after reload.
2. Booking displaces a lower-priority managed event
   - Setup: link "Important" at P1. A has a P3 habit placed Tuesday 10:00 to
     11:00.
   - Action: book Tuesday 10:00 for 30 minutes.
   - Expected: the booked event is at 10:00 to 10:30; the habit moved out of
     10:00 to 10:30.
   - Reload: both times persist after reload.
3. A managed item never takes a booked slot
   - Setup: test 1 done. A creates a P1 habit with ideal time Tuesday 10:00.
   - Action: sync.
   - Expected: the habit is not placed at 10:00 to 10:30.
   - Reload: same after reload.
4. Reschedule by the booker
   - Setup: test 1 done.
   - Action: open the reschedule link from the event description; pick
     Wednesday 11:00.
   - Expected: the same Google event id now runs Wednesday 11:00 to 11:30.
   - Reload: Tuesday 10:00 is offered again; Wednesday 11:00 is not.
5. Cancel by the booker
   - Setup: test 1 done.
   - Action: open the cancel link; confirm.
   - Expected: the event is cancelled in A's calendar.
   - Reload: Tuesday 10:00 is offered again after reload.
6. Lowered external event is not changed
   - Setup: link at P1. A has an external event Tuesday 14:00 to 15:00 whose
     priority A lowered to P3.
   - Action: book Tuesday 14:00.
   - Expected: the booked event and the external event both exist at 14:00.
   - Reload: both persist after reload.
7. Redirect after booking
   - Setup: link with `redirectUrl` set to an https page that the test
     controls.
   - Action: book any slot.
   - Expected: the confirmation shows, then the browser is on the redirect
     page 7 seconds later (allow 1 second of tolerance).
   - Reload: the booked event exists in A's calendar.
