#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(dirname "$SCRIPT_DIR")
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
ENV_FILE=${ARCHIVE_MAIL_ENV_FILE:-"$DEPLOY_DIR/.env"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy deploy/.env.example first." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required." >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a
: "${ARCHIVE_MAIL_DATA_DIR:?Set ARCHIVE_MAIL_DATA_DIR in $ENV_FILE}"
: "${ARCHIVE_MAIL_POSTGRES_DIR:?Set ARCHIVE_MAIL_POSTGRES_DIR in $ENV_FILE}"
: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in $ENV_FILE}"

if [ ! -f "$ARCHIVE_MAIL_DATA_DIR/archive-mail.sqlite" ]; then
  echo "SQLite database not found: $ARCHIVE_MAIL_DATA_DIR/archive-mail.sqlite" >&2
  exit 1
fi

mkdir -p "$ARCHIVE_MAIL_POSTGRES_DIR"
compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres

attempt=0
until compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_isready -U "${POSTGRES_USER:-archive_mail}" -d "${POSTGRES_DB:-archive_mail}" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PostgreSQL did not become ready." >&2
    exit 1
  fi
  sleep 2
done

container_id=$(compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q archive-mail)
was_running=false
if [ -n "$container_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = "true" ]; then
  was_running=true
  compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop -t 120 archive-mail
fi

restart_if_needed() {
  if [ "$was_running" = "true" ]; then
    compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d archive-mail >/dev/null
  fi
}
trap restart_if_needed EXIT HUP INT TERM

compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps --build archive-mail \
  npm run db:migrate:postgres -- --sqlite /data/archive-mail.sqlite --reset

trap - EXIT HUP INT TERM
restart_if_needed

echo "SQLite data was copied and row-count validated in PostgreSQL."
echo "Archive Mail continues using SQLite until the asynchronous PostgreSQL EmailStore adapter is enabled."
