#!/bin/sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PUBLIC_URL=${1:-https://vts.i234.me}
NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@synology.local}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}

case "$PUBLIC_URL" in
  https://*) ;;
  *)
    echo "Usage: $0 https://mail.example.com" >&2
    echo "The public URL must start with https://." >&2
    exit 1
    ;;
esac

PUBLIC_AUTHORITY=${PUBLIC_URL#https://}
case "$PUBLIC_AUTHORITY" in
  ""|*"'"*|*\"*|*/*|*\?*|*\#*|*@*|*[!A-Za-z0-9._:-]*|.*|*.)
    echo "The public URL must be one HTTPS origin without credentials, a path, query, fragment, or trailing slash." >&2
    exit 1
    ;;
esac
case "$PUBLIC_AUTHORITY" in
  *.*) ;;
  *)
    echo "The public URL must use a fully qualified domain name." >&2
    exit 1
    ;;
esac

case "$NAS_APP_DIR" in
  /*) ;;
  *)
    echo "ARCHIVE_MAIL_NAS_APP_DIR must be an absolute path." >&2
    exit 1
    ;;
esac
case "$NAS_APP_DIR" in
  *[!A-Za-z0-9_./-]*)
    echo "ARCHIVE_MAIL_NAS_APP_DIR contains unsupported characters." >&2
    exit 1
    ;;
esac

SSH_IDENTITY_ARGS=
if [ -f "$SSH_IDENTITY" ]; then
  SSH_IDENTITY_ARGS="-i $SSH_IDENTITY -o IdentitiesOnly=yes"
fi

echo "Updating Archive Mail's Synology environment for $PUBLIC_URL..."
ssh $SSH_IDENTITY_ARGS "$NAS_HOST" /bin/sh -s -- "$NAS_APP_DIR" "$PUBLIC_URL" <<'REMOTE_SCRIPT'
set -eu

APP_DIR=$1
PUBLIC_URL=$2
ENV_FILE="$APP_DIR/deploy/.env"
TEMP_FILE="$ENV_FILE.public-url.$$"
BACKUP_FILE="$ENV_FILE.before-public-url"

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

awk -v public_url="$PUBLIC_URL" '
  BEGIN {
    public_url_written = 0
    trust_proxy_written = 0
    bind_address_written = 0
  }
  /^EMAIL_CLIENT_PUBLIC_URL=/ {
    if (!public_url_written) {
      print "EMAIL_CLIENT_PUBLIC_URL=" public_url
      public_url_written = 1
    }
    next
  }
  /^EMAIL_CLIENT_TRUST_PROXY=/ {
    if (!trust_proxy_written) {
      print "EMAIL_CLIENT_TRUST_PROXY=true"
      trust_proxy_written = 1
    }
    next
  }
  /^ARCHIVE_MAIL_BIND_ADDRESS=/ {
    if (!bind_address_written) {
      print "ARCHIVE_MAIL_BIND_ADDRESS=127.0.0.1"
      bind_address_written = 1
    }
    next
  }
  { print }
  END {
    if (!public_url_written) print "EMAIL_CLIENT_PUBLIC_URL=" public_url
    if (!trust_proxy_written) print "EMAIL_CLIENT_TRUST_PROXY=true"
    if (!bind_address_written) print "ARCHIVE_MAIL_BIND_ADDRESS=127.0.0.1"
  }
' "$ENV_FILE" > "$TEMP_FILE"

chmod 600 "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT HUP INT TERM

echo "Updated $ENV_FILE:"
grep -E '^(EMAIL_CLIENT_PUBLIC_URL|EMAIL_CLIENT_TRUST_PROXY|ARCHIVE_MAIL_BIND_ADDRESS)=' "$ENV_FILE"
echo "Previous environment saved at $BACKUP_FILE."
REMOTE_SCRIPT

echo "Recreating and verifying Archive Mail with the updated environment..."
exec "$REPOSITORY_DIR/deploy-to-synology.command"
