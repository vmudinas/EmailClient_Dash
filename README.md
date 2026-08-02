# Archive Mail

Archive Mail is a browser-based React application served by one ASP.NET Core service. PostgreSQL is the only production database. The C# process owns the API, Swagger, static React files, PST/MBOX imports, scheduled work, Gmail synchronization, calendars, AI jobs, sender rules, and property-management services.

There is no Electron application and no Node API. Node.js is used only to build and develop the React workspace.

## Production architecture

```text
Browser -> ASP.NET Core :3001 -> PostgreSQL
                    |-> /api/*
                    |-> /swagger
                    |-> React static files
                    |-> import, Gmail, AI, and property workers
```

The runtime image contains .NET 10, the compiled React assets, `readpst`, and PostgreSQL client tools. It does not contain Node.js, Fastify, Electron, or a SQLite runtime provider.

## Run locally

Requirements:

- .NET SDK 10
- Node.js 22 or newer
- PostgreSQL 16 or newer

Set the PostgreSQL environment variables, install the React dependencies, and start both development processes:

```bash
export PGHOST=127.0.0.1
export PGPORT=5432
export PGDATABASE=archive_mail
export PGUSER=archive_mail
export PGPASSWORD=replace-me
export POSTGRES_SCHEMA=archive_mail

npm ci
npm run dev
```

The Vite UI is available on its printed development URL. The C# API serves Swagger at `http://localhost:3001/swagger` and reports its runtime at `http://localhost:3001/api/health`.

For the production-style local server:

```bash
npm run build:web
dotnet run --project apps/api-dotnet/ArchiveMail.Api/ArchiveMail.Api.csproj
```

## Deploy with Docker

The supported deployment is defined in [`deploy/compose.yaml`](deploy/compose.yaml):

- `archive-mail`: the single long-running C# application container
- `postgres`: the single PostgreSQL database container
- `postgres-migrate`: a one-shot cutover job that exits before the app starts

Configure and deploy:

```bash
cp deploy/.env.example deploy/.env
${EDITOR:-vi} deploy/.env
./deploy/scripts/deploy.sh
```

See [`deploy/README.md`](deploy/README.md) for Synology, reverse proxy, Gmail OAuth, backup, restore, and troubleshooting instructions.

For the configured Synology installation, double-click `deploy-to-synology.command` on the Mac. Its first run configures passwordless deployment and then continues automatically; the NAS performs the Docker build, one-time SQLite cutover, PostgreSQL startup, and health verification.

## One-time SQLite cutover

SQLite is supported only by the separate C# migration utility so an existing installation can be moved once. It is never opened by the production API.

Before the first cutover:

1. Back up the existing `/data` directory.
2. Configure a new PostgreSQL data directory and password in `deploy/.env`.
3. Keep `archive-mail.sqlite` in the configured data directory.
4. Run `./deploy/scripts/migrate-to-postgres.sh`, or enable the one-time Compose migration.

The migrator stops the app, saves any existing PostgreSQL database to a timestamped dump, replaces the target schema, copies every non-FTS SQLite table with PostgreSQL binary `COPY`, recreates indexes and foreign keys, validates every row count, and writes `/data/postgres-cutover.complete` only after success. The C# service then creates or upgrades its PostgreSQL-native schema and search indexes.

Incomplete legacy Node imports cannot use the C# checkpoint format. They are retained for inspection but marked failed and non-resumable during cutover; clear the partial job and restart the source file with the C# importer. New C# imports checkpoint every committed batch and resume after restart or redeployment.

Keep the old SQLite file as a short-lived rollback artifact until the PostgreSQL application and backups have been verified. It can then be archived or removed from the server data directory.

## Imports

PST imports use parallel `readpst` extraction, bounded asynchronous MIME parsing, batched PostgreSQL binary `COPY`, and durable checkpoints. MBOX imports use the same batch writer and checkpoint model. Attachment/blob materialization runs separately so message ingestion does not wait for every blob operation.

Useful deployment controls:

```dotenv
ARCHIVE_MAIL_IMPORT_BATCH_SIZE=1000
ARCHIVE_MAIL_IMPORT_PARSER_CONCURRENCY=4
ARCHIVE_MAIL_IMPORT_READPST_JOBS=4
ARCHIVE_MAIL_IMPORT_LEASE_SECONDS=120
```

Progress is persisted in PostgreSQL. A running job whose lease expires can be claimed by the replacement C# process from its last committed version-2 checkpoint.

Combining archives and combining mailboxes both run as jobs on the same progress model, and both carry any connected Google account across with them: the merged archive keeps syncing, and merged messages keep the source keys their Gmail account dedupes against, so a later full pull does not re-import the mailbox.

To point a connected account somewhere else without merging anything, use **Move** on the account in the Gmail dialog. This changes only where future syncs are filed — the Google grant is untouched, so nothing is reauthorized, and mail already downloaded stays in the archive it landed in. Reauthorizing deliberately cannot do this: it pins the connection's existing destination so that finishing an authorization can never redirect an account's mail.

## Database configuration

PostgreSQL can be configured by environment variables or through Admin settings. Saved connection settings are protected outside the mail database so the app can reconnect on startup. The settings UI can test PostgreSQL and Microsoft SQL Server connection strings, but PostgreSQL is the only activatable runtime provider today; SQL Server requires a complete schema, search, and bulk-import adapter before activation is safe.

## Authentication and integrations

The first fresh database creates the `admin` account with a temporary PIN that must be changed on first use; the value is documented in [`deploy/README.md`](deploy/README.md) rather than shown in the sign-in screen. Use HTTPS outside a trusted local network.

Accounts carry one of three roles. `admin` has full control, `user` gets a private mail and calendar workspace with per-screen permissions, and `renter` is limited to its linked tenant portal.

Gmail OAuth needs a Web application callback when deployed remotely:

```text
https://mail.example.com/api/gmail/oauth/callback
```

Application secrets can be supplied through `deploy/.env` or saved in Admin settings. Saved values are encrypted with persistent ASP.NET Core data-protection keys under `/data`.

## Validation

```bash
npm run test:run -w @email-client/web
npm run build:web
dotnet test apps/api-dotnet/ArchiveMail.Api.Tests/ArchiveMail.Api.Tests.csproj
docker build -f deploy/Dockerfile -t archive-mail:local .
docker compose --env-file deploy/.env -f deploy/compose.yaml config
```

The health response must identify the cutover runtime:

```json
{"status":"ok","api":"csharp","database":"postgresql","importer":"async-batched-resumable"}
```
