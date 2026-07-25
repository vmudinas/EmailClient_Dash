#!/bin/sh
# Opt the NAS into pulling prebuilt images from GHCR instead of building them
# locally on every deploy. See "Faster deploys via GitHub Container Registry"
# in deploy/README.md.
#
# Usage:
#   ./configure-registry-deploy.command            # show current values, change nothing
#   ./configure-registry-deploy.command --apply     # write the registry-mode values
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPOSITORY_DIR"

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@192.168.68.123}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
ENV_FILE="$NAS_APP_DIR/deploy/.env"

IMAGE=${ARCHIVE_MAIL_IMAGE:-ghcr.io/vmudinas/emailclient_dash:latest}
MIGRATOR_IMAGE=${ARCHIVE_MAIL_MIGRATOR_IMAGE:-ghcr.io/vmudinas/emailclient_dash-migrator:latest}

APPLY=false
for argument in "$@"; do
  case "$argument" in
    --apply) APPLY=true ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

if [ ! -f "$SSH_IDENTITY" ]; then
  echo "Missing SSH key $SSH_IDENTITY. Run ./setup-synology-deploy.command first." >&2
  exit 1
fi

remote() { ssh -o BatchMode=yes -i "$SSH_IDENTITY" -o IdentitiesOnly=yes "$NAS_HOST" "$@"; }

echo "== Current registry settings on $NAS_HOST =="
remote "grep -E 'ARCHIVE_MAIL_IMAGE_SOURCE|ARCHIVE_MAIL_IMAGE=|ARCHIVE_MAIL_MIGRATOR_IMAGE' '$ENV_FILE' || echo '(none set; deploys build locally)'"

if [ "$APPLY" != true ]; then
  echo
  echo "Read-only run. Re-run with --apply to write these values:"
  echo "  ARCHIVE_MAIL_IMAGE_SOURCE=registry"
  echo "  ARCHIVE_MAIL_IMAGE=$IMAGE"
  echo "  ARCHIVE_MAIL_MIGRATOR_IMAGE=$MIGRATOR_IMAGE"
  echo
  echo "Before applying, confirm both GHCR packages are set to Public:"
  echo "  https://github.com/vmudinas/EmailClient_Dash/pkgs/container/emailclient_dash"
  echo "  https://github.com/vmudinas/EmailClient_Dash/pkgs/container/emailclient_dash-migrator"
  exit 0
fi

echo
echo "== Backing up and updating $ENV_FILE =="
remote "
  set -eu
  cp '$ENV_FILE' '$ENV_FILE.bak.\$(date -u +%Y%m%dT%H%M%SZ)'
  set_value() {
    key=\"\$1\"; value=\"\$2\"
    if grep -q \"^\$key=\" '$ENV_FILE'; then
      # Rewrite in place without sed -i, which DSM's sed handles inconsistently.
      awk -v k=\"\$key\" -v v=\"\$value\" -F= '{ if (\$1==k) print k\"=\"v; else print }' '$ENV_FILE' > '$ENV_FILE.tmp'
      mv '$ENV_FILE.tmp' '$ENV_FILE'
    else
      printf '%s=%s\n' \"\$key\" \"\$value\" >> '$ENV_FILE'
    fi
  }
  set_value ARCHIVE_MAIL_IMAGE_SOURCE registry
  set_value ARCHIVE_MAIL_IMAGE '$IMAGE'
  set_value ARCHIVE_MAIL_MIGRATOR_IMAGE '$MIGRATOR_IMAGE'
  chmod 600 '$ENV_FILE'
"
echo "== Values now on the NAS =="
remote "grep -E 'ARCHIVE_MAIL_IMAGE_SOURCE|ARCHIVE_MAIL_IMAGE=|ARCHIVE_MAIL_MIGRATOR_IMAGE' '$ENV_FILE'"

echo
echo "Registry mode is configured. Run ./pull-deploy.command to deploy from GHCR."
