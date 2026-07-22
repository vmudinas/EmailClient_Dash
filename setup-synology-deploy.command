#!/bin/sh
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SETUP="$REPOSITORY_DIR/deploy/scripts/setup-synology-deploy.sh"

if [ -x "$REPOSITORY_DIR/deploy/scripts/setup.local.sh" ]; then
  exec "$REPOSITORY_DIR/deploy/scripts/setup.local.sh" "$@"
fi
exec "$SETUP" "$@"
