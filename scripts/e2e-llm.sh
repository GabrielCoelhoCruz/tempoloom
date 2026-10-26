#!/usr/bin/env bash
# Runs the assistant chat E2E tests tagged @llm-real against a real
# OpenAI-compatible endpoint instead of the fake model (tests/e2e/fake-llm.ts).
# The base URL and the key come from 1Password (read-only service account,
# vault tempoloom-e2e) and exist only in the test process environment.
#
#   TEMPOLOOM_LLM_MODEL=claude-haiku-5-5 scripts/e2e-llm.sh [playwright args]
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN_FILE="${TEMPOLOOM_OP_TOKEN_FILE:-$HOME/.config/op/tempoloom.token}"
OP="${OP:-$HOME/.local/bin/op}"
TEMPLATE="${TEMPOLOOM_E2E_LLM_ENV_TEMPLATE:-tests/e2e/llm.env.tpl}"
[ -s "$TOKEN_FILE" ] || { echo "missing 1Password token: $TOKEN_FILE" >&2; exit 3; }
export OP_SERVICE_ACCOUNT_TOKEN="$(cat "$TOKEN_FILE")"
export TEMPOLOOM_LLM_MODEL="${TEMPOLOOM_LLM_MODEL:-claude-haiku-5-5}"
npm run build >/dev/null
# op run masks the secret values in the output of the tests.
TEMPOLOOM_E2E_LLM=real "$OP" run --env-file="$TEMPLATE" -- \
  npx playwright test --grep @llm-real "$@"
