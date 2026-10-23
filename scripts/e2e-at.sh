#!/usr/bin/env bash
# Runs the E2E suite as if the real time were another moment (test tool):
#   scripts/e2e-at.sh "2026-10-22 23:50" [playwright args]
# The time is Europe/Berlin local time. The test runner, the server and the
# browser see a clock that starts there and then runs at normal speed
# (tests/e2e/shift-clock.mjs). Containers keep the real time, so two specs
# fail with a moved clock: sso.spec.ts when the clock is before the real time or
# more than a day after it (the server refuses the Dex container's ID tokens),
# and self-host.spec.ts when it is ahead (the app in the Docker image plans
# from the real time).
set -euo pipefail
cd "$(dirname "$0")/.."
target=$(TZ=Europe/Berlin date -d "$1" +%s%3N)
shift
export TEMPOLOOM_E2E_SHIFT_MS=$((target - $(date +%s%3N)))
export NODE_OPTIONS="--import=$PWD/tests/e2e/shift-clock.mjs"
exec npx playwright test "$@"
