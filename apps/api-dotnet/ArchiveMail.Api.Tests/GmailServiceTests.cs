using System.Text.Json;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class GmailServiceTests : IDisposable
{
    private readonly string _dataDirectory = Path.Combine(
        Path.GetTempPath(), $"archive-mail-gmail-service-{Guid.NewGuid():N}");

    [Fact]
    public void StartsDesktopOAuthWithoutAClientSecret()
    {
        Directory.CreateDirectory(_dataDirectory);
        var active = new ActiveDatabaseConfiguration(
            DatabaseProviderIds.PostgreSql,
            "Host=unused;Database=unused",
            "test",
            _dataDirectory,
            Path.Combine(_dataDirectory, "database-settings.json"),
            false);
        var settings = new AppSettingsService(active);
        settings.UpdateGmail(JsonSerializer.SerializeToElement(new
        {
            clientId = "desktop.apps.googleusercontent.com"
        }));
        var service = new GmailService(
            null!, settings, null!, null!, active, null!, NullLogger<GmailService>.Instance);

        var result = JsonSerializer.SerializeToElement(service.StartAuthorization(
            JsonSerializer.SerializeToElement(new { }),
            "owner-1",
            "http://localhost:3001/api/gmail/oauth/callback"));
        var authorizationUrl = result.GetProperty("authorizationUrl").GetString();

        Assert.NotNull(authorizationUrl);
        Assert.Contains("client_id=desktop.apps.googleusercontent.com", authorizationUrl, StringComparison.Ordinal);
        Assert.Contains("code_challenge=", authorizationUrl, StringComparison.Ordinal);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
