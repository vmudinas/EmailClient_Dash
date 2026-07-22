#!/bin/sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPOSITORY_DIR"

git diff --check
sh -n deploy/scripts/*.sh

SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
if [ ! -f "$SSH_IDENTITY" ]; then
  echo "First deployment: configuring passwordless Synology access..."
  if [ -x deploy/scripts/setup.local.sh ]; then
    deploy/scripts/setup.local.sh
  else
    deploy/scripts/setup-synology-deploy.sh
  fi
fi

if [ -x deploy/scripts/push.local.sh ]; then
  exec deploy/scripts/push.local.sh "$@"
fi
exec deploy/scripts/push-synology.sh "$@"
