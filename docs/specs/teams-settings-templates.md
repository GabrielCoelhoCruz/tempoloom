# Team settings and default templates

Spec id: SPEC-TEAMS-02
Evidence: E-0102 (ev_5428e0dd1a44), E-0170 (ev_d03324e8b6e1), E-0182 (ev_80185208c432), E-0158 (ev_5682619fc975), E-0003 (ev_fdf25af08b9c), E-0093 (ev_ce823e40cc99)
Status of evidence: public docs only

## Summary

Team admins manage team-wide settings: who can invite, how same-domain
users join, and default templates for new members. The templates set
default work hours and meeting hours, recommended habits, and a recommended
focus time goal. Defaults apply only to people who join after the admin
saves them. Admins also switch assistant chat on or off for the whole team.

## Concepts and inputs

### Team settings pages (admin only)

| Page | Contents | Owner spec |
|---|---|---|
| Members | Member table, roles, seat bar | `teams-membership.md` |
| Defaults | Habit templates, default hours sets, team focus time template, booking link branding | this spec; branding in the booking link specs |
| Settings | Invite permission, join mode, assistant chat switch, out-of-office calendars | this spec; `teams-ooo-calendar.md` |
| Billing | Plans and payment | non-goal |
| Webhooks | Team webhook configurations | `integrations-webhooks.md` |

### Team habit template

| Field | Type | Default | Notes |
|---|---|---|---|
| `title` | text | | Shown in the habit list. |
| habit fields | as in `habits-automation.md` | defaults of `habits-automation.md` | Duration, frequency, ideal time, ideal days, priority, defense. |

### Default hours

| Field | Type | Default | Notes |
|---|---|---|---|
| `work_hours` | weekly intervals | none | Same shape as a user's work hours set. |
| `meeting_hours` | weekly intervals | none | Same shape as a user's meeting hours set. |

### Team focus time template

| Field | Type | Default | Allowed |
|---|---|---|---|
| `mode` | enum `proactive`, `reactive` | open question | Focus modes as in `focus-time.md`. |
| `weekly_goal_hours` | number | open question | Hours per week. |

### Invite settings

| Field | Type | Default |
|---|---|---|
| `invite_permission` | enum `admins`, `all_members` | open question (proposed `admins`) |
| `join_mode` | enum `invite_only`, `request`, `automatic` | `request` |

### Assistant chat switch

| Field | Type | Default |
|---|---|---|
| `assistant_chat_enabled` | boolean | open question (see rule 13) |

## Behavior

### Access

1. Only team admins can change team settings. One exception: when the
   team allows it, members can add out-of-office calendars
   (`teams-ooo-calendar.md` rule 2).
2. Each user also has personal settings (scheduling preferences, task
   defaults, hours sets, color rules). Team settings never replace them.

### Default templates (legacy evidence)

3. An admin can create, edit and delete team habit templates.
4. The system offers team habit templates to each new member during
   onboarding.
5. The habits page of every team member shows the team habit templates at
   the top, as recommended routines. Selecting one creates a personal habit
   from the template.
6. An admin can set default work hours and default meeting hours for the
   team.
7. When a new member joins, the system copies the default hours into that
   member's work hours set and meeting hours set.
8. An admin can create a team focus time template by choosing a focus mode
   and a weekly goal, then saving.
9. When a new member joins, the system shows the team focus time template
   as a recommendation in that member's focus time settings. The member can
   accept it, change how long or how often it runs, or switch it off.
10. Defaults apply only to members who join after the admin saves them. A
    change to a default never changes the settings of existing members.
11. A member can change their own hours and focus goal at any time after
    joining, including values that came from a default.

### Invite settings

12. An admin sets who can invite (admins only, or all members) and the join
    mode. The join mode rules are in `teams-membership.md` rules 12 to 16.

### Assistant chat switch (current version)

13. One switch controls assistant chat for the whole team. An admin turns
    it on or off for all members in team settings.
14. When the setting is off, a member who opens assistant chat sees a
    notice that chat is off and that they must ask a team admin. The notice
    has a link that shows who the team admins are.
15. After sign-up, the planner prompts the new user to enable assistant
    chat. The evidence does not say how this prompt interacts with the team
    switch; see open question 4.

## Outputs

- Recommended habit templates at the top of each member's habits page.
- Onboarding step that lists team habit templates for a new member.
- New member's hours sets filled from the defaults.
- Focus time recommendation in a new member's focus settings.
- Chat-disabled notice in the planner chat panel.
- No managed event is created until a member accepts a template. Then the
  normal habit or focus time rules place managed events.

## Edge cases

1. An admin edits a habit template after members created habits from it:
   existing habits do not change (follows rule 10).
2. An admin deletes a template: it leaves the recommendation list. Habits
   already made from it stay.
3. The default hours have no meeting hours: the new member keeps the
   system default meeting hours (proposal).
4. A new member joins through directory provisioning without sign-in: the
   defaults apply when the account is created (proposal).
5. A member leaves and joins again: they count as a new member, so current
   defaults apply again (proposal; evidence silent).
6. An admin turns chat off while a member has staged changes from chat in
   preview mode: the staged changes stay and the member can still apply or
   discard them (proposal).

## Observed API shapes

Not yet observed.

## Open questions

1. Current-version evidence for templates is missing. The admin pages above
   come from legacy docs. Does the current version keep the same pages?
2. What are the default weekly goal and focus mode in a new team focus
   template?
3. Can a team have more than one focus time template, for example per
   department? The policy pages (`teams-policies.md`) suggest yes for
   enterprise teams.
4. What is the default of the assistant chat switch for a new team? Proposed
   default: on.
5. Does a new member see the focus recommendation once, or until they act
   on it?
6. Can an admin push a template change to existing members on purpose?
   Proposed default: no.

## Acceptance tests

Common setup: Google Workspace test domain. Account A is admin of a team.
Account B is a member with personal work hours Mon to Fri 09:00 to 17:00.
Account C is a new Google account that has never signed in.

### T1. Default hours apply only to new members

- Setup: common setup.
- Action: A sets default work hours Mon to Thu 10:00 to 16:00 and saves. A
  invites C. C signs up and joins. C creates a daily habit of 30 minutes
  that may use any work hour.
- Expected calendar state: C's habit events on Google Calendar fall Mon to
  Thu between 10:00 and 16:00. No habit event falls on Friday. B's managed
  events still use 09:00 to 17:00.
- Reload check: after reload, C's work hours show Mon to Thu 10:00 to
  16:00 and B's show Mon to Fri 09:00 to 17:00.

### T2. Team focus time recommendation

- Setup: common setup. A saves a team focus template: weekly goal 6 hours.
- Action: C joins. C opens focus settings and accepts the recommendation.
- Expected calendar state: C's Google calendar shows focus time managed
  events for the current week that total 6 hours (less if the week has no
  room, per `focus-time.md`). B has no new focus events.
- Reload check: after reload, C's focus goal shows 6 hours; B's focus
  settings show no recommendation.

### T3. Team habit templates show to all members

- Setup: common setup. A creates a team habit template "Weekly planning",
  60 minutes, once per week.
- Action: B opens the habits page. B selects the template.
- Expected calendar state: one managed event "Weekly planning" of 60
  minutes appears on B's Google calendar this week.
- Reload check: after reload, the template is still listed at the top of
  B's habits page, and B's habit list includes "Weekly planning".

### T4. Assistant chat switch

- Setup: common setup. Chat is on.
- Action: A turns chat off. B opens the chat panel in the planner. A turns
  chat on again. B reloads and sends a message.
- Expected calendar state: no calendar change.
- Reload check: while off, B sees the disabled notice with the admin link
  after reload. After A turns chat on, B's message gets a reply.
