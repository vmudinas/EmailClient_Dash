#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: install-synology-rebuild.sh REBUILD_SCRIPT DEPLOY_USER" >&2
  exit 2
fi

rebuild_source=$1
deploy_user=$2

case "$rebuild_source" in
  /tmp/archive-mail-rebuild-*.sh) ;;
  *) echo "Refusing unexpected rebuild script path: $rebuild_source" >&2; exit 1 ;;
esac
case "$deploy_user" in
  ''|*[!A-Za-z0-9_-]*) echo "The deployment username is invalid." >&2; exit 1 ;;
esac

cp "$rebuild_source" /usr/local/bin/archive-mail-rebuild.sh
chown root:root /usr/local/bin/archive-mail-rebuild.sh
chmod 755 /usr/local/bin/archive-mail-rebuild.sh
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/archive-mail-rebuild.sh\n' "$deploy_user" \
  > /etc/sudoers.d/archive-mail
chmod 440 /etc/sudoers.d/archive-mail

if command -v visudo >/dev/null 2>&1; then
  visudo -c
else
  echo "visudo is not installed; the caller will validate the rule with sudo -n -l."
fi
