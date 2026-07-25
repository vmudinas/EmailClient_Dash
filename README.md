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

## Database configuration

PostgreSQL can be configured by environment variables or through Admin settings. Saved connection settings are protected outside the mail database so the app can reconnect on startup. The settings UI can test PostgreSQL and Microsoft SQL Server connection strings, but PostgreSQL is the only activatable runtime provider today; SQL Server requires a complete schema, search, and bulk-import adapter before activation is safe.

## Authentication and integrations

The first fresh database creates the `admin` account with a temporary PIN that must be changed on first use; the value is documented in [`deploy/README.md`](deploy/README.md) rather than shown in the sign-in screen. Use HTTPS outside a trusted local network.

Accounts carry one of four roles. `admin` has full control, `user` gets a private mail and calendar workspace with per-screen permissions, `renter` is limited to its linked tenant portal, and `lucas` opens only the Lithuanian trainer described below.

## Lithuanian trainer

Accounts with the `lucas` role sign in to a single screen for practising Lithuanian vocabulary. A word pair is one Lithuanian word beside its English translation. Only the Lithuanian side is spoken and recorded — the English word states the meaning and is not something being learned. The browser speaks the word with `speechSynthesis` at `lt-LT`, and the learner records their own attempt with `MediaRecorder`.

**Scoring.** The recording is uploaded and transcribed on the server with OpenAI speech-to-text (`gpt-4o-transcribe`, `language=lt`). `LithuanianScoring` then compares the transcript to the target word: both are lowercased, stripped of punctuation, and folded to plain letters (recognizers are inconsistent about `ą č ę ė į š ų ū ž`), then measured by Levenshtein distance as a percentage. **85% or higher passes.** The expected word is deliberately never sent as a prompt — that would bias the recognizer toward returning it and inflate every score.

The browser also transcribes locally where it can, and that result is used only as a fallback when no key is configured or the API call fails. Either way the take is saved with its date; an unscored take is marked as such rather than discarded.

What this measures is which word was recognised, not how closely the learner's voice matches a particular speaker — comparing a child's voice to a synthesized one as raw audio would produce a number with nothing behind it.

**Configuration and privacy.** Admin settings has a **Lithuanian** section holding the trainer's own OpenAI key and model, stored encrypted in `app-settings.protected.json` alongside the other secrets. It is deliberately separate from the mail AI providers: practice recordings are uploaded to OpenAI, and removing this one key stops those uploads without affecting mail analysis. `LITHUANIAN_OPENAI_API_KEY` overrides the saved value. With no key configured, nothing is uploaded and takes are saved unscored.

**Daily goal.** One new word a day. The screen leads with today's date and says whether the word is still owed, how long the current streak is, and how many days have passed since the last one. Days are the learner's local days, computed in the browser, because the stored timestamps are UTC and a UTC boundary would call yesterday's word today's.

Recordings are written under `<data directory>/lithuanian-recordings` and capped at 8 MB each; `lithuanian_words` and `lithuanian_recordings` hold the metadata, transcript, score, and date. The screen is laid out mobile-first because it is mainly used on a phone. The microphone requires a secure context, so serve the app over HTTPS for recording to be available on a phone or laptop.

The installation seeds a `lucas` account on startup when one does not already exist. Its PIN can be reset from Admin settings and Users like any other account.

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
