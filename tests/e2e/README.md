# End-to-end tests

The E2E tests are the main proof that a feature works. They run against a
real Google Calendar test account: real OAuth, real events created, moved and
deleted, and checks after a page reload and a server restart.

Never use a personal Google account. Use a throwaway account that holds no
real data.

## One-time setup

1. Create a throwaway Google account.
2. Signed in as that account, create a Google Cloud project and enable the
   Google Calendar API.
3. Configure the OAuth consent screen: user type "External", publishing status
   "Testing", and add the throwaway account as a test user.
4. Create an OAuth client of type "Web application" with these redirect URIs:
   - `http://localhost:8788/auth/google/callback` (E2E server)
   - `http://localhost:8787/auth/google/callback` (development server)
5. Write the client values to `~/.config/tempoloom/e2e.env` (outside the
   repository) and run `chmod 600` on it:

   ```bash
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   E2E_GOOGLE_EMAIL=the-throwaway-account@gmail.com
   ```

6. Start the login browser and sign in to the throwaway account once:

   ```bash
   scripts/login-browser.sh start
   curl -s -X PUT "http://127.0.0.1:9333/json/new?https://accounts.google.com/"
   ```

   The DevTools port listens on `127.0.0.1` only. On a remote host, forward it
   with `ssh -N -L 9333:127.0.0.1:9333 <host>`, open `chrome://inspect` in a
   local Chrome, add `localhost:9333` under "Configure…", click "inspect" on
   the Google tab, and sign in through the live view.

The profile is stored in `~/.local/state/tempoloom/e2e-chrome-profile`. The
browser keeps the Google session, so later runs need no password.

## Run

```bash
scripts/login-browser.sh start   # if it is not running
npm run build
npm run test:e2e
```

Each run starts a fresh server with an empty database on port 8788. The tests
sign in through the real OAuth consent screen, then check the calendar with
the Google Calendar API.

## Artifacts

- `.e2e/report/` HTML report with a page screenshot per test
- `.e2e/results.json` machine-readable results
- `.e2e/run.md` written by `scripts/e2e-run.sh`: commands, branch, HEAD,
  and the result summary

Traces and videos are off: they can contain session tokens.
