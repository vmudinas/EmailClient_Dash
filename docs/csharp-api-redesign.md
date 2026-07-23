# C# and PostgreSQL cutover

## Final state

Archive Mail now has one application runtime:

```text
React browser client
        |
ASP.NET Core 10
  - static React files
  - REST API and Swagger
  - PST/MBOX import workers
  - scheduled AI, Gmail, and property work
        |
PostgreSQL
```

The Electron application and Fastify API were removed. Node remains only in the development and image-build stages for TypeScript, Vite, and React tests. No Node executable or package is copied into the runtime image.

The ASP.NET Core API implements the routes used by the React client for authentication and users, archives, folders, messages and search, uploads and imports, sender filing and smart rules, diagnostics and audit, settings, Gmail send/sync/OAuth, Google and Apple calendars, todos/follow-ups/drafts/resumes, AI jobs and schedules, news/stocks, and property management.

## Import design

New imports use:

- native parallel PST extraction with `readpst`;
- bounded asynchronous MIME parsing with MimeKit;
- PostgreSQL binary `COPY` batches;
- checkpoint updates in the same transaction as each committed batch;
- renewable worker leases and `FOR UPDATE SKIP LOCKED` claims;
- deferred attachment materialization;
- statement-level counter triggers.

The checkpoint format is version 2. A partially completed legacy Node job cannot be resumed safely because its source keys and checkpoints differ. During SQLite cutover it is marked failed and non-resumable. The partial archive remains available until an administrator clears it and restarts the import.

## Database boundary

`ArchiveMail.Api` links only PostgreSQL and Microsoft SQL Server client libraries. PostgreSQL is the required and only active runtime provider. SQL Server connection strings can be saved and tested for future deployment work, but activation is intentionally rejected until its schema, full-text search, query dialect, and bulk writer are implemented and validated.

SQLite appears only in `ArchiveMail.Migrator`, which is built into a separate one-shot image. It opens the legacy database read-only and is not part of normal application startup after `/data/postgres-cutover.complete` exists.

## Cutover gates

The deployment scripts enforce these gates:

1. PostgreSQL must pass its health check.
2. The application is stopped before the final SQLite snapshot.
3. Any existing PostgreSQL database is saved as a timestamped custom-format dump.
4. Schema replacement requires the migrator's explicit `--confirm-reset` flag.
5. Every copied table must have an identical source and destination row count.
6. The durable cutover marker is written only after migration succeeds.
7. The long-running container starts only after the one-shot migrator exits successfully.
8. Deployment health must report `api=csharp` and `database=postgresql`.

After the marker exists, ordinary deployments preserve PostgreSQL and never replay the stale SQLite file.

## Verification

Use:

```bash
npm run test:run -w @email-client/web
npm run build:web
dotnet test apps/api-dotnet/ArchiveMail.Api.Tests/ArchiveMail.Api.Tests.csproj
docker build -f deploy/Dockerfile -t archive-mail:local .
docker compose --env-file deploy/.env -f deploy/compose.yaml config
```

For a real migration rehearsal, use an isolated PostgreSQL database and a copy of the legacy SQLite file. Verify authentication, archive/folder/message counts, search, imported attachment access, settings, and at least one restarted version-2 import before deleting the rollback copy.
