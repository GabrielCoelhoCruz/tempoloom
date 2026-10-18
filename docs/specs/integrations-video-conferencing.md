# Video conferencing integrations: Zoom and Gong

Spec id: SPEC-INT-03
Evidence: E-0156 (ev_20ff2ded5fee), E-0038 (ev_8e1051e687ac), E-0227 (ev_1a84a969cba0), E-0189 (ev_d31be1b5cb3f), E-0168 (ev_8dc3c6fd18f7), E-0157 (ev_a6d35a3b7c5b)
Status of evidence: public docs only

## Summary

Zoom: the user connects a Zoom account. Tempoloom then sees when the user
joins and leaves Zoom calls, and updates the Slack status and DND during
calls. It also shows Zoom join buttons in the Planner, adds Zoom links to
booked and flexible meetings, links transcripts, and can place recovery
buffers after Zoom meetings.

Gong: a team admin connects the organization's Gong account once. Tempoloom
then pairs team members with Gong users by email. When an invitee books
through a booking link, Tempoloom puts a Gong link on the event, so that
the sales-call recorder can record it.

## Concepts and inputs

Zoom connection (per user): Zoom user id, Zoom account id, granted scopes.

Zoom preferences (per user):

| Field | Type | Default | Notes |
|---|---|---|---|
| `slack_status_on_call` | bool | true when Slack is connected (Proposed default) | Needs Slack and status sync. |
| `dnd_on_important_calls` | bool | false (Proposed default) | Needs Slack DND permission. |
| `link_transcripts` | bool | true (Proposed default) | Needs Zoom cloud recording with transcripts. |
| `buffer_after_zoom` | bool | false (Proposed default) | Uses the recovery buffer settings of `buffers-automation.md`. |

Conference option "Zoom": a value of the conference field of booking links
(`booking-links.md`) and flexible meetings (`meetings-flexible.md`).

Gong connection (per team): Gong workspace id, stored OAuth grant, link
mode. Scopes, as named in Gong: `api:users:read` and
`api:meetings:user:create`. Tempoloom requests no other Gong scope.

Gong link mode (comes from the Gong organization):

| Mode | Meaning |
|---|---|
| reusable | Each host has one fixed Gong consent link. |
| unique | Each meeting needs a new Gong meeting and link. |

Gong user match (per team member): Gong user id, match status (`matched`,
`not_found`, `deactivated`), last checked time.

## Behavior

### Zoom: connect and disconnect

1. The user connects Zoom from Settings > Integrations (overview spec
   rules). Zoom login and consent follow. The Zoom account must allow
   third-party apps; Zoom can require admin approval of the app.
2. After consent, Tempoloom shows the Zoom preferences above.
3. Disconnect stops presence detection, status and DND changes, join
   support, transcript links and Zoom buffers. Events, Slack statuses and
   transcripts that already exist stay.
4. The user can also uninstall the app in the Zoom App Marketplace (overview
   rule 9).

### Zoom: call presence

5. Tempoloom gets an event from Zoom when the connected user joins or
   leaves a Zoom call.
6. On join, when `slack_status_on_call` is true and Slack status sync is
   on, Tempoloom sets the Slack status to the meeting status of the Slack
   spec (`integrations-slack.md`, category "Meeting").
7. On leave, Tempoloom clears that status. Then the Slack spec's calendar
   rule decides the next status.
8. Rules 6 and 7 apply to calls that match a calendar event and to ad hoc
   calls with no calendar event. When a call runs past its event end, the
   status stays until the user leaves. When the user leaves early, the
   status clears at once.
9. While the user is in a call, the call status wins over any status from
   the calendar.
10. When `dnd_on_important_calls` is true, Tempoloom turns on Slack DND on
    join of an important call and turns it off on leave. Proposed default
    for "important": the call's calendar event has a category with `dnd`
    true in the Slack status settings, or the event is an external meeting.
    Ad hoc calls are not important.

### Zoom: links and Planner

11. In the Planner, an event that has a Zoom join URL (in the conference
    data, location or description) shows a Join button. The button opens
    the Zoom URL.
12. A booking link or flexible meeting can use the conference option
    "Zoom". Then Tempoloom creates a Zoom meeting for each calendar event
    that it creates, with the event title, start time and duration. It writes the
    join URL into the event's conference data and location. (Per-event
    meeting: Proposed default.)
13. When Tempoloom moves such an event, it updates the Zoom meeting time.
    When it deletes the event, it deletes the Zoom meeting. (Proposed
    default.)
14. Without the Zoom integration (legacy evidence), a user can paste Zoom
    details into the first event of a recurring flexible meeting in Google
    Calendar. The details then apply to the series. Later events may show
    them only after the first event is in the past. Tempoloom must keep
    conference data that a user added by hand when it moves events of the
    series.

### Zoom: transcripts and buffers

15. When `link_transcripts` is true and Zoom has a transcript for a
    finished call, Tempoloom adds a "Transcript" link to the event details
    in the Planner. Zoom recording and transcription settings decide whether
    a transcript exists.
16. When `buffer_after_zoom` is true, Tempoloom places a recovery buffer
    after events that have a Zoom link. The buffer length and rules come
    from `buffers-automation.md`; there, this is a recovery buffer with the
    condition `has_video_link`, limited to Zoom links.

### Gong

17. Only a user who is an admin of the Tempoloom team and an admin in Gong
    can connect Gong. The connection applies to the whole team. Other users
    do not consent.
18. Tempoloom stores the grant and refreshes the access token when needed.
19. User matching: after connect, and then periodically, Tempoloom reads
    the Gong user directory. It pairs each active Gong user with the team
    member who has the same email address. Proposed defaults: the match is case-insensitive, and the
    period is 24 hours.
20. A matched user is enabled for Gong automatically. A user who is
    deactivated in Gong is disabled at the next match run.
21. Enabled users see "Gong" as a conference option in the booking link
    editor. Tempoloom sets Gong as the default conference option for the
    booking links of enabled users. (Scope of "default": see open
    questions.)
22. When an invitee books a meeting on a booking link with the Gong option:
    - reusable mode: Tempoloom puts the host's Gong link in the event
      location;
    - unique mode: Tempoloom creates a Gong meeting from the booked
      meeting's start, end, title, organizer and invitees, and puts the
      returned link in the event location.
23. Tempoloom does not read Gong recordings, transcripts or conversation
    content.
24. A team admin disconnects Gong. Tempoloom stops matching users and stops
    adding Gong links to new bookings. Events that already exist do not
    change. A Gong admin can also revoke the grant in Gong.

## Outputs

- Slack status and DND changes on Zoom join and leave.
- Planner Join button and Transcript link.
- Calendar events with Zoom or Gong links in conference data or location.
- Zoom meetings created, moved and deleted with their events.
- Recovery buffer events after Zoom meetings (buffer spec).

## Edge cases

1. The user joins a second Zoom call before leaving the first: the status
   stays until the user leaves the last call.
2. Zoom sends the leave event late or never. Proposed default: clear the
   call status 4 hours after the event end. For ad hoc calls, clear it 4
   hours after join.
3. Slack is not connected: Zoom presence does nothing visible; the
   preferences view says that Slack is required.
4. A booking uses the Gong option, but the host is not matched. Proposed
   default: use the link's second conference option, or no link. The
   booking link editor shows a warning.
5. A booked Gong meeting is rescheduled or cancelled: see open questions.
6. Two team members have the same email in Gong: match none and show the
   conflict to the admin. (Proposed default.)

## Observed API shapes

Not yet observed.

## Open questions

1. Which calls count as "important" for DND in the reference?
2. Where does the reference show Zoom transcripts, and what does it do with
   them?
3. Does the Zoom buffer use the normal recovery buffer length?
4. Does the reference create one Zoom meeting per event, or one per booking
   link or per flexible meeting series?
5. For Gong unique links, does the reference update or recreate the Gong
   meeting when a booked meeting moves, and does it delete it on cancel?
6. Does "Gong as default" change existing booking links, or only new ones?
7. How often does the reference run Gong user matching?

## Acceptance tests

1. Slack status follows an ad hoc Zoom call.
   - Setup: Google Calendar test account, Slack and Zoom test accounts
     connected, status sync on. No calendar event now.
   - Action: start an instant Zoom meeting as the user. Wait 1 minute.
     Leave the meeting.
   - Expected: during the call, the Slack status shows the meeting status.
     Within 1 minute after leave, the status is empty. Google Calendar has
     no new event.
   - Reload: reload Slack. The status is empty.
2. Call runs past the event end.
   - Setup: busy event from now to now + 10 minutes with a Zoom link.
   - Action: join the call; stay 5 minutes after the event end; leave.
   - Expected: the status stays during the extra 5 minutes and clears after
     leave.
   - Reload: status empty after reload.
3. Zoom link on a booked meeting.
   - Setup: booking link with conference option "Zoom".
   - Action: book a slot as an invitee.
   - Expected: the Google Calendar event has a Zoom join URL in its
     conference data or location. The Planner shows a Join button.
   - Reload: reload Google Calendar and the Planner. The link and button
     remain.
4. Gong link on a booked meeting.
   - Setup: Gong test organization in reusable mode, connected by an admin.
     Team member with the same email in Gong. Booking link with the Gong
     option.
   - Action: book a slot as an invitee.
   - Expected: the event location in Google Calendar is the host's Gong
     link.
   - Reload: the location remains after reload.
5. Gong deactivation.
   - Setup: test 4 state.
   - Action: deactivate the user in Gong. Run user matching.
   - Expected: the Gong option is no longer offered for that user's booking
     links. Existing events keep their links.
   - Reload: same state after reload.
