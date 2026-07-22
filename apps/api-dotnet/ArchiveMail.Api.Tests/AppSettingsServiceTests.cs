using System.Text.Json;
using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class AppSettingsServiceTests : IDisposable
{
    private readonly string _dataDirectory = Path.Combine(
        Path.GetTempPath(), $"archive-mail-app-settings-{Guid.NewGuid():N}");

    [Fact]
    public void ImportsLegacyNodeGmailSettingsIntoProtectedStorage()
    {
        Directory.CreateDirectory(_dataDirectory);
        File.WriteAllText(Path.Combine(_dataDirectory, "gmail-oauth-settings.json"), JsonSerializer.Serialize(new
        {
            clientId = "legacy.apps.googleusercontent.com",
            clientSecret = "legacy-secret",
            syncIntervalMinutes = 7,
            syncMailboxActions = true
        }));

        var first = new AppSettingsService(ActiveConfiguration());
        var imported = first.Current().GmailValue;

        Assert.Equal("legacy.apps.googleusercontent.com", imported.ClientId);
        Assert.Equal("legacy-secret", imported.ClientSecret);
        Assert.Equal(7, imported.SyncIntervalMinutes);
        Assert.True(imported.SyncMailboxActions);
        Assert.True(File.Exists(first.SettingsPath));
        Assert.DoesNotContain("legacy-secret", File.ReadAllText(first.SettingsPath), StringComparison.Ordinal);

        File.Delete(Path.Combine(_dataDirectory, "gmail-oauth-settings.json"));
        var restarted = new AppSettingsService(ActiveConfiguration());
        Assert.Equal("legacy.apps.googleusercontent.com", restarted.Current().GmailValue.ClientId);
        Assert.Equal("legacy-secret", restarted.Current().GmailValue.ClientSecret);
    }

    [Fact]
    public void ImportsDownloadedGoogleOAuthJsonFromLegacyPath()
    {
        Directory.CreateDirectory(_dataDirectory);
        File.WriteAllText(Path.Combine(_dataDirectory, "gmail-oauth-settings.json"), """
            {"web":{"client_id":"web.apps.googleusercontent.com","client_secret":"web-secret"}}
            """);

        var settings = new AppSettingsService(ActiveConfiguration()).Current().GmailValue;

        Assert.Equal("web.apps.googleusercontent.com", settings.ClientId);
        Assert.Equal("web-secret", settings.ClientSecret);
    }

    private ActiveDatabaseConfiguration ActiveConfiguration() => new(
        DatabaseProviderIds.PostgreSql,
        "Host=unused;Database=unused",
        "test",
        _dataDirectory,
        Path.Combine(_dataDirectory, "database-settings.json"),
        false);

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
