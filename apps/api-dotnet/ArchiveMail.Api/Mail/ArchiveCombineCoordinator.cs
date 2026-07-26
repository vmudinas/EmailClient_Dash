using ArchiveMail.Api.Imports;
using Npgsql;

namespace ArchiveMail.Api.Mail;

/// <summary>
/// Claims and runs queued combines. Kept separate from <see cref="ImportCoordinator"/> so a long
/// merge never occupies the slot a file import needs, and so the two claim queries cannot take
/// each other's work: the importer claims only pst/mbox, this claims only 'combine'.
/// </summary>
public sealed class ArchiveCombineCoordinator(
    NpgsqlDataSource database,
    ArchiveCombineService combines,
    ImportJobRepository jobs,
    ILogger<ArchiveCombineCoordinator> logger) : BackgroundService
{
    private static readonly TimeSpan Lease = TimeSpan.FromMinutes(5);

    /// <summary>
    /// Progress lands at most this often. A batch of 2,000 commits in well under a second on a
    /// small archive, and writing a row per batch would put more load on the database than the
    /// merge itself for no visible gain - the UI polls every 1.5s at its fastest.
    /// </summary>
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromSeconds(1);

    internal const string ClaimSql = $"""
        WITH candidate AS (
          SELECT id
          FROM import_jobs
          WHERE source_type = '{ArchiveCombineService.SourceType}'
            AND (
              status = 'queued'
              OR (status = 'running' AND (lease_until IS NULL OR lease_until < $1))
            )
          ORDER BY updated_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE import_jobs AS job
        SET status = 'running',
            phase = 'parsing',
            can_resume = 1,
            worker_id = $2,
            lease_until = $3,
            attempt = attempt + 1,
            message = 'Moving emails',
            updated_at = $1
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id
        """;

    private readonly string _workerId = $"{Environment.MachineName}:{Environment.ProcessId}:combine";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            // Guarded end to end: an exception out of ExecuteAsync faults the hosted service and
            // the host stops the whole application by default.
            try
            {
                var jobId = await ClaimAsync(stoppingToken);
                if (jobId is null)
                {
                    await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                    continue;
                }

                var job = await jobs.GetAsync(jobId, stoppingToken);
                if (job is null) continue;
                try
                {
                    var lastWrite = DateTimeOffset.MinValue;
                    await combines.RunAsync(
                        job,
                        async moved =>
                        {
                            var now = DateTimeOffset.UtcNow;
                            if (now - lastWrite < ProgressInterval) return;
                            lastWrite = now;
                            await ReportAsync(jobId, moved, stoppingToken);
                        },
                        stoppingToken);
                    await CompleteAsync(jobId, stoppingToken);
                    logger.LogInformation("Combine {JobId} finished", jobId);
                }
                catch (OperationCanceledException) when (!stoppingToken.IsCancellationRequested)
                {
                    // Stopped by the user. Whatever already moved stays moved; the source keeps
                    // the rest, and resuming picks up from there.
                    logger.LogInformation("Combine {JobId} stopped at its last committed batch", jobId);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    logger.LogError(exception, "Combine {JobId} failed", jobId);
                    await jobs.MarkFailedAsync(jobId, exception.Message, stoppingToken);
                }
            }
            catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogError(exception, "Combine worker iteration failed; retrying");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    private async Task<string?> ClaimAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(ClaimSql, connection, transaction);
        command.Parameters.AddWithValue(now.ToString("O"));
        command.Parameters.AddWithValue(_workerId);
        command.Parameters.AddWithValue(now.Add(Lease).ToString("O"));
        var claimed = await command.ExecuteScalarAsync(cancellationToken) as string;
        await transaction.CommitAsync(cancellationToken);
        return claimed;
    }

    /// <summary>
    /// Writes progress and renews the lease in one statement, scoped to status = 'running'. That
    /// scope is also how a cancel reaches this worker: the cancel endpoint only flips the row, so
    /// an update that matches nothing means the job is no longer ours to finish. Stopping here
    /// rather than at the end matters - finalizing a cancelled merge would delete the source.
    /// </summary>
    private async Task ReportAsync(string jobId, long moved, CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE import_jobs
            SET processed_items = $2, lease_until = $3, message = 'Moving emails', updated_at = $4
            WHERE id = $1 AND status = 'running'
            """;
        var now = DateTimeOffset.UtcNow;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(jobId);
        command.Parameters.AddWithValue(moved);
        command.Parameters.AddWithValue(now.Add(Lease).ToString("O"));
        command.Parameters.AddWithValue(now.ToString("O"));
        if (await command.ExecuteNonQueryAsync(cancellationToken) != 1)
            throw new OperationCanceledException("This combine is no longer running");
    }

    private async Task CompleteAsync(string jobId, CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE import_jobs
            SET status = 'completed', phase = 'finalizing', can_resume = 0,
                processed_items = COALESCE(total_items, processed_items),
                worker_id = NULL, lease_until = NULL,
                message = 'Combine complete', updated_at = $2
            WHERE id = $1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(jobId);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }
}
