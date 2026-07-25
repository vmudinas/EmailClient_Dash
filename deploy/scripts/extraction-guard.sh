# shellcheck shell=sh
# Refuse to silently destroy an in-progress PST extraction.
#
# Recreating the container restarts readpst from 0%. readpst cannot resume a half-written
# export, so PstStager deletes the staging directory and re-extracts the entire source. On a
# large PST that is hours of work discarded with no warning -- which happened repeatedly
# during the 57GB import before anyone realised a deploy was the cause.
#
# The signal is the one PstStager itself uses: a staging directory with no .readpst-complete
# marker. That directory is bind-mounted on the host, so this needs no container access and
# therefore no sudo. The find expression deliberately contains no '$' fields, because those
# do not survive the local -> ssh -> remote shell quoting layers intact.
#
# Requires remote() and NAS_APP_DIR from the calling script.
# Set ARCHIVE_MAIL_FORCE_DEPLOY=true to proceed without the prompt.

guard_in_flight_extraction() {
  guard_data_dir=$(remote "grep -E '^ARCHIVE_MAIL_DATA_DIR=' '$NAS_APP_DIR/deploy/.env' 2>/dev/null | tail -n 1 | cut -d= -f2-" 2>/dev/null || true)
  # No data directory configured, or a path this script will not interpolate into a remote
  # command: skip the check rather than guess. A missed warning beats a broken deploy.
  [ -n "$guard_data_dir" ] || return 0
  case "$guard_data_dir" in
    *[!A-Za-z0-9_./-]*) return 0 ;;
  esac

  guard_pending=$(remote "find '$guard_data_dir/import-staging' -mindepth 1 -maxdepth 1 -type d '!' -exec test -e '{}/.readpst-complete' ';' -print 2>/dev/null | wc -l" 2>/dev/null || echo 0)
  guard_pending=$(printf '%s' "$guard_pending" | tr -dc '0-9')
  [ -n "$guard_pending" ] || guard_pending=0
  [ "$guard_pending" -gt 0 ] || return 0

  echo "" >&2
  echo "WARNING: $guard_pending PST extraction(s) on the NAS have not finished." >&2
  echo "Deploying recreates the container, and readpst cannot resume a partial export, so" >&2
  echo "the extraction restarts from 0% and any progress so far is discarded." >&2

  if [ "${ARCHIVE_MAIL_FORCE_DEPLOY:-false}" = true ]; then
    echo "ARCHIVE_MAIL_FORCE_DEPLOY=true; continuing anyway." >&2
    return 0
  fi
  if [ ! -t 0 ]; then
    echo "Refusing to deploy unattended. Re-run interactively, or set" >&2
    echo "ARCHIVE_MAIL_FORCE_DEPLOY=true to deploy anyway." >&2
    exit 1
  fi

  printf 'Type RESTART-EXTRACTION to deploy anyway: '
  read -r guard_reply
  if [ "$guard_reply" != "RESTART-EXTRACTION" ]; then
    echo "Aborted; nothing was deployed."
    exit 1
  fi
}
