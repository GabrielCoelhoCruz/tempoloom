# Meeting cost calculator

Spec id: SPEC-TOOLS-02
Evidence: E-0024 (ev_d7790092b5fd)
Status of evidence: public docs only

## Summary

A free, public page that estimates what a meeting costs in salary. The user
enters the average annual salary of attendees, the number of attendees, the
meeting length and how often it repeats. The page shows the cost of one
meeting and the cost per year. It counts salary only and assumes 48 working
weeks per year.

## Concepts and inputs

| Field | Type | Default | Allowed |
|---|---|---|---|
| `annual_salary` | money, whole currency units | 100000 | 1 to 10000000 (proposal) |
| `attendees` | integer | 5 | 1 to 1000 (proposal) |
| `duration_minutes` | integer | empty (proposal: 30) | 1 to 1440 (proposal). See open question 1 about the unit. |
| `frequency` | enum | `weekly` | `every_weekday`, `weekly`, `biweekly`, `monthly`, `quarterly`, `one_time` |

Constants:

| Constant | Value | Source |
|---|---|---|
| Working weeks per year | 48 | Note on the page: 4 weeks of time off. |
| Working hours per year | 1920 | 48 weeks × 40 hours. |

Occurrences per year by frequency (derived from 48 working weeks; proposal
where marked):

| Frequency | Occurrences per year |
|---|---|
| `every_weekday` | 240 (48 × 5) |
| `weekly` | 48 |
| `biweekly` | 24 |
| `monthly` | 12 (proposal) |
| `quarterly` | 4 |
| `one_time` | 1 |

## Behavior

1. The page shows the four inputs, a note about the assumptions (48 working
   weeks, salary only), a Calculate button and a Reset button.
2. Before the first calculation, both results show 0.
3. Calculate computes:
   - hourly rate = `annual_salary` / 1920;
   - cost per meeting = `attendees` × hourly rate × (`duration_minutes` /
     60);
   - annual cost = cost per meeting × occurrences per year.
4. The page shows "annual cost" and "cost per meeting", rounded to whole
   currency units, with thousands separators (proposal for rounding).
5. Reset sets all inputs to defaults and both results to 0.
6. Invalid input (empty, zero, negative, or not a number) blocks Calculate
   and marks the field with a message (proposal).
7. The page uses one currency symbol. Proposed: the instance's default
   currency, US dollar if not set.
8. The page needs no login and stores nothing on the server.

## Outputs

- Two result values on the page.
- No calendar events change.

## Edge cases

1. `one_time`: annual cost equals cost per meeting.
2. Very large values: compute in decimal, not binary floating point, so
   that results do not show rounding noise.
3. Duration not a whole number of minutes: refuse (proposal).
4. Worked example (from the page text): 8 attendees, 100000 salary, 60
   minutes. Hourly rate 52.08; cost per meeting 416.67, shown as 417.
   Weekly annual cost: 48 × 416.67 = 20000. The page text gives about 21000
   to 22000 for this example, which matches 52 weeks, not 48. This spec uses
   48 to match the note in the tool. See open question 2.

## Observed API shapes

Not yet observed. Not applicable: the reference calculator runs in the
browser.

## Open questions

1. Is meeting duration in minutes or hours, and what is its default? The
   capture shows an empty number field.
2. Which yearly count does the tool use for weekly meetings: 48 (tool note)
   or 52 (worked example in the page text)? The page FAQ also mentions 2080
   hours per year, which is 52 weeks.
3. How does the tool count monthly meetings with 48 working weeks?
4. Does the tool round results, and how?
5. Should Tempoloom also show a cost estimate on meetings in the planner?
   Not observed in the reference; organization analytics has meeting cost
   (`analytics-organization.md` rule 7).

## Acceptance tests

Common setup: the calculator page open in a browser. A Google test account
U is signed in to Tempoloom in another tab, with a known calendar.

### T1. Weekly meeting

- Setup: common setup.
- Action: enter salary 100000, attendees 8, duration 60, frequency weekly;
  select Calculate.
- Expected calendar state: U's Google calendar is unchanged.
- Reload check: results show cost per meeting 417 and annual cost 20,000.
  After page reload, inputs and results show defaults and 0 (no storage).

### T2. Every weekday

- Setup: common setup.
- Action: salary 96000, attendees 3, duration 15, frequency every weekday;
  Calculate.
- Expected calendar state: unchanged.
- Reload check: hourly rate 50, cost per meeting 37.50 shown as 38, annual
  cost 9,000 (37.5 × 240).

### T3. One-time meeting

- Setup: common setup.
- Action: salary 120000, attendees 6, duration 60, frequency one-time;
  Calculate.
- Expected calendar state: unchanged.
- Reload check: cost per meeting 375 and annual cost 375.

### T4. Reset and validation

- Setup: T1 done.
- Action: select Reset. Then clear attendees and select Calculate.
- Expected calendar state: unchanged.
- Reload check: after Reset, inputs show defaults and results show 0. The
  empty attendees field shows a message and results stay 0.
