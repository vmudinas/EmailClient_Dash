# Archive Mail .NET services

`ArchiveMail.Api` is the only application API and runtime service. It targets .NET 10, serves the React build and Swagger, and uses PostgreSQL for all durable application state.

`ArchiveMail.Migrator` is a separate one-shot C# utility. It reads a legacy SQLite database in read-only mode, copies it into PostgreSQL, validates table row counts, and exits. SQLite is not referenced by `ArchiveMail.Api` or copied into the production image.

`ArchiveMail.Api.Tests` covers import parsing, checkpoints, batching, configuration, and supporting services.

Run:

```bash
dotnet build apps/api-dotnet/ArchiveMail.Api/ArchiveMail.Api.csproj
dotnet test apps/api-dotnet/ArchiveMail.Api.Tests/ArchiveMail.Api.Tests.csproj
```

The API requires PostgreSQL. SQL Server connection testing is exposed for future configuration, but SQL Server activation remains blocked until it has full schema, query, search, and bulk-import parity.

Legacy imports with an incompatible Node checkpoint are deliberately not resumed. The cutover migrator marks them failed and non-resumable so the operator can clear the partial archive and restart it with the C# version-2 checkpoint format.
