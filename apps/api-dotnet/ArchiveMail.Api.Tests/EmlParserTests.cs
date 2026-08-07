using System.Text.Json;
using ArchiveMail.Api.Imports;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class EmlParserTests
{
    [Fact]
    public async Task ParsesMessageIntoStablePostgresInput()
    {
        var testDirectory = Path.Combine(Path.GetTempPath(), $"archive-mail-test-{Guid.NewGuid():N}");
        var inbox = Path.Combine(testDirectory, "Mailbox", "Inbox");
        Directory.CreateDirectory(inbox);
        var source = Path.Combine(inbox, "1.eml");
        await File.WriteAllTextAsync(source, """
            From: Sender Name <sender@example.com>
            To: Recipient <recipient@example.com>
            Message-Id: <stable@example.com>
            Date: Tue, 21 Jul 2026 13:50:37 -0400
            Subject: Test import
            Content-Type: text/plain; charset=utf-8

            Imported body
            """);

        try
        {
            var first = await EmlParser.ParseAsync("archive-id", testDirectory, source, CancellationToken.None);
            var second = await EmlParser.ParseAsync("archive-id", testDirectory, source, CancellationToken.None);

            Assert.Equal("Mailbox/Inbox", first.FolderPath);
            Assert.Equal("sender@example.com", first.SenderAddress);
            Assert.Contains("stable@example.com", first.InternetMessageId);
            Assert.Equal("archive:archive-id:rfc822:stable@example.com", first.ConversationKey);
            Assert.Equal("Imported body", first.BodyText);
            Assert.Equal(first.SourceKey, second.SourceKey);
            Assert.Equal("recipient@example.com", JsonDocument.Parse(first.ToJson).RootElement[0].GetProperty("address").GetString());
        }
        finally
        {
            Directory.Delete(testDirectory, recursive: true);
        }
    }

    [Fact]
    public void ReplyUsesTheOldestReferenceAsItsConversationRoot()
    {
        var key = EmlParser.ConversationKey(
            "archive-1",
            "reply@example.com",
            ["<root@example.com>", "<parent@example.com>"],
            "<parent@example.com>");

        Assert.Equal("archive:archive-1:rfc822:root@example.com", key);
    }

    [Fact]
    public void ConversationKeysAreScopedToTheArchive()
    {
        var first = EmlParser.ConversationKey("archive-1", "same@example.com", [], null);
        var second = EmlParser.ConversationKey("archive-2", "same@example.com", [], null);

        Assert.NotEqual(first, second);
    }

    [Fact]
    public void MessageWithoutAnyRfcIdentifierKeepsTheLegacyFallback()
    {
        Assert.Null(EmlParser.ConversationKey("archive-1", null, [], null));
    }

    [Fact]
    public void NewCheckpointUsesDurableVersionTwoContract()
    {
        var checkpoint = ImportCheckpoint.Empty with
        {
            Stage = "indexing",
            LastFile = "Mailbox/Inbox/1000.eml",
            CommittedItems = 1000,
            DiscoveredItems = 611_197,
            SourceFingerprint = "fingerprint"
        };

        Assert.Equal(2, checkpoint.Version);
        Assert.Equal(1000, checkpoint.CommittedItems);
        Assert.Equal("Mailbox/Inbox/1000.eml", checkpoint.LastFile);
    }
}
