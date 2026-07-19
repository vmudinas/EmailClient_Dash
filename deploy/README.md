# Archive Mail server deployment

This deployment runs the API, scheduler, Gmail sync, import workers, and static web UI in one production container. The Electron desktop application is not included. All durable state lives in one host directory mounted at `/data`.

## Requirements

- Docker Engine with Docker Compose, or Synology DSM 7 Container Manager.
- A writable local-disk directory for SQLite, blobs, uploads, OAuth tokens, saved API keys, and settings.
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

Useful commands:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f archive-mail
docker compose --env-file deploy/.env -f deploy/compose.yaml restart archive-mail
```

Run `./deploy/scripts/deploy.sh` again after pulling source changes. It rebuilds the production image, recreates the service, and waits for `/api/health` to report healthy.

## Synology NAS

### SSH/script method

1. Install **Container Manager**.
2. Clone or copy the repository to a local volume such as `/volume1/docker/archive-mail/app`.
3. Copy `deploy/.env.example` to `deploy/.env`.
4. Set:

```dotenv
ARCHIVE_MAIL_DATA_DIR=/volume1/docker/archive-mail/data
ARCHIVE_MAIL_BACKUP_DIR=/volume1/docker/archive-mail/backups
ARCHIVE_MAIL_UID=1026
ARCHIVE_MAIL_GID=100
```

Use `id -u your-dsm-user` and `id -g your-dsm-user` over SSH instead of assuming the example IDs. Then run:

```bash
cd /volume1/docker/archive-mail/app
./deploy/scripts/deploy.sh
```

### Container Manager project method

Synology Container Manager can create a Project from a Compose file. Choose the repository's `deploy` directory as the project path and use `compose.yaml`; keep `deploy/.env` in that same directory. Build and start the project. The compose build context is the repository root, so the entire repository must remain together.

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

## Backups and restore

Create a consistent backup:

```bash
./deploy/scripts/backup.sh
```

The backup script gracefully stops the container so SQLite checkpoints and closes its WAL, archives the complete data directory, restarts the service, and removes backups older than `ARCHIVE_MAIL_BACKUP_RETENTION_DAYS`.

Restore a backup:

```bash
./deploy/scripts/restore.sh /srv/archive-mail/backups/archive-mail-YYYYMMDDTHHMMSSZ.tar.gz
```

Restore creates a separate safety backup of the current data first. Test restores periodically and copy backups to another physical device.

## Security checklist

- Change the bootstrap `admin` PIN `2332` immediately.
- Prefer HTTPS and a dedicated hostname.
- Keep host port `3001` bound to loopback when using a same-host reverse proxy.
- Do not expose the Docker socket to this container.
- Keep `deploy/.env`, `/data`, and backups readable only by the service administrator.
- Back up before upgrades and avoid two containers mounting the same data directory simultaneously.
