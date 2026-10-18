# Executive assistant use

Spec id: SPEC-TEAMS-05
Evidence: E-0074 (ev_b5ca2d13ca39), E-0099 (ev_6bdab0fd61fa), E-0003 (ev_fdf25af08b9c), E-0182 (ev_80185208c432)
Status of evidence: public docs only (legacy evidence)

## Summary

An executive assistant manages one or more executives' calendars from their
own Tempoloom account. The executive grants delegated access once. The
assistant then switches into the executive's account and sets up flexible
meetings, booking links, habits, buffers, mirroring and priorities for
them. This spec lists the parts of that journey that are specific to
assistants, and points to the specs that own each feature. All evidence is
from legacy docs.

## Concepts and inputs

| Concept | Meaning | Owner spec |
|---|---|---|
| Delegated access | One team member acts inside another member's account. | `accounts-delegated-access.md` |
| Delegate | The user who received access (the assistant). | `accounts-delegated-access.md` |
| Team booking pages directory | A list of every team member's public booking links. | this spec |
| Default booking link set | Booking links created for a new user. | `booking-links.md` |

## Behavior

### Setup

1. The assistant and each executive have separate accounts in the same
   team (`teams-membership.md`).
2. In the reference, delegated access needs the large-team or enterprise
   tier. Tempoloom has no tiers.
3. The executive grants access once, from their account settings, by
   searching for the assistant by name and confirming. Full rules, limits
   and the account switcher are in `accounts-delegated-access.md`. In summary: the
   delegate can do all the executive can, except delete the account, add
   or remove calendars, or manage API keys; the delegate switches account
   from the avatar menu; a banner shows while acting as the executive; an
   exit action returns to the delegate's own account.
4. One assistant can be a delegate for any number of executives. One
   executive can have several delegates.

### Team booking pages directory

5. The booking links page has a tab that lists every team member's booking
   page and public booking links. Any team member can copy a link from it
   for another member.

### Default booking links (legacy evidence)

6. The reference offers a new user three starting booking links:
   - a 15-minute link at medium priority;
   - a 60-minute link at critical priority, which offers times over all
     lower-priority items;
   - a link that offers both 15 and 30 minutes at medium priority.
   `booking-links.md` owns this rule.

### Journey the assistant depends on

7. Converting the executive's existing recurring meetings into flexible
   meetings, with ideal time set to the current time, a minimum duration,
   a priority, and order rules between meetings. Owner: `meetings-flexible.md`.
8. Priority boost for a recurring flexible meeting that was missed: one
   step up after one missed week, two steps after two missed weeks one
   after the other
   (legacy evidence). Owner: `meetings-flexible-rescheduling.md`.
9. A daily digest of meetings at risk in the next 2 weeks (legacy
   evidence). Current-version digest: `assistant-chat.md` rules 15 to 20.
10. Team booking links with several organizers, a shared-availability heat
    map, and optional attendees. Owner: `booking-links-team.md`.
11. Habit templates often used for executives: lunch, exercise, focus
    time, catch-up blocks in the morning and the afternoon, a status report
    each week, sprint planning, strategic planning, a review of metrics each
    month, a review of customer feedback, and a review of department
    requirements. Owner:
    `habits-automation.md`.
12. Mirroring a personal calendar into the work calendar, with four
    visibility options. Owner: `sync-calendar-mirroring.md`.
13. Priority view of all items across types, with drag and drop between
    priority columns. Owner: `planning-priorities.md`.

## Outputs

- Booking pages directory tab.
- All other outputs belong to the owner specs.

## Edge cases

1. The assistant edits the executive's account and the executive edits the
   same item at the same time: the reference updates both sessions in real
   time and advises against parallel edits. Owner:
   `accounts-delegated-access.md`.
2. The assistant forgets to switch accounts and creates items in their own
   account: the banner (rule 3) is the only guard in the evidence.
   Proposed: the create forms also show whose account they write to.
3. The executive leaves the team: proposed, delegated access ends at once.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version keep the booking pages directory tab?
2. Does the current version still create the three default booking links?
3. In the current version, can the assistant use assistant chat inside the
   executive's account, and whose memories apply?
4. Can an executive limit a delegate to some features?

## Acceptance tests

Common setup: Google Workspace test domain. Team with assistant account S
and executive accounts X1 and X2. X1 and X2 each have a booking link and a
recurring weekly 30-minute one-on-one with a colleague on their Google
calendar.

### T1. Grant and switch

- Setup: common setup.
- Action: X1 grants delegated access to S. S opens the avatar menu and
  switches to X1.
- Expected calendar state: no calendar change.
- Reload check: after reload, S still acts as X1 and the banner shows. S
  exits; after reload, S is back in their own account.

### T2. Assistant converts a meeting for the executive

- Setup: T1 done; S acts as X1.
- Action: S converts X1's weekly one-on-one into a flexible meeting with
  priority critical and applies.
- Expected calendar state: the one-on-one stays on X1's Google calendar at
  its time (if free) and is now a managed event. S's own calendar is
  unchanged.
- Reload check: after reload as X1, the flexible meeting is in X1's
  automation list, not in S's.

### T3. Booking pages directory

- Setup: common setup.
- Action: S opens the booking links page and the team tab.
- Expected calendar state: no change.
- Reload check: after reload, the tab lists X1's and X2's booking links,
  and a copied link opens X1's booking page.

### T4. Two executives

- Setup: X1 and X2 both granted access to S.
- Action: S switches to X2 and creates a daily 30-minute habit "Catch up".
- Expected calendar state: "Catch up" events appear on X2's Google calendar
  only.
- Reload check: after reload, X1 has no "Catch up" habit.
