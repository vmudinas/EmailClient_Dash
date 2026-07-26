using System.Text.Json;
using ArchiveMail.Api.Imports;
using Npgsql;

namespace ArchiveMail.Api.Mail;

/// <summary>
/// Combining used to run inline on the POST that started it. Moving a 600k message archive
/// rewrites every one of those rows - and every index entry behind them, the GIN search index
/// included - which takes far longer than any reverse proxy will hold a request open. The proxy
/// answered 504, ASP.NET cancelled RequestAborted on the client disconnect, Npgsql cancelled the
/// statement, and the single enclosing transaction rolled back. The merge looked like it was
/// running and then changed nothing, every time, with no way to tell how far it had got.
///
/// So a combine is a job now. It is recorded in <c>import_jobs</c> under source_type 'combine',
/// which is what gives it the progress bar, phase label and ETA the importer already has, and it
/// moves messages in bounded batches that each commit on their own. Progress survives a restart
/// and the browser only ever waits on the enqueue.
/// </summary>
public sealed class ArchiveCombineService(
    NpgsqlDataSource database,
    ImportJobRepository jobs,
    ILogger<ArchiveCombineService> logger)
{
    /// <summary>Rows moved per committed batch, sized to keep each transaction short.</summary>
    internal const int BatchSize = 2_000;

    /// <summary>A batch rewrites every index entry for the rows it touches, the GIN index included.</summary>
    internal const int BatchCommandTimeoutSeconds = 300;

    internal const string SourceType = ImportJobRepository.CombineSourceType;
    internal const string ArchiveKind = "archive";
    internal const string FolderKind = "folder";

    /// <summary>
    /// Moves one bounded batch of an archive's messages. The source_key rewrite rides along with
    /// the archive_id change rather than running as its own pass over the table, which halves the
    /// row rewrites; it is there to keep moved rows from colliding with the destination's own keys
    /// on the (archive_id, source_key) unique index.
    /// </summary>
    internal const string MoveArchiveBatchSql = """
        WITH batch AS (
          SELECT id FROM messages
          WHERE archive_id = $1
          ORDER BY id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        UPDATE messages message
        SET archive_id = $2,
            source_key = $1 || ':' || message.source_key
        FROM batch
        WHERE message.id = batch.id
        """;

    /// <summary>
    /// Read in the finalizing transaction, so a cancel cannot slip between the last progress
    /// write and the deletes that finish the merge.
    /// </summary>
    internal const string LockJobStatusSql = "SELECT status FROM import_jobs WHERE id = $1 FOR UPDATE";

    /// <summary>Moves one bounded batch out of a mailbox subtree into the destination mailbox.</summary>
    internal const string MoveFolderBatchSql = """
        WITH batch AS (
          SELECT id FROM messages
          WHERE folder_id = ANY($1)
          ORDER BY id
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        UPDATE messages message
        SET folder_id = $2
        FROM batch
        WHERE message.id = batch.id
        """;

    public async Task<ImportJobDto> EnqueueArchiveCombineAsync(
        string sourceId,
        string targetId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        if (sourceId == targetId) throw new ArgumentException("Choose two different archives");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var archives = new Dictionary<string, (string Name, string Status)>(StringComparer.Ordinal);
        await using (var locked = new NpgsqlCommand(
            "SELECT id, name, status FROM archives WHERE id = ANY($1) AND owner_user_id = $2 FOR UPDATE",
            connection,
            transaction))
        {
            locked.Parameters.AddWithValue(new[] { sourceId, targetId });
            locked.Parameters.AddWithValue(ownerUserId);
            await using var reader = await locked.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
                archives[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2));
        }
        if (archives.Count != 2) throw new MailNotFoundException("Archive not found");
        if (archives.Values.Any(archive => archive.Status == "importing"))
            throw new MailConflictException("Wait for imports to finish before combining archives");
        await EnsureNotAlreadyQueuedAsync(connection, transaction, [sourceId, targetId], cancellationToken);

        // The destination mailbox is created now rather than by the worker, so the tree the user
        // is about to watch fill up exists from the moment they press the button.
        var prefix = MailRepository.NormalizeMailboxName(archives[sourceId].Name);
        var suffix = 1;
        while (await FolderPathExistsAsync(connection, transaction, targetId, prefix, cancellationToken))
            prefix = MailRepository.NormalizeMailboxName($"{archives[sourceId].Name} ({++suffix})");

        var rootFolderId = Guid.NewGuid().ToString();
        await using (var root = new NpgsqlCommand(
            """
            INSERT INTO folders (id, archive_id, parent_id, name, path, message_count, unread_count)
            VALUES ($1, $2, NULL, $3, $3, 0, 0)
            """,
            connection,
            transaction))
        {
            root.Parameters.AddWithValue(rootFolderId);
            root.Parameters.AddWithValue(targetId);
            root.Parameters.AddWithValue(prefix);
            await root.ExecuteNonQueryAsync(cancellationToken);
        }

        var total = await CountAsync(
            connection, transaction, "SELECT COUNT(*) FROM messages WHERE archive_id = $1", sourceId, cancellationToken);
        return await InsertJobAsync(
            connection,
            transaction,
            targetId,
            sourceId,
            $"{archives[sourceId].Name} → {archives[targetId].Name}",
            total,
            new CombinePlan(ArchiveKind, sourceId, targetId, targetId, prefix, rootFolderId, []),
            ownerUserId,
            cancellationToken);
    }

    public async Task<ImportJobDto> EnqueueFolderCombineAsync(
        string sourceId,
        string targetId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        if (sourceId == targetId) throw new ArgumentException("Choose two different mailboxes");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        var source = await ReadFolderAsync(connection, transaction, sourceId, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Mailbox not found");
        var target = await ReadFolderAsync(connection, transaction, targetId, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Destination mailbox not found");
        if (source.ArchiveId != target.ArchiveId)
            throw new ArgumentException("Mailboxes belong to different archives");
        if (target.Path.StartsWith(source.Path + "/", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("A mailbox cannot be combined into its child");
        if (source.Status == "importing")
            throw new MailConflictException("Wait for the archive import to finish before combining mailboxes");
        await EnsureNotAlreadyQueuedAsync(connection, transaction, [source.ArchiveId], cancellationToken);

        var subtree = new List<string>();
        await using (var command = new NpgsqlCommand(
            "SELECT id FROM folders WHERE archive_id = $1 AND (path = $2 OR path LIKE $3 ESCAPE '\\')",
            connection,
            transaction))
        {
            command.Parameters.AddWithValue(source.ArchiveId);
            command.Parameters.AddWithValue(source.Path);
            command.Parameters.AddWithValue($"{MailRepository.EscapeLike(source.Path)}/%");
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) subtree.Add(reader.GetString(0));
        }

        long total;
        await using (var count = new NpgsqlCommand(
            "SELECT COUNT(*) FROM messages WHERE folder_id = ANY($1)", connection, transaction))
        {
            count.Parameters.AddWithValue(subtree.ToArray());
            total = Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken));
        }

        return await InsertJobAsync(
            connection,
            transaction,
            source.ArchiveId,
            sourceId,
            $"{source.Path} → {target.Path}",
            total,
            new CombinePlan(FolderKind, sourceId, targetId, source.ArchiveId, target.Path, targetId, subtree.ToArray()),
            ownerUserId,
            cancellationToken);
    }

    /// <summary>
    /// Runs a queued combine to completion, one committed batch at a time. Safe to re-enter after
    /// a restart: moved rows stop matching the source, so a resumed run picks up exactly where the
    /// last committed batch left off.
    /// </summary>
    public async Task RunAsync(
        ImportJobRecord job,
        Func<long, Task> onProgress,
        CancellationToken cancellationToken)
    {
        var plan = ReadPlan(job)
            ?? throw new InvalidOperationException("This combine is missing its merge plan and cannot be resumed");
        var moved = job.Public.ProcessedItems;

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var affected = await MoveBatchAsync(plan, cancellationToken);
            if (affected == 0)
            {
                // SKIP LOCKED means an empty batch is not proof the move is done - it also happens
                // when every remaining row is locked elsewhere. Finalizing early would hand rows
                // that still exist to a cascading delete, so the count decides, not the batch.
                if (await RemainingAsync(plan, cancellationToken) == 0) break;
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
                continue;
            }

            moved += affected;
            await onProgress(moved);
        }

        await FinalizeAsync(job.Public.Id, plan, cancellationToken);
    }

    private async Task<int> MoveBatchAsync(CombinePlan plan, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var batch = new NpgsqlCommand(
            plan.Kind == FolderKind ? MoveFolderBatchSql : MoveArchiveBatchSql,
            connection,
            transaction)
        {
            CommandTimeout = BatchCommandTimeoutSeconds
        };
        if (plan.Kind == FolderKind) batch.Parameters.AddWithValue(plan.SubtreeFolderIds);
        else batch.Parameters.AddWithValue(plan.SourceId);
        batch.Parameters.AddWithValue(plan.TargetId);
        batch.Parameters.AddWithValue(BatchSize);
        var affected = await batch.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return affected;
    }

    private async Task<long> RemainingAsync(CombinePlan plan, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var command = plan.Kind == FolderKind
            ? new NpgsqlCommand("SELECT COUNT(*) FROM messages WHERE folder_id = ANY($1)", connection)
            : new NpgsqlCommand("SELECT COUNT(*) FROM messages WHERE archive_id = $1", connection);
        command.CommandTimeout = BatchCommandTimeoutSeconds;
        if (plan.Kind == FolderKind) command.Parameters.AddWithValue(plan.SubtreeFolderIds);
        else command.Parameters.AddWithValue(plan.SourceId);
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
    }

    /// <summary>
    /// Re-homes what is left behind and recounts. Cheap next to the message pass - an archive
    /// holds thousands of folders, not hundreds of thousands - but it deletes rows that cascade to
    /// messages, so it re-checks that nothing is left to move before it touches anything.
    /// </summary>
    private async Task FinalizeAsync(string jobId, CombinePlan plan, CancellationToken cancellationToken)
    {
        var remaining = await RemainingAsync(plan, cancellationToken);
        if (remaining != 0)
            throw new InvalidOperationException(
                $"Refusing to finish the combine with {remaining} messages still in the source");

        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        // Cancellation is a row update, and the loop only notices it through a progress write
        // that is throttled to once a second. A cancel landing inside that window - or during the
        // final batches, or during this method - would otherwise still delete the source. Taking
        // the status under FOR UPDATE in the same transaction as the delete closes that window.
        await using (var status = new NpgsqlCommand(LockJobStatusSql, connection, transaction))
        {
            status.Parameters.AddWithValue(jobId);
            if (Convert.ToString(await status.ExecuteScalarAsync(cancellationToken)) != "running")
                throw new OperationCanceledException("This combine is no longer running");
        }

        string recountArchiveId;

        if (plan.Kind == FolderKind)
        {
            // The subtree cascades from its root. Every message left it above, so nothing rides
            // along with the delete.
            await using var drop = new NpgsqlCommand(
                "DELETE FROM folders WHERE id = $1", connection, transaction);
            drop.Parameters.AddWithValue(plan.SourceId);
            await drop.ExecuteNonQueryAsync(cancellationToken);
            recountArchiveId = plan.ArchiveId;
        }
        else
        {
            await using (var folders = new NpgsqlCommand(
                """
                UPDATE folders
                SET archive_id = $2,
                    parent_id = CASE WHEN parent_id IS NULL THEN $3 ELSE parent_id END,
                    path = $4 || '/' || path
                WHERE archive_id = $1
                """,
                connection,
                transaction)
            {
                CommandTimeout = BatchCommandTimeoutSeconds
            })
            {
                folders.Parameters.AddWithValue(plan.SourceId);
                folders.Parameters.AddWithValue(plan.TargetId);
                folders.Parameters.AddWithValue(plan.RootFolderId);
                folders.Parameters.AddWithValue(plan.Prefix);
                await folders.ExecuteNonQueryAsync(cancellationToken);
            }

            // The job row points at the destination archive, so dropping the source cannot
            // cascade the job's own progress away underneath it.
            await using (var drop = new NpgsqlCommand(
                "DELETE FROM archives WHERE id = $1", connection, transaction))
            {
                drop.Parameters.AddWithValue(plan.SourceId);
                await drop.ExecuteNonQueryAsync(cancellationToken);
            }
            recountArchiveId = plan.TargetId;
        }

        await MailRepository.RecountArchiveAsync(connection, transaction, recountArchiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private async Task<ImportJobDto> InsertJobAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string archiveId,
        string sourceId,
        string displayName,
        long total,
        CombinePlan plan,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var jobId = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using (var job = new NpgsqlCommand(
            $"""
            INSERT INTO import_jobs (
              id, archive_id, source_path, source_name, source_type, status, phase,
              processed_items, total_items, processed_bytes, total_bytes, error_count,
              ocr_enabled, can_resume, temporary_source, checkpoint_json, checkpoint_version,
              message, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, '{SourceType}', 'queued', 'queued',
              0, $5, 0, 0, 0,
              0, 0, 0, $6, 2,
              'Waiting to combine', $7, $7
            )
            """,
            connection,
            transaction))
        {
            job.Parameters.AddWithValue(jobId);
            job.Parameters.AddWithValue(archiveId);
            job.Parameters.AddWithValue(sourceId);
            job.Parameters.AddWithValue(displayName);
            job.Parameters.AddWithValue(total);
            job.Parameters.AddWithValue(JsonSerializer.Serialize(plan, PlanJson));
            job.Parameters.AddWithValue(now);
            await job.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        logger.LogInformation(
            "Queued {Kind} combine {JobId}: {Total} messages, {Source} into {Target}",
            plan.Kind, jobId, total, plan.SourceId, plan.TargetId);
        return (await jobs.GetAsync(jobId, ownerUserId, cancellationToken))!.Public;
    }

    private static async Task EnsureNotAlreadyQueuedAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string[] archiveIds,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            ImportJobRepository.ActiveCombineTouchingSql, connection, transaction);
        command.Parameters.AddWithValue(archiveIds);
        if (await command.ExecuteScalarAsync(cancellationToken) is not null)
            throw new MailConflictException("A combine is already running for this archive");
    }

    private static async Task<long> CountAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string sql,
        string parameter,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction)
        {
            CommandTimeout = BatchCommandTimeoutSeconds
        };
        command.Parameters.AddWithValue(parameter);
        return Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static async Task<bool> FolderPathExistsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string archiveId,
        string path,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            "SELECT 1 FROM folders WHERE archive_id = $1 AND lower(path) = lower($2) LIMIT 1",
            connection,
            transaction);
        command.Parameters.AddWithValue(archiveId);
        command.Parameters.AddWithValue(path);
        return await command.ExecuteScalarAsync(cancellationToken) is not null;
    }

    private static async Task<FolderTarget?> ReadFolderAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string id,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(
            """
            SELECT folder.archive_id, folder.path, archive.status
            FROM folders folder JOIN archives archive ON archive.id = folder.archive_id
            WHERE folder.id = $1 AND archive.owner_user_id = $2
            """,
            connection,
            transaction);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new FolderTarget(reader.GetString(0), reader.GetString(1), reader.GetString(2))
            : null;
    }

    internal static readonly JsonSerializerOptions PlanJson = new(JsonSerializerDefaults.Web);

    internal static CombinePlan? ReadPlan(ImportJobRecord job)
    {
        try
        {
            var plan = job.Checkpoint.RootElement.Deserialize<CombinePlan>(PlanJson);
            return plan is null || string.IsNullOrWhiteSpace(plan.SourceId) ? null : plan;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record FolderTarget(string ArchiveId, string Path, string Status);
}

/// <param name="Kind">"archive" or "folder".</param>
/// <param name="ArchiveId">The archive to recount when the merge finishes.</param>
/// <param name="Prefix">Archive merges only: the destination mailbox path the tree is nested under.</param>
/// <param name="RootFolderId">Archive merges only: the destination mailbox created at enqueue time.</param>
/// <param name="SubtreeFolderIds">Mailbox merges only: the source mailbox and its descendants.</param>
public sealed record CombinePlan(
    string Kind,
    string SourceId,
    string TargetId,
    string ArchiveId,
    string Prefix,
    string RootFolderId,
    string[] SubtreeFolderIds);
