# Archive Mail server deployment

This deployment runs the API, scheduler, Gmail sync, import workers, and static web UI in one production container, plus a private PostgreSQL container used as the migration target. The Electron desktop application is not included. SQLite and uploaded content remain under `/data`; PostgreSQL uses its own host directory.

## Requirements

- Docker Engine with Docker Compose, or Synology DSM 7 Container Manager.
- A writable local-disk directory for SQLite, blobs, uploads, OAuth tokens, saved API keys, and settings.
- A second writable local-disk directory for PostgreSQL and a long random `POSTGRES_PASSWORD`.
- A reverse proxy with HTTPS when the app is accessed outside a trusted LAN or when Gmail is authorized from another computer.

Do not place the data directory on NFS, SMB, Synology Drive, Cloud Sync, or another synchronized/network filesystem. SQLite and its WAL files need local filesystem semantics.

## Linux quick start

```bash
cp deploy/.env.example deploy/.env
${EDITOR:-vi} deploy/.env
./deploy/scripts/deploy.sh
```

Set `ARCHIVE_MAIL_UID` and `ARCHIVE_MAIL_GID` to the account that owns the data directory:

```bash
id -u
id -g
```

The secure default binds port `3001` only to `127.0.0.1` for a same-host reverse proxy. Set `ARCHIVE_MAIL_BIND_ADDRESS=0.0.0.0` only for direct LAN access protected by the server firewall.

Normal username/PIN login from another device is disabled by default because the desktop QR flow is read-only. For a server deployment on a trusted LAN or behind HTTPS, set:

```dotenv
EMAIL_CLIENT_ALLOW_REMOTE_LOGIN=true
```

Paired QR sessions remain read-only. A normal remote login receives the configured user's full role.

Useful commands:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f archive-mail
docker compose --env-file deploy/.env -f deploy/compose.yaml restart archive-mail
```

Run `./deploy/scripts/deploy.sh` again after pulling source changes. It rebuilds the production image, recreates the service, and waits for `/api/health` to report healthy.

SQLite schema migrations run automatically when the recreated container starts. On the first build containing private user workspaces, existing mail and account configuration are assigned to the first active administrator; newly created users begin with empty private mail and calendar workspaces.

## Large imports

Imports parse and extract attachments in Node worker threads with a separate SQLite connection. SQLite permits one writer, so the production defaults run one database-writing import at a time and commit messages in short batches. This prevents multiple imports from fighting over the same write lock while preserving resumable checkpoints.

```dotenv
EMAIL_IMPORT_CONCURRENCY=1
EMAIL_IMPORT_BATCH_SIZE=50
EMAIL_IMPORT_THROTTLE_MS=5
EMAIL_IMPORT_LATENCY_THRESHOLD_MS=250
```

When an API request exceeds the latency threshold, the import worker temporarily increases the pause between batches. Current active/queued workers, batch size, and throttle state are shown under **Admin settings > Database** and returned by `GET /api/import-jobs-runtime`.

## PostgreSQL container and data migration

Compose starts a private `postgres:17-alpine` service without publishing port `5432`. Set `ARCHIVE_MAIL_POSTGRES_DIR`, `POSTGRES_DB`, `POSTGRES_USER`, and a long random `POSTGRES_PASSWORD` in `deploy/.env`.

To stop Archive Mail, copy all non-FTS SQLite tables into PostgreSQL, recreate compatible indexes and foreign keys, add PostgreSQL full-text indexes, validate every table's row count, and restart the application:

```bash
./deploy/scripts/migrate-to-postgres.sh
```

The migration is repeatable and replaces the PostgreSQL `archive_mail` schema when `--reset` is used by the wrapper. Attachment bytes remain under `/data/blobs`; database rows retain their content-addressed blob references.

**Runtime status:** the PostgreSQL container and validated data migration are implemented, but the existing `EmailStore` contract is synchronous and backed by `better-sqlite3`. Archive Mail therefore continues serving SQLite after the copy. Selecting PostgreSQL in Admin settings remains disabled until the API storage contract and all service/database calls are converted to the asynchronous PostgreSQL adapter. The migration target is a safe cutover rehearsal and backup, not yet the active runtime database.

## Synology NAS

### SSH/script method

1. Install **Container Manager**.
2. Clone or copy the repository to a local volume such as `/volume1/docker/archive-mail/app`.
3. Copy `deploy/.env.example` to `deploy/.env`.
4. Set:

```dotenv
ARCHIVE_MAIL_DATA_DIR=/volume1/docker/archive-mail/data
ARCHIVE_MAIL_BACKUP_DIR=/volume1/docker/archive-mail/backups
ARCHIVE_MAIL_POSTGRES_DIR=/volume1/docker/archive-mail/postgres
POSTGRES_PASSWORD=replace-with-a-long-random-password
ARCHIVE_MAIL_UID=1026
ARCHIVE_MAIL_GID=100
ARCHIVE_MAIL_BIND_ADDRESS=0.0.0.0
EMAIL_CLIENT_ALLOW_REMOTE_LOGIN=true
```

Use `id -u your-dsm-user` and `id -g your-dsm-user` over SSH instead of assuming the example IDs. Then run:

```bash
cd /volume1/docker/archive-mail/app
./deploy/scripts/deploy.sh
```

### Container Manager project method

Synology Container Manager can create a Project from a Compose file. Choose the repository's `deploy` directory as the project path and use `compose.yaml`; keep `deploy/.env` in that same directory. Build and start the project. The compose build context is the repository root, so the entire repository must remain together.

If Container Manager reuses a stale image or container, create a DSM **Task Scheduler > Scheduled Task > User-defined script** task, run it as `root`, schedule it every minute, and use this command:

```bash
/volume1/docker/archive-mail/app/deploy/scripts/synology-deploy-task.sh
```

Name the task `Archive Mail deployment`. The task exits immediately unless the upload script has created a deployment request marker, so the one-minute schedule does not rebuild continuously. To verify the one-time setup, create `/volume1/docker/archive-mail/backups/rebuild.request` and run the task manually once. The script builds without cache, recreates the service, verifies remote-login configuration, and waits for a healthy container. It never removes the bind-mounted data directory.

After that one-time root-task setup, every deployment is one command from the repository on the Mac:

```bash
./deploy/scripts/push-synology.sh
```

The command asks for the Synology SSH password once, uploads a clean snapshot without local dependencies, build output, Git metadata, or `deploy/.env`, preserves the existing NAS environment file, writes a deployment request for the scheduled root task, waits for the health check, and prints the build result. Override `ARCHIVE_MAIL_NAS_HOST`, `ARCHIVE_MAIL_NAS_APP_DIR`, or `ARCHIVE_MAIL_NAS_BACKUP_DIR` when deploying to a different NAS or path. SSH keys can remove the password prompt, but the script never stores a password.

To avoid typing the override every time, keep a personal launcher next to the scripts — any `*.local.sh` file is git-ignored and excluded from the uploaded snapshot:

```bash
#!/bin/sh
# deploy/scripts/push.local.sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export ARCHIVE_MAIL_NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-user@192.168.1.2}
exec "$SCRIPT_DIR/push-synology.sh" "$@"
```

### Passwordless-sudo rebuild (alternative to the scheduled task)

Instead of the every-minute scheduled task, the SSH account can be allowed to run exactly one root-owned rebuild script without a password. `push-synology.sh` detects this automatically: when the sudo rule exists it rebuilds directly over the same SSH connection and streams the build output live; otherwise it falls back to the deployment-request marker and the scheduled task.

The sudo rule must point at a **root-owned copy outside the app tree**. The copy under `/volume1/docker/archive-mail/app` is replaced by every upload, so a rule targeting it would let the SSH account run arbitrary code as root. One-time setup, as root on the NAS (`sudo -i`):

```bash
cp /volume1/docker/archive-mail/app/deploy/scripts/synology-rebuild.sh /usr/local/bin/archive-mail-rebuild.sh
chown root:root /usr/local/bin/archive-mail-rebuild.sh
chmod 755 /usr/local/bin/archive-mail-rebuild.sh
cat > /etc/sudoers.d/archive-mail <<'EOF'
gliukaz ALL=(root) NOPASSWD: /usr/local/bin/archive-mail-rebuild.sh
EOF
chmod 440 /etc/sudoers.d/archive-mail
visudo -c
```

Replace `gliukaz` with the SSH account name. `visudo -c` must report the files parse correctly before closing the root shell.

Notes:

- The root-owned copy is a deliberate snapshot. When `deploy/scripts/synology-rebuild.sh` changes in the repository, refresh it with the same `cp`/`chown`/`chmod` as root; `push-synology.sh` prints a warning when the two copies differ but continues with the installed one. Requiring root to approve script changes is the security property, not an inconvenience.
- A DSM major update can reset `/etc/sudoers.d`. If a later push falls back to the scheduled-task flow unexpectedly, re-run the one-time setup.
- With the sudo rule in place, the `Archive Mail deployment` scheduled task is redundant and can be disabled or deleted; leaving it enabled is harmless since it exits immediately unless a request marker exists.

Synology documents Project creation and Compose operations in its [Container Manager Project guide](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project?version=7).

## Reverse proxy and HTTPS

Recommended topology:

```text
Browser -> https://mail.example.com -> reverse proxy -> http://127.0.0.1:3001
```

On Synology DSM 7, create the rule under **Control Panel > Login Portal > Advanced > Reverse Proxy**. Set the HTTPS hostname as the source and `127.0.0.1:3001` over HTTP as the destination. Synology's current options are documented in its [Reverse Proxy guide](https://kb.synology.com/en-global/DSM/help/DSM/AdminCenter/system_login_portal_advanced?version=7).

Set the exact external origin in `deploy/.env`:

```dotenv
EMAIL_CLIENT_PUBLIC_URL=https://mail.example.com
EMAIL_CLIENT_TRUST_PROXY=true
```

Archive Mail serves both the UI and API from the same origin. A subpath such as `https://example.com/archive-mail` is not supported; use a dedicated hostname.

`EMAIL_CLIENT_TRUST_PROXY=true` lets authentication throttling and audit history use the forwarded client address. Enable it only when untrusted clients cannot bypass the reverse proxy and connect directly to port `3001`.

## Gmail OAuth on a server

The local desktop launch uses Google's loopback callback. A browser on another computer cannot return to the container through that callback. For the server deployment:

1. Set `EMAIL_CLIENT_PUBLIC_URL` to the HTTPS origin.
2. In Google Cloud, create a **Web application** OAuth client.
3. Add this exact authorized redirect URI:

```text
https://mail.example.com/api/gmail/oauth/callback
```

4. Upload the downloaded Web OAuth JSON under **Admin settings > Gmail**, or set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in `deploy/.env`.

Environment-managed Gmail credentials make those Admin fields read-only. Leaving the variables unset keeps UI management enabled. Existing authorized accounts and refresh tokens are stored in the persistent data directory.

## AI keys

Leave `OPENAI_API_KEY` and `DEEPSEEK_API_KEY` unset to enter keys under **Admin settings > AI**. Set them in `deploy/.env` only when environment management is preferred. The `.env` file and every backup contain sensitive credentials and mail data; restrict access accordingly.

## Property payments and reminders

Property integrations can be configured under **Properties > Communications > Configure**, or with the environment variables listed in [`deploy/.env.example`](.env.example). Admin-saved values take precedence over environment fallbacks and are stored in the persistent data directory.

With `EMAIL_CLIENT_PUBLIC_URL=https://mail.example.com`, configure these exact HTTPS callbacks:

```text
Stripe: https://mail.example.com/api/property-webhooks/stripe
PayPal: https://mail.example.com/api/property-webhooks/paypal
Twilio: https://mail.example.com/api/property-webhooks/twilio/inbound
```

Set `STRIPE_WEBHOOK_SECRET` to Stripe's endpoint signing secret and `PAYPAL_WEBHOOK_ID` to the created PayPal webhook ID. Twilio's incoming-message callback uses the account auth token to validate `X-Twilio-Signature`. The property automation interval defaults to five minutes and can be changed with `PROPERTY_AUTOMATION_INTERVAL_MINUTES`.

Run a provider test-mode transaction before enabling live payments. Browser redirects do not mark payments successful; verified provider state is authoritative. SMS reminders require an explicit opt-in recorded in the Communications tab, and STOP-like inbound messages revoke consent.

## Backups and restore

Create a consistent backup:

```bash
./deploy/scripts/backup.sh
```

The backup script gracefully stops the application so SQLite checkpoints and closes its WAL, archives the complete `/data` directory, restarts the service, and removes backups older than `ARCHIVE_MAIL_BACKUP_RETENTION_DAYS`. Until PostgreSQL becomes the active runtime adapter, create an additional PostgreSQL dump after each migration rehearsal:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres \
  pg_dump -U archive_mail -d archive_mail --clean --if-exists --no-owner \
  | gzip > /srv/archive-mail/backups/archive-mail-postgres.sql.gz
```

Restore a backup:

```bash
./deploy/scripts/restore.sh /srv/archive-mail/backups/archive-mail-YYYYMMDDTHHMMSSZ.tar.gz
```

Restore creates a separate safety backup of the current data first. Test restores periodically and copy backups to another physical device.

Administrators can also create an online property restore point under **Properties > Communications > Backups**. These snapshots are kept under `/data/property-backups` and include SQLite, property documents, request attachments, photos, and relevant integration settings. `PROPERTY_BACKUP_RETENTION` controls the number retained. They complement rather than replace the full stopped-container backup above.

## Security checklist

- Change the bootstrap `admin` PIN `2332` immediately.
- Keep `EMAIL_CLIENT_ALLOW_REMOTE_LOGIN=false` unless the service is limited to a trusted LAN or protected by HTTPS.
- Prefer HTTPS and a dedicated hostname.
- Keep host port `3001` bound to loopback when using a same-host reverse proxy.
- Do not expose the Docker socket to this container.
- Keep `deploy/.env`, `/data`, and backups readable only by the service administrator.
- Back up before upgrades and avoid two containers mounting the same data directory simultaneously.
