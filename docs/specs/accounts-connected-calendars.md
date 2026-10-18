# Connected calendars, availability and write targets

Spec id: SPEC-ACCT-01
Evidence: E-0060 (ev_113fb18682d0), E-0106 (ev_2cdb76fa20d7), E-0218 (ev_1322796c67a5), E-0114 (ev_f607afd4c9e8), E-0059 (ev_43fd142018d9), E-0086 (ev_d7e7264ef13c), E-0053 (ev_4544cc9fe82d), E-0041 (ev_5c7f26c4a082), E-0094 (ev_1a74a92985a9), E-0003 (ev_fdf25af08b9c), E-0010 (ev_3ce2126cfbf4), E-0051 (ev_936bc1052a22), E-0063 (ev_1f870480468c), E-0082 (ev_908de7baa80e), E-0104 (ev_173e10d4937f), E-0125 (ev_c3865619996c), E-0172 (ev_d2989bf32eaf), E-0029 (ev_2cd9b977c6e8), E-0033 (ev_448e7d295296)
Status of evidence: public docs only

## Summary

The user chooses which calendars Tempoloom reads when it looks for free
time. These are the connected calendars. The main calendar is always one of
them. Connected calendars change what Tempoloom sees. They do not change what
coworkers see; calendar mirroring does that. This spec also fixes the exact
set of calendars that count for availability, and where Tempoloom writes each
kind of event.

## Concepts and inputs

### Terms

- **Added account**: a Google or Microsoft account that the user linked to
  Tempoloom. See `accounts-login-emails-permissions.md`.
- **Main email**: the one added account that the user marked as main.
- **Main calendar**: the primary calendar of the main email. On Google, the
  calendar whose id is the account email.
- **Connected calendar**: a calendar that the user marked for availability.
- **Availability set**: all connected calendars of the user.
- **Target calendar**: the calendar where Tempoloom writes a managed event.

### Inputs

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `connected` (per calendar) | bool | `true` for the main calendar; Proposed default `false` for all others | Locked to `true` for the main calendar and for calendars in a mirroring policy (rules 2 and 3). |
| `category` (per connected calendar) | enum | Proposed default: `business` for the main calendar, `personal` for others | Proposed values: `business`, `personal`, `travel` (same as the mirroring `calendar_type`). Used by color rules, stats and chat status (E-0106). |
| habit or flexible meeting `target_calendar` | calendar id | main calendar | Any writable connected calendar. Set at creation only (rule 20). |
| hours set `task_calendar` | calendar id | main calendar | Any writable connected calendar (rule 21). |
| booking link `target_account` | added account id | main email | Any added account (rule 22). |

### Plan limits in the reference

- Free plan: the comparison table shows 2 connected calendars; a help page
  says only the main calendar stays connected on the free plan. Paid plans:
  no limit (E-0003, E-0060). See open questions.
- On downgrade to the free plan, the main calendar stays connected and all
  other connected calendars are turned off (E-0060).

## Behavior

### Choosing connected calendars

1. A settings page lists each added account with its calendars. Each
   calendar has a check box for `connected` (E-0060, E-0106).
2. The main calendar is always connected. Its check box is checked and
   locked (E-0060, E-0106).
3. A calendar that an enabled mirroring policy uses is connected, and its
   check box is locked (E-0106). Proposed: this applies to both the source
   and the destination of the policy.
4. The list shows a calendar only when the added account has full read and
   write access to it (E-0060, E-0106). The list does not show:
   - calendars with free/busy-only or read-only access;
   - group, resource, holiday and birthday calendars that the provider makes
     (on Google, calendar ids under `group.v.calendar.google.com`, such as
     the national holiday calendars).
5. The help text tells the user how to replace a holiday calendar: make an
   own calendar with the holidays they want and connect it (E-0106).
6. When two added accounts can see the same calendar, the list shows it once
   (E-0106). Proposed: under the account that the user added first.
7. An "add another account" button starts the provider sign-in. After it
   ends, the new account and its calendars show in the list (E-0041, E-0106).
8. The user can set a `category` for each connected calendar (E-0106).
9. When the user changes the main email, the old main calendar stops being
   connected and the new main calendar becomes connected (E-0060). Proposed:
   when the old main calendar is used in a mirroring policy, it stays
   connected (rule 3).
10. When the user removes an added account, its calendars stop being
    connected (E-0041).

### Availability set: which calendars count

11. The availability set is exactly the set of connected calendars. By rules
    2 and 3 it always holds the main calendar and every calendar of every
    enabled mirroring policy (E-0060, E-0106).
12. The scheduler reads every event on every calendar in the availability
    set. It places all managed events (task chunks, habits, focus time,
    flexible meetings, buffers) around them (E-0060, E-0218, E-0010).
13. The scheduler does not read any calendar outside the availability set,
    also when that calendar belongs to an added account (E-0218).
14. Events on connected calendars other than the main calendar, and mirrored
    copies, count as P1. The user cannot change their priority (E-0104,
    legacy evidence). Events on the main calendar that Tempoloom did not
    create are also P1 by default; the scheduler spec covers the rest.
15. Proposed: the scheduler counts a source event and its mirrored copy as
    one busy interval. It uses the source event and ignores the copy when it
    can read the source. This avoids a double count and keeps the source
    owner's own response in charge.
16. The free/busy meaning of each event, event tags and conflict rules are
    in `planning-scheduler.md`.
17. A buffer automation can read one chosen calendar or all connected
    calendars (E-0051). The buffer spec covers this.

### Write targets: where Tempoloom writes

18. By default, Tempoloom writes every managed event to the main calendar
    (E-0060, E-0114).
19. Tempoloom writes a managed event only to a writable connected calendar.
    Proposed: when a target calendar stops being connected or writable, the
    item shows an error and Tempoloom places no new events for it until the
    user picks a new target.
20. Habits and flexible meetings: the user picks `target_calendar` when
    creating the item. After creation the field is read-only (E-0082, legacy
    evidence).
21. Tasks: each hours set has a `task_calendar`. Chunks of a task go to the
    `task_calendar` of the hours set that the task uses (E-0172). A user can
    use this to give task events other default alerts than the main
    calendar (E-0125).
22. Booking-link events: Tempoloom writes them to the primary calendar of the
    added account chosen on the link, and sends the invitations from that
    account (E-0063, legacy evidence).
23. Focus time and buffers: the evidence names no target choice. Proposed:
    the main calendar.
24. Mirrored copies: Tempoloom writes them to the destination calendar of the
    policy, and to no other calendar. See `sync-calendar-mirroring.md`.

### What other people see

25. The provider's "find a time" views for coworkers show only the main
    calendar. Events on other calendars, connected or not, are invisible to
    coworkers there (E-0114, E-0218).
26. To make busy time from another calendar visible to coworkers, the user
    mirrors that calendar into the main calendar (E-0218, E-0053).
27. Sharing a calendar with one's own other account in the provider shows
    the events only to that account, not to coworkers. Mirroring writes real
    events, so coworkers see them (E-0086).

### Connected calendars versus mirroring

28. The help text and the settings page explain the choice (E-0218, E-0053,
    E-0060):
    - Use a connected calendar when only Tempoloom needs to plan around the
      events.
    - Use mirroring when other people book time directly on the user's
      calendar and must see the busy time.
29. Both features appear on the same settings page, with a button to create
    a new mirroring policy (E-0106).

### Shared and external calendars

30. A calendar that another person shared with an added account can be
    connected when the share gives full read and write access (E-0059,
    E-0106).
31. Calendars from other services (for example iCloud) must first be added
    to a Google or Microsoft account. Then they can be connected or mirrored.
    The other service can delay changes by many hours (E-0059).

## Outputs

- Settings page: accounts, calendars with locked or open check boxes,
  categories, add-account button, new-policy button.
- Scheduler input: events from the availability set only.
- Managed events written only to the target calendars in rules 18 to 24.

## Edge cases

1. A user with one account and one calendar: the availability set is the
   main calendar only.
2. A mirroring policy is deleted: its calendars stay connected but are no
   longer locked (rule 3). Proposed.
3. The user unchecks a secondary calendar: the scheduler stops reading it at
   once. Managed events that now have a better slot may move, following the
   scheduler rules.
4. The provider removes write access to a connected calendar: it disappears
   from the list (rule 4). Proposed: show a warning instead of a silent
   removal, and turn the calendar off.
5. A habit target calendar is removed from the account: see rule 19.
6. A calendar visible through two accounts: shown once (rule 6). Events on it
   are read once.
7. The user downgrades to the free plan: only the main calendar stays
   connected (E-0060).

## Observed API shapes

Not yet observed.

## Open questions

1. Free plan limit: 1 or 2 connected calendars (E-0003 and E-0060 differ)?
2. Does the lock in rule 3 apply to the source, the destination, or both?
3. Does a new added account's primary calendar start as connected?
4. Can tasks, focus time and buffers be written to a calendar other than
   the main calendar in the current version, other than through the hours
   set setting?
5. Which category values exist for connected calendars, and what is the
   default for each?
6. When the main email changes, what happens to managed events that already
   exist on the old main calendar?
7. Does the scheduler read the source event or the copy when both are on
   connected calendars (rule 15)?
8. Can a read-only subscribed calendar (for example an imported iCloud feed)
   be connected? Rule 4 says no; E-0059 suggests yes.

## Acceptance tests

Common setup: Google test account G1 is the main email of user U1, with main
calendar M. G1 also owns a secondary calendar S. Google test account G2 is
added to U1, with primary calendar P2. Work hours: Monday to Friday, 09:00
to 17:00. "Reload check" means reload the web app and read the events again
from the Google Calendar API.

### AT-1 Main calendar is locked

1. Setup: a new user signs up with G1.
2. Action: open the connected-calendar settings.
3. Expected: M is checked and its check box is locked. S and the holiday
   calendars of G1 are handled as in rule 4: S is shown unchecked; Google
   holiday and birthday calendars are not shown.
4. Reload check: same state after reload.

### AT-2 A connected calendar blocks scheduling

1. Setup: S connected. On S, create "Private appointment" tomorrow 09:00 to
   13:00, busy. M is empty tomorrow.
2. Action: create a task of 2 hours, due end of tomorrow, using work hours.
3. Expected: Tempoloom writes the task chunk(s) on M, and no chunk overlaps
   09:00 to 13:00 tomorrow. S is unchanged.
4. Action 2: uncheck S. Create a second 4-hour task due end of tomorrow.
5. Expected 2: the scheduler may now use 09:00 to 13:00 on M.
6. Reload check: the check box state and event placement stay after reload.

### AT-3 Calendars outside the set do not count

1. Setup: S not connected. On S, create a busy event tomorrow 09:00 to
   17:00.
2. Action: create a 1-hour task due end of tomorrow.
3. Expected: the chunk can land tomorrow between 09:00 and 17:00 on M.
4. Reload check: same after reload.

### AT-4 Mirroring locks its calendars

1. Setup: no policies. P2 not connected.
2. Action: create mirroring policy P2 to M.
3. Expected: P2 is now checked and locked. Delete the policy: P2 stays
   checked and is no longer locked (Proposed).
4. Reload check: lock state stays after reload.

### AT-5 Habit target calendar

1. Setup: S connected.
2. Action: create a habit "Walk" with target calendar S.
3. Expected: the habit events are on S, not on M. Open the habit edit form:
   the target calendar field is read-only.
4. Reload check: events still on S after reload.

### AT-6 Task calendar per hours set

1. Setup: S connected. Personal hours: every day 18:00 to 21:00. Set the
   personal hours `task_calendar` to S.
2. Action: create a 1-hour task that uses personal hours.
3. Expected: its chunk is on S between 18:00 and 21:00.
4. Reload check: same after reload.

### AT-7 Changing the main email changes the main calendar

1. Setup: G2 is added to U1. No mirroring policy uses M.
2. Action: make G2 the main email and confirm.
3. Expected: P2 is checked and locked. M is no longer connected (unless a
   policy uses it). A new task created after the switch is written to P2.
4. Reload check: the main email and the lock state stay after reload.

### AT-8 Calendar visible through two accounts

1. Setup: G2 shares S with "make changes" rights. S is visible to both G1
   and G2.
2. Action: open the connected-calendar settings.
3. Expected: S shows once.
4. Reload check: same after reload.
