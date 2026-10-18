#!/usr/bin/env bash
# Starts or stops a Dex OpenID Connect identity provider in Docker for E2E
# tests of single sign-on. It listens on 127.0.0.1 only and keeps its data in
# memory. Each start creates static users on corp.test with random passwords
# and a client secret for Tempoloom; they are fixtures for this loopback server
# only, stored with mode 600 in the state directory.
#
# Users (email = <name>@corp.test): u, v, x, m.
# Client: id "tempoloom", redirect URI
#   http://localhost:$TEMPOLOOM_E2E_PORT/auth/sso/callback (or $TEMPOLOOM_OIDC_REDIRECT_URI).
#
#   scripts/oidc-server.sh start    # prints the issuer
#   scripts/oidc-server.sh stop     # removes only this script's container
#   scripts/oidc-server.sh env      # prints OIDC_* variables for tests
set -euo pipefail
STATE="${TEMPOLOOM_E2E_STATE:-$HOME/.local/state/tempoloom}/oidc"
NAME="${TEMPOLOOM_OIDC_CONTAINER:-tempoloom-e2e-oidc}"
PORT="${TEMPOLOOM_OIDC_PORT:-5556}"
IMAGE="${TEMPOLOOM_OIDC_IMAGE:-ghcr.io/dexidp/dex:latest}"
REDIRECT="${TEMPOLOOM_OIDC_REDIRECT_URI:-http://localhost:${TEMPOLOOM_E2E_PORT:-8788}/auth/sso/callback}"
ISSUER="http://127.0.0.1:$PORT/dex"
USERS="u v x m"
DOMAIN="corp.test"

bcrypt() {
  if command -v mkpasswd >/dev/null; then
    mkpasswd -m bcrypt -R 10 "$1"
  elif command -v htpasswd >/dev/null; then
    htpasswd -nbBC 10 "" "$1" | cut -d: -f2
  else
    echo "needs mkpasswd (package whois) or htpasswd (package apache2-utils)" >&2
    exit 1
  fi
}

case "${1:-}" in
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$STATE"
    mkdir -p "$STATE"
    chmod 700 "$STATE"
    umask 077
    newpass() { head -c 24 /dev/urandom | base64 | tr -d '/+='; }
    newpass > "$STATE/client-secret"
    {
      echo "issuer: $ISSUER"
      echo "storage:"
      echo "  type: memory"
      echo "web:"
      echo "  http: 0.0.0.0:5556"
      echo "oauth2:"
      echo "  skipApprovalScreen: true"
      echo "staticClients:"
      echo "  - id: tempoloom"
      echo "    name: Tempoloom"
      echo "    secret: $(cat "$STATE/client-secret")"
      echo "    redirectURIs:"
      echo "      - $REDIRECT"
      echo "enablePasswordDB: true"
      echo "staticPasswords:"
      for u in $USERS; do
        p=$(newpass)
        printf '%s\n' "$p" > "$STATE/password-$u"
        hash=$(bcrypt "$p")
        echo "  - email: $u@$DOMAIN"
        echo "    hash: '$hash'"
        echo "    username: $u"
        echo "    userID: $(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
      done
    } > "$STATE/config.yaml"
    # Dex reads its config (it holds the client secret, mode 600) as the host user,
    # which is root inside rootless Docker.
    run_as="$(id -u):$(id -g)"
    docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless && run_as=0:0
    docker run -d --name "$NAME" --user "$run_as" -p "127.0.0.1:$PORT:5556" \
      -v "$STATE/config.yaml:/tempoloom/dex.yaml:ro" "$IMAGE" dex serve /tempoloom/dex.yaml >/dev/null
    for _ in $(seq 1 100); do
      curl -sf -o /dev/null "$ISSUER/.well-known/openid-configuration" && break
      sleep 0.2
    done
    curl -sf -o /dev/null "$ISSUER/.well-known/openid-configuration" ||
      { docker logs "$NAME" >&2; echo "Dex did not start" >&2; exit 1; }
    echo "running: $ISSUER (container $NAME)"
    ;;
  stop)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo stopped
    ;;
  env)
    [ -s "$STATE/client-secret" ] && [ -n "$(docker ps -q --filter "name=^${NAME}$")" ] || { echo "not running; run: $0 start" >&2; exit 1; }
    echo "OIDC_ISSUER=$ISSUER"
    echo "OIDC_CLIENT_ID=tempoloom"
    echo "OIDC_CLIENT_SECRET=$(cat "$STATE/client-secret")"
    echo "OIDC_DOMAIN=$DOMAIN"
    for u in $USERS; do
      echo "OIDC_PASSWORD_$u=$(cat "$STATE/password-$u")"
    done
    ;;
  *) echo "usage: $0 start|stop|env" >&2; exit 2 ;;
esac
