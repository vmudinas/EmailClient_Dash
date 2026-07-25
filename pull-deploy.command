#!/bin/sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPOSITORY_DIR"

git diff --check
sh -n deploy/scripts/*.sh

SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
if [ ! -f "$SSH_IDENTITY" ]; then
  echo "No passwordless Synology SSH key found." >&2
  echo "Run ./deploy-to-synology.command once first; it configures access and performs a full deployment." >&2
  exit 1
fi

exec deploy/scripts/pull-deploy.sh "$@"
