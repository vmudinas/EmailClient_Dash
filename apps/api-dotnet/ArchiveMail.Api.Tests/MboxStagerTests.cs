using ArchiveMail.Api.Imports;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MboxStagerTests
{
    [Fact]
    public async Task StagesMessagesOnceAndReturnsAStableFingerprint()
    {
        var testDirectory = Path.Combine(Path.GetTempPath(), $"archive-mail-mbox-{Guid.NewGuid():N}");
        Directory.CreateDirectory(testDirectory);
        var source = Path.Combine(testDirectory, "mailbox.mbox");
        await File.WriteAllTextAsync(source, """
            From sender@example.com Tue Jul 21 13:50:37 2026
            From: Sender <sender@example.com>
            To: First <first@example.com>
            Message-Id: <first@example.com>
            Date: Tue, 21 Jul 2026 13:50:37 -0400
            Subject: First

            First body

            From sender@example.com Tue Jul 21 13:51:37 2026
            From: Sender <sender@example.com>
            To: Second <second@example.com>
            Message-Id: <second@example.com>
            Date: Tue, 21 Jul 2026 13:51:37 -0400
            Subject: Second

            Second body
            """);

        try
        {
            var options = Options.Create(new ImportOptions { DataDirectory = testDirectory });
            var stager = new MboxStager(options, NullLogger<MboxStager>.Instance);
            var job = Job(source);

            var first = await stager.EnsureStagedAsync(job, CancellationToken.None);
            var firstWriteTimes = first.MessageFiles.Select(File.GetLastWriteTimeUtc).ToArray();
            var second = await stager.EnsureStagedAsync(job, CancellationToken.None);

            Assert.Equal(2, first.MessageFiles.Count);
            Assert.Equal(first.SourceFingerprint, second.SourceFingerprint);
            Assert.Equal(first.MessageFiles, second.MessageFiles);
            Assert.Equal(firstWriteTimes, second.MessageFiles.Select(File.GetLastWriteTimeUtc));
            Assert.All(second.MessageFiles, path => Assert.StartsWith(testDirectory, path, StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(testDirectory, recursive: true);
        }
    }

    private static ImportJobRecord Job(string sourcePath)
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        return new ImportJobRecord(
            new ImportJobDto(
                "job-id", "archive-id", Path.GetFileName(sourcePath), "mbox", "running", "extracting",
                0, null, 0, new FileInfo(sourcePath).Length, 0, false, true, null, now, now),
            sourcePath,
            false,
            System.Text.Json.JsonDocument.Parse("{}"),
            null,
            null,
            1);
    }
}
