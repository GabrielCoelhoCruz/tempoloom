# Current version baseline

Spec id: SPEC-PLATFORM-01
Evidence: E-0183 (ev_000dae433420), E-0148 (ev_e7b99cd896e0), E-0076 (ev_b70225a1a49a), E-0133 (ev_05d15af3feda), E-0158 (ev_5682619fc975), E-0043 (ev_d7b30359b03e), E-0182 (ev_80185208c432), E-0075 (ev_39bcdda5c8f6)
Status of evidence: public docs only

## Summary

The reference has two generations: a legacy version ("1.0") and a current
version ("2.0"). Tempoloom matches the current version. This spec states
what the current version contains, what changed from legacy, and how other
specs must treat legacy-only evidence. It also records the reference's
import from a closed competitor, which Tempoloom does not need.

## Concepts and inputs

| Term | Meaning |
|---|---|
| Current version | The reference generation that new accounts get. Accounts created after May 2026 start on it. |
| Legacy version | The older generation. Its help pages carry a legacy banner. Legacy users see an upgrade banner and can upgrade themselves. |
| Legacy evidence | A rule seen only on legacy pages. Specs mark such rules "(legacy evidence)". |

## Behavior

### What the current version contains

1. A central planner that shows the calendar, assistant chat, the
   automation sidebar, suggested tasks and recommendations in one place.
2. Assistant chat (`assistant-chat.md`).
3. Preview mode for staged changes (`assistant-preview-mode.md`).
4. Automations as one model with a shared structure (name, event settings,
   rules, priority, order within a priority). Types: focus time, habits,
   buffers, flexible meetings, meeting checks, meeting load cap. Users
   create them from the library (`automations-library.md`), from a create
   action, or through chat.
5. Recommendations and issues: conflicts, days with too many meetings,
   a focus goal not met, skipped habits, and meetings with no agenda or no
   video link.
6. Insights, built on the legacy personal and team stats, with org-level
   grouping for companies (`analytics-personal-stats.md`,
   `analytics-team-stats.md`, `analytics-organization.md`).
7. AI tool access through MCP (`assistant-mcp-server.md`).

### What carries over from legacy

8. Focus time, habits, flexible meetings, buffers, booking links, calendar
   mirroring and connected calendars, chat app and task tool integrations,
   and the work, meeting and personal hours sets.

### What changed for tasks

9. In the current version, tasks no longer get their own managed events
   placed automatically. The system instead suggests tasks to work on
   during the user's free focus time. The task list itself carries over.
   The core planning area must specify this; this spec only records it.

### Upgrade from legacy

10. On upgrade, existing managed events carry over without user action.
11. Tempoloom has no legacy users, so it needs no version switch and no
    upgrade banner.

### How specs use the evidence

12. Each spec specifies current behavior.
13. When only legacy evidence exists for a rule, the spec still specifies
    it and marks it "(legacy evidence)".
14. When legacy and current evidence disagree, current wins.
15. Legacy-only areas in this group: detailed stats panels, weekly report
    email, team default templates, executive assistant guide, team focus
    time template.

### Competitor import (non-goal)

16. The reference has a settings page that imports a JSON export file from
    a competitor that shut down in March 2026. It maps hours, focus time,
    habits, breaks, booking links and flexible meetings, then shows which
    items were imported and which need review. Tempoloom does not build
    this: the source service is closed and its file format is not in the
    evidence.
17. The reference advises users to turn off any other scheduling tool
    before they enable managed events, so the two tools do not create
    competing events. Tempoloom onboarding should show the same advice
    (proposal).

## Outputs

- No direct outputs. This spec sets the baseline for other specs.
- Onboarding advice about other scheduling tools (rule 17).

## Edge cases

1. A rule exists only in a legacy page and conflicts with a current
   marketing page: prefer the current marketing page and record the
   conflict in the owner spec's open questions.
2. A current help page links to a legacy page for details: treat those
   details as legacy evidence.

## Observed API shapes

Not yet observed.

## Open questions

1. Where in the account does the reference show the version (1.0 or 2.0)?
   The help pages point to a settings page whose name is not captured.
2. Which legacy features were removed in the current version, not only
   renamed? Weekly reports and the executive assistant flows are the main
   unknowns.
3. How exactly are tasks suggested inside focus time in the current
   version? (Core planning area.)
4. The current FAQ has questions on issues, suggested times and a
   find-a-time feature with no captured answers. What do they do?

## Acceptance tests

Common setup: Google test account U with work hours Mon to Fri 09:00 to
17:00.

### T1. Tasks do not get their own managed events

- Setup: common setup. U has a focus time automation with a weekly goal of
  6 h and no other automations.
- Action: U creates a task "Quarterly report", 3 h, due in 5 days.
- Expected calendar state: U's Google calendar gets no managed event for
  the task itself. Focus time events are present as before.
- Reload check: after reload, the planner shows "Quarterly report" as a
  suggestion inside a focus time block, and Google Calendar still has no
  task event.

### T2. Automations share one structure

- Setup: common setup.
- Action: U creates a habit, a buffer and a focus time automation, each from
  the library, and opens each form.
- Expected calendar state: after apply, each automation's managed events
  are on Google Calendar.
- Reload check: after reload, all three forms show the same sections (name,
  event settings, rules, priority) and all three appear in the sidebar
  under their priority.
