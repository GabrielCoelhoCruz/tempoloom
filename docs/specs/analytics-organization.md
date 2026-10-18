# Organization analytics

Spec id: SPEC-ANALYTICS-03
Evidence: E-0012 (ev_a025d5e005ce), E-0014 (ev_6d4b05eba664), E-0169 (ev_76c7d3032b39), E-0020 (ev_35bf2e8ddf95), E-0183 (ev_000dae433420), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Organization analytics show how calendar time is spent across a whole
company, grouped and filtered by department, manager line, location and
other directory attributes. They cover meeting load, focus time, calendar
fragmentation, free time, travel and breaks, with past and future ranges,
week-over-week trends and exports. Data comes from every employee's
calendar through an organization-wide calendar grant, not only from people
who signed in. In the reference, this is an enterprise-tier feature.

## Concepts and inputs

### Data sources

| Source | Gives | Spec |
|---|---|---|
| Directory provisioning (SCIM) | People and their attributes | `admin-sso-provisioning.md` |
| Organization-wide calendar grant (in Google Workspace a delegated service account; in Microsoft 365 a tenant admin consent) | Calendar events of each provisioned person | `admin-sso-provisioning.md` |

Without the calendar grant, analytics cover only people who signed in and
connected a calendar.

### Dimensions (filters and grouping)

Every directory attribute that arrives over SCIM becomes a filter and a
grouping key. Attributes not sent do not appear. Known attributes:

- Standard: user name, name, display name, title, user type, email, active.
- Enterprise extension: employee number, cost center, organization,
  division, department, manager.
- Product extension: location, hire date, job category, org role, work
  group.
- Custom: any extra attribute.

The manager attribute builds the reporting tree. Grouping by manager line
needs it.

### Report controls

| Field | Type | Default | Allowed |
|---|---|---|---|
| `level` | enum `company`, `department`, `team`, `individual` | `company` | See rule 3 for `individual`. |
| `filters` | list of (attribute, values) | none | Any dimension. |
| `group_by` | attribute | none | Any dimension. |
| `range` | date range | last 4 weeks (proposal) | Past and future, custom. |
| `compare` | boolean | true | Week-over-week trend lines. |

## Behavior

### Metrics

1. Time breakdown by category, as in `analytics-personal-stats.md`, plus
   free time, travel time and break time.
2. Focus time report: focus hours per person per week, and the average
   length of a focus session.
3. Deep work score: one group-level number that rates how well a group's
   schedules support focused work. It combines meeting hours, days heavy with
   meetings, availability of long focus blocks, and fragmentation. The
   reference compares it with industry benchmarks. The formula is not
   observed. Proposed formula, 0 to 100:
   - a = share of work hours not in meetings (0 to 1),
   - b = share of workdays with less than 4 h of meetings (0 to 1),
   - c = share of free work time in blocks of 2 h or more (0 to 1),
   - d = 1 minus the share of free work time that is fragmented (gaps
     under 60 minutes) (0 to 1),
   - score = round(25 × (a + b + c + d)).
4. Calendar fragmentation: fragmented time per person per day, as defined
   in `teams-policies.md` rule 21.
5. Time in meetings and meeting type split (one-on-one, team, external).
6. Average daily meeting load: mean meeting hours per person per workday.
7. Meeting cost: meeting hours multiplied by an hourly cost per person.
   Proposed input: an admin-set default annual salary per group, converted
   with the rule in `tools-meeting-cost-calculator.md`.
8. Every metric supports past and future ranges and a week-over-week
   trend.

### Access and privacy

9. Only users with an analytics admin role can open organization
   analytics (proposal). The reference states that its signals describe
   group patterns and are not meant to judge one person's performance.
10. The reference lists individual-level reports. Proposed rule: an
    individual report is visible to that person and to analytics admins;
    groups smaller than 3 people show no values.
11. Assistant chat can answer questions about organization analytics for
    analytics admins, using the same numbers (`assistant-chat.md`).

### Exports

12. An analytics admin can export the current report as CSV. Columns: the
    group keys, period start, period end, and one column per metric.
    Proposed. The reference says exports are customizable; the options are
    not observed.

### Coverage and freshness

13. Provisioned people who never signed in still count, when the calendar
    grant is in place. The system refreshes their calendar data once every
    24 hours.
14. After a person's first sign-in, their data updates in real time, as for
    any user.
15. Large provisioning runs add people gradually. Reports grow as people
    appear. This is expected, not a failure.

### Not current

16. The reference lists policy analysis and industry benchmark reports as
    "coming soon". Tempoloom does not need them for parity.

## Outputs

- Organization analytics page with filters, grouping, metric panels and
  trends.
- CSV export file.
- No calendar events change.

## Edge cases

1. A person without a manager attribute appears under "No manager" in a
   manager-line grouping.
2. A person whose calendar grant failed has attributes but no events:
   exclude them from averages and show a count of "people without calendar
   data" (proposal).
3. A filter that leaves fewer than 3 people: show no values (rule 10).
4. A person moves department mid-range: proposed, count each day under the
   department they had on that day. If the system has no attribute history,
   use the current value and say so in the report footer.
5. Attribute values sent in the wrong format (for example a date as free
   text): store the raw value and show it as text.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the reference formula for the deep work score?
2. Which roles can see organization analytics and individual reports?
3. What export formats and options exist?
4. What does an "analytics-only seat" (a pricing add-on) allow? Proposed:
   a person whose calendar is analyzed but whose calendar the scheduler
   never changes.
5. What is "baseline org performance review" (enterprise tier)? It may be
   a service, not a product feature.
6. Does the reference keep attribute history for moves between groups?

## Acceptance tests

Common setup: Google Workspace test domain with Tempoloom configured for
directory provisioning and the domain-wide calendar grant
(`admin-sso-provisioning.md`). The directory pushes four people:

- P1 and P2: `department = Engineering`, manager M.
- P3: `department = Sales`, manager M.
- P4: `department = Sales`, never signs in.

Each has known meetings last week: P1 10 h, P2 6 h, P3 12 h, P4 8 h. M is an
analytics admin.

### T1. Department grouping includes people who never signed in

- Setup: common setup; wait one 24-hour refresh cycle after provisioning.
- Action: M opens organization analytics, range = last week, group by
  department.
- Expected calendar state: no event on any calendar changes.
- Reload check: after reload, Engineering shows 8 h average meeting time and
  Sales shows 10 h (P4 included).

### T2. Filter by custom attribute

- Setup: common setup, plus custom attribute `site = Lisbon` on P1 and P3.
- Action: M filters `site = Lisbon`.
- Expected calendar state: no change.
- Reload check: after reload, the `site` filter is listed and the filtered
  view shows no values (2 people is below the guard of 3).

### T3. Export

- Setup: common setup.
- Action: M exports the department report as CSV.
- Expected calendar state: no change.
- Reload check: the file has one row per department and period with the
  metric columns; values match the page after reload.

### T4. Non-admin is refused

- Setup: common setup.
- Action: P1 opens the organization analytics page.
- Expected calendar state: no change.
- Reload check: P1 sees an access message after reload.
