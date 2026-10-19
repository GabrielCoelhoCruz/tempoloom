# Event categories and color rules

Spec id: SPEC-EVENTS-03
Evidence: E-0087 (ev_7a786863692c), E-0047 (ev_96d988127a7f), E-0135 (ev_863b715d8623), E-0111 (ev_da4073591415), E-0052 (ev_3db8b91a422f), E-0207 (ev_b37f118a61e9), E-0172 (ev_d2989bf32eaf), E-0077 (ev_38c8b46b5b57)
Status of evidence: public docs only

## Summary

Tempoloom gives every calendar event a category, such as one-on-one,
external meeting or solo work. Categories drive stats, buffer filters and
color rules. A color rule paints events in Google Calendar by category. By
default only managed events are painted; the user can extend this to all
events. The user can change the category of any single event.

## Concepts and inputs

### Categories

| Category id | Meaning |
|---|---|
| `team_meeting` | Three or more people, all with an email in the user's login domain (E-0087). |
| `one_on_one` | Exactly one other attendee, in the user's login domain (E-0087). |
| `external_meeting` | At least one other attendee with an email outside the user's login domain (E-0087). |
| `solo_work` | Not personal, and the user is the only attendee (E-0087). Work task chunks also use it (E-0172). Stats split it into deep (longer than 2 hours) and shallow (shorter than 2 hours) (E-0087). Tempoloom decision: the split uses sessions, as `analytics-personal-stats.md` defines them; a session of exactly 2 hours is deep. |
| `personal` | Mirrored from a calendar marked personal, or detected by keywords in title or description (E-0087). |
| `travel` | Travel and logistics: travel and recovery buffers, `#tl_trip` events, and events detected by travel keywords (E-0087, E-0207). |
| `flight` | A flight, detected or tagged (E-0052, E-0207). |
| `vacation` | Out-of-office span longer than 8 hours (E-0111). |
| `personal_commitment` | Out-of-office span shorter than 8 hours (E-0111). |

Proposed: focus events use `solo_work`. Habits use `solo_work` when
`category=work` and `personal` when `category=personal`.

### Color settings

| Field | Type | Default | Allowed values |
|---|---|---|---|
| `color_scope` | `managed_only` or `all_events` | `managed_only` | E-0047. |
| `category_colors` | map of category id to color | Proposed defaults below | One of Google's 11 event colors (ids 1 to 11) or `calendar_default` (E-0047). |

Proposed default colors: team_meeting 9 (Blueberry), one_on_one 7 (Peacock),
external_meeting 11 (Tomato), solo_work 2 (Sage), personal 3 (Grape),
travel 5 (Banana), flight 5 (Banana), vacation 8 (Graphite),
personal_commitment 8 (Graphite).

## Behavior

### Category detection

1. Tempoloom assigns exactly one category to each event, by the first rule that matches in this order (Proposed order; open question 1):
   1. a manual category set by the user on this event;
   2. `#tl_flight` gives `flight`; `#tl_trip` gives `travel`;
   3. an out-of-office event gives `vacation` or `personal_commitment` by the 8-hour rule;
   4. a detected flight gives `flight`;
   5. a managed event gives the category of its type (see the note under Categories);
   6. a mirrored event from a calendar marked personal, or a personal keyword match, gives `personal`;
   7. a travel keyword match gives `travel`;
   8. any other attendee outside the login domain gives `external_meeting`;
   9. exactly one other attendee inside the login domain gives `one_on_one`;
   10. two or more other attendees, all inside the login domain, give `team_meeting`;
   11. otherwise `solo_work`.
2. Attendees who declined still count for the category. Proposed.
3. When event details change, Tempoloom detects the category again. Example: adding a third same-domain person to a one-on-one makes it a team meeting, and its color changes (E-0047).
4. The user can set the category of one event in the planner side panel. The color follows the new category (E-0087). For a recurring event, Proposed: the planner asks "this event" or "all events in the series".
5. Proposed keyword lists. Personal: "doctor", "dentist", "gym", "school", "pickup", "birthday", "family". Travel: "commute", "drive", "ride", "transit". Matching is case-insensitive, whole word.

### Color rules

6. With `color_scope=managed_only`, Tempoloom sets the color only on managed events (E-0047).
7. With `color_scope=all_events`, Tempoloom also sets the color on external events on the user's writable calendars (E-0047).
8. When the user changes a category color or the scope, Tempoloom repaints past and future events that the rule covers (E-0047). Proposed range: the past 90 days and the whole scheduling window.
9. An item color overrides the category color: a habit color, a task color, or a mirroring policy color (E-0047).
   Tempoloom decision: tasks, habits, focus time and buffers have a Color field: "Category color" (the color rule), "Calendar color", or one of the 11 colors.
10. Tempoloom never tries to change the color of events that Google does not allow it to change: events generated from mail (such as hotel or flight reservations) and birthday events (E-0047). It skips them without error.
11. Changing `color_scope` repaints many events. Tempoloom accepts at most 2 scope changes per minute per user; a third change in the same minute is rejected with a message to wait (E-0135 says more than two toggles in a minute cause issues).
12. Reset: the user sets every category to `calendar_default`, waits for the repaint, and sets the colors again. Proposed: Tempoloom offers a "repaint all" button that does the same in one step (E-0135).
13. For Outlook calendars, colors may not show as set. The settings page states this limit (E-0047).

### Scheduler interaction

14. Categories are inputs for buffer filters (`buffers-automation.md`), focus counting (`focus-time.md`) and meeting overload limits. The scheduler reads the category at the start of each run.
15. A category or color change never moves an event.
16. Repainting runs as a background job. It must not delay a scheduler run. Proposed.

## Outputs

- Google Calendar `colorId` on covered events.
- Planner: category label and color on each event; a category menu in the side panel.
- Stats: time per category (owned by `analytics-personal-stats.md`).

## Edge cases

1. The user's login domain is a public mail domain such as gmail.com: Proposed: treat every other attendee as external unless the email is the user's own other account.
2. An event with only resource rooms as attendees: rooms do not count as people. Proposed.
3. An event the user does not own (an invitation): with `all_events`, Tempoloom changes only the user's copy color. Proposed.
4. A mirrored copy: it uses the mirroring policy color when set, else the category color.

## Observed API shapes

Not yet observed.

## Open questions

1. What is the reference product's precedence order between categories?
2. Which keywords mark personal and travel events?
3. Does the current version add categories (for example focus or flight) or change the attendee rules?
4. How far back does a repaint reach?
5. Default category colors.

## Acceptance tests

Common setup: Google Calendar test account with login domain test.example,
a second account in the same domain and a third account in another domain.
Home time zone America/New_York. Default color settings.

1. **Managed only.**
   Setup: a habit "Walk" and an external meeting with the same-domain account.
   Action: set the `solo_work` color to Tomato (11).
   Expected: "Walk" events get color 11. The external meeting keeps its original color.
   Reload: re-read Google Calendar. Colors persist.

2. **All events.**
   Action: set `color_scope=all_events`.
   Expected: the external meeting (one other same-domain attendee) gets the `one_on_one` color.
   Reload: colors persist.

3. **Recategorize on change.**
   Setup: scenario 2 done.
   Action: add the other-domain account to the meeting.
   Expected: within 60 seconds, the category becomes `external_meeting` and the color changes to its color.
   Reload: the same.

4. **Manual override.**
   Action: in the planner, set the meeting's category to `personal`.
   Expected: the color changes to the `personal` color. Adding another attendee later does not change the category.
   Reload: the override persists.

5. **Scope change limit.**
   Action: change `color_scope` three times within 60 seconds.
   Expected: the third change is rejected with a message. The second change is the active state.
   Reload: the setting shows the second change.
