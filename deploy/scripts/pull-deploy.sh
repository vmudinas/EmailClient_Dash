#!/bin/sh
set -eu

# Lightweight companion to push-synology.sh for routine deploys once the NAS
# is configured for registry mode (see deploy/README.md). Unlike
# push-synology.sh, this script never builds or tests locally and never
# uploads the repository — it only verifies registry mode is configured on
# the NAS and triggers the already pull-aware rebuild script over SSH.

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIR=$(dirname "$(dirname "$SCRIPT_DIR")")

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@synology.local}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
NAS_BACKUP_DIR=${ARCHIVE_MAIL_NAS_BACKUP_DIR:-/volume1/docker/archive-mail/backups}
CONTROL_PATH="$HOME/.ssh/archive-mail-pull-deploy-$$"
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
SSH_IDENTITY_ARGS=
if [ -f "$SSH_IDENTITY" ]; then
  SSH_IDENTITY_ARGS="-i $SSH_IDENTITY -o IdentitiesOnly=yes"
fi

case "$NAS_APP_DIR$NAS_BACKUP_DIR" in
  *[!A-Za-z0-9_./-]*)
    echo "NAS paths may contain only letters, numbers, underscores, periods, slashes, and hyphens." >&2
    exit 1
    ;;
esac

cleanup() {
  ssh $SSH_IDENTITY_ARGS -S "$CONTROL_PATH" -O exit "$NAS_HOST" >/dev/null 2>&1 || true
  rm -f "$CONTROL_PATH"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$HOME/.ssh"
rm -f "$CONTROL_PATH"

echo "Connecting to $NAS_HOST..."
ssh \
  $SSH_IDENTITY_ARGS \
  -M \
  -S "$CONTROL_PATH" \
  -o ControlPersist=10m \
  -o PreferredAuthentications=publickey,keyboard-interactive,password \
  -fnNT \
  "$NAS_HOST"

remote() {
  ssh $SSH_IDENTITY_ARGS -S "$CONTROL_PATH" "$NAS_HOST" "$@"
}

echo "Checking that the NAS is configured for registry-based deploys..."
env_file="$NAS_APP_DIR/deploy/.env"
image_source=$(remote "grep -E '^ARCHIVE_MAIL_IMAGE_SOURCE=' '$env_file' 2>/dev/null | tail -n 1 | cut -d= -f2-" 2>/dev/null || true)
if [ "$image_source" != "registry" ]; then
  echo "ARCHIVE_MAIL_IMAGE_SOURCE=registry is not set in $env_file on the NAS." >&2
  echo "Add the registry-mode lines to the NAS's deploy/.env before using pull-deploy.command; see deploy/README.md." >&2
  exit 1
fi

REBUILD_BIN=/usr/local/bin/archive-mail-rebuild.sh
direct_rebuild=false
if remote "sudo -n -l $REBUILD_BIN" >/dev/null 2>&1; then
  local_hash=$(shasum -a 256 "$REPOSITORY_DIR/deploy/scripts/synology-rebuild.sh" | cut -d' ' -f1)
  remote_hash=$(remote "sha256sum $REBUILD_BIN 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)
  if [ "$remote_hash" = "$local_hash" ]; then
    direct_rebuild=true
  else
    echo "The root-owned NAS rebuild script is outdated." >&2
    echo "Run setup-synology-deploy.command once to refresh passwordless deployment." >&2
  fi
else
  echo "Passwordless rebuild is not configured on the NAS." >&2
  echo "Run setup-synology-deploy.command once to enable it." >&2
fi

if [ "$direct_rebuild" != true ]; then
  exit 1
fi

echo "Passwordless rebuild is configured. Pulling and rebuilding directly..."
# A previous scheduled-task fallback may have timed out while leaving its
# request marker behind. Remove it so a DSM task cannot start a second,
# overlapping deployment later.
remote "rm -f '$NAS_BACKUP_DIR/rebuild.request' '$NAS_BACKUP_DIR/rebuild.status'"
if remote "sudo -n $REBUILD_BIN"; then
  echo "Deployment and PostgreSQL migration completed successfully."
  exit 0
fi
echo "Direct rebuild failed." >&2
exit 1
