# Weekly report email

Spec id: SPEC-ANALYTICS-04
Evidence: E-0215 (ev_91f415d61c95), E-0180 (ev_fca85fcae16d), E-0011 (ev_eeadbdf09079), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only (legacy evidence)

## Summary

Each user gets a weekly email that sums up how they spent the week and
previews the next one. It arrives on the last workday of the week, early in
the user's work hours. The top part has three time totals and a few
changing calendar facts; the user can share that part on a public page.
The lower part previews next week's calendar and the user's top
priorities. All rules come from legacy docs. In the reference, every tier
gets this email.

## Concepts and inputs

| Field | Type | Default | Notes |
|---|---|---|---|
| `weekly_report_enabled` | boolean | true | Per user, in notification settings. |
| work hours | user's work hours set | | Sets the delivery time. |
| home time zone | user setting | | |

## Behavior

### Delivery

1. The report is on for every new user.
2. The user can turn it off in the notification section of personal
   settings, and on again.
3. The system sends the report once per week, on the last day of the week
   that has work hours in the user's work hours set.
4. The send time falls in the first hour of work hours on that day. Example:
   work hours on Friday 08:00 to 17:00 give a send time between 08:00 and
   09:00 on Friday, in the user's home time zone.
5. The report covers the current work week from its first workday up to the
   send time (proposal; the evidence does not state the cut-off).

### Content

6. Productivity totals, three figures for the week:
   - Personal time: personal-tagged task and habit events, plus events
     mirrored from a personal calendar.
   - Solo work: work-tagged task and habit events, plus events with no
     other invitees.
   - Meetings: events with other invitees (one-on-one, team and external).
   Categories follow `analytics-personal-stats.md`.
7. Calendar facts: a short set of extra facts drawn from the calendar, shown
   as colored blocks under the totals. The set can differ each
   week. Proposed set, show up to 4 that apply: busiest meeting day, longest
   focus session, number of meetings booked through booking links, hours of
   breaks taken, number of people met.

   Tempoloom decision: until the weekly email exists, the stats page shows
   these calendar facts for the chosen range, in this order, skipping facts
   with a zero value.
8. Next week preview: the primary calendar's events for next week, by day,
   with the busiest and the lightest day marked. Each day and each event
   links to the planner at that day.
9. Priorities: the user's highest-priority open tasks and the habits they
   plan for the coming week, in priority order. Each links to the
   item in the app.

### Sharing

10. The email has share actions for the top part only (totals and calendar
    facts). Event titles and the next week preview are never shared.
11. A share action creates a public page for that week's top part. Targets:
    copy a direct link, X (Twitter), LinkedIn, Facebook. Each social target
    opens that site's share dialog with the page link.
12. The public page needs no login. It shows the user's display name, the
    week dates, the three totals and the calendar facts.

## Outputs

- One email per user per week (when enabled).
- Optional public share page per shared week.
- No calendar events change.

## Edge cases

1. A user with no work hours set: proposed, send on Friday at 09:00 home
   time.
2. A week where the last workday is a full out-of-office day: proposed,
   send on that day at the usual time anyway.
3. A user changes work hours during the week: use the work hours in force
   at send time.
4. A user turns the report off after the send time on the send day: no
   effect on the email already sent.
5. Zero events in the week: send the email with zero totals (proposal).
6. A shared page link is opened after the user deletes their account:
   proposed, return "not found".

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version still send weekly reports? The current FAQ does
   not mention them; the pricing page still lists them for all tiers.
2. Which period does the report cover: the full calendar week, or up to the
   send time?
3. Which calendar facts does the reference choose, and how?
4. Can a user revoke a shared page?
5. Is there a team or manager version of the weekly email?

## Acceptance tests

Common setup: Google test account U, home time zone fixed, work hours Mon
to Fri 08:00 to 17:00. The test environment can set the server clock
(proposal for testability). This week U has: 3 h of meetings with other
invitees, 4 h of events with no invitees, one personal habit of 1 h. Next
week U has a meeting on Tuesday.

### T1. Delivery time and totals

- Setup: common setup; clock set to Friday 07:55 home time.
- Action: advance the clock to Friday 09:00.
- Expected calendar state: no event on U's calendar changes.
- Reload check: U's inbox has one report with a send time between 08:00 and
  09:00 Friday. It shows meetings 3 h, solo work 4 h, personal time 1 h. The
  next week preview lists the Tuesday meeting. Reloading the email (open it
  again) shows the same content.

### T2. Last workday moves the send day

- Setup: common setup, but work hours Mon to Thu 10:00 to 18:00.
- Action: advance the clock from Thursday 09:55 to Thursday 11:00.
- Expected calendar state: no change.
- Reload check: one report arrived between 10:00 and 11:00 Thursday; none
  arrives on Friday.

### T3. Opt out

- Setup: common setup.
- Action: U turns the weekly report off in settings. Advance the clock past
  next Friday 09:00.
- Expected calendar state: no change.
- Reload check: after reload of settings, the switch is still off; no new
  report arrived.

### T4. Share page hides event details

- Setup: T1 done.
- Action: U selects "copy link" in the report and opens the link in a
  private browser window.
- Expected calendar state: no change.
- Reload check: after reload, the page shows the totals and facts, and no
  event title or next week preview appears in the page text.
