#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Usage: $0 /path/to/archive-mail-backup.tar.gz [--yes]" >&2
  exit 1
fi

backup=$1
assume_yes=${2:-}
if [ ! -f "$backup" ]; then
  echo "Backup not found: $backup" >&2
  exit 1
fi
tar -tzf "$backup" >/dev/null

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

case "$ARCHIVE_MAIL_DATA_DIR" in
  /|"") echo "Unsafe ARCHIVE_MAIL_DATA_DIR" >&2; exit 1 ;;
esac

if [ "$assume_yes" != "--yes" ]; then
  printf 'Replace all current Archive Mail data in %s? Type RESTORE: ' "$ARCHIVE_MAIL_DATA_DIR"
  read -r confirmation
  [ "$confirmation" = "RESTORE" ] || { echo "Restore cancelled."; exit 1; }
fi

if docker compose version >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  compose() { docker-compose "$@"; }
else
  echo "Docker Compose is required." >&2
  exit 1
fi

mkdir -p "$ARCHIVE_MAIL_DATA_DIR" "$ARCHIVE_MAIL_BACKUP_DIR"
staging=$(mktemp -d "$(dirname "$ARCHIVE_MAIL_DATA_DIR")/.archive-mail-restore.XXXXXX")
trap 'rm -rf "$staging"' EXIT HUP INT TERM
tar -xzf "$backup" -C "$staging"

compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" stop -t 120 archive-mail >/dev/null 2>&1 || true
safety="$ARCHIVE_MAIL_BACKUP_DIR/archive-mail-before-restore-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$ARCHIVE_MAIL_DATA_DIR" -czf "$safety" .
find "$ARCHIVE_MAIL_DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$staging"/. "$ARCHIVE_MAIL_DATA_DIR"/
compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d archive-mail >/dev/null

echo "Restore started from: $backup"
echo "Pre-restore safety backup: $safety"
