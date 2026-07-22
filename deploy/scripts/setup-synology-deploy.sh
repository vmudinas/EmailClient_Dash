#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@synology.local}
CONTROL_PATH="$HOME/.ssh/archive-mail-setup-$$"
REMOTE_TEMP="/tmp/archive-mail-rebuild-$$.sh"
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}

cleanup() {
  ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -S "$CONTROL_PATH" "$NAS_HOST" "rm -f '$REMOTE_TEMP'" >/dev/null 2>&1 || true
  ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -S "$CONTROL_PATH" -O exit "$NAS_HOST" >/dev/null 2>&1 || true
  rm -f "$CONTROL_PATH"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$HOME/.ssh"
rm -f "$CONTROL_PATH"

if [ ! -f "$SSH_IDENTITY" ]; then
  echo "Creating a dedicated Archive Mail deployment key..."
  ssh-keygen -q -t ed25519 -N '' -C archive-mail-synology-deploy -f "$SSH_IDENTITY"
fi
if ! ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 "$NAS_HOST" true 2>/dev/null; then
  echo "Installing the deployment key. Enter the Synology SSH password once."
  ssh-copy-id -i "$SSH_IDENTITY.pub" "$NAS_HOST"
fi

echo "Connecting to $NAS_HOST..."
ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -M -S "$CONTROL_PATH" -o ControlPersist=10m \
  -fnNT "$NAS_HOST"

remote_user=$(ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -S "$CONTROL_PATH" "$NAS_HOST" id -un)
case "$remote_user" in
  ''|*[!A-Za-z0-9_-]*) echo "The remote username is invalid." >&2; exit 1 ;;
esac

scp -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -o ControlPath="$CONTROL_PATH" \
  "$SCRIPT_DIR/synology-rebuild.sh" "$NAS_HOST:$REMOTE_TEMP"

echo "Synology may ask for the sudo password once. Future deployments will not need it."
ssh -tt -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -S "$CONTROL_PATH" "$NAS_HOST" "sudo /bin/sh -c '
  set -eu
  cp $REMOTE_TEMP /usr/local/bin/archive-mail-rebuild.sh
  chown root:root /usr/local/bin/archive-mail-rebuild.sh
  chmod 755 /usr/local/bin/archive-mail-rebuild.sh
  printf \"%s ALL=(root) NOPASSWD: /usr/local/bin/archive-mail-rebuild.sh\\n\" $remote_user > /etc/sudoers.d/archive-mail
  chmod 440 /etc/sudoers.d/archive-mail
  visudo -c
'"

if ! ssh -i "$SSH_IDENTITY" -o IdentitiesOnly=yes -S "$CONTROL_PATH" "$NAS_HOST" \
  "sudo -n -l /usr/local/bin/archive-mail-rebuild.sh" >/dev/null 2>&1; then
  echo "The passwordless rebuild permission could not be verified." >&2
  exit 1
fi

echo "Passwordless Archive Mail deployment is configured for $remote_user on $NAS_HOST."
echo "Run deploy-to-synology.command to upload, migrate, rebuild, and verify the application."
