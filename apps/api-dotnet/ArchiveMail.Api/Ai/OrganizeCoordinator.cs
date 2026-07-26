namespace ArchiveMail.Api.Ai;

/// <summary>
/// Claims and runs queued "Organize" runs. Same shape as <see cref="DuplicateScanCoordinator"/> and
/// the combine worker, and separate from them so labelling an archive never occupies the slot a scan
/// or an import needs.
/// </summary>
public sealed class OrganizeCoordinator(
    OrganizeService organize,
    ILogger<OrganizeCoordinator> logger) : BackgroundService
{
    internal static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan IdlePause = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan FailurePause = TimeSpan.FromSeconds(5);

    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}:organize";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (await organize.ClaimAsync(_workerId, Lease, stoppingToken) is not { } claimed)
                {
                    await Task.Delay(IdlePause, stoppingToken);
                    continue;
                }

                var (runId, owner, archiveId, useAi) = claimed;
                try
                {
                    await organize.RunAsync(runId, owner, archiveId, useAi, Lease, stoppingToken);
                    logger.LogInformation("Organize run {RunId} finished", runId);
                }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                {
                    // Cancelled by the owner, or reclaimed. Every batch already committed keeps its
                    // labels, and a rerun resumes from what is still unlabelled.
                    logger.LogInformation("Organize run {RunId} stopped before finishing", runId);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    logger.LogError(error, "Organize run {RunId} failed", runId);
                    await organize.MarkFailedAsync(runId, error.Message, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                logger.LogError(error, "Organize worker iteration failed; retrying");
                await Task.Delay(FailurePause, stoppingToken);
            }
        }
    }
}
