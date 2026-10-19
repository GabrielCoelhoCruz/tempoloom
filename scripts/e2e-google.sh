#!/usr/bin/env bash
# Runs the E2E suite against Google Calendar. Secrets come from 1Password
# (read-only service account, vault tempoloom-e2e) and exist only in the test
# process environment.
#
#   scripts/e2e-google.sh [playwright args]
#     A service account with its own test calendar. It cannot invite guests.
#   TEMPOLOOM_E2E_GOOGLE_AUTH=oauth scripts/e2e-google.sh [playwright args]
#     A Google user: a person approves the access once per run in a browser
#     (scripts/google-oauth-login.ts), then the suite runs on that account.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_FILE="${TEMPOLOOM_OP_TOKEN_FILE:-$HOME/.config/op/tempoloom.token}"
OP="${OP:-$HOME/.local/bin/op}"
[ -s "$TOKEN_FILE" ] || { echo "missing 1Password token: $TOKEN_FILE" >&2; exit 3; }
export OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
if [ "${TEMPOLOOM_E2E_GOOGLE_AUTH:-}" = oauth ]; then
  TEMPLATE="${TEMPOLOOM_E2E_ENV_TEMPLATE:-tests/e2e/google-oauth.env.tpl}"
  npm run build >/dev/null
  TEMPOLOOM_E2E_BACKEND=google exec "$OP" run --env-file="$TEMPLATE" -- \
    node scripts/google-oauth-login.ts -- npx playwright test "$@"
fi
TEMPLATE="${TEMPOLOOM_E2E_ENV_TEMPLATE:-tests/e2e/google.env.tpl}"
# Check that the key resolves to a service account key, without printing it.
"$OP" run --env-file="$TEMPLATE" -- sh -c 'printf %s "$GOOGLE_SERVICE_ACCOUNT_JSON" | node -e "
  let s = \"\"; process.stdin.on(\"data\", (d) => (s += d)).on(\"end\", () => {
    const k = JSON.parse(s); if (k.type !== \"service_account\" || !k.client_email) process.exit(4);
  });"' || { echo "google-service-account item missing or not a service account key" >&2; exit 4; }
npm run build >/dev/null
TEMPOLOOM_E2E_BACKEND=google "$OP" run --env-file="$TEMPLATE" -- npx playwright test "$@"
