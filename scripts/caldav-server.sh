#!/usr/bin/env bash
# Starts or stops a Radicale CalDAV server in Docker for E2E tests. It listens
# on 127.0.0.1 only and starts with empty storage. Each start creates a local
# test user with a random password; the password is a fixture for this
# loopback server only, stored with mode 600 in the state directory. Storage
# is a named Docker volume that this script creates and removes.
#
#   scripts/caldav-server.sh start    # prints URL and user name
#   scripts/caldav-server.sh stop     # removes only this script's container
#   scripts/caldav-server.sh env      # prints CALDAV_* variables for tests
set -euo pipefail
STATE="${TEMPOLOOM_E2E_STATE:-$HOME/.local/state/tempoloom}/radicale"
NAME="${TEMPOLOOM_CALDAV_CONTAINER:-tempoloom-e2e-radicale}"
VOLUME="$NAME-data"
PORT="${TEMPOLOOM_CALDAV_PORT:-5232}"
IMAGE="${TEMPOLOOM_CALDAV_IMAGE:-tomsquest/docker-radicale:latest}"
USER_NAME="e2e"

case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$STATE"
    mkdir -p "$STATE/config"
    chmod 700 "$STATE"
    password=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )
    password2=$(head -c 24 /dev/urandom | base64 | tr -d '/+=' )
    umask 077
    # A second user is a colleague for tests of meetings between two people.
    printf '%s:%s\n%s:%s\n' "$USER_NAME" "$password" "${USER_NAME}2" "$password2" > "$STATE/config/users"
    printf '%s\n' "$password" > "$STATE/password"
    printf '%s\n' "$password2" > "$STATE/password2"
    chmod 644 "$STATE/config/users"
    cat > "$STATE/config/config" <<CONF
[server]
hosts = 0.0.0.0:5232
[auth]
type = htpasswd
htpasswd_filename = /config/users
htpasswd_encryption = plain
[rights]
type = owner_only
[storage]
filesystem_folder = /data/collections
[logging]
level = warning
CONF
    chmod 755 "$STATE/config"; chmod 644 "$STATE/config/config"
    docker run -d --name "$NAME" -p "127.0.0.1:$PORT:5232" \
      -v "$STATE/config:/config:ro" -v "$VOLUME:/data" "$IMAGE" >/dev/null
    for _ in $(seq 1 50); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
      [ "$code" != "000" ] && break
      sleep 0.2
    done
    echo "running: http://127.0.0.1:$PORT/ user $USER_NAME (container $NAME)"
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    echo stopped
    ;;
  env)
    [ -s "$STATE/password" ] && [ -n "$(docker ps -q --filter "name=^${NAME}$")" ] || { echo "not running; run: $0 start" >&2; exit 1; }
    echo "CALDAV_URL=http://127.0.0.1:$PORT/"
    echo "CALDAV_USERNAME=$USER_NAME"
    echo "CALDAV_PASSWORD=$(cat "$STATE/password")"
    echo "CALDAV_USERNAME2=${USER_NAME}2"
    echo "CALDAV_PASSWORD2=$(cat "$STATE/password2")"
    ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
