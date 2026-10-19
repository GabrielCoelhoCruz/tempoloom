# Meeting quality checks

Spec id: SPEC-AUTO-02
Evidence: E-0134 (ev_86c342a26f3c), E-0043 (ev_d7b30359b03e), E-0141 (ev_d12320a15a83)
Status of evidence: public docs only

## Summary

Meeting quality automations look at upcoming meetings and flag problems
before the meeting starts: overlapping commitments, attendees who declined or
are not free, invitations the user has not answered, and meetings without a
video link. They are on for every user from the start and need no setup.
Team admins can add company checks. Checks never block or change a meeting;
they only raise an issue.

## Concepts and inputs

### Built-in checks

| Check id | Raises an issue when | Proposed precise rule |
|---|---|---|
| `conflict` | Two commitments overlap (E-0134). | Two busy events overlap by at least 1 minute, and each is an event the user organized or accepted, a booking-link meeting, or a locked managed event. Free events, declined events and unlocked managed events never count. |
| `attendee_availability` | An attendee declined, or is not free at that time (E-0134). | The user organizes the meeting, and an attendee's response is "declined", or a same-domain attendee's free/busy shows busy at that time. |
| `rsvp_reminder` | The user has not answered an invitation (E-0134). | The user's response is "needs action". |
| `video_link` | A meeting has no video link (E-0134). | The event has at least one other attendee, is not all-day, has no conference data, has no video URL in location or description, and has no physical address in its location. |
| `company` | An admin-defined standard is not met (E-0134). | See "Company checks". |

Proposed horizon for all checks: events that start in the next 7 days.

Tempoloom decision: the horizon is 7 days. Checks read events on calendars
that count for availability. A video link is an RFC 7986 CONFERENCE property
(Google: a Meet link), or a URL in the location or description whose host
names a video service (Zoom, Meet, Teams, Webex, Whereby, Jitsi and similar)
or contains "meet", "video" or "call". "Not free" is read only for a guest who
is a Tempoloom user on this instance: a busy, timed event that guest
organizes or accepted overlaps the meeting. Each guest's answer is read from
the event (CalDAV PARTSTAT, Google responseStatus). Checks skip events the
user declined, all-day events and calendar mirroring copies; the `conflict`
check counts only locked managed events, as the rule says.

Tempoloom decision: library entry 4 ("Agenda drafts for my meetings") adds a
fifth check, `agenda`, off by default: a meeting the user organizes, with
guests and an empty description, gets a "No agenda" issue. Its "Draft agenda"
action shows a fixed agenda template (title, three agenda points, guests) in
the Issues tab; Tempoloom writes it into the event description only when the
user applies it. Tempoloom has no AI drafting.

### Issue

| Field | Type | Notes |
|---|---|---|
| `check_id` | id | |
| `event_id` | id | The event, or the first of two events for `conflict`. |
| `series_id` | id or none | For recurring events. |
| `message` | string | Short text that names the problem. |
| `state` | `open`, `ignored`, `resolved` | |

### User settings

| Field | Type | Default |
|---|---|---|
| enabled per built-in check | bool | `true` (E-0134) |
| `digest_channel` | `email`, `chat`, `both`, `none` | Proposed: `email` |
| `digest_time` | local time | Proposed: 08:00 |

Tempoloom decision: the channel is `email` or `none`. A chat app channel needs
a chat integration (a vendor app), which Tempoloom does not have. The digest
goes out at the first check after `digest_time` in the user's time zone; a new
time takes effect at its next occurrence, which is today when the time is still
ahead. No email is sent when there is no open issue.

## Behavior

1. Each new user gets all built-in checks enabled. The user configures nothing (E-0134).
2. The user can disable one check from the automation list. A disabled check raises no new issues and closes its open issues (E-0134).
3. For an open issue, the user can ignore it for this event or for the whole series. An ignored issue does not come back for that scope (E-0134).
   Tempoloom decision: issues are computed from the event cache each time they
   are read, so an issue resolves as soon as its condition ends (rule 5) and
   turning a check off closes its issues at once (rule 2). Only ignores are
   stored. A `conflict` issue belongs to the earlier of the two events.
4. Tempoloom re-evaluates checks when an event in the horizon changes, and at least every 15 minutes. Proposed.
5. When the condition of an open issue is no longer true, the issue becomes `resolved` and leaves the issue list. Proposed.
6. Issues show in three places (E-0134):
   - the "Issues" tab in the planner side panel;
   - the assistant chat, when the user asks about the schedule;
   - the daily digest, sent by email, by the chat app, or both, as set in notification settings.
7. Checks never decline, move or edit an event (E-0134).

### Company checks

8. A team admin can create a company check. It applies to every member's calendar (E-0134).
9. A company check is a condition on a meeting. Example: more than four attendees and an empty description ("no agenda") (E-0134). Proposed condition fields: attendee count, external attendees present, description empty, length, video link present, title text.
   Tempoloom decision: these six fields, all of which must hold. The attendee
   count includes the organizer. A guest is external when the email domain
   differs from the team's domain. A company check applies to the meetings the
   organizer organizes; it shows in the Issues tab as "Company check".
10. A company check raises its issue only for the meeting's organizer (E-0134).
11. Company checks show in the "Meeting quality" section with a lock icon. Only admins may change or turn them off. A member can still ignore a single issue. Proposed for ignore (E-0134).
12. A company check never stops anyone from booking the meeting (E-0134).

### Scheduler interaction

13. Meeting quality checks do not place, move or defend any event. They read the calendar after each scheduler run.
14. The `conflict` check ignores overlaps that the scheduler will resolve by itself (unlocked managed events).
15. A conflict that involves a booking-link meeting placed over a lowered external event (see `events-external-priority.md`) raises a `conflict` issue.

## Outputs

- Issues in the planner "Issues" tab, with event link, message, and "ignore" actions.
- Daily digest message on the chosen channel.
- Assistant chat answers that include open issues.

## Edge cases

1. An all-day event overlapping a timed meeting: not a conflict. Proposed.
2. A recurring meeting with the same problem every week: one issue per occurrence in the horizon; "ignore for series" closes all of them.
3. An attendee with a private calendar: the availability part of `attendee_availability` is skipped; the declined part still works.
4. A meeting the user organizes but has not marked as accepted: counts as a commitment.

## Observed API shapes

Not yet observed.

## Open questions

1. What horizon do the checks use?
2. How does the reference product decide that an attendee "is not available"?
3. Does the video link check skip in-person meetings?
4. What condition fields can admins use in company checks?
5. When is the daily digest sent, and what is its default channel?

## Acceptance tests

Common setup: Google Calendar test account with a same-domain second account
and an other-domain third account. Home time zone America/New_York. Test day
is a weekday at least 1 day ahead and within 7 days.

1. **Missing video link.**
   Action: create a meeting 10:00 to 10:30 on the test day with the second account, no conference link, no location.
   Expected: within 15 minutes, the Issues tab shows a `video_link` issue for it.
   Action: add a Google Meet link.
   Expected: the issue becomes resolved and leaves the tab.
   Reload: the tab shows no issue for this meeting.

2. **Unanswered invitation.**
   Action: from the third account, invite the test user to a meeting on the test day. Do not answer.
   Expected: an `rsvp_reminder` issue appears. After accepting, it resolves.
   Reload: no open issue for it.

3. **Attendee declined.**
   Action: the test user organizes a meeting with the second account. The second account declines.
   Expected: an `attendee_availability` issue appears for the test user.
   Reload: the issue persists until the attendee accepts or is removed.

4. **Ignore for series.**
   Setup: a weekly recurring meeting with an attendee and no video link.
   Action: ignore its issue for the whole series.
   Expected: no `video_link` issues for any occurrence.
   Reload: still none.

5. **Disable a check.**
   Action: disable `rsvp_reminder` in the automation list.
   Expected: open RSVP issues close. A new unanswered invitation raises none.
   Reload: the check stays disabled.

6. **Conflict.**
   Action: accept two meetings that overlap 11:00 to 11:30 on the test day.
   Expected: a `conflict` issue names both meetings. Neither meeting changes.
   Reload: the issue persists until one meeting is declined or moved.
