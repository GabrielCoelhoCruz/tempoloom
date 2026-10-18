# Delegated access

Spec id: SPEC-ACCT-03
Evidence: E-0099 (ev_6bdab0fd61fa), E-0074 (ev_b5ca2d13ca39), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

All workflow rules in this spec come from legacy evidence (E-0099, E-0074).
The current pricing page still lists the feature for the two highest plans
(E-0003).

## Summary

A user (the owner) can let another member of the same team (the delegate)
act inside the owner's Tempoloom account. A typical delegate is an executive
assistant. The delegate switches into the owner's account from the account
menu, sees a banner while acting there, and can do almost everything the
owner can.

## Concepts and inputs

### Terms

- **Owner**: the user who gives access.
- **Delegate**: the team member who gets access.
- **Acting session**: the time a delegate works inside an owner's account.

### Fields

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `delegates` (per owner) | list of user ids | empty | Members of the owner's team only. No upper limit in the evidence. |
| `acting_as` (per session) | user id or none | none | Set when the delegate switches; cleared on exit. |

### Plan limits in the reference

- Only on the two highest plans (E-0003, E-0099, E-0074).

## Behavior

1. The owner's account settings have a "delegate access" section. It has a
   search box for team members (E-0099, E-0074). (legacy evidence)
2. Each search result has a button to give access. Tempoloom shows a
   confirmation dialog. The dialog says that the delegate will see and
   change the owner's Tempoloom data. After confirmation, the delegate shows
   in the owner's delegate list (E-0099). (legacy evidence)
3. Only members of the owner's team can be delegates (E-0099). (legacy
   evidence)
4. An owner can have more than one delegate. A delegate can act for many
   owners (E-0099, E-0074). (legacy evidence)
5. The delegate's account menu (top right) lists every owner who gave
   access. Selecting an owner reloads the web app inside that owner's account
   (E-0099, E-0074). (legacy evidence)
6. During an acting session, every page shows a top banner that says the
   user is acting in another person's account (E-0099, E-0074). (legacy
   evidence)
7. During an acting session, the delegate can do everything the owner can,
   except (E-0099, E-0074) (legacy evidence):
   - delete the owner's Tempoloom account;
   - add or remove added accounts or calendars;
   - create or change API keys.
8. The account menu has an "exit" action. It ends the acting session and
   reloads the web app in the delegate's own account (E-0099). (legacy
   evidence)
9. Changes made by a delegate and by the owner at the same time show in both
   sessions in real time. The help text advises against changing the same
   account from two sessions at once (E-0099). (legacy evidence)
10. Proposed: the owner can remove a delegate from the list. The delegate
    loses access at once. An open acting session ends at the next request
    and returns the delegate to their own account.
11. Proposed: Tempoloom records the acting user on every change made in an
    acting session, so the owner can see who made a change.

## Outputs

- Owner settings: delegate search, give-access button, confirmation dialog,
  delegate list.
- Delegate account menu: list of owners, exit action.
- Banner during acting sessions.
- Blocked actions (rule 7) show a message that delegates cannot do them.

## Edge cases

1. A delegate leaves the team: Proposed: the delegate loses access to all
   owners in that team.
2. The owner leaves the team: Proposed: all their delegates lose access.
3. The owner's plan drops below the required plan: Proposed: delegation stops
   and the list is kept for later.
4. A delegate creates a mirroring policy that needs a calendar the owner has
   not added: the delegate cannot add it (rule 7). The owner must add the
   calendar first (E-0074).
5. A delegate tries to open the add-account flow: Tempoloom blocks it with a
   message.

## Observed API shapes

Not yet observed.

## Open questions

1. Does the current version keep this workflow unchanged?
2. How does an owner remove a delegate, and what does the delegate see?
3. Can a delegate see or change the owner's billing and team settings?
4. Does the reference keep a record of changes made by delegates?
5. Does the owner get a notification when a delegate acts?

## Acceptance tests

Common setup: users U1 (owner, main email G1) and U2 (delegate, main email
G3) are in the same team on a plan that allows delegation. "Reload check"
means reload the web app and read the state again.

### AT-1 Give access and act

1. Setup: U1 has no delegates.
2. Action: U1 searches for U2, gives access, and confirms. U2 opens the
   account menu and selects U1.
3. Expected: U1's delegate list shows U2. U2's web app reloads in U1's
   account and shows the banner. U2 creates a 1-hour task; its chunk is
   written to the G1 primary calendar.
4. Reload check: after reload, U2 is still acting as U1 and the banner
   still shows; the task exists in U1's account.

### AT-2 Blocked actions

1. Setup: U2 is acting as U1.
2. Action: U2 tries to add an account, to remove G1, to create an API key,
   and to delete U1's account.
3. Expected: each action is blocked with a message. No account, key or
   deletion change happens.
4. Reload check: U1's account list and API keys are unchanged after reload.

### AT-3 Exit

1. Setup: U2 is acting as U1.
2. Action: U2 selects exit in the account menu.
3. Expected: the web app reloads in U2's own account. No banner.
4. Reload check: still in U2's own account after reload.

### AT-4 Non-team member

1. Setup: U4 is not in U1's team.
2. Action: U1 searches for U4 in the delegate search.
3. Expected: U4 is not offered.
4. Reload check: delegate list unchanged after reload.
