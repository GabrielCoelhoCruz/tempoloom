# Team stats

Spec id: SPEC-ANALYTICS-02
Evidence: E-0194 (ev_b9b3b267f35a), E-0180 (ev_fca85fcae16d), E-0183 (ev_000dae433420), E-0182 (ev_80185208c432), E-0074 (ev_b5ca2d13ca39), E-0076 (ev_b70225a1a49a), E-0169 (ev_76c7d3032b39), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Team stats show the same time categories as personal stats, averaged over
all members of a team. They never show one member's numbers, which
protects each person's privacy. Leaders and members use them to see meeting
load, focus time and the balance of work and personal time across the
team, in the past and in
the coming weeks. The panel list comes from legacy docs; the current
version calls the view "insights" and adds grouping by department and
management line for larger organizations.

## Concepts and inputs

| Field | Type | Default | Allowed |
|---|---|---|---|
| `view` | enum | `team` | Header tab next to `mine`. |
| `range` | date range | last 2 weeks (proposal) | Same as personal stats: quick picks of 2, 4 or 12 weeks, custom, future allowed. History limit 12 weeks (legacy; one legacy line says 90 days). |
| `grouping` | enum `auto`, `day`, `week` | `auto` | Same as personal stats. |
| `included_members` | derived | | Active team members with at least one connected calendar. |

Categories and the deep or shallow work rule are the same as in
`analytics-personal-stats.md`.

## Behavior

1. Each figure is the mean over `included_members` of that member's
   personal figure for the same range and grouping.
2. The team view never shows a single member's value, name or event.
   Hover values are team averages.
3. Panels: time breakdown, time breakdown trend, work habits and tasks,
   focus time (deep versus shallow, weekday heat map, most productive
   weekday), work-life balance, meeting breakdown (with heaviest and
   lightest weekday), and highlights. Each works as in personal stats but
   with averages.
4. The team view has no "people met" panel.
5. The team view adds a "time in meetings" panel. For a set of meeting-hour
   thresholds, it shows the percent of included members whose meeting hours
   in the period reach that threshold. Example: 100 percent of members have
   0 or more hours; 50 percent have 15 or more hours. The panel colors each
   cell on a scale from 0 to 100 percent.
6. Proposed thresholds for rule 5, per week: 0, 5, 10, 15, 20, 25, 30
   hours. Per day: 0, 1, 2, 3, 4, 5, 6 hours.
7. Future ranges show planned time for capacity planning, as in personal
   stats.
8. Members who were provisioned but have no connected calendar are left out
   of `included_members` (see `admin-sso-provisioning.md`).
9. Team stats are read-only. They never change calendar events.
10. Current version: for teams with directory attributes, team insights
    can group and filter by department, manager line and other attributes.
    That larger view is in `analytics-organization.md`.

## Outputs

- Team stats page with the panels above.
- No calendar events are created or changed.

## Edge cases

1. A team with one included member: the averages equal that member's
   personal stats. Proposed: show the team view only when at least 3
   members are included, to keep the privacy promise; otherwise show
   "Not enough members for team stats."
2. A member joins mid-range: proposed, include them only for the days after
   they joined.
3. A member leaves: proposed, exclude them from all ranges after they leave.
4. Members in different time zones: each member's day boundaries use that
   member's home time zone.
5. A meeting between two members counts once for each member, so it appears
   in both personal figures before averaging.

## Observed API shapes

Not yet observed.

## Open questions

1. Who can open team stats: every member, or admins only? Legacy docs show
   a tab for any user; the enterprise setup guide mentions administrators.
   Proposed default: every member, since values are averages.
2. Is there a minimum team size before averages show?
3. Which meeting-hour thresholds does the "time in meetings" panel use?
4. Is the history limit 12 weeks or 90 days?
5. Is team stats gated? The pricing page lists team analytics in paid
   tiers only.

## Acceptance tests

Common setup: Google Workspace test domain. Team with members A, B and C,
each with a connected Google calendar and work hours Mon to Fri 09:00 to
17:00. In last week:

- A has 10 h of meetings, B has 4 h, C has 1 h (all team meetings with
  same-domain attendees, inside work hours).
- A has one 3 h solo event; B and C have none.

### T1. Averages

- Setup: common setup.
- Action: A opens stats, selects the team tab, range = last week, grouping
  = week.
- Expected calendar state: no event on any member's calendar changes.
- Reload check: after reload, team meetings show 5.0 h average, deep work
  1.0 h average. No member name or single value appears anywhere on the
  page.

### T2. Time in meetings distribution

- Setup: common setup.
- Action: open the time in meetings panel for last week.
- Expected calendar state: no change.
- Reload check: after reload, with the proposed weekly thresholds, the
  panel shows 100 percent at 0 h, 33 percent at 5 h, 33 percent at 10 h,
  and 0 percent at 15 h.

### T3. Member without a calendar is excluded

- Setup: common setup, plus member D provisioned with no connected
  calendar.
- Action: open the team tab for last week.
- Expected calendar state: no change.
- Reload check: averages are the same as in T1 (D not counted).

### T4. Small team guard

- Setup: a team with only A and B.
- Action: A opens the team tab.
- Expected calendar state: no change.
- Reload check: after reload, the page shows the not-enough-members message
  (proposed rule).
