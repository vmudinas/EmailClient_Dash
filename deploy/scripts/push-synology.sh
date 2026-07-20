#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIR=$(dirname "$(dirname "$SCRIPT_DIR")")

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@192.168.68.57}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
NAS_BACKUP_DIR=${ARCHIVE_MAIL_NAS_BACKUP_DIR:-/volume1/docker/archive-mail/backups}
CONTROL_PATH="$HOME/.ssh/archive-mail-deploy-$$"

case "$NAS_APP_DIR$NAS_BACKUP_DIR" in
  *[!A-Za-z0-9_./-]*)
    echo "NAS paths may contain only letters, numbers, underscores, periods, slashes, and hyphens." >&2
    exit 1
    ;;
esac

cleanup() {
  ssh -S "$CONTROL_PATH" -O exit "$NAS_HOST" >/dev/null 2>&1 || true
  rm -f "$CONTROL_PATH"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$HOME/.ssh"
rm -f "$CONTROL_PATH"

echo "Connecting to $NAS_HOST..."
ssh \
  -M \
  -S "$CONTROL_PATH" \
  -o ControlPersist=10m \
  -o PubkeyAuthentication=no \
  -o PreferredAuthentications=keyboard-interactive,password \
  -fnNT \
  "$NAS_HOST"

remote() {
  ssh -S "$CONTROL_PATH" "$NAS_HOST" "$@"
}

echo "Uploading the current repository snapshot..."
COPYFILE_DISABLE=1 tar --no-xattrs \
  -C "$REPOSITORY_DIR" \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./dist' \
  --exclude='*/dist' \
  --exclude='./.git' \
  --exclude='./deploy/.env' \
  --exclude='.DS_Store' \
  -cf - . | remote "
    set -eu
    app_dir='$NAS_APP_DIR'
    staging='$NAS_APP_DIR.next'
    previous='$NAS_APP_DIR.previous'

    restore_previous() {
      rm -rf \"\$staging\"
      if [ ! -d \"\$app_dir\" ] && [ -d \"\$previous\" ]; then
        mv \"\$previous\" \"\$app_dir\"
      fi
    }
    trap restore_previous EXIT HUP INT TERM

    rm -rf \"\$staging\" \"\$previous\"
    mkdir -p \"\$staging\"
    tar -xf - -C \"\$staging\"
    if [ ! -f \"\$app_dir/deploy/.env\" ]; then
      echo 'Missing existing deploy/.env on the NAS.' >&2
      exit 1
    fi
    cp \"\$app_dir/deploy/.env\" \"\$staging/deploy/.env\"
    chmod 755 \"\$staging/deploy/scripts/\"*.sh
    mv \"\$app_dir\" \"\$previous\"
    mv \"\$staging\" \"\$app_dir\"
    rm -rf \"\$previous\"
    trap - EXIT HUP INT TERM
  "

REBUILD_BIN=/usr/local/bin/archive-mail-rebuild.sh
if remote "sudo -n -l $REBUILD_BIN" >/dev/null 2>&1; then
  echo "Passwordless rebuild is configured. Rebuilding directly..."
  local_hash=$(shasum -a 256 "$REPOSITORY_DIR/deploy/scripts/synology-rebuild.sh" | cut -d' ' -f1)
  remote_hash=$(remote "sha256sum $REBUILD_BIN 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)
  if [ -n "$remote_hash" ] && [ "$remote_hash" != "$local_hash" ]; then
    echo "Warning: $REBUILD_BIN on the NAS differs from deploy/scripts/synology-rebuild.sh." >&2
    echo "Refresh the root-owned copy when convenient (see deploy/README.md)." >&2
  fi
  if remote "sudo -n $REBUILD_BIN"; then
    echo "Deployment completed successfully."
    exit 0
  fi
  echo "Direct rebuild failed." >&2
  exit 1
fi

echo "Passwordless rebuild is not configured; requesting the scheduled deployment task instead."
remote "
  set -eu
  mkdir -p '$NAS_BACKUP_DIR'
  rm -f '$NAS_BACKUP_DIR/rebuild.log' '$NAS_BACKUP_DIR/rebuild.status'
  : > '$NAS_BACKUP_DIR/rebuild.request'
"
echo "Deployment requested. Waiting for the Synology root task to pick it up..."

attempt=0
while [ "$attempt" -lt 180 ]; do
  deployment_status=$(remote "cat '$NAS_BACKUP_DIR/rebuild.status' 2>/dev/null || true")
  case "$deployment_status" in
    success)
      remote "cat '$NAS_BACKUP_DIR/rebuild.log'"
      echo "Deployment completed successfully."
      exit 0
      ;;
    failed)
      remote "cat '$NAS_BACKUP_DIR/rebuild.log'" >&2
      echo "Deployment failed. See $NAS_BACKUP_DIR/rebuild.log on the NAS." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 5
done

remote "tail -100 '$NAS_BACKUP_DIR/rebuild.log' 2>/dev/null || true" >&2
echo "Timed out waiting for the Synology deployment task." >&2
exit 1
