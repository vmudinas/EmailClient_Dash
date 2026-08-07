using System.Text.Json;
using System.Net;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Productivity;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Logging.Abstractions;
using MimeKit;
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
            null!, settings, null!, null!, null!, active, null!, null!, NullLogger<GmailService>.Instance);

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
    public void IncrementalSyncOverlapsThePreviousWatermark()
    {
        var query = GmailService.BuildIncrementalQuery(
            "newer_than:30d",
            "2026-08-06T12:10:00.0000000+00:00");

        var expected = new DateTimeOffset(2026, 8, 6, 12, 5, 0, TimeSpan.Zero).ToUnixTimeSeconds();
        Assert.Equal($"newer_than:30d after:{expected}", query);
    }

    [Fact]
    public void FirstSyncDoesNotInventAWatermark()
    {
        Assert.Equal("newer_than:30d", GmailService.BuildIncrementalQuery(" newer_than:30d ", null));
    }

    [Fact]
    public void GmailConversationKeysAreConnectionScoped()
    {
        Assert.Equal("gmail:connection-1:thread-1", GmailService.GmailConversationKey("connection-1", "thread-1"));
        Assert.NotEqual(
            GmailService.GmailConversationKey("connection-1", "thread-1"),
            GmailService.GmailConversationKey("connection-2", "thread-1"));
    }

    [Fact]
    public void GmailLabelsCannotHideAReplyOrOverwriteAHighValueCategory()
    {
        var reply = GmailService.ApplyGmailLabels(
            "person@example.test", "Re: project", "Following up",
            "{\"in-reply-to\":\"<first@example.test>\"}",
            new HashSet<string> { "CATEGORY_PROMOTIONS", "INBOX" });
        var job = GmailService.ApplyGmailLabels(
            "recruiter@example.test", "Interview for the platform role", "",
            "{}", new HashSet<string> { "CATEGORY_UPDATES" });

        Assert.Equal("primary", reply.Category);
        Assert.Equal("jobs", job.Category);
        Assert.Contains("CATEGORY_PROMOTIONS", reply.HeadersJson, StringComparison.Ordinal);
    }

    [Fact]
    public void GmailLabelsStillClassifyOrdinaryBulkMail()
    {
        var result = GmailService.ApplyGmailLabels(
            "store@example.test", "An ordinary message", "",
            "{}", new HashSet<string> { "CATEGORY_PROMOTIONS" });

        Assert.Equal("promotions", result.Category);
    }

    [Fact]
    public void ReplySendCarriesRfcHeadersAndTheGmailThreadId()
    {
        var message = new MimeMessage();
        GmailService.ApplyReplyHeaders(message, "<source@example.com>");
        var payload = GmailService.BuildSendPayload("message"u8.ToArray(), "thread-1");

        Assert.Equal("source@example.com", message.InReplyTo);
        Assert.Contains("source@example.com", message.References);
        Assert.Equal("thread-1", payload.GetProperty("threadId").GetString());
        Assert.False(string.IsNullOrWhiteSpace(payload.GetProperty("raw").GetString()));
    }

    [Fact]
    public void InterruptedSyncRecoveryMakesConnectionsSchedulableAgain()
    {
        Assert.Contains("WHERE status='syncing'", GmailService.RecoverInterruptedSyncsSql, StringComparison.Ordinal);
        Assert.Contains("SET status='connected'", GmailService.RecoverInterruptedSyncsSql, StringComparison.Ordinal);
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

    [Fact]
    public void MailboxActionsBuildExactIdempotentGmailLabelMutations()
    {
        var payload = GmailService.BuildBatchModifyPayload(
            ["gmail-message-1", "gmail-message-2"],
            [GmailMailboxAction.Read, GmailMailboxAction.Star, GmailMailboxAction.Archive]);

        Assert.Equal(
            ["gmail-message-1", "gmail-message-2"],
            payload.GetProperty("ids").EnumerateArray().Select(value => value.GetString()!).ToArray());
        Assert.Equal(
            ["STARRED"],
            payload.GetProperty("addLabelIds").EnumerateArray().Select(value => value.GetString()!).ToArray());
        Assert.Equal(
            ["INBOX", "UNREAD"],
            payload.GetProperty("removeLabelIds").EnumerateArray().Select(value => value.GetString()!).ToArray());
    }

    [Theory]
    [InlineData("Spam", "SPAM")]
    [InlineData("Trash", "TRASH")]
    public void SpamAndTrashLeaveTheInboxUsingTheirProviderSystemLabel(
        string actionName, string expectedLabel)
    {
        var action = Enum.Parse<GmailMailboxAction>(actionName);
        var payload = GmailService.BuildBatchModifyPayload(["message-1"], [action]);
        var added = payload.GetProperty("addLabelIds").EnumerateArray().Select(value => value.GetString()!).ToArray();
        var removed = payload.GetProperty("removeLabelIds").EnumerateArray().Select(value => value.GetString()!).ToArray();

        Assert.Equal([expectedLabel], added);
        Assert.Equal(["INBOX"], removed);
    }

    [Theory]
    [InlineData("Archive", "Archive")]
    [InlineData("Archived", "Archive")]
    [InlineData("Trash", "Trash")]
    [InlineData("Deleted Items", "Trash")]
    [InlineData("Spam", "Spam")]
    [InlineData("Junk", "Spam")]
    public void SpecialLocalDestinationsMapToGmailSystemActions(
        string destination, string expectedActionName)
    {
        var expected = Enum.Parse<GmailMailboxAction>(expectedActionName);
        Assert.Equal(expected, GmailService.DestinationAction(destination));
    }

    [Fact]
    public void CustomLocalFoldersDoNotInventGmailLabels()
    {
        Assert.Null(GmailService.DestinationAction("Receipts"));
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, true, false)]
    [InlineData(true, false, false)]
    [InlineData(true, true, true)]
    public void MailboxPropagationRequiresBothTheSettingAndModifyGrant(
        bool configured, bool granted, bool expected)
    {
        Assert.Equal(expected, GmailService.ShouldSyncMailboxActions(configured, granted));
    }

    [Fact]
    public void MailboxMessageResolutionIsOwnerAndConnectionScoped()
    {
        Assert.Contains("a.owner_user_id=$2", GmailService.MailboxMessageLookupSql, StringComparison.Ordinal);
        Assert.Contains("g.archive_id=m.archive_id", GmailService.MailboxMessageLookupSql, StringComparison.Ordinal);
        Assert.Contains("starts_with(m.source_key,'gmail:' || lower(g.email) || ':')",
            GmailService.MailboxMessageLookupSql, StringComparison.Ordinal);
        Assert.Contains("a.owner_user_id=$2", GmailService.SenderSpamExpansionSql, StringComparison.Ordinal);
        Assert.Contains("LIMIT $3", GmailService.SenderSpamExpansionSql, StringComparison.Ordinal);
    }

    [Fact]
    public void OnlyGmailBatchModifyPostsAreRetried()
    {
        Assert.True(GmailService.IsRetryableMailboxMutation(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", HttpMethod.Post));
        Assert.False(GmailService.IsRetryableMailboxMutation(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", HttpMethod.Post));
        Assert.False(GmailService.IsRetryableMailboxMutation(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify", HttpMethod.Get));
    }

    [Fact]
    public async Task ResumeAttachmentRemainsSerializableAfterTheSourceFileIsClosed()
    {
        Directory.CreateDirectory(_dataDirectory);
        var path = Path.Combine(_dataDirectory, "resume.pdf");
        var expected = "resume bytes"u8.ToArray();
        await File.WriteAllBytesAsync(path, expected);
        var body = new BodyBuilder { TextBody = "Hello" };

        await GmailService.AddResumeAttachmentAsync(
            body,
            new ResumeContent("resume.pdf", "application/pdf", path),
            CancellationToken.None);
        File.Delete(path);

        var message = new MimeMessage();
        message.From.Add(MailboxAddress.Parse("ai@vitas.work"));
        message.To.Add(MailboxAddress.Parse("recipient@example.com"));
        message.Body = body.ToMessageBody();
        await using var serialized = new MemoryStream();
        await message.WriteToAsync(serialized);
        serialized.Position = 0;
        var parsed = await MimeMessage.LoadAsync(serialized);
        var attachment = Assert.IsType<MimePart>(Assert.Single(parsed.Attachments));
        await using var decoded = new MemoryStream();
        Assert.NotNull(attachment.Content);
        await attachment.Content!.DecodeToAsync(decoded);

        Assert.Equal(expected, decoded.ToArray());
    }

    public void Dispose()
    {
        if (Directory.Exists(_dataDirectory)) Directory.Delete(_dataDirectory, true);
    }
}
