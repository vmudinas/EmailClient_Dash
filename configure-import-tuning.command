#!/bin/sh
# Set PST import tuning on the Synology NAS, then optionally deploy.
#
# Four parallel readpst workers cause seek thrashing when one large PST is being
# extracted from a contended spinning volume, so the default here is 2.
#
# Usage:
#   ./configure-import-tuning.command                 # show current values, change nothing
#   ./configure-import-tuning.command --apply         # write the tuning values
#   ./configure-import-tuning.command --apply --deploy  # write, then run the full deployment
#   READPST_JOBS=1 ./configure-import-tuning.command --apply
set -eu

REPOSITORY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$REPOSITORY_DIR"

NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-gliukaz@192.168.68.123}
NAS_APP_DIR=${ARCHIVE_MAIL_NAS_APP_DIR:-/volume1/docker/archive-mail/app}
SSH_IDENTITY=${ARCHIVE_MAIL_SSH_IDENTITY:-$HOME/.ssh/archive_mail_synology_ed25519}
ENV_FILE="$NAS_APP_DIR/deploy/.env"

READPST_JOBS=${READPST_JOBS:-2}
PARSER_CONCURRENCY=${PARSER_CONCURRENCY:-2}
BATCH_SIZE=${BATCH_SIZE:-1000}
LEASE_SECONDS=${LEASE_SECONDS:-300}

APPLY=false
DEPLOY=false
for argument in "$@"; do
  case "$argument" in
    --apply) APPLY=true ;;
    --deploy) DEPLOY=true ;;
    *) echo "Unknown option: $argument" >&2; exit 2 ;;
  esac
done

if [ ! -f "$SSH_IDENTITY" ]; then
  echo "Missing SSH key $SSH_IDENTITY. Run ./setup-synology-deploy.command first." >&2
  exit 1
fi

remote() { ssh -o BatchMode=yes -i "$SSH_IDENTITY" -o IdentitiesOnly=yes "$NAS_HOST" "$@"; }

echo "== Current import tuning on $NAS_HOST =="
remote "grep -E 'ARCHIVE_MAIL_IMPORT_' '$ENV_FILE' || echo '(none set; compose defaults apply: READPST_JOBS=4 PARSER_CONCURRENCY=4)'"

# A deploy recreates the container, and readpst cannot resume a half-written
# export - PstStager deletes the staging directory and starts over. Losing hours
# of extraction silently is worse than refusing to continue.
echo
echo "== Extraction in progress? =="
# grep -cx on the comm column only: no $ fields, so ssh quoting cannot silently
# break the check and report "nothing running" while an extraction is in flight.
EXTRACTING=$(remote 'ps -eo comm | grep -cx readpst || true' | tr -d ' ')
if [ "${EXTRACTING:-0}" -gt 0 ]; then
  READ_SO_FAR=$(remote 'for d in /proc/[0-9]*; do if [ "$(cat $d/comm 2>/dev/null)" = readpst ]; then grep "^read_bytes" $d/io 2>/dev/null | tr -dc "0-9"; echo; fi; done | head -1' || true)
  echo "!! readpst IS RUNNING - it has read ${READ_SO_FAR:-unknown} bytes of the source."
  echo "!! A deploy or container restart DISCARDS that progress and re-extracts from 0%."
  if [ "$DEPLOY" = true ]; then
    printf 'Type RESTART-EXTRACTION to deploy anyway: '
    read -r confirmation
    [ "$confirmation" = "RESTART-EXTRACTION" ] || { echo "Aborted; nothing changed."; exit 1; }
  fi
else
  echo "No readpst process; nothing to lose by restarting."
fi

if [ "$APPLY" != true ]; then
  echo
  echo "Read-only run. Re-run with --apply to write these values:"
  echo "  ARCHIVE_MAIL_IMPORT_READPST_JOBS=$READPST_JOBS"
  echo "  ARCHIVE_MAIL_IMPORT_PARSER_CONCURRENCY=$PARSER_CONCURRENCY"
  echo "  ARCHIVE_MAIL_IMPORT_BATCH_SIZE=$BATCH_SIZE"
  echo "  ARCHIVE_MAIL_IMPORT_LEASE_SECONDS=$LEASE_SECONDS"
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
  set_value ARCHIVE_MAIL_IMPORT_READPST_JOBS '$READPST_JOBS'
  set_value ARCHIVE_MAIL_IMPORT_PARSER_CONCURRENCY '$PARSER_CONCURRENCY'
  set_value ARCHIVE_MAIL_IMPORT_BATCH_SIZE '$BATCH_SIZE'
  set_value ARCHIVE_MAIL_IMPORT_LEASE_SECONDS '$LEASE_SECONDS'
  chmod 600 '$ENV_FILE'
"
echo "== Values now on the NAS =="
remote "grep -E 'ARCHIVE_MAIL_IMPORT_' '$ENV_FILE'"

echo
echo "These take effect when the container is recreated."
if [ "$DEPLOY" = true ]; then
  echo "== Deploying =="
  exec "$REPOSITORY_DIR/deploy-to-synology.command"
fi
echo "Run ./deploy-to-synology.command when you are ready to apply them."
