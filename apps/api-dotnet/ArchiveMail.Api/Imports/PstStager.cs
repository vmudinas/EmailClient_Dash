using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;

namespace ArchiveMail.Api.Imports;

public sealed class PstStager(IOptions<ImportOptions> options, ILogger<PstStager> logger)
{
    private readonly ImportOptions _options = options.Value;

    public async Task<StagedArchive> EnsureStagedAsync(
        ImportJobRecord job, CancellationToken cancellationToken, Action<long>? onBytesRead = null)
    {
        if (!string.Equals(job.Public.SourceType, "pst", StringComparison.OrdinalIgnoreCase))
            throw new NotSupportedException("PstStager only accepts PST sources");

        var stagingRoot = Path.GetFullPath(Path.Combine(_options.DataDirectory, "import-staging"));
        var stagingPath = Path.GetFullPath(job.StagingPath ?? Path.Combine(stagingRoot, job.Public.Id));
        if (!stagingPath.StartsWith(stagingRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidOperationException("Import staging path is outside the configured data directory");
        var completionMarker = Path.Combine(stagingPath, ".readpst-complete");

        if (!File.Exists(completionMarker))
        {
            // readpst cannot continue a half-written export reliably. Database
            // batches remain durable, but an interrupted extraction is rebuilt.
            if (Directory.Exists(stagingPath)) Directory.Delete(stagingPath, recursive: true);
            Directory.CreateDirectory(stagingPath);
            TryDisableCopyOnWrite(stagingPath);
            logger.LogInformation("Extracting {Source} with {Jobs} readpst workers", job.SourcePath, _options.ReadPstJobs);
            var startInfo = new ProcessStartInfo
            {
                FileName = _options.ReadPstPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            startInfo.ArgumentList.Add("-q");
            startInfo.ArgumentList.Add("-e");
            startInfo.ArgumentList.Add("-j");
            startInfo.ArgumentList.Add(Math.Max(1, _options.ReadPstJobs).ToString());
            startInfo.ArgumentList.Add("-o");
            startInfo.ArgumentList.Add(stagingPath);
            startInfo.ArgumentList.Add(job.SourcePath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Unable to start readpst");
            var stdout = process.StandardOutput.ReadToEndAsync(cancellationToken);
            var stderr = process.StandardError.ReadToEndAsync(cancellationToken);

            // Best-effort progress: sample /proc/{pid}/io every few seconds so the UI can show
            // real extraction progress instead of a frozen 0% for the (potentially hours-long)
            // readpst run. Linked to the outer token so it stops as soon as that fires, and
            // always cancelled + drained in the finally below so it never outlives readpst.
            using var progressCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            var progressTask = onBytesRead is null
                ? Task.CompletedTask
                : ExtractionProgressPoller.RunAsync(
                    process.Id,
                    ReadCumulativeBytesRead,
                    onBytesRead,
                    SafeFileLength(job.SourcePath),
                    ExtractionProgressPoller.DefaultInterval,
                    progressCts.Token);

            try
            {
                await process.WaitForExitAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync(CancellationToken.None);
                throw;
            }
            finally
            {
                progressCts.Cancel();
                try
                {
                    await progressTask;
                }
                catch (Exception exception)
                {
                    // Progress reporting must never affect the import outcome.
                    logger.LogDebug(exception, "Extraction progress polling for {JobId} ended unexpectedly", job.Public.Id);
                }
            }

            var output = await stdout;
            var error = await stderr;
            if (process.ExitCode != 0)
                throw new InvalidOperationException($"readpst exited with code {process.ExitCode}: {error}".Trim());
            if (!string.IsNullOrWhiteSpace(output)) logger.LogDebug("readpst: {Output}", output.Trim());

            await File.WriteAllTextAsync(completionMarker, DateTimeOffset.UtcNow.ToString("O"), cancellationToken);
        }

        var files = Directory.EnumerateFiles(stagingPath, "*.eml", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .ToArray();
        var fingerprint = await FingerprintAsync(job.SourcePath, cancellationToken);
        return new StagedArchive(stagingPath, files, fingerprint);
    }

    /// <summary>
    /// Default reader for <see cref="ExtractionProgressPoller"/>: parses the cumulative bytes a
    /// process has read from the Linux `/proc/{pid}/io` `rchar:` line. Fully defensive - missing
    /// file, permission error, a process that already exited, or a non-Linux host all just
    /// produce null so a tick is skipped rather than throwing.
    /// </summary>
    internal static long? ReadCumulativeBytesRead(int pid)
    {
        try
        {
            foreach (var line in File.ReadLines($"/proc/{pid}/io"))
            {
                if (!line.StartsWith("rchar:", StringComparison.Ordinal)) continue;
                return long.TryParse(line.AsSpan("rchar:".Length).Trim(), out var bytes) ? bytes : null;
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    private static long? SafeFileLength(string path)
    {
        try
        {
            return new FileInfo(path).Length;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Best-effort: disables btrfs copy-on-write for the staging directory before readpst fills
    /// it with tens of thousands of small .eml files, which is meaningfully cheaper on
    /// COW filesystems. Only takes effect on an empty directory, which this always is (it was
    /// just created). Anything going wrong here (missing `chattr` binary, non-btrfs volume, an
    /// unsupported filesystem, or any other failure) must never block or fail the import.
    /// </summary>
    private void TryDisableCopyOnWrite(string path)
    {
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = "chattr",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false
            };
            startInfo.ArgumentList.Add("+C");
            startInfo.ArgumentList.Add(path);

            using var process = Process.Start(startInfo);
            if (process is null) return;
            if (!process.WaitForExit(5_000))
            {
                process.Kill(entireProcessTree: true);
                return;
            }
            if (process.ExitCode != 0)
            {
                logger.LogDebug(
                    "chattr +C on {Path} exited with code {ExitCode}; continuing without copy-on-write disabled",
                    path, process.ExitCode);
            }
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Unable to disable copy-on-write for {Path}; continuing without it", path);
        }
    }

    private static async Task<string> FingerprintAsync(string path, CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        var prefixLength = (int)Math.Min(4 * 1024 * 1024, info.Length);
        var prefix = new byte[prefixLength];
        await using var stream = File.OpenRead(path);
        await stream.ReadExactlyAsync(prefix, cancellationToken);
        var metadata = System.Text.Encoding.UTF8.GetBytes($"{info.Length}:{info.LastWriteTimeUtc.Ticks}:");
        var hash = SHA256.HashData([.. metadata, .. prefix]);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}

public sealed record StagedArchive(string Path, IReadOnlyList<string> MessageFiles, string SourceFingerprint);
