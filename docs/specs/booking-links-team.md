# Team links and round-robin links

Spec id: SPEC-LINK-04
Evidence: E-0066 (ev_e85176d32a5d), E-0065 (ev_02ad624a317c), E-0163 (ev_aa5715921a1a), E-0063 (ev_1f870480468c), E-0205 (ev_e2940d16a99b), E-0007 (ev_e10aa7cec1e9)
Status of evidence: public docs only

## Summary

A team link is a booking link with several organizers from one team. It
offers only the times when every required organizer can meet, and invites
all organizers. A round-robin link has a pool of team members. It offers a
time when at least one pool member can meet, and books the meeting with one
of them. Round-robin links can also have organizers who join every meeting
(E-0007, E-0163).

## Concepts and inputs

Team links use the `organizers` field of SPEC-LINK-01. Round-robin links add
`roundRobinPool`.

### Pool record

| Field | Type | Default | Notes |
|---|---|---|---|
| `userId` | Tempoloom user | | member of the link owner's team (E-0065, E-0163) |
| `hours` | hours set id, or item-specific hours (`planning-hours.md`) | the member's meeting hours | E-0163 |
| `preferred` | boolean | false | preferred organizers are chosen first (E-0065, E-0163) |

### Link kinds

| Kind | `organizers` | `roundRobinPool` |
|---|---|---|
| Personal link | the creator only | empty |
| Team link | 2 or more | empty |
| Round-robin link | 0 or more | 2 or more (Proposed minimum) |

## Behavior

### Team links

1. The creator adds teammates as organizers in the organizers section
   (E-0066, E-0163). Only members of the creator's Tempoloom team can be
   added. The member picker has an action to invite a new team member
   (E-0066).
2. For each organizer, the creator picks the hours to use: any hours set of
   that organizer, or item-specific hours. Each co-organizer can later change
   their own hours on the link (E-0066, E-0163).
3. An organizer can be marked optional. Tempoloom then ignores that
   organizer's availability, and still invites that organizer to every
   booking as an optional guest (E-0066, E-0163, E-0063).
4. The link offers a time only when every availability check passes for
   every required organizer (SPEC-LINK-02 rule 16).
5. The link has one priority, set by the main organizer, used for every
   organizer's calendar (E-0066, E-0163).
6. A preferred time must be free of any event on every required organizer's
   calendars (E-0066).
7. With recovery buffers on, Tempoloom uses the longest recovery buffer
   among the organizers (E-0063). The settings form suggests turning
   buffers off for team links to offer more times (E-0063).
8. Every booking invites all organizers (E-0066, E-0163).
9. Exactly one organizer is host. The host is the organizer of the Google
   event, and Tempoloom uses the host's conference integration (E-0063).
10. Every co-organizer can view, copy and change the link in their own
    account. A co-organizer cannot change the link's page (group). A
    co-organizer who views the link sees a note that another user owns it
    (E-0066).
11. Links where the user is a co-organizer appear in the user's "team
    links" page group (E-0205).

### Round-robin links

12. The creator adds team members to the pool from the organizers section
    (E-0065, E-0163).
13. The link may also have organizers. Required organizers join every
    meeting and must be available. Optional organizers join every meeting
    and are not checked. The link may have no organizers at all (E-0065,
    E-0163).
14. Availability: a time is offered when every check passes for every
    required organizer, and every check passes for at least one pool member
    (E-0065, E-0163). The checks for pool members use the shared link
    priority on each member's calendar (E-0065, E-0163).
15. The booker sees the combined times and does not choose a person. The
    page shows no host name before confirmation (E-0065, E-0163).
16. Assignment at booking, among the pool members who pass every check for
    the chosen slot (E-0065, E-0163):
    1. if one or more preferred members pass, keep only those;
    2. keep the members with the fewest bookings through this link;
    3. Proposed tie-break: the member whose last assignment through this
       link is oldest (never assigned counts as oldest), then the lowest
       user id.
    The count in step 2 is open (see Open questions). Proposed: count
    non-cancelled bookings of this link that started within the past 30 days or
    in the future.
17. The default mode offers every pool member's time. Tempoloom does not
    hide times to balance the load; it balances only through rule 16
    (E-0065, E-0163).
18. Host: with no organizers, the assigned member is the host and the
    organizer of the event. With organizers, the organizer marked host is
    the host, and the assigned member is a guest (E-0065).
19. Target calendar: when the assigned member is the host, the event goes
    to that member's main account, primary calendar (Proposed). Otherwise
    the link's `targetCalendar` applies.
20. Reschedule: Tempoloom keeps the original member when that member passes
    every check at the new time. Otherwise it assigns again with rule 16
    (E-0065, E-0163).
21. A conference location that needs an integration (for example Zoom) must
    be enabled for every possible host. If one possible host lacks it, the
    form shows an alert and the link does not use that location (E-0065).
22. Every organizer and every pool member can see and edit most fields. Only
    the main organizer can change `targetCalendar`, `slug`, `page`, and
    delete the link (E-0065).
23. The confirmation page and the booker's emails name the assigned member
    (E-0065).

### Scheduler and other calendars

24. Tempoloom reads each organizer's and pool member's calendars through
    their own stored tokens. All of them must be Tempoloom users in the same
    team (E-0066, E-0163).
25. After a booking, the scheduler of each required organizer, each optional
    organizer and the assigned member treats the event as a fixed booked
    event and moves their lower-priority managed events away from it
    (SPEC-LINK-01 rules 22 and 23).
26. Pool members who are not assigned are not affected.

## Outputs

- Google event on the host's calendar, with all organizers (optional ones
  flagged) and, for round robin, the assigned member as guests.
- The booking record stores the assigned member.
- Links page: team links show the organizer avatars; round-robin links
  show the pool and the preferred marks (Proposed display).

## Edge cases

1. Every pool member is busy at a time but the required organizers are
   free: the time is not offered.
2. A preferred member is free but has more bookings than another free
   member: the preferred member is assigned (preferred is checked first).
3. A pool member leaves the team: Tempoloom removes the member from the
   pool for availability; existing bookings stay (Proposed).
4. Two bookings for the same slot arrive at once on a round-robin link with
   two free members: the first gets the member chosen by rule 16; the second
   gets the other member if that member still passes (Proposed).
5. A team link whose required organizers have no common hours: no time is
   offered; the inspector shows `outsideHours`.
6. On reschedule, the original member is free but is not preferred, and a
   preferred member is also free: the original member stays (rule 20 comes
   before rule 16).

## Observed API shapes

Not yet observed.

## Open questions

1. Over which period does the reference count bookings for load balance?
2. Can a link have pool members from outside the team?
3. What is the minimum pool size?
4. Is there a mode that balances the load strictly (equal distribution)?
   E-0065 says the default is maximum availability, which suggests other
   modes may exist.
5. Which calendar receives the event when the assigned member is the host?

## Acceptance tests

Test accounts: A and C are Tempoloom users in one team. A's meeting hours are
09:00 to 17:00; C's are 13:00 to 17:00. Both have start minutes :00 and :30
and empty calendars next Tuesday unless the test says otherwise. The booker
uses a private browser window.

1. Team link invites everyone
   - Setup: team link "Panel", A host, C required, 30 minutes, P4.
   - Action: book next Tuesday 14:00.
   - Expected: A's calendar has the event with guests C and the booker. C's
     calendar shows the invitation.
   - Reload: 14:00 is no longer offered after reload.
2. Optional organizer
   - Setup: as test 1, C optional, C has a busy event Tuesday 10:00 to 11:00.
   - Action: open the page for Tuesday.
   - Expected: 10:00 is offered. Booking it invites C as an optional guest.
   - Reload: the event shows C as optional after reload.
3. Round robin covers more time
   - Setup: round-robin link "Support" with no organizers, pool A and C,
     P4, 30 minutes.
   - Action: open the page for Tuesday; book 10:00.
   - Expected: 09:00 to 16:30 are offered. The 10:00 booking goes to A (only
     A is available). The confirmation shows A's name and email.
   - Reload: the event is on A's calendar with A as organizer.
4. Load balance
   - Setup: test 3 done.
   - Action: book Tuesday 14:00.
   - Expected: the booking goes to C (both free, C has fewer bookings).
   - Reload: the event is on C's calendar.
5. Preferred member
   - Setup: as test 3, A marked preferred, one earlier booking already
     assigned to A.
   - Action: book Tuesday 15:00.
   - Expected: the booking goes to A.
   - Reload: the event is on A's calendar.
6. Reschedule keeps the member
   - Setup: test 4 done (C has the 14:00 booking).
   - Action: reschedule it to 15:30, when both are free.
   - Expected: the same event, now at 15:30, still with C.
   - Reload: same after reload.
