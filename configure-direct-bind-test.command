#!/bin/sh
set -eu

# Temporary diagnostic test: exposes Archive Mail directly on the NAS's LAN
# interface on port 3001 (bypassing DSM's reverse proxy entirely), to check
# whether the reverse proxy itself is what's silently closing external
# HTTPS connections. Plain HTTP only - no certificate.
#
# Usage:
#   ./configure-direct-bind-test.command on    # expose port 3001 on 0.0.0.0 (default)
#   ./configure-direct-bind-test.command off   # revert to the secure 127.0.0.1 default
#
# You'll be prompted once for your NAS sudo password - this NAS's deploy
# user only has passwordless sudo for the full rebuild script, not for
# docker directly, and a full rebuild defaults to a local image build
# (potentially 45+ minutes), which is far too slow for a quick test.
#
# This script only changes the NAS side. You must separately add (and later
# remove) a Deco port-forward rule: external 3001 -> 192.168.68.123:3001.
#
# WARNING: while "on", anything reachable on port 3001 - including from the
# internet once port-forwarded - gets plain HTTP with no certificate, so the
# login password and session cookie travel unencrypted. Diagnostic use only;
# revert with "off" as soon as you're done testing.

MODE=${1:-on}
case "$MODE" in
  on)  BIND_ADDRESS=0.0.0.0 ;;
  off) BIND_ADDRESS=127.0.0.1 ;;
  *)
    echo "Usage: $0 [on|off]" >&2
    exit 1
    ;;
esac

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@synology.local}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}

SSH_IDENTITY_ARGS=
if [ -f "$SSH_IDENTITY" ]; then
  SSH_IDENTITY_ARGS="-i $SSH_IDENTITY -o IdentitiesOnly=yes"
fi

HELPER_PATH=/tmp/archive-mail-direct-bind-recreate.sh

echo "Setting ARCHIVE_MAIL_BIND_ADDRESS=$BIND_ADDRESS on the Synology..."
ssh $SSH_IDENTITY_ARGS "$NAS_HOST" /bin/sh -s -- "$NAS_APP_DIR" "$BIND_ADDRESS" "$HELPER_PATH" <<'REMOTE_SCRIPT'
set -eu

APP_DIR=$1
BIND_ADDRESS=$2
HELPER_PATH=$3
DEPLOY_DIR="$APP_DIR/deploy"
ENV_FILE="$DEPLOY_DIR/.env"
COMPOSE_FILE="$DEPLOY_DIR/compose.yaml"
TEMP_FILE="$ENV_FILE.direct-bind-test.$$"
BACKUP_FILE="$ENV_FILE.before-direct-bind-test"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE on the Synology." >&2
  exit 1
fi

cleanup() {
  rm -f "$TEMP_FILE"
}
trap cleanup EXIT HUP INT TERM

cp "$ENV_FILE" "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"

awk -v bind_address="$BIND_ADDRESS" '
  BEGIN { written = 0 }
  /^ARCHIVE_MAIL_BIND_ADDRESS=/ {
    if (!written) {
      print "ARCHIVE_MAIL_BIND_ADDRESS=" bind_address
      written = 1
    }
    next
  }
  { print }
  END {
    if (!written) print "ARCHIVE_MAIL_BIND_ADDRESS=" bind_address
  }
' "$ENV_FILE" > "$TEMP_FILE"

chmod 600 "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT HUP INT TERM

echo "Updated $ENV_FILE:"
grep -E '^ARCHIVE_MAIL_BIND_ADDRESS=' "$ENV_FILE"
echo "Previous environment saved at $BACKUP_FILE."

cat > "$HELPER_PATH" <<HELPER_SCRIPT
#!/bin/sh
set -eu

DEPLOY_DIR="$DEPLOY_DIR"
ENV_FILE="$ENV_FILE"
COMPOSE_FILE="$COMPOSE_FILE"
BIND_ADDRESS="$BIND_ADDRESS"

DOCKER_BIN=/usr/local/bin/docker
if [ ! -x "\$DOCKER_BIN" ]; then
  DOCKER_BIN=\$(command -v docker || true)
fi
if [ -z "\$DOCKER_BIN" ] || [ ! -x "\$DOCKER_BIN" ]; then
  echo "Docker was not found." >&2
  exit 1
fi

compose() {
  "\$DOCKER_BIN" compose --env-file "\$ENV_FILE" -f "\$COMPOSE_FILE" "\$@"
}

echo "Recreating the archive-mail container with the new binding..."
compose up -d --force-recreate archive-mail

container_id=\$(compose ps -q archive-mail)
if [ -z "\$container_id" ]; then
  echo "Archive Mail container was not created." >&2
  exit 1
fi

attempt=0
while [ "\$attempt" -lt 60 ]; do
  health=\$("\$DOCKER_BIN" inspect \\
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \\
    "\$container_id")
  case "\$health" in
    healthy)
      echo "Archive Mail is healthy with ARCHIVE_MAIL_BIND_ADDRESS=\$BIND_ADDRESS."
      exit 0
      ;;
    unhealthy|exited|dead)
      compose logs --tail=100 archive-mail
      echo "Archive Mail failed with status: \$health" >&2
      exit 1
      ;;
  esac
  attempt=\$((attempt + 1))
  sleep 2
done

compose logs --tail=100 archive-mail
echo "Timed out waiting for Archive Mail to become healthy." >&2
exit 1
HELPER_SCRIPT

chmod 700 "$HELPER_PATH"
echo "Helper script staged at $HELPER_PATH."
REMOTE_SCRIPT

echo
echo "Recreating the container - enter your NAS sudo password if prompted..."
ssh -t $SSH_IDENTITY_ARGS "$NAS_HOST" "sudo sh -c 'sh $HELPER_PATH; status=\$?; rm -f $HELPER_PATH; exit \$status'"

if [ "$MODE" = on ]; then
  echo
  echo "Port 3001 is now bound to 0.0.0.0 on the NAS (plain HTTP, no certificate)."
  echo "Next steps:"
  echo "  1. In the Deco app: More > Advanced > NAT Forwarding > Port Forwarding > +"
  echo "     External port 3001  ->  192.168.68.123 : 3001  (TCP)"
  echo "  2. On your phone, Wi-Fi off, 5G only, open: http://vts.i234.me:3001/"
  echo "     (plain http, not https - this test intentionally skips TLS)"
  echo
  echo "This is a DIAGNOSTIC TEST ONLY. Revert when done:"
  echo "  $0 off"
  echo "...and remove the Deco port-forward rule you added above."
else
  echo
  echo "Reverted: port 3001 is bound to 127.0.0.1 again (the secure default)."
  echo "Remember to also remove the Deco port-forward rule for external 3001, if you added one."
fi
