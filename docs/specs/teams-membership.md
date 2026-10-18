# Team membership

Spec id: SPEC-TEAMS-01
Evidence: E-0093 (ev_ce823e40cc99), E-0101 (ev_c075498dc915), E-0127 (ev_008b8b410fd0), E-0102 (ev_5428e0dd1a44), E-0169 (ev_76c7d3032b39), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Each user belongs to one team. Sign-up creates a team for the new user.
Team admins invite people by email or by an invite link. People with the
same company email domain can find a team and ask to join, or join at once,
depending on the team's join mode. Members can leave. Admins can remove
members and give or take away the admin role. The team page shows how many
seats are in use.

## Concepts and inputs

### Team

| Field | Type | Default | Notes |
|---|---|---|---|
| `id` | id | generated | |
| `members` | list of Member | creator only | |
| `join_mode` | enum `invite_only`, `request`, `automatic` | `request` | How same-domain users join after they find the team. |
| `invite_permission` | enum `admins`, `all_members` | open question | Who can send invitations. |
| `seat_limit` | integer or none | none | Reference: purchased seats. Tempoloom: optional instance limit (proposal). |
| `domain` | text | email domain of the creator | Used for discovery. |

### Member

| Field | Type | Default | Notes |
|---|---|---|---|
| `user` | user id | | |
| `role` | enum `admin`, `member` | `member` | Creator is `admin`. |
| `status` | enum `active`, `invited`, `requested` | | `invited` = pending invitation. `requested` = pending join request. |

### Invitation

| Field | Type | Default | Notes |
|---|---|---|---|
| `emails` | list of email | | One or more addresses in one send. |
| `message` | text | empty | Optional note in the invitation email. |
| `grant_admin` | boolean | false | Optional. |
| `link` | URL on the Tempoloom instance | generated | Copyable from the member table. |
| `state` | enum `pending`, `accepted`, `revoked` | `pending` | |

### Team size by tier (reference)

| Reference tier | Maximum team members |
|---|---|
| Free | 1 |
| Small-team tier | 10 |
| Large-team tier | 100 |
| Enterprise tier | more than 100 |

Tempoloom has no paid tiers. Proposed default: no team size limit, with an
optional instance setting for a maximum.

## Behavior

### Team creation

1. When a user signs up, the system creates a team and makes the user its
   only member and its admin. (The admin role is inferred: the reference
   blocks the sole admin from leaving, so each team has at least one admin.)
2. When other users with the same email domain exist and are not in a team
   with more than one member, the team page shows a prompt to create a team.
   The prompt lists those users. The user selects people and sends invites.
   Each selected person gets one invitation email with a join link.

### Invitations

3. An allowed user opens the team page and selects "Add member". When the
   team already has members, the same action is an invite icon at the top
   right of the member table.
4. The user enters one or more email addresses, an optional message, and an
   optional admin grant, then sends.
5. The system sends one invitation email per address. The email has a link
   to join the team.
6. Each invited address shows in the member table with status `invited`.
7. A "copy invite link" action on an `invited` row copies the join link, so
   the inviter can send it another way.
8. A delete (trash) action on an `invited` row revokes the invitation. A
   revoked link must not add the person to the team.
9. When the invited person already has an account, opening the link and
   accepting adds them to the team at once.
10. When the invited person has no account, they complete sign-up and
    onboarding first. Then the system adds them to the team.
11. In the reference, a free-tier team cannot invite members. Tempoloom:
    no such gate (proposal), unless the instance sets a team size limit.

### Discovery and join requests

12. A team is discoverable when it has at least 2 members and its
    `join_mode` is `request` or `automatic`.
13. A user whose email domain matches a discoverable team sees a prompt on
    the team page to join that team.
14. With `join_mode = request`, the user sends a join request. Every admin of
    the team sees a pending request with a "Review" action. Review shows the
    requester, an approve action, a reject action, and an admin toggle.
    Approval adds the user as a member (or admin, if toggled). Rejection
    removes the request.
15. With `join_mode = automatic`, selecting "Join" adds the user at once.
    There is no review step.
16. With `join_mode = invite_only`, the team is not shown in prompts. Only an
    invitation adds a user.

### Leaving

17. Any member can leave at any time from their own row in the member table
    (a "leave team" icon at the far right), followed by a confirm step.
18. The system blocks the leave action when the user is the only admin of
    the team.
19. Leaving does not delete the account or any of the user's data (tasks,
    habits, managed events, settings).
20. After leaving, the user loses features that came from a seat in the old
    team.

### Removing and roles

21. Only admins can change other members. Each member row has a menu with
    two actions: make admin or remove admin, and delete.
22. Delete asks for confirmation. On confirm, the member leaves the team and
    their seat becomes free. The admin can invite the person again later.
23. An admin can edit team settings (see `teams-settings-templates.md`).
    In the reference, admins also manage billing (non-goal for Tempoloom).

### Seats

24. When a seat limit exists, a person uses one seat from the moment they
    join the team.
25. A bar above the member table shows seats in use and seats left.
26. A user that directory provisioning created, and who never signed in,
    does not use a seat (see `admin-sso-provisioning.md`).
27. When active members exceed the seat limit, the system shows an overage
    notice to the team. Scheduling continues as normal for every member. The
    system blocks new invitations, join approvals and automatic joins until
    the team frees seats or the limit rises.

## Outputs

- Invitation email per address: inviter name, team name, optional message,
  join link.
- Member table: name, email, role, status, row actions.
- Seat bar (when a limit exists).
- Overage notice (when members exceed seats).
- No calendar events change because of membership actions.

## Edge cases

1. The sole admin tries to leave: blocked. The UI must say why. Proposed
   text: "Make another member an admin before you leave."
2. An admin removes the admin role from themselves while they are the only
   admin: block this, for the same reason as rule 18 (proposal).
3. An invitation goes to an address that is already a member: proposed,
   reject the address in the send form with a message.
4. A person accepts a revoked invitation link: show "This invitation is no
   longer valid" (proposed text) and do not add them.
5. A person in another team accepts an invitation: the evidence does not
   say if they move or must leave first. See open questions.
6. Two admins approve and reject the same request at the same time: the
   first action wins. The second admin sees the request as resolved.
7. A user with a different email domain cannot see a team in discovery.
8. Seat overage: existing members keep scheduling; only adding people is
   blocked.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the default for `invite_permission`? The evidence says invites
   can be limited to admins or opened to all members, but not which is the
   default. Proposed default: `admins`.
2. After a user leaves, which team are they in? Proposed default: the system
   creates a new team with the user as its only member and admin.
3. When a member of team X accepts an invitation to team Y, do they leave X
   automatically? Proposed default: yes, after a confirm dialog.
4. Does an invitation expire? Proposed default: no expiry until revoked.
5. Does a removed member get a notification email?
6. Can a team have a name, and where does it show?
7. Does the discovery prompt list teams by name, or by member names?

## Acceptance tests

Common setup: a Google Workspace test domain with test accounts A, B, C
and D on the same domain. Each account signed in to Tempoloom once, which
created a single-member team for each. Account B has one daily habit
(30 minutes, work hours), so B has managed habit events on its Google
calendar.

### T1. Invite by email and accept

- Setup: common setup.
- Action: A opens the team page, adds B's email with message "Welcome",
  sends. B opens the invitation email and accepts.
- Expected calendar state: B's Google calendar still has the same managed
  habit events at the same times. A's calendar is unchanged.
- Reload check: A reloads the team page; B shows as `member`, `active`.
  B reloads; B's team page lists A as admin.

### T2. Copy link and revoke

- Setup: common setup. A invites C. C has not accepted.
- Action: A copies the invite link from C's row. A selects delete on C's
  row. C opens the copied link.
- Expected calendar state: no change on A or C calendars.
- Reload check: C sees an invalid-invitation message. A reloads; C's row is
  gone.

### T3. Join request with review

- Setup: A's team has A and B. `join_mode = request`.
- Action: D opens the team page, sees the prompt for A's team, sends a
  request. A opens Review and approves with the admin toggle on.
- Expected calendar state: no calendar change for A, B or D.
- Reload check: after reload, D is listed as `admin` in A's team.

### T4. Automatic join

- Setup: A's team has A and B. A sets `join_mode = automatic`.
- Action: C selects Join on the prompt.
- Expected calendar state: no calendar change.
- Reload check: after reload, C is an active member. No review item exists
  for A.

### T5. Sole admin cannot leave; member can

- Setup: A's team has A (only admin) and B.
- Action: A selects leave. Then B selects leave and confirms.
- Expected calendar state: B's managed habit events remain on B's calendar
  after B leaves.
- Reload check: A is still in the team with an error shown for the first
  attempt. After reload, B is not in A's team, and B still sees the habit in
  the habit list.

### T6. Remove member and change role

- Setup: A's team has A, B, C.
- Action: A makes B an admin. A deletes C and confirms.
- Expected calendar state: C's calendar is unchanged.
- Reload check: after reload, B shows as `admin`, C is absent, and the seat
  bar (if a limit is set) shows one more free seat.

### T7. Seat overage keeps scheduling

- Setup: instance seat limit for A's team set to 2. Team has A and B. Then
  the limit is lowered to 1.
- Action: A tries to invite C. B creates a new daily habit of 45 minutes.
- Expected calendar state: the system places B's new habit events on B's
  Google calendar as normal.
- Reload check: after reload, the overage notice still shows, the invite
  was refused, and B's new habit events are still on the calendar.
