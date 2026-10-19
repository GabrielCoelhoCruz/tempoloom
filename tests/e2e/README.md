# End-to-end tests

The E2E tests are the main proof that a feature works. Playwright drives the
real UI in Chrome; the real API and scheduler write to a real calendar; each
test checks the calendar, a page reload and, where it matters, a server
restart.

## Backends

- `caldav` (default): a Radicale CalDAV server in Docker on `127.0.0.1:5232`.
  The test fixture starts it with empty storage and local test users, and
  removes it at the end. Users `e2e` and `e2e2` to `e2e6` act as team
  members; `e2e2` may change events in `e2e`'s calendars named `shared-*` and
  `e2e3` may only read them (a shared team calendar); `e2egrant` reads every
  user's calendars (an organization's calendar access). Nothing to set up
  besides Docker.
- `google`: Google Calendar through either a Google user with OAuth or a
  service account. All tests share the calendar `[tl-test] tempoloom-e2e`.
  The driver creates it with a marker description and deletes its events
  before each test. It empties only a calendar with that name and marker that
  the account itself created (Google's `dataOwner` is the account's email; an
  owner role alone is not enough, because a calendar that another account
  shares with "manage sharing" also gives it). It stops if such a calendar
  comes from another account, or if it finds two. Run one suite per Google account
  at a time: two runs empty each other's calendar. Tests that need several
  users, extra calendars, or incoming invitations skip on this backend (the
  driver skips the test when it asks for an extra calendar or an invitation).
  A service account cannot invite guests; tests that add guests skip with it.

## Other loopback servers

The fixtures also start these in Docker, on `127.0.0.1` only, and remove them
at the end:

- Mailpit (`scripts/mail-server.sh`): receives the mail the server sends, for
  example team invitations; tests read it through Mailpit's HTTP API.
- Dex (`scripts/oidc-server.sh`): an OpenID Connect identity provider for the
  single sign-on tests, with a test user whose password is new on each run.
  It needs `mkpasswd` (package `whois`) or `htpasswd` (package
  `apache2-utils`) to hash that password.

Ports and container names come from environment variables, so several runs
can share a host: `TEMPOLOOM_E2E_PORT`, `TEMPOLOOM_CALDAV_PORT`,
`TEMPOLOOM_CALDAV_CONTAINER`, `TEMPOLOOM_E2E_STATE`, `TEMPOLOOM_MAIL_CONTAINER`,
`TEMPOLOOM_MAIL_SMTP_PORT`, `TEMPOLOOM_MAIL_HTTP_PORT`, `TEMPOLOOM_OIDC_PORT`,
`TEMPOLOOM_OIDC_CONTAINER`.

## Run on CalDAV

```bash
npm ci
scripts/e2e-run.sh            # builds, runs all tests, writes .e2e/run.md
scripts/e2e-run.sh tests/e2e/meetings.spec.ts   # one file
```

Set `TEMPOLOOM_E2E_KEEP_CALDAV=1` to keep the Radicale container between runs.
Stop it with `scripts/caldav-server.sh stop`.

## Run on Google Calendar with a service account

1. Create a Google Cloud project and enable the Google Calendar API.
2. Create a service account in that project and a JSON key for it.
3. Store the key in 1Password, vault `tempoloom-e2e`, item
   `google-service-account`, as the file field `key.json`.
4. Create a 1Password service account with read-only access to that vault.
5. Save its token to `~/.config/op/tempoloom.token` with mode 600.
6. Run `scripts/e2e-google.sh`.

The key exists only in the test process environment (`op run`); the
repository holds only the reference in `tests/e2e/google.env.tpl`.

## Run on Google Calendar with OAuth

Use a dedicated Google test account. OAuth runs the suite as that user and
supports guest invitations. The same test calendar is reused on each run.

1. Enable the Google Calendar API in a Google Cloud project.
2. Configure the OAuth consent screen and add the test account as a test user.
3. Create a web OAuth client with the redirect URI
   `http://127.0.0.1:8798/auth/google/callback`.
4. Store the downloaded client JSON in 1Password, vault `tempoloom-e2e`, item
   `google-oauth-client`, field `client.json`. Store the test account's email
   in the same item, field `test-account-email` (or put the address in
   `tests/e2e/google-oauth.env.tpl` as `GOOGLE_TEST_ACCOUNT_EMAIL`).
5. Give the read-only 1Password service account access to that item. Save its
   token as described in the service account setup above.
6. Run the command below.
7. Open the printed loopback URL in a browser that can reach the callback port.
   Sign in as the test user and approve all requested access once for that run.
   The helper stops if another Google account approves, if Google has not
   verified the account's email, or if nobody approves within 10 minutes.

```bash
TEMPOLOOM_E2E_GOOGLE_AUTH=oauth scripts/e2e-google.sh
```

The suite starts after approval. `scripts/google-oauth-login.ts` passes the
refresh token to the test command through `GOOGLE_REFRESH_TOKEN` in its
process environment. The helper does not print the token or save a token file,
and it revokes the token when the command exits, also after a failure.
The fixtures give the token only to the operator command
`connect-google-oauth`, which checks it with Google, reads the account from
the ID token, and stores it encrypted in the test database, as a browser
sign-in does. The fixtures stop if `GOOGLE_REFRESH_TOKEN` is set without
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` or `GOOGLE_TEST_ACCOUNT_EMAIL`.

To change the callback port, set `GOOGLE_OAUTH_LOGIN_PORT` and register the
matching redirect URI on the OAuth client. `TEMPOLOOM_E2E_ENV_TEMPLATE` can
select another environment template. The default OAuth template is
`tests/e2e/google-oauth.env.tpl`.

Without either OAuth credentials or a service account key,
`TEMPOLOOM_E2E_BACKEND=google` fails with
`No Google credentials; run scripts/e2e-google.sh`.

## Artifacts

- `.e2e/report/` HTML report with page screenshots per test
- `.e2e/results.json` machine-readable results
- `.e2e/test-results/` screenshots and the server log of failed tests
- `.e2e/radicale.log` CalDAV server log (no secrets)
- `.e2e/run.md` written by `scripts/e2e-run.sh`: commands, branch, HEAD,
  dirty paths and the result summary

Traces and videos are off: they can contain session tokens.
