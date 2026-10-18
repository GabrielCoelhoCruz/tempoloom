#!/usr/bin/env bash
# Starts or stops a Radicale CalDAV server in Docker for E2E tests. It listens
# on 127.0.0.1 only and starts with empty storage. Each start creates local
# test users with random passwords; the passwords are fixtures for this
# loopback server only, stored with mode 600 in the state directory. Storage
# is a named Docker volume that this script creates and removes.
#
# Users: e2e and e2e2 to e2e6 own their calendars. e2e2 may change events in
# e2e's calendars named "shared-*", e2e3 may only read them (a shared team
# calendar). e2egrant reads every user's calendars (an organization grant).
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
EXTRA_USERS="2 3 4 5 6"

case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
    rm -rf "$STATE"
    mkdir -p "$STATE/config"
    chmod 700 "$STATE"
    umask 077
    newpass() { head -c 24 /dev/urandom | base64 | tr -d '/+='; }
    password=$(newpass)
    printf '%s\n' "$password" > "$STATE/password"
    printf '%s:%s\n' "$USER_NAME" "$password" > "$STATE/config/users"
    for n in $EXTRA_USERS grant; do
      p=$(newpass)
      printf '%s\n' "$p" > "$STATE/password$n"
      printf '%s%s:%s\n' "$USER_NAME" "$n" "$p" >> "$STATE/config/users"
    done
    chmod 644 "$STATE/config/users"
    cat > "$STATE/config/config" <<CONF
[server]
hosts = 0.0.0.0:5232
[auth]
type = htpasswd
htpasswd_filename = /config/users
htpasswd_encryption = plain
[rights]
type = from_file
file = /config/rights
[storage]
filesystem_folder = /data/collections
[logging]
level = warning
CONF
    # The first section that matches both user and collection decides.
    cat > "$STATE/config/rights" <<RIGHTS
[root]
user: .+
collection:
permissions: R

[principal]
user: .+
collection: {user}
permissions: RW

[calendars]
user: .+
collection: {user}/[^/]+
permissions: rw

[shared-write]
user: ${USER_NAME}2
collection: ${USER_NAME}/shared-[^/]+
permissions: rw

[shared-read]
user: ${USER_NAME}3
collection: ${USER_NAME}/shared-[^/]+
permissions: r

[grant-principals]
user: ${USER_NAME}grant
collection: [^/]+
permissions: R

[grant-calendars]
user: ${USER_NAME}grant
collection: [^/]+/[^/]+
permissions: r
RIGHTS
    chmod 755 "$STATE/config"; chmod 644 "$STATE/config/config" "$STATE/config/rights"
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
    for n in $EXTRA_USERS grant; do
      echo "CALDAV_USERNAME$n=$USER_NAME$n"
      echo "CALDAV_PASSWORD$n=$(cat "$STATE/password$n")"
    done
    ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
