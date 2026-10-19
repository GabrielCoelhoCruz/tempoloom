# Booking page and branding

Spec id: SPEC-LINK-03
Evidence: E-0217 (ev_cec6f530162a), E-0063 (ev_1f870480468c), E-0055 (ev_4afbb658ac95), E-0163 (ev_aa5715921a1a), E-0173 (ev_cc5ae996c9b1), E-0066 (ev_e85176d32a5d), E-0065 (ev_02ad624a317c)
Status of evidence: public docs only

## Summary

The booking page is what a booker sees when opening a booking link. The
booker picks a duration, a date and a time in any time zone, fills a short
form, and gets a confirmation with reschedule and cancel actions. Bookers
need no account. A booker who is a Tempoloom user can overlay their own
calendar. The team can brand the page and its emails with its own logo and
banner, or remove branding.

## Concepts and inputs

### Page inputs

| Input | Type | Source |
|---|---|---|
| link settings | | SPEC-LINK-01 |
| offered times | list of starts with a `preferred` flag | SPEC-LINK-02 |
| URL parameter `tz` | IANA time zone name | E-0063 |
| URL parameter `day` | date, `YYYY-MM-DD` | E-0063 |
| URL parameter `time` | 24-hour local time, `HH:MM` | E-0063 |
| URL parameter `duration` | minutes | E-0063 |
| URL parameters `data-*` | custom data for webhooks | SPEC-INT-13 rules 18 to 21 |
| one-off link prefill | invitee name and email | SPEC-LINK-05 |

### Details form fields

| Field | Type | Required | Evidence |
|---|---|---|---|
| `name` | string, 1 to 120 characters | yes | E-0217 |
| `email` | valid email address | yes | E-0217 |
| `cc` | list of email addresses, up to 10 (Proposed limit) | no | E-0217 |
| `message` | text, up to 2 KB (Proposed limit) | no | E-0217 |
| `location` | one of the link's location options | yes when the link has more than one | E-0063, E-0217 |
| answers | one per link question | per question `required` | E-0217, E-0173 |

### Branding

| Setting | Level | Values | Evidence |
|---|---|---|---|
| `teamBranding` | team | `default` (Tempoloom logo), `none`, `custom` | E-0055, E-0163 |
| `groupBranding` | link group | `default`, `none`, `custom` | E-0055 |
| link `branding` | link | `sameAsGroup`, `default`, `none`, `custom` | E-0055 |
| `logo` | team asset | JPG or PNG, at most 2 MB | E-0055 |
| `banner` | team asset | JPG or PNG, at most 8 MB; 1200 x 400 px recommended | E-0055 |
| `homepageUrl` | team setting | URL or empty | E-0055 |

## Behavior

### Booking page

1. Anyone with the URL can open the page and book. No account is needed
   (E-0217).
2. The page header shows the link title and description (E-0063), and the
   branding (rules 25 to 31).
3. When the link has more than one duration, the page shows the durations
   at the top, with `defaultDuration` selected. A change of duration loads
   the times for that duration (E-0217, E-0063).
4. The page shows a date picker and the list of offered times for the
   selected date (SPEC-LINK-02).
5. Each preferred time has a green dot (E-0217, E-0066).
6. Time zone picker: a searchable list of IANA time zones. The default is the
   browser's time zone. When the selected zone differs from the browser's
   zone, or from the logged-in user's calendar zone, the page lists that
   actual zone first so the booker can compare (E-0217).
   Tempoloom decision: the list starts with the browser's zone and, for a
   signed-in user whose calendar zone differs, that calendar zone; then all
   zones. A search field filters the list. The page says which zone the
   times use and, when it differs, the browser's zone. The chosen zone is
   kept in the URL (`tz`), so a reload shows the same view.
7. Time format switch: 12-hour or 24-hour (E-0217). Proposed default: from
   the browser locale.
   Tempoloom decision: the last choice is kept in the browser (local
   storage); 12-hour times read like "9:00 AM".
8. All times on the page are shown in the selected zone. The server works in
   UTC.
9. URL parameters (E-0063):
   - `tz` selects the time zone;
   - `day` opens that date;
   - `time` selects that start on that date, if it is offered;
   - `duration` selects that duration, if the link has it.
   An invalid or unavailable value is ignored, and the page uses its
   default (Proposed).
   Tempoloom decision: `day` starts the list of dates at that date; `time`
   opens the details form for that start; a change of duration or zone
   updates `duration` and `tz` in the URL.
10. Overlay my calendar: when the booker is logged in to Tempoloom, the page
    shows a switch that overlays the booker's own events next to the
    offered times (E-0217, E-0173). The organizer's calendar is never shown
    to bookers (E-0217).
    Tempoloom decision: the overlay lists the booker's events of all their
    connected calendars under each date, and marks offered times that
    overlap one of them. The switch state is kept in the browser.
11. Inspect availability: organizers see the inspector switch (SPEC-LINK-02).

### Details and confirmation

12. After the booker picks a time and selects next, the page shows the
    details form (E-0217).
13. The questions of the link show in the details form, in their order
    (E-0217, E-0063).
14. Confirm creates the booking (SPEC-LINK-01 rules 11 to 13). Required
    fields must be filled first (E-0217).
15. The confirmation page shows the title, date, start and end in the
    booker's zone, the location, the organizers, and two actions:
    reschedule and cancel (E-0217).
16. For a round-robin link, the confirmation page shows the assigned
    host's name and email address. Before confirmation the page shows no
    host name (E-0065, E-0163).
17. With a `redirectUrl`, the page goes to that URL 7 seconds after the
    confirmation shows (E-0217). Embedded pages follow the embed redirect
    mode (SPEC-LINK-05).
18. The reschedule action opens the page in reschedule mode: it shows the
    current time and the offered times; a new pick replaces the time
    (SPEC-LINK-01 rule 16).
19. The cancel action asks for confirmation, then cancels (SPEC-LINK-01
    rule 18).
20. The event description has the same reschedule and cancel links
    (E-0217). Each link holds a random token of at least 128 bits that
    identifies the booking (Proposed).

### Emails

21. On create, reschedule and cancel, Tempoloom emails the organizers and
    the booker (E-0217). Each email has the title, the time in the
    recipient's zone (Proposed: the booker's selected zone for the booker,
    the calendar zone for organizers), the location, and the reschedule and
    cancel links (booker email only).
    Tempoloom decision: subjects start with "Booked:", "Rescheduled:" or
    "Cancelled:" for the booker, and "New booking:", "Rescheduled:" or
    "Cancelled:" for organizers. Organizer emails also have the booker's
    name, email, message and answers. Each email has a plain text and an
    HTML part; the HTML part carries the branding with absolute image URLs.
    The reschedule and cancel links open the manage page in that mode; the
    cancel link asks before it cancels.
22. The reminder email follows SPEC-LINK-01 rule 21.
23. Emails use the branding of the link (E-0055).
24. A one-off link can prefill name and email (SPEC-LINK-05). The booker can
    change them.

### Branding

25. Branding applies to the booking page, embeds and the emails about
    bookings (E-0055).
26. `default`: Tempoloom's logo. `none`: no logo. `custom`: the team's logo
    and banner (E-0055, E-0163).
27. Resolution order: the link setting wins; `sameAsGroup` uses the
    group's setting; the group setting overrides the team setting (E-0055).
28. The team setting is only a starting value: a group or link copies it
    when it is created. A later change of the team setting does not reach
    a group or link with an explicit value (E-0055).
29. Only a team admin can upload the logo and banner and set the team
    default. Any team member can choose `custom` for a link (E-0055,
    E-0163).
30. Banner images that are not 1200 x 400 px are cropped to fill that area
    (E-0055). Proposed: center crop to a 3:1 ratio.
31. The logo links to `homepageUrl`. When `homepageUrl` is empty, the logo
    is not a link (E-0055).

### Scheduler and other calendars

32. The page never shows organizers' event details to bookers. It shows only
    offered times (E-0217).
33. Overlay data comes from the booker's own Tempoloom account and is never
    stored with the booking (Proposed).

## Outputs

- Public booking page: header, branding, durations, date picker, times with
  preferred dots, time zone picker, format switch, details form,
  confirmation page, reschedule mode, cancel confirmation.
- Emails: confirmation, update, cancel, reminder.
- No calendar writes except through SPEC-LINK-01.

## Edge cases

1. `time` parameter for a start that is not offered: the date opens, no time
   is selected.
2. A booker in a zone with a 30-minute offset: times show with their real
   local minutes (for example 10:30 instead of 10:00).
3. The booker opens an old reschedule link after the booking was cancelled:
   the page says the booking is cancelled and offers a new booking
   (Proposed).
4. The booker opens a reschedule link after the meeting started: the page
   refuses the reschedule (Proposed).
5. Banner upload over 8 MB or not JPG or PNG: the upload is refused with a
   message (E-0055).
6. An embed in a page without a top-level redirect permission: see
   SPEC-LINK-05.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the overlay switch work for a booker who is logged in to another
   instance? Proposed: no, only for users of the same instance.
2. Can the booker change the time zone after picking a time?
3. Do bookers see the list of organizers before confirming on a team link?
4. What is in the reference's confirmation and update emails?
5. Is the 7-second redirect delay fixed or configurable?

## Acceptance tests

Test accounts: A is a Tempoloom user (host), time zone America/New_York,
meeting hours 09:00 to 17:00, start minutes :00 and :30, empty calendar on
next Tuesday. Link "Chat" at P4 with durations 30 and 60, default 30, two
locations (Meet and an address), one required single-line question. The
booker uses a private browser window.

1. Durations and time zone
   - Setup: as above.
   - Action: open the page with `?tz=Europe/London&duration=60`.
   - Expected: 60 is selected; next Tuesday's first time is 09:00 New York
     time, shown in London time. Switching to 30 lists more times.
   - Reload: the same parameters give the same view.
2. Book with the form
   - Setup: as above.
   - Action: pick next Tuesday 10:00 New York time, fill name, email, one CC,
     message, answer, pick the address location, confirm.
   - Expected: A's calendar has an event 10:00 to 10:30 with guests booker
     and CC, the address as event location, and the message and answer
     in the description. The confirmation page shows the reschedule and
     cancel actions.
   - Reload: the confirmation URL still shows the booking after reload.
3. Required question
   - Setup: as above.
   - Action: try to confirm without an answer.
   - Expected: the form shows an error; no event is created.
   - Reload: Tuesday 10:00 is still offered.
4. Branding override
   - Setup: team default `custom` with a logo; group default `none`; link
     `sameAsGroup`.
   - Action: open the page.
   - Expected: no logo. Set the link to `custom`, reload: the team logo shows.
   - Reload: settings persist after reload.
5. Overlay
   - Setup: B is a Tempoloom user on the same instance with an event next
     Tuesday 11:00 to 12:00 New York time.
   - Action: B opens the page logged in and turns on the overlay.
   - Expected: B's event shows next to the times; A's events never show.
   - Reload: the overlay switch is visible again after reload.
