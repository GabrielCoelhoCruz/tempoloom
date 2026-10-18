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
- `google`: Google Calendar through a service account that owns a fresh test
  calendar for each test. Tests that need two calendars, invitations or a
  second user skip themselves on this backend.

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

## Run on Google Calendar (one-time setup)

1. Create a Google Cloud project and enable the Google Calendar API.
2. Create a service account in that project and a JSON key for it.
3. Store the key in 1Password, vault `tempoloom-e2e`, item
   `google-service-account`, as the file field `key.json`.
4. Create a 1Password service account with read-only access to that vault.
5. Save its token to `~/.config/op/tempoloom.token` with mode 600.
6. Run `scripts/e2e-google.sh`.

The key exists only in the test process environment (`op run`); the
repository holds only the reference in `tests/e2e/google.env.tpl`.

## Artifacts

- `.e2e/report/` HTML report with page screenshots per test
- `.e2e/results.json` machine-readable results
- `.e2e/test-results/` screenshots and the server log of failed tests
- `.e2e/radicale.log` CalDAV server log (no secrets)
- `.e2e/run.md` written by `scripts/e2e-run.sh`: commands, branch, HEAD,
  dirty paths and the result summary

Traces and videos are off: they can contain session tokens.
