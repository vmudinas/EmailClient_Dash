using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace ArchiveMail.Api.Imports;

public sealed class ImportCoordinator(
    ImportJobRepository jobs,
    ImportBatchWriter writer,
    ArchiveStager stager,
    IOptions<ImportOptions> options,
    ILogger<ImportCoordinator> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };
    private readonly ImportOptions _options = options.Value;
    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}:{Guid.NewGuid():N}";
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _active = new();

    public string WorkerId => _workerId;
    public int ActiveCount => _active.Count;
    public int BatchSize => Math.Clamp(_options.BatchSize, 100, 10_000);
    public int ParserConcurrency => Math.Clamp(_options.ParserConcurrency, 1, 16);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            logger.LogWarning("C# import worker is disabled; set Import__Enabled=true after the cutover checkpoint decision");
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            return;
        }

        var lease = TimeSpan.FromSeconds(Math.Clamp(_options.LeaseSeconds, 30, 600));

        while (!stoppingToken.IsCancellationRequested)
        {
            // Everything in the loop body is guarded. An exception escaping ExecuteAsync faults
            // the hosted service, and the host's default BackgroundServiceExceptionBehavior is
            // StopHost - so a single transient Npgsql failure while claiming a job used to take
            // the whole API down, not just the importer, and the reverse proxy answered 502
            // until the container restarted.
            try
            {
                var job = await jobs.ClaimNextAsync(_workerId, lease, stoppingToken);
                if (job is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
                    continue;
                }

                using var linked = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                _active[job.Public.Id] = linked;
                try
                {
                    await RunJobAsync(job, stager, lease, linked.Token);
                }
                catch (OperationCanceledException) when (linked.IsCancellationRequested)
                {
                    logger.LogInformation("Import {JobId} stopped at its last committed checkpoint", job.Public.Id);
                }
                catch (Exception exception)
                {
                    logger.LogError(exception, "Import {JobId} failed", job.Public.Id);
                    await jobs.MarkFailedAsync(job.Public.Id, exception.Message, stoppingToken);
                }
                finally
                {
                    _active.TryRemove(job.Public.Id, out _);
                }
            }
            catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(exception, "Import worker iteration failed; retrying");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    public void Cancel(string jobId)
    {
        if (_active.TryGetValue(jobId, out var cancellation)) cancellation.Cancel();
    }

    private async Task RunJobAsync(
        ImportJobRecord job,
        ArchiveStager stager,
        TimeSpan lease,
        CancellationToken cancellationToken)
    {
        var existingCheckpoint = ReadCheckpoint(job.Checkpoint);
        if (job.Public.ProcessedItems > 0 && existingCheckpoint.Version != 2)
        {
            throw new InvalidOperationException(
                "This job uses the legacy Node PST checkpoint and cannot be resumed safely by the C# parser. " +
                "Keep the partial archive for inspection or clear it and restart once with the C# importer.");
        }

        var staged = await stager.EnsureStagedAsync(
            job,
            cancellationToken,
            bytesRead => ReportExtractionProgress(job.Public.Id, bytesRead, lease, cancellationToken));
        var checkpoint = existingCheckpoint.Version == 2 ? existingCheckpoint : ImportCheckpoint.Empty;
        if (checkpoint.SourceFingerprint is not null && checkpoint.SourceFingerprint != staged.SourceFingerprint)
            throw new InvalidOperationException("The archive source changed after the checkpoint was created");

        checkpoint = checkpoint with
        {
            Version = 2,
            Stage = "parsing",
            DiscoveredItems = staged.MessageFiles.Count,
            SourceFingerprint = staged.SourceFingerprint
        };
        await jobs.SetStagingAsync(
            job.Public.Id, staged.Path, staged.MessageFiles.Count, checkpoint, cancellationToken);
        job = job with { StagingPath = staged.Path };

        var startIndex = FindResumeIndex(staged, checkpoint.LastFile);
        if (job.Public.ArchiveId is null) throw new InvalidOperationException("Import job has no archive");

        for (var offset = startIndex; offset < staged.MessageFiles.Count; offset += BatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var count = Math.Min(BatchSize, staged.MessageFiles.Count - offset);
            var batchFiles = staged.MessageFiles.Skip(offset).Take(count).ToArray();
            var parsed = new ParsedMessage[count];
            await Parallel.ForEachAsync(
                Enumerable.Range(0, count),
                new ParallelOptions { MaxDegreeOfParallelism = ParserConcurrency, CancellationToken = cancellationToken },
                async (index, token) =>
                {
                    parsed[index] = await EmlParser.ParseAsync(
                        job.Public.ArchiveId, staged.Path, batchFiles[index], token);
                });

            var committed = offset + count;
            checkpoint = checkpoint with
            {
                Stage = "indexing",
                LastFile = Path.GetRelativePath(staged.Path, batchFiles[^1]).Replace(Path.DirectorySeparatorChar, '/'),
                CommittedItems = committed
            };
            await writer.CommitAsync(job, parsed, checkpoint, lease, cancellationToken);
            logger.LogInformation(
                "Import {JobId}: committed {Committed}/{Total} messages",
                job.Public.Id, committed, staged.MessageFiles.Count);
        }

        await jobs.MarkCompletedAsync(job.Public.Id, cancellationToken);
    }

    /// <summary>
    /// Fire-and-forget bridge from the stager's synchronous progress callback (invoked from the
    /// PST poll loop roughly every 5 seconds, which is throttling enough on its own) to the
    /// repository update. Never awaited by the caller so a slow write can't stall extraction;
    /// any failure - including cancellation - is logged and swallowed here so it can't surface
    /// as an unobserved task exception or affect the import outcome.
    /// </summary>
    private void ReportExtractionProgress(string jobId, long bytesRead, TimeSpan lease, CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested) return;
        _ = ReportExtractionProgressAsync(jobId, bytesRead, lease, cancellationToken);
    }

    private async Task ReportExtractionProgressAsync(string jobId, long bytesRead, TimeSpan lease, CancellationToken cancellationToken)
    {
        try
        {
            await jobs.UpdateExtractionProgressAsync(jobId, bytesRead, lease, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // Import is stopping; this last sample doesn't need to land.
        }
        catch (Exception exception)
        {
            logger.LogDebug(exception, "Unable to persist extraction progress for import {JobId}", jobId);
        }
    }

    private static ImportCheckpoint ReadCheckpoint(JsonDocument document)
    {
        try
        {
            return document.RootElement.Deserialize<ImportCheckpoint>(JsonOptions) ?? ImportCheckpoint.Empty;
        }
        catch (JsonException)
        {
            return ImportCheckpoint.Empty;
        }
    }

    private static int FindResumeIndex(StagedArchive archive, string? lastFile)
    {
        if (lastFile is null) return 0;
        for (var index = 0; index < archive.MessageFiles.Count; index++)
        {
            var relative = Path.GetRelativePath(archive.Path, archive.MessageFiles[index])
                .Replace(Path.DirectorySeparatorChar, '/');
            if (string.CompareOrdinal(relative, lastFile) > 0) return index;
        }
        return archive.MessageFiles.Count;
    }
}
