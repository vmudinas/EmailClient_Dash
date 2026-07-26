namespace ArchiveMail.Api.Ai;

/// <summary>
/// Claims and runs queued duplicate scans, and spends its idle time backfilling fingerprints.
///
/// The scan used to run inline on POST /api/ai/duplicates/scan. On any archive worth scanning that
/// outlived the reverse proxy's timeout, so the browser got a 504 while the work carried on
/// unwatched inside a request nobody was reading any more - and because it held connections and
/// hammered the database throughout, the rest of the app went down with it. Making it a claimed job
/// gives it a progress bar, a cancel, and survival across a restart, and lets the request that
/// starts it return in a single insert.
///
/// One worker, not two: a scan and the backfill both write <c>messages.fingerprinted_at</c>, and
/// running them concurrently only meant they raced for the same rows and the same connections. A
/// claimed scan takes priority and the backfill fills the gaps between scans.
/// </summary>
public sealed class DuplicateScanCoordinator(
    DeduplicationService duplicates,
    ILogger<DuplicateScanCoordinator> logger) : BackgroundService
{
    /// <summary>
    /// Renewed at every progress report. Long enough that a slow batch on a busy database is not
    /// mistaken for a dead worker, short enough that a scan orphaned by a restart is picked up
    /// again while the user is still watching for it.
    /// </summary>
    internal static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);

    private static readonly TimeSpan IdlePause = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan BackfillDrainedPause = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan FailurePause = TimeSpan.FromSeconds(5);

    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}:duplicates";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            // Guarded end to end. BackgroundWorkerPolicy already keeps a crashed worker from taking
            // the host down; this keeps one bad iteration from taking the worker down.
            try
            {
                if (await duplicates.ClaimScanAsync(_workerId, Lease, stoppingToken) is not { } claimed)
                {
                    var written = await duplicates.FingerprintIdleBatchAsync(stoppingToken);
                    await Task.Delay(written == 0 ? BackfillDrainedPause : IdlePause, stoppingToken);
                    continue;
                }

                var (scanId, owner) = claimed;
                try
                {
                    await duplicates.RunScanAsync(scanId, owner, Lease, stoppingToken);
                    logger.LogInformation("Duplicate scan {ScanId} finished", scanId);
                }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                {
                    // Cancelled by the owner, or reclaimed by another worker. Whatever groups were
                    // already written stay written and remain reviewable.
                    logger.LogInformation("Duplicate scan {ScanId} stopped before finishing", scanId);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    logger.LogError(error, "Duplicate scan {ScanId} failed", scanId);
                    await duplicates.MarkScanFailedAsync(scanId, error.Message, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                logger.LogError(error, "Duplicate scan worker iteration failed; retrying");
                await Task.Delay(FailurePause, stoppingToken);
            }
        }
    }
}
