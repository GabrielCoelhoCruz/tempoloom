# Microsoft Outlook calendar support

Spec id: SPEC-ACCT-04
Evidence: E-0211 (ev_e43f2883d8e8), E-0033 (ev_448e7d295296), E-0220 (ev_5e4b6a11f988), E-0053 (ev_4544cc9fe82d), E-0094 (ev_1a74a92985a9), E-0041 (ev_5c7f26c4a082), E-0203 (ev_6fcb5f8189d7), E-0003 (ev_fdf25af08b9c)
Status of evidence: public docs only

## Summary

Tempoloom works with Microsoft Outlook calendars (Microsoft 365 and
Outlook.com) as well as with Google calendars. A user can sign up with
Microsoft, or add a Microsoft account to an existing Tempoloom account. All
features work the same way where the provider allows it. This spec lists
the places where Microsoft behaves differently and what Tempoloom does there.

## Concepts and inputs

- **Provider**: `google` or `microsoft`, per added account.
- Microsoft access goes through Microsoft Graph. Permissions are in
  `accounts-login-emails-permissions.md` rule 21.
- Outlook support is on all plans in the reference (E-0003).

## Behavior

### General

1. A user can sign up with a Microsoft account, or add one to an existing
   Tempoloom account. Tempoloom suggests adding it to the existing account
   instead of creating a second Tempoloom account (E-0211, E-0094).
2. Planning features (tasks, habits, focus time, flexible meetings, booking
   links, buffers, mirroring) work on Microsoft calendars with the same
   rules as on Google, except as listed below (E-0211, E-0033).
3. Mirroring works across providers in both directions: Google to Microsoft
   and Microsoft to Google (E-0053).
4. Managed events on Microsoft are normal Outlook events with free/busy,
   categories and, for meetings, Teams links (E-0033).

### Differences from Google

5. Event tags in the response note: Microsoft sends the response note only
   to the organizer and does not keep it on the attendee's event. So
   Tempoloom reads event tags on Microsoft events only from the title and the
   description, not from the response note (E-0211, E-0203).
6. Update emails for flexible meetings: Microsoft has no way to mute update
   emails for one event change. When Tempoloom moves a flexible meeting on
   Microsoft, attendees can get an update email for each move. Organizers do
   not see them (E-0211). The flexible meeting settings show this warning
   for Microsoft organizers. Proposed.
7. Free/busy of attendees who do not use Tempoloom: the Microsoft schedule
   API returns less detail. Flexible meetings and booking links with such
   attendees can use slightly wrong free/busy data (E-0211). Proposed:
   Tempoloom treats every interval that Microsoft marks as anything other
   than free as busy for such attendees.
8. Teams links on Microsoft 365 Family: a Microsoft API defect stops Teams
   from being added as the conferencing option for those accounts (E-0211).
   Tempoloom hides the Teams option for them and explains why. Proposed.
9. Colors of external events: Tempoloom does not write colors or categories
   back to external events on Microsoft calendars. It shows them only in the
   Planner (E-0211).
10. Colors of managed events: Tempoloom maps each of its event colors to the
    closest Outlook category color. The matched category can be a custom
    category of the user (E-0211). Proposed: Tempoloom creates its own
    categories with fixed names, one per color, so it never reuses a user's
    custom category.
11. Reminders on task events: on Google, task events use the calendar's
    default reminders. On Microsoft, the API cannot read the default, so task
    events get a single reminder at start minus 15 minutes (E-0211). Proposed:
    a user setting for this reminder on Microsoft (the reference plans one).
12. Focus-time event type: Google's native focus-time event type is not used
    for accounts that have Microsoft calendars (E-0211).

### Not supported in the reference

13. Outlook calendars of other mailboxes (delegate or shared mailbox access): the help page
    says not yet supported; the marketing page says supported (E-0211,
    E-0033). See open questions.
14. Hosted or on-premises Exchange: not supported. Sign-up and add-account
    with such an account fail with a clear message (E-0211).
15. Chat and status integration for Microsoft Teams, and a Microsoft To Do
    (Outlook Tasks) integration: not available. Teams works only as a
    conferencing option (E-0211).
16. The Google Calendar add-on can wrongly report a Google to Microsoft
    mirrored event as broken; its repair action does nothing for it
    (E-0211). Tempoloom's own repair check must handle cross-provider
    copies.

### Admin approval

17. When a Microsoft 365 tenant needs admin approval, Tempoloom shows the
    help page in `accounts-login-emails-permissions.md` rule 22 (E-0220).

## Outputs

- Microsoft events created and updated through Microsoft Graph.
- Warnings in the forms for flexible meetings (rule 6) and Teams on Family
  accounts (rule 8).
- Error messages for Exchange on-premises (rule 14).

## Edge cases

1. A user with a Google main email and a Microsoft secondary email:
   mirroring between them follows `sync-calendar-mirroring.md` with no
   change.
2. An event tag placed only in a Microsoft response note: no effect
   (rule 5).
3. A managed event color with no close Outlook category: Proposed: use the
   Tempoloom category of that color (rule 10).
4. A Microsoft account with a mailbox on a hosted Exchange server: rule 14.

## Observed API shapes

Not yet observed.

## Open questions

1. Are delegated and shared Outlook calendars supported now (rule 13)?
2. Does the reference still map colors to the user's custom categories, or
   does it create its own?
3. Is there now a user setting for task reminders on Microsoft?
4. Do mirrored copies on Microsoft have reminders turned off, given that
   created events otherwise get a 15-minute reminder?
5. Is the Microsoft response note limit still in place?

## Acceptance tests

These scenarios need one Microsoft 365 test account (O1) in addition to the
Google test account G1. "Reload check" means reload the web app and read the
events again from both provider APIs.

### AT-1 Cross-provider mirroring

1. Setup: G1 main. O1 added. Policy O1 primary to G1 primary, label only,
   personal type.
2. Action: in Outlook, create "Doctor" tomorrow 10:00 to 11:00, busy.
3. Expected: within 2 minutes, the G1 primary calendar has "Personal
   commitment" 10:00 to 11:00, busy.
4. Reload check: the copy is still there once after reload.

### AT-2 Task reminder on Microsoft

1. Setup: O1 is the main email of a second Tempoloom user.
2. Action: create a 1-hour task.
3. Expected: the Outlook task event has one reminder, set to 15 minutes.
4. Reload check: the reminder stays after reload.

### AT-3 Tag in response note has no effect on Microsoft

1. Setup: O1 is the main email of Tempoloom user U5. U5 work hours
   tomorrow are 14:00 to 16:00 only. G1 invites O1 to "Planning" tomorrow
   14:00 to 15:00.
2. Action: O1 accepts with the response note `#tl_free`. Then U5 creates a
   1-hour task due at the end of tomorrow.
3. Expected: the tag has no effect. "Planning" stays busy for the
   scheduler, so the task chunk is placed 15:00 to 16:00, not 14:00 to
   15:00.
4. Reload check: same placement after reload.

### AT-4 Managed event colors use Tempoloom categories

1. Setup: O1 main. A habit with a set color.
2. Action: let Tempoloom place the habit events.
3. Expected: each habit event on Outlook has exactly one category, and it
   is a Tempoloom category for that color (Proposed rule 10).
4. Reload check: the category stays after reload.
