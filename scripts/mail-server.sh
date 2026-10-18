#!/usr/bin/env bash
# Starts or stops a Mailpit mail server in Docker for E2E tests: it accepts
# SMTP on 127.0.0.1 and shows the received messages through its HTTP API.
# It keeps messages in memory only; stop removes the container.
#
#   scripts/mail-server.sh start
#   scripts/mail-server.sh stop
#   scripts/mail-server.sh env      # prints SMTP_URL and MAIL_API_URL
set -euo pipefail
NAME="${TEMPOLOOM_MAIL_CONTAINER:-tempoloom-e2e-mail}"
SMTP_PORT="${TEMPOLOOM_MAIL_SMTP_PORT:-1025}"
HTTP_PORT="${TEMPOLOOM_MAIL_HTTP_PORT:-8025}"
IMAGE="${TEMPOLOOM_MAIL_IMAGE:-axllent/mailpit:latest}"

case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" -p "127.0.0.1:$SMTP_PORT:1025" -p "127.0.0.1:$HTTP_PORT:8025" \
      "$IMAGE" >/dev/null
    for _ in $(seq 1 50); do
      curl -sf -o /dev/null "http://127.0.0.1:$HTTP_PORT/api/v1/messages" && break
      sleep 0.2
    done
    echo "running: smtp 127.0.0.1:$SMTP_PORT, api http://127.0.0.1:$HTTP_PORT/ (container $NAME)"
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo stopped
    ;;
  env)
    [ -n "$(docker ps -q --filter "name=^${NAME}$")" ] || { echo "not running; run: $0 start" >&2; exit 1; }
    echo "SMTP_URL=smtp://127.0.0.1:$SMTP_PORT"
    echo "MAIL_API_URL=http://127.0.0.1:$HTTP_PORT/"
    ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
