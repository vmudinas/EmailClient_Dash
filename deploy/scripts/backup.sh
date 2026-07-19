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

set -a
. "$ENV_FILE"
set +a

: "${ARCHIVE_MAIL_DATA_DIR:?Set ARCHIVE_MAIL_DATA_DIR in $ENV_FILE}"
ARCHIVE_MAIL_BACKUP_DIR=${ARCHIVE_MAIL_BACKUP_DIR:-"$(dirname "$ARCHIVE_MAIL_DATA_DIR")/backups"}
ARCHIVE_MAIL_BACKUP_RETENTION_DAYS=${ARCHIVE_MAIL_BACKUP_RETENTION_DAYS:-14}

case "$ARCHIVE_MAIL_DATA_DIR" in
  /|"") echo "Unsafe ARCHIVE_MAIL_DATA_DIR" >&2; exit 1 ;;
esac
case "$ARCHIVE_MAIL_BACKUP_DIR/" in
  "$ARCHIVE_MAIL_DATA_DIR/"*) echo "Backup directory cannot be inside the data directory." >&2; exit 1 ;;
esac

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required." >&2
  exit 1
fi

mkdir -p "$ARCHIVE_MAIL_BACKUP_DIR"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$ARCHIVE_MAIL_BACKUP_DIR/archive-mail-$timestamp.tar.gz"
temporary="$backup.partial"
container_id=$(compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q archive-mail)
was_running=false
if [ -n "$container_id" ] && [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = "true" ]; then
  was_running=true
  compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop -t 120 archive-mail
fi

restart_if_needed() {
  rm -f "$temporary"
  if [ "$was_running" = "true" ]; then
    compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d archive-mail >/dev/null
  fi
}
trap restart_if_needed EXIT HUP INT TERM

tar -C "$ARCHIVE_MAIL_DATA_DIR" -czf "$temporary" .
mv "$temporary" "$backup"
find "$ARCHIVE_MAIL_BACKUP_DIR" -type f -name 'archive-mail-*.tar.gz' -mtime "+$ARCHIVE_MAIL_BACKUP_RETENTION_DAYS" -delete

trap - EXIT HUP INT TERM
if [ "$was_running" = "true" ]; then
  compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d archive-mail >/dev/null
fi

echo "Backup created: $backup"
