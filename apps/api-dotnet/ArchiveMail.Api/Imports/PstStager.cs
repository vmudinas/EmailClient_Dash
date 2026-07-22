using System.Diagnostics;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;

namespace ArchiveMail.Api.Imports;

public sealed class PstStager(IOptions<ImportOptions> options, ILogger<PstStager> logger)
{
    private readonly ImportOptions _options = options.Value;

    public async Task<StagedArchive> EnsureStagedAsync(ImportJobRecord job, CancellationToken cancellationToken)
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
