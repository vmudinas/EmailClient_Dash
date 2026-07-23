#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this script as root from Synology DSM Task Scheduler." >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(dirname "$SCRIPT_DIR")
if [ ! -f "$DEPLOY_DIR/compose.yaml" ]; then
  # Running from the root-owned copy outside the app tree (the passwordless-sudo
  # setup in deploy/README.md); fall back to the standard NAS layout.
  DEPLOY_DIR=/volume1/docker/archive-mail/app/deploy
fi
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

RESOLVED_DOCKER_BIN="$DOCKER_BIN"
set -a
. "$ENV_FILE"
set +a
# .env configures the app, not this script — never let a user-writable file
# redirect which binary this root script executes.
DOCKER_BIN="$RESOLVED_DOCKER_BIN"

case "${EMAIL_CLIENT_PUBLIC_URL:-}" in
  https://*.*) ;;
  "")
    echo "WARNING: EMAIL_CLIENT_PUBLIC_URL is empty. Google OAuth from another computer will not work until an HTTPS public URL is configured." >&2
    ;;
  *)
    echo "WARNING: EMAIL_CLIENT_PUBLIC_URL must be an HTTPS domain for Google OAuth; '${EMAIL_CLIENT_PUBLIC_URL}' will be rejected by Google." >&2
    ;;
esac

compose() {
  "$DOCKER_BIN" compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "Building a fresh Archive Mail image without cache..."
compose build --no-cache archive-mail postgres-migrate

echo "Removing the stale container and project network..."
compose down --remove-orphans

echo "Creating the container from the fresh image and current environment..."
mkdir -p "$ARCHIVE_MAIL_DATA_DIR" "$ARCHIVE_MAIL_POSTGRES_DIR"
compose up -d --force-recreate postgres archive-mail

container_id=$(compose ps -q archive-mail)
if [ -z "$container_id" ]; then
  echo "Archive Mail container was not created." >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 90 ]; do
  health=$("$DOCKER_BIN" inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container_id")
  case "$health" in
    healthy)
      health_payload=$("$DOCKER_BIN" exec "$container_id" curl --fail --silent http://127.0.0.1:3001/api/health)
      case "$health_payload" in
        *'"api":"csharp"'*'"database":"postgresql"'*) ;;
        *)
        echo "Archive Mail is healthy but is not the C# PostgreSQL service: ${health_payload:-unknown}" >&2
        exit 1
        ;;
      esac
      if [ -n "${EMAIL_CLIENT_PUBLIC_URL:-}" ]; then
        echo "Archive Mail is healthy at $EMAIL_CLIENT_PUBLIC_URL"
      else
        echo "Archive Mail is healthy on host port ${ARCHIVE_MAIL_PORT:-3001}."
      fi
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
