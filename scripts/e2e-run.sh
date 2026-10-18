#!/usr/bin/env bash
# Runs the E2E suite and writes a rerunnable record to .e2e/run.md:
# the exact commands, branch, HEAD, dirty paths, and the result summary.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p .e2e
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
branch=$(git rev-parse --abbrev-ref HEAD)
head=$(git rev-parse HEAD)
dirty=$(git status --porcelain)
npm run build >/dev/null
rm -f .e2e/radicale.log
npx playwright test "$@" 2>&1 | tee .e2e/output.txt
status=${PIPESTATUS[0]}
summary=$(node -e '
  const r = JSON.parse(require("fs").readFileSync(".e2e/results.json", "utf8"));
  const s = r.stats; console.log(`expected=${s.expected} unexpected=${s.unexpected} skipped=${s.skipped} flaky=${s.flaky} duration_ms=${Math.round(s.duration)}`);
' 2>/dev/null || echo "no results.json")
{
  echo "# E2E run"
  echo
  echo "- Started: $started"
  echo "- Branch: $branch"
  echo "- HEAD: $head"
  echo "- Dirty paths: ${dirty:-none}"
  echo "- Node: $(node --version), Playwright: $(npx playwright --version 2>/dev/null)"
  echo "- Exit status: $status"
  echo "- Result: $summary"
  echo
  echo "## Commands"
  echo
  echo '```bash'
  echo "git checkout $head"
  echo "npm ci"
  echo "scripts/e2e-run.sh $*"
  echo '```'
  echo
  echo "Report: .e2e/report/index.html. Screenshots: .e2e/test-results/."
} > .e2e/run.md
exit "$status"
