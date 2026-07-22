using ArchiveMail.Api.Infrastructure;
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

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
