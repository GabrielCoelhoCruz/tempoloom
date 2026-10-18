#!/usr/bin/env bash
# Starts or stops a headed Chrome (under Xvfb) with a persistent profile and a
# DevTools port bound to 127.0.0.1. A person signs in to the Google test
# account once; E2E tests then attach to this browser over CDP.
#
#   scripts/login-browser.sh start   # prints the CDP endpoint
#   scripts/login-browser.sh stop    # stops only the processes this script started
#   scripts/login-browser.sh status
set -euo pipefail
STATE="${TEMPOLOOM_E2E_STATE:-$HOME/.local/state/tempoloom}"
PROFILE="$STATE/e2e-chrome-profile"
PORT="${TEMPOLOOM_E2E_CDP_PORT:-9333}"
DISPLAY_NUM="${TEMPOLOOM_E2E_DISPLAY:-:93}"
PIDS="$STATE/login-browser.pids"
CHROME="${CHROME:-/usr/bin/google-chrome}"
mkdir -p "$STATE" "$PROFILE"

running() { [ -s "$PIDS" ] && while read -r pid; do kill -0 "$pid" 2>/dev/null || return 1; done < "$PIDS"; }

case "${1:-}" in
  start)
    if running; then echo "already running: http://127.0.0.1:$PORT"; exit 0; fi
    Xvfb "$DISPLAY_NUM" -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
    xvfb_pid=$!
    sleep 1
    DISPLAY="$DISPLAY_NUM" "$CHROME" \
      --user-data-dir="$PROFILE" \
      --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
      --no-first-run --no-default-browser-check --password-store=basic \
      --window-size=1440,900 about:blank >/dev/null 2>&1 &
    chrome_pid=$!
    printf '%s\n%s\n' "$xvfb_pid" "$chrome_pid" > "$PIDS"
    for _ in $(seq 1 50); do
      curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
      sleep 0.2
    done
    curl -fs "http://127.0.0.1:$PORT/json/version" >/dev/null || { echo "Chrome did not open its DevTools port" >&2; exit 1; }
    echo "running: http://127.0.0.1:$PORT (xvfb $xvfb_pid, chrome $chrome_pid)"
    ;;
  stop)
    if [ -s "$PIDS" ]; then
      tac "$PIDS" | while read -r pid; do kill "$pid" 2>/dev/null || true; done
      rm -f "$PIDS"
    fi
    echo stopped
    ;;
  status)
    if running; then echo "running: http://127.0.0.1:$PORT pids $(paste -sd' ' "$PIDS")"; else echo "not running"; fi
    ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
