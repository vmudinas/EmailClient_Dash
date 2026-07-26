using System.Text.Json;
using System.Net;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Infrastructure;
using Microsoft.AspNetCore.WebUtilities;
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
            null!, settings, null!, null!, null!, active, null!, NullLogger<GmailService>.Instance);

        var result = JsonSerializer.SerializeToElement(service.StartAuthorization(
            JsonSerializer.SerializeToElement(new { }),
            "owner-1",
            "http://localhost:3001/api/gmail/oauth/callback"));
        var authorizationUrl = result.GetProperty("authorizationUrl").GetString();

        Assert.NotNull(authorizationUrl);
        Assert.Contains("client_id=desktop.apps.googleusercontent.com", authorizationUrl, StringComparison.Ordinal);
        Assert.Contains("code_challenge=", authorizationUrl, StringComparison.Ordinal);
        var scopes = QueryHelpers.ParseQuery(new Uri(authorizationUrl).Query)["scope"].ToString().Split(' ');
        Assert.Contains("https://www.googleapis.com/auth/gmail.readonly", scopes);
        Assert.Contains("https://www.googleapis.com/auth/gmail.send", scopes);
        Assert.Contains("https://www.googleapis.com/auth/gmail.settings.basic", scopes);
        Assert.Contains("https://www.googleapis.com/auth/calendar.events", scopes);
        Assert.Contains("https://www.googleapis.com/auth/calendar.calendarlist.readonly", scopes);
    }

    [Fact]
    public void ConnectionUpsertSuppliesRequiredProgressValues()
    {
        var sql = string.Join(
            " ",
            GmailService.ConnectionUpsertSql.Split(
                (char[]?)null,
                StringSplitOptions.RemoveEmptyEntries));

        Assert.Contains(
            "status,processed_items,total_items,imported_items,can_send",
            sql,
            StringComparison.Ordinal);
        Assert.Contains(
            "'connected',0,NULL,0,$10",
            sql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void MovingAConnectionRewritesOnlyItsDestination()
    {
        // Moving is not reauthorizing. The refresh token, the granted scopes and last_synced_at all
        // survive untouched - a token belongs to the Google account, not to the archive it fills -
        // and the row is addressed by id so one move cannot take another connection with it.
        var sql = GmailService.MoveDestinationSql;
        Assert.Contains("SET archive_id=$2,folder_id=$3", sql, StringComparison.Ordinal);
        Assert.Contains("WHERE id=$1", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("refresh_token", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("last_synced_at", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("can_send", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void ReauthorizingStillCannotRedirectAnAccountsMail()
    {
        // The move endpoint exists precisely because this stays true: finishing an authorization
        // for an existing connection reads its archive and folder back out of the row and ignores
        // whatever the request asked for, so a stray authorization cannot capture someone's mail.
        Assert.Contains(
            "SELECT g.email,g.archive_id,g.folder_id",
            GmailService.ExistingConnectionSql,
            StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE", GmailService.ExistingConnectionSql, StringComparison.Ordinal);
    }

    [Fact]
    public void ExistingGmailSchemaGetsProgressDefaultsRepaired()
    {
        Assert.Contains(
            "ALTER TABLE gmail_connections ALTER COLUMN processed_items SET DEFAULT 0;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE gmail_connections ALTER COLUMN imported_items SET DEFAULT 0;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ExistingCutoverSchemaGetsGmailImportConflictIndexesRepaired()
    {
        Assert.Contains(
            "CREATE UNIQUE INDEX folders_archive_path_conflict_idx ON folders(archive_id, path);",
            DatabaseInitializer.CoreSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "CREATE UNIQUE INDEX messages_archive_source_key_conflict_idx ON messages(archive_id, source_key);",
            DatabaseInitializer.CoreSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "CREATE UNIQUE INDEX deferred_attachment_jobs_message_conflict_idx ON deferred_attachment_jobs(message_id);",
            DatabaseInitializer.CoreSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "Gmail sync was interrupted. Start Gmail sync again.",
            DatabaseInitializer.CoreSchemaSql,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(HttpStatusCode.TooManyRequests, true)]
    [InlineData(HttpStatusCode.InternalServerError, true)]
    [InlineData(HttpStatusCode.BadGateway, true)]
    [InlineData(HttpStatusCode.ServiceUnavailable, true)]
    [InlineData(HttpStatusCode.GatewayTimeout, true)]
    [InlineData(HttpStatusCode.BadRequest, false)]
    [InlineData(HttpStatusCode.Unauthorized, false)]
    public void RetriesOnlyTransientGoogleResponses(HttpStatusCode status, bool expected)
    {
        Assert.Equal(expected, GmailService.TransientGoogleStatus(status));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
