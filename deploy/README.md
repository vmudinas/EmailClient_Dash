# Archive Mail server deployment

This deployment runs the API, scheduler, Gmail sync, import workers, Swagger, and static React UI in one C# production container, plus a private PostgreSQL runtime database. Node is used only while building the React assets. Uploaded content and protected settings remain under `/data`; PostgreSQL uses its own host directory.

## Requirements

- Docker Engine with Docker Compose, or Synology DSM 7 Container Manager.
- A writable local-disk directory for blobs, uploads, saved API keys, and settings.
- A second writable local-disk directory for PostgreSQL and a long random `POSTGRES_PASSWORD`.
- A reverse proxy with HTTPS when the app is accessed outside a trusted LAN or when Gmail is authorized from another computer.

Do not place the data or PostgreSQL directory on NFS, SMB, Synology Drive, Cloud Sync, or another synchronized/network filesystem. Keep both on local server or NAS volumes.

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

Use HTTPS for access beyond a trusted LAN. Authentication is cookie-based and role checks are enforced by the C# API.

Useful commands:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f archive-mail
docker compose --env-file deploy/.env -f deploy/compose.yaml restart archive-mail
```

Run `./deploy/scripts/deploy.sh` again after pulling source changes. It rebuilds the production image, recreates the service, and waits for `/api/health` to report healthy.

The one-time cutover migrator creates the PostgreSQL schema before the application starts. Existing mail and account configuration are retained; newly created users begin with empty private mail and calendar workspaces.

## API and schema verification

Every production image build runs the React and C# test suites before publishing
the image. The API startup then verifies the live PostgreSQL schema against all
declared tables, columns, required defaults, nullability rules, and named unique
indexes. After the container becomes healthy, every deployment entry point runs
`smoke-api.py` against the live service. It loads the React entry page and every
referenced production asset, inventories live Swagger, and verifies that every
protected operation rejects an unauthenticated request. Any build-test, schema,
UI-asset, Swagger, or route-authentication failure makes the deployment fail
instead of reporting success.

Run the read-only OpenAPI smoke test against a reachable service:

```bash
ARCHIVE_MAIL_BASE_URL=http://127.0.0.1:3001 \
  node deploy/scripts/smoke-api.mjs
```

Without credentials it checks Swagger, the health handler, and authentication
enforcement for every protected operation. To exercise authenticated GET
handlers, supply a temporary token or explicitly supply a test account PIN:

```bash
ARCHIVE_MAIL_BASE_URL=http://127.0.0.1:3001 \
ARCHIVE_MAIL_SMOKE_TOKEN=replace-with-temporary-token \
  node deploy/scripts/smoke-api.mjs
```

Mutation checks are disabled by default because they create and delete test
data. Enable `ARCHIVE_MAIL_SMOKE_ALLOW_MUTATIONS=true` only against an isolated
test database.

## Large imports

Imports use native parallel PST extraction, bounded asynchronous MIME parsing, and PostgreSQL binary `COPY` batches. Each committed batch includes its version-2 checkpoint, so a replacement C# process can resume after its worker lease expires.

```dotenv
ARCHIVE_MAIL_IMPORT_BATCH_SIZE=1000
ARCHIVE_MAIL_IMPORT_PARSER_CONCURRENCY=4
ARCHIVE_MAIL_IMPORT_READPST_JOBS=4
ARCHIVE_MAIL_IMPORT_LEASE_SECONDS=120
```

Current active/queued workers and import configuration are returned by `GET /api/import-jobs-runtime`.

## PostgreSQL runtime and one-time cutover

Compose starts a private `postgres:17-alpine` service without publishing port `5432`. Set `ARCHIVE_MAIL_POSTGRES_DIR`, `POSTGRES_DB`, `POSTGRES_USER`, and a long random `POSTGRES_PASSWORD` in `deploy/.env`.

The project runs a one-shot `postgres-migrate` service before the first PostgreSQL-backed start. With `ARCHIVE_MAIL_POSTGRES_MIGRATE_ON_DEPLOY=true`, it first saves any existing PostgreSQL database to `/data/postgres-before-cutover-<timestamp>.dump`, replaces the PostgreSQL schema with a row-count-validated copy of the legacy SQLite database, and then writes `/data/postgres-cutover.complete`. The C# service creates its PostgreSQL-native tables, full-text indexes, and triggers when it starts. The marker makes every later deployment preserve the live database instead of replaying stale SQLite data.

To stop Archive Mail, copy all non-FTS SQLite tables into PostgreSQL, recreate compatible indexes and foreign keys, add PostgreSQL full-text indexes, validate every table's row count, and restart the application:

```bash
./deploy/scripts/migrate-to-postgres.sh
```

The wrapper stops Archive Mail before taking the final SQLite snapshot. The migration replaces the PostgreSQL `archive_mail` schema once; attachment bytes remain under `/data/blobs` and database rows retain their content-addressed blob references.

**Runtime status:** PostgreSQL is the only production runtime database for mail, users, sessions, rules, jobs, property records, and search. The production application has no SQLite dependency. `Microsoft.Data.Sqlite` exists only in the separate one-time C# migrator and its tests. Keep the legacy SQLite file briefly as a rollback artifact, then archive or remove it only after the PostgreSQL-backed application and backups have been verified.

## Synology NAS

### One-click deployment from this Mac

Run the launchers on the Mac that contains this repository. Do not copy them into an SSH session and do not run Docker locally. The launcher uploads the current repository snapshot; the Synology NAS performs the image build, one-time database migration, container replacement, and health check.

1. In DSM, enable **Control Panel > Terminal & SNMP > Enable SSH service** and install **Container Manager**.
2. Double-click `deploy-to-synology.command` in the repository root. On its first run, enter the Synology SSH password and then the Synology sudo password when asked. The launcher installs a dedicated SSH key and grants only the root-owned Archive Mail rebuild command passwordless sudo access before continuing with the deployment.
3. Keep the Terminal window open while Synology builds the images and performs the health check. Future double-click deployments should require no command entry or password.
4. Open `http://synology.local:3001`. The deployment succeeds only after `/api/health` identifies the C# API and PostgreSQL database.

Use `setup-synology-deploy.command` separately only to repair or refresh passwordless deployment access after a DSM upgrade or a privileged rebuild-script change.

For this existing installation, the personal launcher also requires either the legacy `archive-mail.sqlite` file or the completed PostgreSQL cutover marker in the configured NAS data directory. This prevents a wrong `ARCHIVE_MAIL_DATA_DIR` from silently creating an empty database.

The uploader preserves the NAS copy of `deploy/.env`, generates missing PostgreSQL settings, creates the PostgreSQL and backup directories, uploads uncommitted local changes, rebuilds both images, performs the SQLite cutover once, and waits for a healthy application. A GitHub push is not required for deployment, although the completed source should still be committed and pushed separately for version history and recovery.

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

Name the task `Archive Mail deployment`. The task exits immediately unless the upload script has created a deployment request marker, so the one-minute schedule does not rebuild continuously. To verify the one-time setup, create `/volume1/docker/archive-mail/backups/rebuild.request` and run the task manually once. The script rebuilds changed source and test layers while reusing expensive package layers, recreates the services, verifies the C# and PostgreSQL health response, and never removes the bind-mounted data directory.

After that one-time root-task setup, every deployment is one command from the repository on the Mac:

```bash
./deploy/scripts/push-synology.sh
```

The command uploads a clean snapshot without local dependencies, build output, Git metadata, or `deploy/.env`, preserves the existing NAS environment file, backfills missing PostgreSQL settings with a generated password, runs the root-owned rebuild command (or requests the scheduled task fallback), waits for migration and the C# PostgreSQL health check, and prints the build result. Override `ARCHIVE_MAIL_NAS_HOST`, `ARCHIVE_MAIL_NAS_APP_DIR`, `ARCHIVE_MAIL_NAS_BACKUP_DIR`, or `ARCHIVE_MAIL_NAS_POSTGRES_DIR` when deploying to a different NAS or path. `setup-synology-deploy.command` installs a dedicated SSH key, but the scripts never store a password.

To avoid typing the override every time, keep a personal launcher next to the scripts — any `*.local.sh` file is git-ignored and excluded from the uploaded snapshot:

```bash
#!/bin/sh
# deploy/scripts/push.local.sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export ARCHIVE_MAIL_NAS_HOST=${ARCHIVE_MAIL_NAS_HOST:-user@192.168.1.2}
export ARCHIVE_MAIL_REQUIRE_EXISTING_DATA=${ARCHIVE_MAIL_REQUIRE_EXISTING_DATA:-true}
exec "$SCRIPT_DIR/push-synology.sh" "$@"
```

### Passwordless-sudo rebuild (alternative to the scheduled task)

Instead of the every-minute scheduled task, the SSH account can be allowed to run exactly one root-owned rebuild script without a password. Double-click `setup-synology-deploy.command` to configure it. `push-synology.sh` detects this automatically: when the sudo rule exists and the installed script matches the repository, it rebuilds directly over the same SSH connection and streams the build output live; otherwise it falls back to the deployment-request marker and the scheduled task.

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

- The root-owned copy is a deliberate snapshot. When `deploy/scripts/synology-rebuild.sh` changes, run `setup-synology-deploy.command` again. The uploader never executes an outdated privileged copy; it uses the DSM scheduled-task fallback when one is configured.
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

For the standard Synology deployment, update these settings on the NAS and
recreate the container with one command from the repository root:

```sh
./configure-synology-public-url.command https://mail.example.com
```

The command backs up the NAS environment file, sets the public URL and trusted
proxy mode, binds the application port to `127.0.0.1`, and runs the existing
deployment health check. The default URL is `https://vts.i234.me` when the
argument is omitted.

### "Deploy succeeded but I can't open the app" — NAT hairpin

`ARCHIVE_MAIL_BIND_ADDRESS=127.0.0.1` (the default and recommended value) means
port `3001` listens on the NAS loopback interface only. This is intentional:
outside traffic is meant to arrive through the HTTPS reverse proxy, never by
hitting the container port directly. Two consequences that look like failures
but are not:

- **`http://<nas-ip>:3001/` or `http://synology.local:3001/` refuses/hangs from
  any other machine.** Correct — the port is not published to the LAN. Use the
  reverse-proxy URL (`EMAIL_CLIENT_PUBLIC_URL`) instead.
- **The deploy reports success but the public URL is unreachable *from your own
  network*.** The deploy health check runs *on the NAS* against
  `http://127.0.0.1:3001/api/health`, so it passes even when outside access is
  broken. When your workstation and the NAS share one public IP (both behind the
  same router), opening `https://<your-domain>` asks the router to route traffic
  to your own WAN address and bounce it back inside — **NAT hairpin / loopback**.
  Many routers don't support it: TLS connects, then the HTTP response never
  returns. External clients (a phone on cellular) are unaffected.

Confirm the diagnosis by reaching the NAS over the LAN with the real hostname —
this should return `{"status":"ok",...}` even when the public URL hangs:

```sh
curl -k --resolve <your-domain>:443:<nas-lan-ip> https://<your-domain>/api/health
```

Fixes, cheapest first:

1. **Per-machine hosts override (quick):** point the hostname at the LAN IP on
   the affected workstation.

   ```sh
   echo "<nas-lan-ip> <your-domain>" | sudo tee -a /etc/hosts
   ```

2. **Split-horizon DNS (network-wide, preferred):** run the Synology **DNS
   Server** package (or your router's local DNS) and add an A record resolving
   `<your-domain>` to `<nas-lan-ip>` for clients inside the LAN. Every device at
   home then reaches the NAS directly and skips the hairpin; external clients
   keep resolving the public IP via public DNS.

3. **Enable NAT loopback / hairpin NAT** on the router, if it offers the option.

Only options 2 and 3 are network-wide; the hosts entry fixes a single machine.

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

The backup script gracefully stops the application, creates a custom-format PostgreSQL dump, archives that dump with the complete `/data` directory, restarts the service, and removes backups older than `ARCHIVE_MAIL_BACKUP_RETENTION_DAYS`.

Restore a backup:

```bash
./deploy/scripts/restore.sh /srv/archive-mail/backups/archive-mail-YYYYMMDDTHHMMSSZ.tar.gz
```

Restore creates a separate PostgreSQL-plus-files safety backup of the current installation first, restores the dump with `pg_restore`, and then starts Archive Mail. Test restores periodically and copy backups to another physical device.

Administrators can also create an online property restore point under **Properties > Communications > Backups**. These snapshots are kept under `/data/property-backups` and include a PostgreSQL custom-format dump, property documents, request attachments, photos, and relevant integration settings. `PROPERTY_BACKUP_RETENTION` controls the number retained. They complement rather than replace the full stopped-container backup above.

## Security checklist

- Change the bootstrap `admin` PIN `2332` immediately.
- Prefer HTTPS and a dedicated hostname.
- Keep host port `3001` bound to loopback when using a same-host reverse proxy.
- Do not expose the Docker socket to this container.
- Keep `deploy/.env`, `/data`, and backups readable only by the service administrator.
- Back up before upgrades and avoid two containers mounting the same data directory simultaneously.
