# Accounts, login emails and provider permissions

Spec id: SPEC-ACCT-02
Evidence: E-0124 (ev_d5e98b2ad31a), E-0041 (ev_5c7f26c4a082), E-0094 (ev_1a74a92985a9), E-0060 (ev_113fb18682d0), E-0106 (ev_2cdb76fa20d7), E-0079 (ev_452e601ad4e8), E-0220 (ev_5e4b6a11f988), E-0211 (ev_e43f2883d8e8), E-0029 (ev_2cd9b977c6e8), E-0033 (ev_448e7d295296), E-0099 (ev_6bdab0fd61fa)
Status of evidence: public docs only

## Summary

A Tempoloom account can hold several Google and Microsoft accounts. One of
them is the main email. Its primary calendar is the main calendar, where
Tempoloom writes by default. The user can log in with any of the emails,
add and remove them, and change which one is main. Tempoloom asks the
provider only for the permissions that the features in use need.

## Concepts and inputs

### Terms

- **Tempoloom account**: one user's settings, items and calendars.
- **Added account**: a Google or Microsoft account linked to a Tempoloom
  account. Each has one email.
- **Main email**: exactly one added account per Tempoloom account.
- **Secondary email**: every other added account.
- **Main calendar**: the primary calendar of the main email.

### Fields per added account

| Field | Type | Default | Allowed values and notes |
|---|---|---|---|
| `provider` | enum | from sign-in | `google`, `microsoft`. |
| `email` | string | from provider | Unique inside one Tempoloom account. |
| `is_main` | bool | `true` for the sign-up account, `false` for others | Exactly one `true` per Tempoloom account. |
| `status` | enum | `connected` | `connected`, `disconnected` (tokens lost or revoked). |
| `granted_scopes` | set of strings | from consent | Grows by incremental consent (rule 18). |

## Behavior

### Sign-up and login

1. A new user signs up with Google or Microsoft. The sign-up account becomes
   the main email, and its primary calendar becomes the main calendar
   (E-0124, E-0029, E-0033).
2. The user can log in with any email of the Tempoloom account (E-0124).
3. Tempoloom resolves a login email in this order (E-0124):
   1. The email is the main email of a Tempoloom account: log in to that
      account.
   2. The email is a secondary email of exactly one Tempoloom account: log
      in to that account.
   3. The email is a secondary email of two or more Tempoloom accounts and
      the main email of none: offer sign-up of one more Tempoloom account.
   4. The email is unknown: start sign-up.
4. An email can be the main email of at most one Tempoloom account. It can be
   a secondary email of many Tempoloom accounts (E-0124).
5. The sign-up screen tells existing users to add a second provider to their
   current account instead of creating a new account (E-0211).

### Adding and removing emails

6. To add an email, the user opens the calendar settings and selects "add
   another account". Tempoloom starts the Google or Microsoft sign-in. When
   it ends, the email shows in the list of added accounts. The user can then
   pick connected calendars from it (E-0041, E-0106).
7. To remove an email, the user expands the email in the list and selects
   delete. Tempoloom shows a confirmation dialog. After confirmation, the
   email is removed, its calendars stop being connected, and its calendars
   can no longer be used in mirroring policies (E-0041).
8. Proposed: the user cannot remove the main email. The delete action is
   not shown for it. The user must first make another email main.
9. Delegates cannot add or remove emails. See
   `accounts-delegated-access.md` (E-0099, legacy evidence).

### Main email

10. Each Tempoloom account has exactly one main email. Tempoloom blocks time
    on its primary calendar by default (E-0094).
11. To change it, the user selects "use as main" under another email. A
    confirmation dialog asks the user to confirm the switch. After
    confirmation, that email is main (E-0094). For the effect on connected
    calendars, see `accounts-connected-calendars.md` rule 9.
12. The switch fails in two cases, each with its own message (E-0094):
    - The email is `disconnected` (rule 14).
    - The email is the main email of another Tempoloom account. Proposed
      error code: `main_email_taken`.
13. For `main_email_taken`, the help text explains the usual cause: an
    earlier, forgotten Tempoloom account that uses this email as main. The
    user logs in with that email to reach the forgotten account, then logs
    back in with the current main email and retries (E-0094). Proposed: when
    the forgotten account has no items and no other emails, Tempoloom offers
    to delete it after the user signs in with that email.

### Disconnected emails

14. When Tempoloom loses access to an added account (refresh token revoked
    or expired), the list shows "Disconnected" under that email (E-0094).
15. A "reconnect" button runs the provider sign-in again and asks the user to
    confirm the permissions. On success, `status` becomes `connected`
    (E-0094).
16. Proposed: while an email is `disconnected`, Tempoloom does not read or
    write its calendars. Mirroring policies and items that use them show an
    error state.

### Provider permissions

17. Google permissions come in three groups (E-0079):
    - calendar (events and calendars);
    - tasks (only for the Google Tasks integration);
    - Workspace and Gmail (only for features that need them).
    Tempoloom uses them to mirror events, place tasks and habits, update
    responses to invitations, compute stats, and feed the chat integration
    (E-0079).
18. Tempoloom asks for the smallest set at sign-up. It asks for more only
    when the user turns on a feature that needs more. Google then shows its
    "additional access" consent screen (E-0079). Tempoloom never asks for a
    scope that no enabled feature uses (E-0079, E-0029, E-0033).
19. Proposed Google scope sets (the exact reference list is not in the
    captured evidence):
    - Sign-up: `openid`, `email`, `profile`,
      `https://www.googleapis.com/auth/calendar.events`,
      `https://www.googleapis.com/auth/calendar.calendarlist.readonly`,
      `https://www.googleapis.com/auth/calendar.settings.readonly`.
    - Sharing a source calendar with the main account (mirroring rule 44):
      add `https://www.googleapis.com/auth/calendar.acls`.
    - Google Tasks integration: add `https://www.googleapis.com/auth/tasks`.
20. Google Workspace admins can approve Tempoloom for the whole domain in the
    Google Admin console, so users see no consent block (E-0029).
21. Microsoft: Tempoloom asks for Microsoft Graph access to calendars and
    to free/busy data (E-0033). Proposed set: `openid`, `profile`, `email`,
    `offline_access`, `User.Read`, `Calendars.ReadWrite`,
    `Calendars.ReadWrite.Shared`.
22. When a Microsoft 365 tenant blocks user consent, Microsoft shows an
    "admin approval" error during sign-in (E-0220). Tempoloom then shows a
    help page that:
    - explains that a tenant admin must approve the app;
    - gives the admin-consent link for Tempoloom's app registration;
    - tells the admin to accept, and to choose consent for the whole
      organization when all users need access;
    - tells the admin where the app then shows in the tenant's enterprise
      applications list;
    - tells the user to retry sign-in after approval (E-0220).
23. Hosted or on-premises Exchange accounts are not supported. Tempoloom shows
    a clear error when sign-in or add-account uses one (E-0211).

## Outputs

- Account list: email, provider, "main" badge, status, reconnect button,
  delete action, "use as main" action.
- Confirmation dialogs for delete and for main switch.
- Error messages: `main_email_taken`, disconnected email, admin approval
  needed, unsupported Exchange.
- Provider consent screens at sign-up and at feature enable time.

## Edge cases

1. The user adds an email that is already in the same Tempoloom account:
   Proposed: no new row; refresh its tokens.
2. The user adds an email that is the main email of another Tempoloom
   account: allowed as a secondary email (rule 4).
3. The user revokes Tempoloom in the Google account permissions page: the
   email becomes `disconnected` at the next API call (rule 14).
4. The user denies an extra scope at feature enable time: the feature stays
   off and shows why. Proposed.
5. A login with an email that is secondary in two accounts never logs in to
   either; it offers a new account (rule 3.3).
6. Removing a secondary email that is the destination of a mirroring policy:
   see `sync-calendar-mirroring.md` edge case 9.

## Observed API shapes

Not yet observed.

## Open questions

1. The exact Google and Microsoft scopes that the reference requests at
   sign-up and per feature (the scope list page was not captured).
2. Can the main email be removed? Rule 8 is a proposal.
3. What happens to managed events on the old main calendar after a main
   switch?
4. Does login with a secondary email that belongs to exactly one account
   always succeed (rule 3.2), or does it need the email to be connected?
5. Exact wording and flow of the "forgotten account" fix, and whether the
   reference can delete such an account itself.
6. Which Gmail scopes does the reference use, and for which feature?

## Acceptance tests

Common setup: Google test accounts G1, G2 and G3. "Reload check" means
reload the web app, log out and log in again where stated, and read the
state again.

### AT-1 Sign-up sets main email and main calendar

1. Setup: no Tempoloom account for G1.
2. Action: sign up with G1 and accept consent.
3. Expected: the account list shows G1 with the main badge and status
   connected. The granted scopes match the sign-up set (rule 19). A test
   task is written to the G1 primary calendar.
4. Reload check: log out, log in with G1, same state.

### AT-2 Add, log in with, and remove a secondary email

1. Setup: AT-1 done.
2. Action: add G2. Log out. Log in with G2.
3. Expected: G2 shows as secondary, connected. Login with G2 opens the same
   Tempoloom account (G1 main).
4. Action 2: create mirroring policy G2 primary to G1 primary. Then delete
   G2 and confirm.
5. Expected 2: G2 is gone from the list. The policy cannot run (it is
   removed or shows an error). G2 calendars are not connected.
6. Reload check: after reload, G2 is still absent.

### AT-3 Change the main email

1. Setup: G1 main, G2 secondary.
2. Action: select "use as main" on G2 and confirm.
3. Expected: G2 has the main badge. G1 is secondary. The G2 primary calendar
   is connected and locked.
4. Reload check: log out and log in with G1: the same account opens, G2 is
   still main.

### AT-4 Main email taken by another account

1. Setup: Tempoloom account A has G1 main. Tempoloom account B has G3 main.
   Add G3 to A as secondary.
2. Action: in A, select "use as main" on G3.
3. Expected: the switch fails with the `main_email_taken` message. G1 stays
   main in A.
4. Reload check: same after reload.

### AT-5 Disconnected and reconnect

1. Setup: G1 main, G2 secondary.
2. Action: revoke Tempoloom access in the G2 Google account permissions
   page. Wait for the next sync cycle.
3. Expected: G2 shows "Disconnected". Policies that use G2 show an error.
4. Action 2: select reconnect and accept consent.
5. Expected 2: G2 status is connected. Policies resume.
6. Reload check: status stays connected after reload.

### AT-6 Login with an email that is secondary in two accounts

1. Setup: accounts A and B both list G3 as a secondary email. G3 is not
   main anywhere.
2. Action: log in with G3.
3. Expected: Tempoloom offers sign-up of a third account. It does not open A
   or B.
4. Reload check: none needed (no state change unless the user accepts).

### AT-7 Incremental consent

1. Setup: G1 main, signed up with the sign-up scope set.
2. Action: turn on the Google Tasks integration.
3. Expected: Google shows a consent screen for the tasks scope only. After
   approval, `granted_scopes` includes the tasks scope.
4. Reload check: the integration stays on after reload.
