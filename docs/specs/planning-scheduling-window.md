# Scheduling window

Spec id: SPEC-PLANNING-06
Evidence: E-0042 (ev_4ec67aadde4a), E-0190 (ev_39d8d5ed64d6), E-0226 (ev_0dc4ddadd24f)
Status of evidence: public docs only

## Summary

The scheduling window is how far ahead Tempoloom places managed events. The
scheduler places habits, tasks, flexible meetings, buffers and focus time only
between now and the window end. Calendar mirroring has its own, longer window.

## Concepts and inputs

| Setting | Type | Default | Range |
|---|---|---|---|
| `schedulingWindowWeeks` | integer weeks | Proposed default: 3 | Proposed default: 1 to 12 |
| `mirroringWindow` | duration | Proposed default: 12 months | mirroring spec |

Reference values by plan (E-0042), for information:

| Reference plan | Managed events | Calendar mirroring |
|---|---|---|
| Free | 1 week | 1 week |
| Trial | 3 weeks | 3 weeks |
| Lower paid plan | 8 weeks | 12 months |
| Higher paid plans | 12 weeks | 12 months |

In the reference, an upgrade away from the free tier sets the window to
3 weeks, and the user can raise it up to the plan limit (E-0042). Tempoloom
has no plans.

Window end: Proposed default: the end of the day (24:00 in the user's time
zone) that is `schedulingWindowWeeks` × 7 days after today.

## Behavior

- **WIN-1.** The scheduler places no managed event that ends after the window
  end (E-0042, E-0226).
- **WIN-2.** The window applies to habits, tasks, flexible meetings, buffers
  and focus time (E-0042).
- **WIN-3.** The window moves forward with time. Each day, new days enter the
  window and the scheduler places items in them. Proposed default: the
  scheduler runs once soon after 00:00 local time for this.
- **WIN-4.** The user changes `schedulingWindowWeeks` on the settings page,
  in a "Scheduling window" control. The scheduler runs again at once (E-0042).
- **WIN-5.** When the user shortens the window, Proposed default: Tempoloom
  deletes unlocked managed events that now end after the window end. Locked
  events stay.
- **WIN-6.** A task whose `startAfter` is after the window end has no chunks.
  The task list shows it as open, not scheduled, with reason "outside window"
  (legacy evidence, E-0190).
- **WIN-7.** Calendar mirroring uses `mirroringWindow`, not this window
  (E-0042). Mirroring spec owns its rules.

## Outputs

- Managed events exist only up to the window end.
- Settings page: the window control with its current value.

## Edge cases

1. A habit with a weekly target in a week that the window cuts in half:
   Proposed default: the scheduler places only the occurrences that fit
   before the window end and does not report the rest as unplaced.
2. A task due after the window end: chunks go only inside the window; the
   rest waits until the window moves (Proposed default). It is not reported
   as at risk unless it is also past the at-risk rule.
3. The user creates a booking-link meeting after the window end: the meeting
   is an external fixed event; the window does not apply to it.

## Observed API shapes

Not yet observed.

## Open questions

1. The reference does not state the exact window end (end of day, or now plus
   N weeks). Proposed default: end of day.
2. Does the reference delete events beyond a shortened window?
3. How often does the reference extend the window?

## Acceptance tests

Fixture F0 from `planning-scheduler.md` (window 3 weeks).

1. **Nothing beyond the window.** Setup: P4 habit "AT-W1", 30 minutes every
   weekday. Action: wait 60 s after creation. Expected: "AT-W1" events exist
   on weekdays from Monday W up to the window end and none after it. Reload: same.
2. **Raising the window.** Setup: test 1. Action: set the window to 5 weeks.
   Expected within 60 s: "AT-W1" events now exist in weeks 4 and 5. Reload:
   the control shows 5.
3. **Lowering the window.** Setup: test 2. Action: set the window to 1 week.
   Expected within 60 s: no unlocked "AT-W1" event ends after the new window
   end (Proposed default WIN-5). Reload: the control shows 1.
4. **Task outside the window.** Setup: window 3 weeks. Action: create task
   "AT-W4", 60 minutes, `startAfter` 4 weeks from today. Expected: no event;
   the task shows reason "outside window". Action: raise the window to
   5 weeks. Expected within 60 s: one "AT-W4" event after `startAfter`
   and before the new window end. Reload: the task is under Scheduled.
