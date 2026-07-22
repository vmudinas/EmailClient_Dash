#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(dirname "$SCRIPT_DIR")
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
ENV_FILE=${ARCHIVE_MAIL_ENV_FILE:-"$DEPLOY_DIR/.env"}

if [ ! -f "$ENV_FILE" ]; then
  cp "$DEPLOY_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE"
  echo "Edit its paths, UID/GID, public URL, and optional credentials, then run this command again."
  exit 2
fi

set -a
. "$ENV_FILE"
set +a

: "${ARCHIVE_MAIL_DATA_DIR:?Set ARCHIVE_MAIL_DATA_DIR in $ENV_FILE}"
: "${ARCHIVE_MAIL_POSTGRES_DIR:?Set ARCHIVE_MAIL_POSTGRES_DIR in $ENV_FILE}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in $ENV_FILE}"
case "$ARCHIVE_MAIL_DATA_DIR" in
  /) echo "ARCHIVE_MAIL_DATA_DIR cannot be /" >&2; exit 1 ;;
esac

mkdir -p "$ARCHIVE_MAIL_DATA_DIR" "$ARCHIVE_MAIL_POSTGRES_DIR"
permission_probe="$ARCHIVE_MAIL_DATA_DIR/.archive-mail-write-test-$$"
if ! (umask 077 && : > "$permission_probe") 2>/dev/null; then
  echo "Cannot write to $ARCHIVE_MAIL_DATA_DIR. Fix ownership for UID ${ARCHIVE_MAIL_UID:-1000} and GID ${ARCHIVE_MAIL_GID:-1000}." >&2
  exit 1
fi
rm -f "$permission_probe"

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required." >&2
  exit 1
fi

docker info >/dev/null

compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build --pull archive-mail postgres-migrate
if [ ! -f "$ARCHIVE_MAIL_DATA_DIR/postgres-cutover.complete" ]; then
  echo "Stopping Archive Mail for the one-time PostgreSQL cutover snapshot..."
  compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop -t 120 archive-mail >/dev/null 2>&1 || true
fi
compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans postgres archive-mail

container_id=$(compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q archive-mail)
if [ -z "$container_id" ]; then
  echo "Archive Mail container was not created." >&2
  exit 1
fi

attempt=0
while [ "$attempt" -lt 90 ]; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")
  case "$status" in
    healthy)
      health_payload=$(docker exec "$container_id" curl --fail --silent http://127.0.0.1:3001/api/health)
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
      compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=100 archive-mail
      echo "Archive Mail failed health checks with status: $status" >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=100 archive-mail
echo "Timed out waiting for Archive Mail to become healthy." >&2
exit 1
