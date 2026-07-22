using ArchiveMail.Api.Infrastructure;
using Npgsql;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class DatabaseSettingsTests : IDisposable
{
    private readonly string _dataDirectory = Path.Combine(
        Path.GetTempPath(),
        $"archive-mail-database-settings-{Guid.NewGuid():N}");

    [Theory]
    [InlineData("postgres", "postgresql")]
    [InlineData("POSTGRESQL", "postgresql")]
    [InlineData("sqlserver", "mssql")]
    [InlineData("mssql", "mssql")]
    public void NormalizesSupportedProviders(string input, string expected)
    {
        Assert.Equal(expected, DatabaseProviderIds.Normalize(input));
    }

    [Theory]
    [InlineData("sqlite")]
    [InlineData("mysql")]
    [InlineData("oracle")]
    public void RejectsUnsupportedProviders(string input)
    {
        Assert.Throws<InvalidOperationException>(() => DatabaseProviderIds.Normalize(input));
    }

    [Fact]
    public void EncryptsPersistedConnectionStringAndCanReadItAfterRestart()
    {
        const string connectionString = "Host=db;Database=mail;Username=archive;Password=do-not-leak";
        var firstProcess = new DatabaseSettingsStore(_dataDirectory);

        firstProcess.Save(DatabaseProviderIds.PostgreSql, connectionString);

        var json = File.ReadAllText(firstProcess.SettingsPath);
        Assert.DoesNotContain("do-not-leak", json, StringComparison.Ordinal);
        Assert.DoesNotContain("Password", json, StringComparison.OrdinalIgnoreCase);

        var restartedProcess = new DatabaseSettingsStore(_dataDirectory);
        var loaded = restartedProcess.TryLoad();
        Assert.NotNull(loaded);
        Assert.Equal(DatabaseProviderIds.PostgreSql, loaded.Value.Provider);
        Assert.Equal(connectionString, loaded.Value.ConnectionString);
    }

    [Fact]
    public void MasksPasswordsBeforeReturningConnectionDetails()
    {
        var postgres = DatabaseSettingsService.MaskConnectionString(
            DatabaseProviderIds.PostgreSql,
            "Host=db;Database=mail;Username=archive;Password=postgres-secret");
        var sqlServer = DatabaseSettingsService.MaskConnectionString(
            DatabaseProviderIds.SqlServer,
            "Server=db;Database=mail;User Id=archive;Password=sql-secret;TrustServerCertificate=true");

        Assert.DoesNotContain("postgres-secret", postgres, StringComparison.Ordinal);
        Assert.DoesNotContain("sql-secret", sqlServer, StringComparison.Ordinal);
        Assert.Contains("********", postgres, StringComparison.Ordinal);
        Assert.Contains("********", sqlServer, StringComparison.Ordinal);
    }

    [Fact]
    public void AppliesConfiguredSchemaToExplicitPostgresConnections()
    {
        var normalized = PostgresSettings.ApplyRuntimeDefaults(
            "Host=db;Database=mail;Username=archive;Password=secret",
            "tenant_mail");
        var builder = new NpgsqlConnectionStringBuilder(normalized);

        Assert.Equal("tenant_mail,public", builder.SearchPath);
        Assert.Equal("archive-mail-csharp", builder.ApplicationName);
        Assert.False(builder.NoResetOnClose);
    }

    [Fact]
    public void ReplacesConflictingExplicitSearchPathWithRuntimeSchema()
    {
        var normalized = PostgresSettings.ApplyRuntimeDefaults(
            "Host=db;Database=mail;Search Path=public",
            "archive_mail");

        Assert.Equal("archive_mail,public", new NpgsqlConnectionStringBuilder(normalized).SearchPath);
    }

    [Theory]
    [InlineData("bad-schema")]
    [InlineData("schema,public")]
    [InlineData("1schema")]
    public void RejectsUnsafeRuntimeSchemas(string schema)
    {
        Assert.Throws<InvalidOperationException>(() =>
            PostgresSettings.ApplyRuntimeDefaults("Host=db;Database=mail", schema));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
