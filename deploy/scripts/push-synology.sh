#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_DIR=$(dirname "$(dirname "$SCRIPT_DIR")")

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@synology.local}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
NAS_BACKUP_DIR=${ARCHIVE_MAIL_NAS_BACKUP_DIR:-/volume1/docker/archive-mail/backups}
NAS_POSTGRES_DIR=${ARCHIVE_MAIL_NAS_POSTGRES_DIR:-/volume1/docker/archive-mail/postgres}
REQUIRE_EXISTING_DATA=${ARCHIVE_MAIL_REQUIRE_EXISTING_DATA:-false}
CONTROL_PATH="$HOME/.ssh/archive-mail-deploy-$$"
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
SSH_IDENTITY_ARGS=
if [ -f "$SSH_IDENTITY" ]; then
  SSH_IDENTITY_ARGS="-i $SSH_IDENTITY -o IdentitiesOnly=yes"
fi

case "$NAS_APP_DIR$NAS_BACKUP_DIR$NAS_POSTGRES_DIR" in
  *[!A-Za-z0-9_./-]*)
    echo "NAS paths may contain only letters, numbers, underscores, periods, slashes, and hyphens." >&2
    exit 1
    ;;
esac
case "$REQUIRE_EXISTING_DATA" in
  true|false) ;;
  *)
    echo "ARCHIVE_MAIL_REQUIRE_EXISTING_DATA must be true or false." >&2
    exit 1
    ;;
esac

if ! POSTGRES_PASSWORD_DEFAULT=$(openssl rand -hex 32 2>/dev/null); then
  echo "OpenSSL is required to generate the initial PostgreSQL password." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required locally to test and build the React application." >&2
  exit 1
fi
if [ ! -d "$REPOSITORY_DIR/node_modules" ]; then
  echo "Installing local React build dependencies..."
  (cd "$REPOSITORY_DIR" && npm ci --no-audit --no-fund)
fi
echo "Testing and building the React application locally..."
(cd "$REPOSITORY_DIR" \
  && npm run build -w @email-client/shared \
  && npm run test:run -w @email-client/web \
  && npm run build -w @email-client/web)
if [ ! -f "$REPOSITORY_DIR/apps/web/dist/index.html" ]; then
  echo "The React production build did not produce apps/web/dist/index.html." >&2
  exit 1
fi

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

. "$SCRIPT_DIR/extraction-guard.sh"
guard_in_flight_extraction

echo "Uploading the current repository snapshot..."
COPYFILE_DISABLE=1 tar --no-xattrs \
  -C "$REPOSITORY_DIR" \
  --exclude='./node_modules' \
  --exclude='*/node_modules' \
  --exclude='./bin' \
  --exclude='*/bin' \
  --exclude='./obj' \
  --exclude='*/obj' \
  --exclude='./.git' \
  --exclude='./deploy/.env' \
  --exclude='*.local.sh' \
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
    env_file=\"\$app_dir/deploy/.env\"
    set -a
    . \"\$env_file\"
    set +a
    if [ '${REQUIRE_EXISTING_DATA}' = true ]; then
      data_dir=\${ARCHIVE_MAIL_DATA_DIR:-}
      if [ -z \"\$data_dir\" ]; then
        echo 'ARCHIVE_MAIL_DATA_DIR is missing from deploy/.env.' >&2
        exit 1
      fi
      if [ ! -f \"\$data_dir/postgres-cutover.complete\" ] &&
         [ ! -f \"\$data_dir/archive-mail.sqlite\" ]; then
        echo \"Refusing the first PostgreSQL cutover: neither postgres-cutover.complete nor archive-mail.sqlite exists in \$data_dir.\" >&2
        echo 'Correct ARCHIVE_MAIL_DATA_DIR in deploy/.env before deploying.' >&2
        exit 1
      fi
    fi
    ensure_env_value() {
      key=\"\$1\"
      value=\"\$2\"
      current=\$(grep \"^\$key=\" \"\$env_file\" | tail -n 1 | cut -d= -f2- || true)
      case \"\$current\" in
        ''|replace-with-*)
          printf '\n%s=%s\n' \"\$key\" \"\$value\" >> \"\$env_file\"
          ;;
      esac
    }
    ensure_env_value ARCHIVE_MAIL_POSTGRES_DIR '${NAS_POSTGRES_DIR}'
    ensure_env_value ARCHIVE_MAIL_BACKUP_DIR '${NAS_BACKUP_DIR}'
    ensure_env_value POSTGRES_DB archive_mail
    ensure_env_value POSTGRES_USER archive_mail
    ensure_env_value POSTGRES_PASSWORD '${POSTGRES_PASSWORD_DEFAULT}'
    ensure_env_value ARCHIVE_MAIL_POSTGRES_MIGRATE_ON_DEPLOY true
    ensure_env_value ARCHIVE_MAIL_DOCKERFILE deploy/Dockerfile.synology
    mkdir -p '${NAS_POSTGRES_DIR}' '${NAS_BACKUP_DIR}'
    chmod 600 \"\$env_file\"
    cp \"\$env_file\" \"\$staging/deploy/.env\"
    chmod 755 \"\$staging/deploy/scripts/\"*.sh
    mv \"\$app_dir\" \"\$previous\"
    mv \"\$staging\" \"\$app_dir\"
    rm -rf \"\$previous\"
    trap - EXIT HUP INT TERM
  "

REBUILD_BIN=/usr/local/bin/archive-mail-rebuild.sh
direct_rebuild=false
if remote "sudo -n -l $REBUILD_BIN" >/dev/null 2>&1; then
  local_hash=$(shasum -a 256 "$REPOSITORY_DIR/deploy/scripts/synology-rebuild.sh" | cut -d' ' -f1)
  remote_hash=$(remote "sha256sum $REBUILD_BIN 2>/dev/null | cut -d' ' -f1" 2>/dev/null || true)
  if [ "$remote_hash" = "$local_hash" ]; then
    direct_rebuild=true
  else
    echo "The root-owned NAS rebuild script is outdated; using the DSM scheduled task instead." >&2
    echo "Run setup-synology-deploy.command once to refresh passwordless deployment." >&2
  fi
fi

if [ "$direct_rebuild" = true ]; then
  echo "Passwordless rebuild is configured. Rebuilding directly..."
  # A previous scheduled-task fallback may have timed out while leaving its
  # request marker behind. Remove it before the direct rebuild so a DSM task
  # cannot start a second, overlapping deployment later.
  remote "rm -f '$NAS_BACKUP_DIR/rebuild.request' '$NAS_BACKUP_DIR/rebuild.status'"
  if remote "sudo -n $REBUILD_BIN"; then
    echo "Deployment and PostgreSQL migration completed successfully."
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
      echo "Deployment and PostgreSQL migration completed successfully."
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
remote "rm -f '$NAS_BACKUP_DIR/rebuild.request'" || true
echo "Timed out waiting for the Synology deployment task." >&2
exit 1
