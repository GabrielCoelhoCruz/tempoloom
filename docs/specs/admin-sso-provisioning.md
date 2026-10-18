# Single sign-on, directory provisioning and organization rollout

Spec id: SPEC-ADMIN-01
Evidence: E-0178 (ev_9e3af3dd95d8), E-0179 (ev_78fc13d6cb03), E-0169 (ev_76c7d3032b39), E-0204 (ev_a6b827c95304), E-0003 (ev_fdf25af08b9c), E-0014 (ev_6d4b05eba664), E-0182 (ev_80185208c432)
Status of evidence: public docs only

## Summary

Large organizations can sign users in through their own identity provider,
create and update users from their directory, and give Tempoloom access to
every employee's calendar at once. Users then appear in the right team
with attributes such as department and manager, often before they
ever sign in. Those attributes drive analytics filters and team policies.
This spec is an overview. In the reference, these features are in the
enterprise tier.

## Concepts and inputs

### Sign-in methods

| Method | Who uses it | Notes |
|---|---|---|
| Google OAuth | Users whose main calendar is Google | Default sign-in. |
| Microsoft OAuth | Users whose main calendar is Microsoft 365 | Default sign-in. |
| Single sign-on (SSO) through an external identity provider | Enterprise teams | OIDC. See open question 1 about SAML. Google and Microsoft calendar users can both use it. |

### SSO configuration (per team)

| Field | Type | Default | Notes |
|---|---|---|---|
| `domains` | list of email domains | required | Each domain is registered on its own. Secondary domains and domains used by contractors count too. |
| `issuer` | URL | required | Identity provider (proposal; standard OIDC field). |
| `client_id` | text | required | |
| `client_secret` | secret | required | |
| `mode` | enum `sso_only`, `sso_and_google` | `sso_only` | See rules 3 to 5. |
| `domain_capture` | boolean | false (proposal) | See rule 9. |

### Directory provisioning (SCIM 2.0)

| Field | Type | Notes |
|---|---|---|
| SCIM endpoint | URL on the instance | |
| API token | secret | Bearer token the identity provider uses. |
| Attributes read | see list | |

Attributes read:

- Standard: `userName`, `name`, `displayName`, `title`, `userType`,
  `emails`, `active`.
- Enterprise extension: `employeeNumber`, `costCenter`, `organization`,
  `division`, `department`, `manager`.
- Product extension (a Tempoloom SCIM schema extension): `location`,
  `hireDate`, `jobCategory`, `orgRole`, `workGroup`.
- Custom attributes: any other attribute. Each one becomes an analytics
  filter.

### Organization-wide calendar grant

| Platform | Mechanism | Scopes |
|---|---|---|
| Google Workspace | Service account with domain-wide delegation. A super admin adds the Tempoloom client ID in Admin console, Security, Access and data control, API controls, Manage domain-wide delegation. | Minimum: `calendar`, `userinfo.profile`, `userinfo.email`, `openid`. Recommended, adds tasks, contacts and directory: `tasks`, `contacts.readonly`, `contacts.other.readonly`, `directory.readonly`, `admin.directory.resource.calendar.readonly`. |
| Microsoft 365 | Tenant-wide admin consent; calendars through Microsoft Graph. | Open question. |

The client ID is the Tempoloom instance's own Google client, not the
reference's.

## Behavior

### Sign-in

1. Without SSO, users sign in with Google OAuth or Microsoft OAuth.
2. SSO is enabled per team. One team in an organization can use SSO while
   other people at the same company keep signing up the normal way.
3. `sso_only`: a user whose email domain is in `domains` can sign in only
   through the identity provider. The Google and Microsoft buttons refuse
   that user with a message that points to SSO.
4. `sso_and_google`: the identity provider and Google sign-in both work for
   the team. Uses: a team that tests SSO alone; consultants whose main
   email is not on the company domain but whose calendar is; users who want
   a personal Gmail login.
5. `sso_only` is the default for a new SSO configuration.

### Provisioning

6. A SCIM create request makes a user in the enterprise team with the sent
   attributes. The user does not need to sign in first.
7. A SCIM update request changes the stored attributes. Analytics filters
   and team policy scopes use the new values on their next evaluation.
8. The manager attribute builds the reporting tree. Without it, the system
   cannot group by manager line.
9. With `domain_capture` on, any person whose sign-up email is on a
   registered domain joins the enterprise team at once, instead of getting a
   separate team. Without it, people who signed up on their own stay in
   their own teams and out of team analytics.
10. The system creates users from a large import at a paced rate, not all
    at once. Users appear over time.
11. There is no dry-run mode. Admins test with a few users first.

### Calendar grant

12. With the Google grant in place, the system attaches each provisioned
    user's primary calendar during provisioning, with no user action.
13. With the Microsoft grant in place, the system attaches calendars
    the same way, through Microsoft Graph.
14. When the grant is missing or lacks a scope, provisioning still
    succeeds. The user exists with attributes but no calendar. That user
    connects a calendar on their first sign-in, and adds no analytics data
    until then.
15. The system cannot tell "grant not given yet" from "grant refused". The
    admin view shows "no calendar attached" in both cases (proposal).

### Seats and freshness

16. A provisioned user who never signed in does not use a seat. The seat is
    used at first sign-in.
17. For provisioned users who never signed in, the system refreshes calendar
    data once every 24 hours. After first sign-in, it processes their
    calendar in real time.

### Admin API

18. A team admin can use the Tempoloom API, with the calendar grant, to
    provision users and calendars. Only team admins can use it.

## Outputs

- Users created and updated in the enterprise team from the directory.
- Calendars attached without user action (with the grant).
- Sign-in page that routes captured domains to SSO.
- Admin view per user: attributes received, calendar attached yes or no,
  signed in yes or no, seat used yes or no (proposal).
- No calendar events change during provisioning. The scheduler acts on a
  user only after first sign-in (proposal).

## Edge cases

1. SCIM sends `active = false`: proposed, the user loses sign-in, stops all
   scheduling, frees their seat, and leaves analytics from that date.
2. SCIM deletes a user: proposed, same as rule above plus account deletion
   after 30 days.
3. A domain is missing from `domains`: users on it are not captured and stay
   outside the team.
4. A user signs up before domain capture is turned on: proposed, an admin
   can move them into the enterprise team; data stays.
5. Two identity providers for one domain: not supported (proposal).
6. A date attribute sent as free text: store as text; show the raw value.

## Observed API shapes

Not yet observed.

## Open questions

1. SAML: one page says SSO uses OIDC only; a newer setup guide says SAML or
   OIDC. Which is current? Proposed: OIDC first, SAML later.
2. Which Microsoft Graph permissions does the tenant consent need?
3. What does the scheduler do for a provisioned user who never signed in?
   Proposed: nothing; analytics only.
4. What happens on SCIM deactivation and deletion?
5. What is the API for admin provisioning, and how is it authorized?
6. Does Tempoloom need the product SCIM extension, or only custom
   attributes?

## Acceptance tests

Common setup: Google Workspace test domain `corp.test`. A test OIDC
identity provider (for example a Keycloak test realm) with users for
`corp.test`. A Tempoloom instance with an enterprise team T; admin A.

### T1. SSO-only sign-in

- Setup: common setup. A enables SSO for T with `domains = [corp.test]`,
  `mode = sso_only`.
- Action: user U (`u@corp.test`) tries Google sign-in, then SSO sign-in.
- Expected calendar state: after SSO sign-in and calendar connection, U's
  Google calendar is unchanged until U creates an item.
- Reload check: Google sign-in is refused with a message that points to
  SSO. After SSO sign-in, a reload keeps U signed in as a member of T.

### T2. SSO plus Google

- Setup: T1 setup, then A sets `mode = sso_and_google`.
- Action: U signs out and signs in with Google.
- Expected calendar state: no change.
- Reload check: U lands in team T after reload.

### T3. Provision with attributes, no seat until sign-in

- Setup: common setup with SCIM configured; the Google domain-wide grant
  in place with the minimum scopes.
- Action: the identity provider pushes user V with `department = Finance`
  and `manager = A`. V does not sign in.
- Expected calendar state: V's Google calendar gets no managed events.
- Reload check: after reload, T's admin view lists V with department
  Finance, calendar attached yes, signed in no, seat used no. Analytics
  filters include `department`.

### T4. Missing grant

- Setup: common setup with SCIM but without the domain-wide grant.
- Action: push user W.
- Expected calendar state: no change on W's calendar.
- Reload check: the admin view lists W with calendar attached no.

### T5. Domain capture

- Setup: common setup, `domain_capture = true`, `mode = sso_and_google`.
- Action: a new person X (`x@corp.test`) signs up with Google.
- Expected calendar state: no change.
- Reload check: after reload, X is a member of T, not of a new team.
