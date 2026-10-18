#!/usr/bin/env bash
# Runs the E2E suite against Google Calendar with a service account that owns
# its own test calendars. The key comes from 1Password (read-only service
# account, vault tempoloom-e2e) and exists only in the test process environment.
#
#   scripts/e2e-google.sh [playwright args]
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_FILE="${TEMPOLOOM_OP_TOKEN_FILE:-$HOME/.config/op/tempoloom.token}"
OP="${OP:-$HOME/.local/bin/op}"
TEMPLATE="${TEMPOLOOM_E2E_ENV_TEMPLATE:-tests/e2e/google.env.tpl}"
[ -s "$TOKEN_FILE" ] || { echo "missing 1Password token: $TOKEN_FILE" >&2; exit 3; }
export OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
# Check that the key resolves to a service account key, without printing it.
"$OP" run --env-file="$TEMPLATE" -- sh -c 'printf %s "$GOOGLE_SERVICE_ACCOUNT_JSON" | node -e "
  let s = \"\"; process.stdin.on(\"data\", (d) => (s += d)).on(\"end\", () => {
    const k = JSON.parse(s); if (k.type !== \"service_account\" || !k.client_email) process.exit(4);
  });"' || { echo "google-service-account item missing or not a service account key" >&2; exit 4; }
npm run build >/dev/null
TEMPOLOOM_E2E_BACKEND=google "$OP" run --env-file="$TEMPLATE" -- npx playwright test "$@"
