using System.Security.Cryptography;
using MimeKit;
using Microsoft.Extensions.Options;

namespace ArchiveMail.Api.Imports;

public sealed class MboxStager(IOptions<ImportOptions> options, ILogger<MboxStager> logger)
{
    private readonly ImportOptions _options = options.Value;

    public async Task<StagedArchive> EnsureStagedAsync(
        ImportJobRecord job, CancellationToken cancellationToken, Action<long>? onBytesRead = null)
    {
        var stagingRoot = Path.GetFullPath(Path.Combine(_options.DataDirectory, "import-staging"));
        var stagingPath = Path.GetFullPath(job.StagingPath ?? Path.Combine(stagingRoot, job.Public.Id));
        if (!stagingPath.StartsWith(stagingRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidOperationException("Import staging path is outside the configured data directory");
        var completionMarker = Path.Combine(stagingPath, ".mbox-complete");

        if (!File.Exists(completionMarker))
        {
            if (Directory.Exists(stagingPath)) Directory.Delete(stagingPath, recursive: true);
            var mailboxName = Path.GetFileNameWithoutExtension(job.Public.SourceName);
            if (string.IsNullOrWhiteSpace(mailboxName)) mailboxName = "Mailbox";
            mailboxName = string.Concat(mailboxName.Select(character =>
                character is '/' or '\\' || char.IsControl(character) ? '-' : character)).Trim();
            var messageRoot = Path.Combine(stagingPath, mailboxName.Length == 0 ? "Mailbox" : mailboxName);
            Directory.CreateDirectory(messageRoot);

            logger.LogInformation("Staging MBOX source {Source}", job.SourcePath);
            await using var input = new FileStream(
                job.SourcePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                256 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            var parser = new MimeParser(input, MimeFormat.Mbox);
            var index = 0;
            while (!parser.IsEndOfStream)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var message = await parser.ParseMessageAsync(cancellationToken);
                var target = Path.Combine(messageRoot, $"{index++:D10}.eml");
                await using var output = new FileStream(
                    target, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
                await message.WriteToAsync(output, cancellationToken);

                if (onBytesRead is not null && index % 50 == 0)
                {
                    try
                    {
                        onBytesRead(input.Position);
                    }
                    catch (Exception exception)
                    {
                        // Progress reporting must never affect the import outcome.
                        logger.LogDebug(exception, "MBOX progress callback failed for job {JobId}", job.Public.Id);
                    }
                }
            }
            await File.WriteAllTextAsync(completionMarker, DateTimeOffset.UtcNow.ToString("O"), cancellationToken);
        }

        var files = Directory.EnumerateFiles(stagingPath, "*.eml", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal).ToArray();
        return new(stagingPath, files, await FingerprintAsync(job.SourcePath, cancellationToken));
    }

    private static async Task<string> FingerprintAsync(string path, CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        var prefix = new byte[(int)Math.Min(4 * 1024 * 1024, info.Length)];
        await using var stream = File.OpenRead(path);
        await stream.ReadExactlyAsync(prefix, cancellationToken);
        var metadata = System.Text.Encoding.UTF8.GetBytes($"{info.Length}:{info.LastWriteTimeUtc.Ticks}:");
        return Convert.ToHexString(SHA256.HashData([.. metadata, .. prefix])).ToLowerInvariant();
    }
}

public sealed class ArchiveStager(PstStager pst, MboxStager mbox)
{
    public Task<StagedArchive> EnsureStagedAsync(
        ImportJobRecord job, CancellationToken cancellationToken, Action<long>? onBytesRead = null) =>
        job.Public.SourceType.ToLowerInvariant() switch
        {
            "pst" => pst.EnsureStagedAsync(job, cancellationToken, onBytesRead),
            "mbox" => mbox.EnsureStagedAsync(job, cancellationToken, onBytesRead),
            _ => throw new NotSupportedException($"Unsupported archive type: {job.Public.SourceType}")
        };
}
