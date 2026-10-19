# Plans and feature inventory

Spec id: SPEC-PLANS-01
Evidence: E-0003 (ev_fdf25af08b9c), E-0093 (ev_ce823e40cc99), E-0171 (ev_47c8d7282a8c), E-0099 (ev_6bdab0fd61fa), E-0074 (ev_b5ca2d13ca39), E-0179 (ev_78fc13d6cb03), E-0169 (ev_76c7d3032b39)
Status of evidence: public docs only

## Summary

The reference sells four tiers: a free tier for one person, a small-team
tier, a large-team tier and an enterprise tier. This spec lists every
feature the pricing page names and the tiers that include it, as a parity
checklist. Prices, payment and discounts are non-goals. Tempoloom is
self-hosted and has no paid tiers; the tier limits become optional instance
settings.

## Concepts and inputs

### Tiers (neutral names)

| Tier | Reference audience | Team size |
|---|---|---|
| Free | One person | 1 user |
| Small-team | Small teams | up to 10 seats |
| Large-team | Large teams | up to 100 seats |
| Enterprise | Very large organizations | over 100 seats |

### Quantity limits per tier

| Limit | Free | Small-team | Large-team | Enterprise | Tempoloom instance setting (proposal) |
|---|---|---|---|---|---|
| Scheduling window for managed events (booking links not limited) | 1 week | 8 weeks | 12 weeks | 12 weeks | `max_scheduling_window_weeks`, default 12 |
| Connected calendars | 2 | unlimited | unlimited | unlimited | `max_connected_calendars`, default none |
| Calendar mirroring configurations | 1 | 3 (plan card) or unlimited (table) | unlimited | unlimited | `max_mirrors`, default none |
| Calendar mirroring window | 12 months | 12 months | 12 months | 12 months | fixed 12 months |
| Booking links | 1 | 3 | unlimited | unlimited | `max_booking_links`, default none |
| Automations per seat | 5 | 10 | 100 | unlimited | `max_automations_per_user`, default none |
| Assistant chat usage | limited | standard | expanded | unlimited | `assistant_chat_quota`, default none |
| Chat memories | limited | full | full | full | `max_chat_memories`, default none |
| AI tool access (ChatGPT app, MCP clients) | read-only | full | full | full | `mcp_write_enabled`, default true |
| Users across one domain | 100 | 100 | 100 | unlimited | none |

### Feature inventory

"All" means every tier. "S+" means small-team and higher. "L+" means
large-team and higher. "E" means enterprise only. The pricing table shows
check marks without empty cells; the tier mapping assumes the checks fill
the highest tiers first (inference). The Spec column names the spec file
or file family that specifies the feature.

#### Calendar controls

| Feature | Tiers | Spec |
|---|---|---|
| Google Calendar support | All | `planning-*` |
| Outlook calendar support | All | `accounts-outlook-support.md` |
| Planner | All | `planning-*` |
| One priority scale across all calendar events | All | `planning-*` |
| No-meeting days | All | `events-tags.md` |
| Daily digest (conflict fixes and agenda) | All | `assistant-chat.md` |
| Scheduling settings: defaults only (Free) or full customization (S+) | All / S+ | `planning-*` |
| Custom hours sets | S+ | `planning-*` |
| Team out-of-office calendar | L+ | `teams-ooo-calendar.md` |
| Delegated access for assistants | L+ | `accounts-*` |

#### Focus time

| Feature | Tiers | Spec |
|---|---|---|
| Focus time automations | All | `focus-time.md` |
| Proactive focus mode | All | `focus-time.md` |
| Reactive focus mode | All | `focus-time.md` |
| Automatic decline of meetings in focus time | All | `focus-time.md` |
| Team focus time templates | L+ | `teams-settings-templates.md` |
| Company focus time goal | E | `teams-policies.md` |
| Enterprise focus time reports | E | `analytics-organization.md` |

#### Habits

| Feature | Tiers | Spec |
|---|---|---|
| Habit automations | All | `habits-automation.md` |
| Habit templates | All | `habits-automation.md` |
| Lunch habit | All | `habits-automation.md` |
| Habit defense settings | All | `habits-automation.md` |

#### Buffers

| Feature | Tiers | Spec |
|---|---|---|
| Buffer after meetings | All | `buffers-*` |
| Buffer before meetings | All | `buffers-*` |
| Meeting notes placed into buffers before and after meetings | All | `buffers-*` |
| Travel buffers | All | `buffers-*` |
| Airport travel buffers | All | `buffers-*` |

#### Flexible meetings

| Feature | Tiers | Spec |
|---|---|---|
| Flexible meetings the user organizes | All | `meetings-*` |
| Meeting conflict notifications | All | `meetings-*` |
| Rescheduling suggestions | All | `meetings-*` |
| AI-drafted meeting agenda | All | `meetings-*` |
| AI-drafted follow-up email or chat message | All | `meetings-*` |
| Meeting transcript sync | All | `integrations-video-conferencing.md` |

#### Meeting checks

| Feature | Tiers | Spec |
|---|---|---|
| RSVP reminder check | All | `automations-meeting-quality.md` |
| Video link check | All | `automations-meeting-quality.md` |
| Attendee availability check | All | `automations-meeting-quality.md` |
| Room or resource decline alert | All | `automations-meeting-quality.md` |

#### Booking links

| Feature | Tiers | Spec |
|---|---|---|
| High-priority booking links | All | `booking-links-*` |
| Several durations on one link | All | `booking-links-*` |
| Booking pages and link groups | All | `booking-links-*` |
| Website and email embeds | All | `booking-links-*` |
| Maximum bookings caps | All | `booking-links-*` |
| Email reminders | All | `booking-links-*` |
| Team booking links | S+ | `booking-links-*` |
| Invitee questions | S+ | `booking-links-*` |
| One-off booking links | S+ | `booking-links-*` |
| Round-robin links | L+ | `booking-links-*` |
| Redirect after booking | L+ | `booking-links-*` |
| Branding settings, remove product branding | L+ | `booking-links-*` |
| Booking webhooks | L+ | `integrations-webhooks.md` |

#### Tasks and project tools

| Feature | Tiers | Spec |
|---|---|---|
| Task time blocking | All | `planning-*` |
| Task time tracking and timers | All | `planning-*` |
| Task suggestions from meetings | All | `planning-*` |
| Google Tasks integration | All | `integrations-*` |
| Todoist, Asana, ClickUp, Jira, Linear integrations | S+ | `integrations-*` |

#### Extensions and platform

| Feature | Tiers | Spec |
|---|---|---|
| ChatGPT app | All (read-only on Free) | `integrations-*` |
| MCP for Claude and Claude Code | All (read-only on Free) | `assistant-mcp-server.md`, `integrations-ai-tools.md` |
| MCP for Microsoft Copilot | All (read-only on Free) | `assistant-mcp-server.md` |
| Slack integration with status sync | All | `integrations-*` |
| Zoom meetings and transcripts | All | `integrations-*` |
| Add Google Meet automatically | All | `integrations-*` |
| Raycast extension | All | `integrations-*` |
| Google Calendar and Gmail add-on | All | `integrations-*` |
| Microsoft Teams support | All | `integrations-*` |

#### Analytics

| Feature | Tiers | Spec |
|---|---|---|
| Weekly report email | All | `analytics-weekly-reports.md` |
| Personal stats and time tracking | S+ | `analytics-personal-stats.md` |
| Team stats | S+ | `analytics-team-stats.md` |
| Organization analytics with org mapping | E | `analytics-organization.md` |
| Organization analytics exports | E | `analytics-organization.md` |
| Baseline organization review | E | non-goal (service) |
| Benchmarks | E | `analytics-organization.md` |

#### Admin and security

| Feature | Tiers | Spec |
|---|---|---|
| Account settings and team templates | All | `teams-settings-templates.md` |
| User and role management | S+ | `teams-membership.md` |
| SSO and SCIM provisioning | E | `admin-sso-provisioning.md` |
| Domain capture | E | `admin-sso-provisioning.md` |
| Scheduling that uses the org chart | E | open (no detail in evidence) |
| Support tier, security reviews, company onboarding | varies | non-goal (service) |

#### Add-ons

| Feature | Notes | Spec |
|---|---|---|
| Analytics-only seats | People analyzed without full scheduling | `analytics-organization.md` open question 4 |
| Enterprise pilot | Service | non-goal |

## Behavior

1. Tempoloom enables every feature in the inventory for every user. There is
   no tier gate in code (proposal).
2. An instance admin can set the quantity limits in the table above. Each
   limit defaults to the value in the last column.
   Tempoloom decision: the operator sets a limit with `node
   src/server/cli.ts limit --name <limit> --value <number|none>`; without
   `--name` it prints them all. Every limit is off by default,
   `max_scheduling_window_weeks` included (the window's own maximum is 12
   weeks). Tempoloom has no instance-admin role, so there is no web page for
   the limits. The server reads them on each use, so a change applies
   without a restart.
3. The scheduling window limit applies to managed events (tasks, habits,
   focus time, flexible meetings, buffers). It never limits booking link
   availability. The scheduling window rules belong to
   `planning-scheduling-window.md`.
   Tempoloom decision: a lower limit caps the user's window when Tempoloom
   plans; the settings page shows "This server plans at most N weeks ahead"
   and refuses a longer window. The user's own value comes back when the
   limit goes.
4. When a user reaches a count limit (booking links, automations, mirrors,
   connected calendars), the create action is refused with a message that
   names the limit and its value. Existing items keep working (proposal,
   matching the seat overage rule in `teams-membership.md` rule 27).
   Tempoloom decision: automations are habits, focus time goals and
   buffers, team policy ones included. Booking links count every link the
   person owns, the default links of the booking page included. The message
   reads like "This server allows at most 4 booking links per person."
5. When `mcp_write_enabled` is false, MCP clients and the ChatGPT app can
   read but not stage changes (`assistant-mcp-server.md`).

## Outputs

- Instance settings page for the limits (instance admin only).
- Limit messages on refused create actions.

## Edge cases

1. An admin lowers a limit below current use: existing items stay; new ones
   are refused until use drops below the limit.
2. An admin lowers `max_scheduling_window_weeks`: the scheduler removes
   managed events beyond the new window on its next run (owner: scheduler
   spec).
3. Conflicting reference values (mirrors on the small-team tier: 3 on the
   plan card, unlimited in the table): not relevant while Tempoloom has no
   tiers.

## Observed API shapes

Not yet observed.

## Open questions

1. What do "limited", "standard" and "expanded" assistant chat usage mean
   in numbers?
2. What does "read-only" access for AI tools allow on the free tier?
3. What does the enterprise feature for scheduling with the org chart do?
4. What is the "more info" text behind each pricing row? The capture has
   the icons but not the text.
5. How does the reference behave when a free user hits the booking link or
   mirror limit?

## Acceptance tests

Common setup: Google test account U on a Tempoloom instance where an
instance admin can change limits.

### T1. Scheduling window limit spares booking links

- Setup: `max_scheduling_window_weeks = 1`. U has a weekly habit of 60
  minutes and a booking link of 30 minutes with no horizon limit of its own.
- Action: the scheduler runs. A guest opens the booking page and views the
  day 20 days from today.
- Expected calendar state: U's Google calendar has habit events only in the
  next 7 days, none later. The booking page offers slots on day 20.
- Reload check: after reload of the planner and the booking page, the same
  holds.

### T2. Booking link count limit

- Setup: `max_booking_links = 1`. U has one booking link.
- Action: U tries to create a second booking link.
- Expected calendar state: no change.
- Reload check: the create action shows a limit message; after reload U has
  one booking link and it still accepts bookings.

### T3. Read-only AI tools

- Setup: `mcp_write_enabled = false`. An MCP client is connected for U.
- Action: the client calls the create-event tool.
- Expected calendar state: no new event on U's Google calendar and nothing
  staged in preview mode.
- Reload check: after reload of the planner, preview mode has no staged
  change; the client got a refusal.
