#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root from Synology DSM Task Scheduler." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(dirname "$SCRIPT_DIR")
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
ENV_FILE=${ARCHIVE_MAIL_ENV_FILE:-"$DEPLOY_DIR/.env"}
DOCKER_BIN=${DOCKER_BIN:-/usr/local/bin/docker}

if [ ! -x "$DOCKER_BIN" ]; then
  echo "Docker was not found at $DOCKER_BIN." >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE." >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

compose() {
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "Building a fresh Archive Mail image without cache..."
compose build --no-cache archive-mail

echo "Removing the stale container and project network..."
compose down --remove-orphans

echo "Creating the container from the fresh image and current environment..."
compose up -d --force-recreate archive-mail

container_id=$(compose ps -q archive-mail)
if [ -z "$container_id" ]; then
  echo "Archive Mail container was not created." >&2
  exit 1
fi

remote_login=$("$DOCKER_BIN" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" \
  | grep '^EMAIL_CLIENT_ALLOW_REMOTE_LOGIN=' || true)
expected_remote_login="EMAIL_CLIENT_ALLOW_REMOTE_LOGIN=${EMAIL_CLIENT_ALLOW_REMOTE_LOGIN:-false}"
if [ "$remote_login" != "$expected_remote_login" ]; then
  echo "The recreated container has an unexpected remote-login setting." >&2
  echo "Expected: $expected_remote_login" >&2
  echo "Actual: ${remote_login:-missing}" >&2
  exit 1
fi
echo "$remote_login"

attempt=0
while [ "$attempt" -lt 90 ]; do
  health=$("$DOCKER_BIN" inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container_id")
  case "$health" in
    healthy)
      echo "Archive Mail is healthy on host port ${ARCHIVE_MAIL_PORT:-3001}."
      exit 0
      ;;
    unhealthy|exited|dead)
      compose logs --tail=100 archive-mail
      echo "Archive Mail failed with status: $health" >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

compose logs --tail=100 archive-mail
echo "Timed out waiting for Archive Mail to become healthy." >&2
exit 1
