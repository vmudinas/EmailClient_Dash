#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DEPLOY_DIR=$(dirname "$SCRIPT_DIR")
ENV_FILE=${ARCHIVE_MAIL_ENV_FILE:-"$DEPLOY_DIR/.env"}

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE." >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

ARCHIVE_MAIL_BACKUP_DIR=${ARCHIVE_MAIL_BACKUP_DIR:-"$(dirname "$DEPLOY_DIR")/../backups"}
LOG_FILE="$ARCHIVE_MAIL_BACKUP_DIR/rebuild.log"
STATUS_FILE="$ARCHIVE_MAIL_BACKUP_DIR/rebuild.status"
REQUEST_FILE="$ARCHIVE_MAIL_BACKUP_DIR/rebuild.request"
LOCK_DIR=/tmp/archive-mail-rebuild.lock

mkdir -p "$ARCHIVE_MAIL_BACKUP_DIR"

if [ ! -f "$REQUEST_FILE" ]; then
  exit 0
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    exit 0
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
printf '%s\n' "$$" > "$LOCK_DIR/pid"

cleanup() {
  rm -rf "$LOCK_DIR"
}
trap cleanup EXIT HUP INT TERM

rm -f "$REQUEST_FILE"

write_status() {
  temporary="$STATUS_FILE.tmp.$$"
  printf '%s\n' "$1" > "$temporary"
  mv "$temporary" "$STATUS_FILE"
}

write_status running
if "$SCRIPT_DIR/synology-rebuild.sh" > "$LOG_FILE" 2>&1; then
  write_status success
  exit 0
fi

write_status failed
exit 1
