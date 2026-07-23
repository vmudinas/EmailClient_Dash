using System.Data;
using System.Text.Json;
using Npgsql;

namespace ArchiveMail.Api.Imports;

public sealed class ImportJobRepository(NpgsqlDataSource database)
{
    internal const string ClaimNextSql = """
        WITH candidate AS (
          SELECT id
          FROM import_jobs
          WHERE source_type <> 'gmail'
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
            phase = CASE WHEN job.phase = 'queued' THEN 'fingerprinting' ELSE job.phase END,
            can_resume = 1,
            worker_id = $2,
            lease_until = $3,
            attempt = attempt + 1,
            message = CASE WHEN attempt > 0 THEN 'Resumed by C# importer' ELSE 'Import started' END,
            updated_at = $1
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.id
        """;

    public async Task<ImportJobDto> CreateAsync(
        string sourcePath,
        bool ocrEnabled,
        string? sourceName,
        bool temporarySource,
        string? ownerUserId,
        string? uploadId,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(sourcePath);
        if (!info.Exists) throw new FileNotFoundException("Import source file was not found", sourcePath);
        var sourceType = info.Extension.ToLowerInvariant() switch
        {
            ".pst" => "pst",
            ".mbox" or ".mbx" => "mbox",
            _ => throw new NotSupportedException("Choose a .pst, .mbox, or .mbx archive")
        };

        var archiveId = Guid.NewGuid().ToString();
        var jobId = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);

        const string ownerSql = "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1";
        await using var ownerCommand = new NpgsqlCommand(ownerSql, connection, transaction);
        var ownerId = ownerUserId ?? await ownerCommand.ExecuteScalarAsync(cancellationToken) as string;
        var displayName = string.IsNullOrWhiteSpace(sourceName) ? info.Name : Path.GetFileName(sourceName);

        const string archiveSql = """
            INSERT INTO archives (
              id, owner_user_id, name, source_type, fingerprint, size_bytes,
              status, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'importing', $7)
            """;
        await using (var archive = new NpgsqlCommand(archiveSql, connection, transaction))
        {
            archive.Parameters.AddWithValue(archiveId);
            archive.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)ownerId ?? DBNull.Value });
            archive.Parameters.AddWithValue(displayName);
            archive.Parameters.AddWithValue(sourceType);
            archive.Parameters.AddWithValue($"pending:{archiveId}");
            archive.Parameters.AddWithValue(info.Length);
            archive.Parameters.AddWithValue(now);
            await archive.ExecuteNonQueryAsync(cancellationToken);
        }

        const string jobSql = """
            INSERT INTO import_jobs (
              id, archive_id, source_path, source_name, source_type, status, phase,
              processed_items, processed_bytes, total_bytes, error_count, ocr_enabled,
              can_resume, temporary_source, checkpoint_json, checkpoint_version,
              created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, 'queued', 'queued',
              0, 0, $6, 0, $7, 0, $8, $9, 2, $10, $10
            )
            """;
        await using (var job = new NpgsqlCommand(jobSql, connection, transaction))
        {
            job.Parameters.AddWithValue(jobId);
            job.Parameters.AddWithValue(archiveId);
            job.Parameters.AddWithValue(info.FullName);
            job.Parameters.AddWithValue(displayName);
            job.Parameters.AddWithValue(sourceType);
            job.Parameters.AddWithValue(info.Length);
            job.Parameters.AddWithValue(ocrEnabled ? 1 : 0);
            job.Parameters.AddWithValue(temporarySource ? 1 : 0);
            job.Parameters.AddWithValue(JsonSerializer.Serialize(ImportCheckpoint.Empty, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
            job.Parameters.AddWithValue(now);
            await job.ExecuteNonQueryAsync(cancellationToken);
        }

        if (uploadId is not null)
        {
            const string uploadSql = """
                UPDATE upload_sessions
                SET status = 'completed', job_id = $2,
                    message = 'Upload complete; import queued', updated_at = $3
                WHERE id = $1
                """;
            await using var upload = new NpgsqlCommand(uploadSql, connection, transaction);
            upload.Parameters.AddWithValue(uploadId);
            upload.Parameters.AddWithValue(jobId);
            upload.Parameters.AddWithValue(now);
            if (await upload.ExecuteNonQueryAsync(cancellationToken) != 1)
                throw new InvalidOperationException("Upload session disappeared while creating the import job");
        }

        await transaction.CommitAsync(cancellationToken);
        return (await GetAsync(jobId, cancellationToken))!.Public;
    }

    public Task<ImportJobDto> CreateAsync(string sourcePath, bool ocrEnabled, CancellationToken cancellationToken) =>
        CreateAsync(sourcePath, ocrEnabled, null, false, null, null, cancellationToken);

    public async Task<IReadOnlyList<ImportJobDto>> ListAsync(string? ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT job.id, job.archive_id, job.source_name, job.source_type, job.status, job.phase,
                   job.processed_items, job.total_items, job.processed_bytes, job.total_bytes,
                   job.error_count, job.ocr_enabled <> 0, job.can_resume <> 0, job.message,
                   job.created_at, job.updated_at
            FROM import_jobs job JOIN archives archive ON archive.id = job.archive_id
            WHERE job.source_type <> 'gmail' AND (@owner IS NULL OR archive.owner_user_id = @owner)
            ORDER BY job.updated_at DESC
            LIMIT 25
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.Add(new NpgsqlParameter { ParameterName = "owner", NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)ownerUserId ?? DBNull.Value });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var jobs = new List<ImportJobDto>();
        while (await reader.ReadAsync(cancellationToken)) jobs.Add(ReadPublic(reader));
        return jobs;
    }

    public async Task<ImportJobRecord?> GetAsync(string id, CancellationToken cancellationToken) =>
        await GetAsync(id, null, cancellationToken);

    public async Task<ImportJobRecord?> GetAsync(string id, string? ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT job.id, job.archive_id, job.source_name, job.source_type, job.status, job.phase,
                   job.processed_items, job.total_items, job.processed_bytes, job.total_bytes,
                   job.error_count, job.ocr_enabled <> 0, job.can_resume <> 0, job.message,
                   job.created_at, job.updated_at, job.source_path, job.temporary_source <> 0,
                   job.checkpoint_json, job.staging_path, job.worker_id, job.attempt
            FROM import_jobs job JOIN archives archive ON archive.id = job.archive_id
            WHERE job.id = $1 AND ($2::text IS NULL OR archive.owner_user_id = $2)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)ownerUserId ?? DBNull.Value });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadRecord(reader) : null;
    }

    public async Task<ImportJobRecord?> ClaimNextAsync(
        string workerId,
        TimeSpan lease,
        CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        var leaseUntil = now.Add(lease).ToString("O");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await using var command = new NpgsqlCommand(ClaimNextSql, connection, transaction);
        command.Parameters.AddWithValue(now.ToString("O"));
        command.Parameters.AddWithValue(workerId);
        command.Parameters.AddWithValue(leaseUntil);
        var claimedId = await command.ExecuteScalarAsync(cancellationToken) as string;
        await transaction.CommitAsync(cancellationToken);
        return claimedId is null ? null : await GetAsync(claimedId, cancellationToken);
    }

    public async Task<ImportJobDto?> SetCancelledAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        if (await GetAsync(id, ownerUserId, cancellationToken) is null) return null;
        await UpdateStateAsync(id, "cancelled", "Import cancelled", canResume: true, cancellationToken);
        return (await GetAsync(id, ownerUserId, cancellationToken))?.Public;
    }

    public async Task<ImportJobDto?> SetQueuedAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        var job = await GetAsync(id, ownerUserId, cancellationToken);
        if (job is null) return null;
        if (!File.Exists(job.SourcePath)) throw new InvalidOperationException("Import source file is no longer available");
        await UpdateStateAsync(id, "queued", "Queued to resume", canResume: false, cancellationToken);
        return (await GetAsync(id, ownerUserId, cancellationToken))?.Public;
    }

    public async Task<bool> ClearAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            DELETE FROM archives
            WHERE id = (
              SELECT archive_id FROM import_jobs
              WHERE id = $1 AND status NOT IN ('queued', 'running')
            )
            AND owner_user_id = $2
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(ownerUserId);
        return await command.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    public async Task MarkFailedAsync(string id, string message, CancellationToken cancellationToken) =>
        await UpdateStateAsync(id, "failed", message, canResume: true, cancellationToken);

    public async Task MarkNonResumableFailedAsync(string id, string message, CancellationToken cancellationToken) =>
        await UpdateStateAsync(id, "failed", message, canResume: false, cancellationToken);

    public async Task MarkCompletedAsync(string id, CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string completeJobSql = """
            UPDATE import_jobs
            SET status = CASE WHEN error_count > 0 THEN 'completed_with_errors' ELSE 'completed' END,
                phase = 'finalizing', can_resume = 0, worker_id = NULL, lease_until = NULL,
                message = CASE WHEN error_count > 0 THEN 'Import completed with errors' ELSE 'Import completed' END,
                updated_at = $2
            WHERE id = $1
            """;
        await using (var command = new NpgsqlCommand(completeJobSql, connection, transaction))
        {
            command.Parameters.AddWithValue(id);
            command.Parameters.AddWithValue(now);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        const string completeArchiveSql = """
            UPDATE archives
            SET status = CASE
                  WHEN (SELECT error_count FROM import_jobs WHERE id = $1) > 0
                    THEN 'ready_with_errors'
                  ELSE 'ready'
                END,
                message_count = (SELECT COUNT(*) FROM messages WHERE archive_id = archives.id),
                folder_count = (SELECT COUNT(*) FROM folders WHERE archive_id = archives.id),
                attachment_count = (
                  SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id = a.message_id
                  WHERE m.archive_id = archives.id
                ),
                imported_at = $2
            WHERE id = (SELECT archive_id FROM import_jobs WHERE id = $1)
            """;
        await using (var command = new NpgsqlCommand(completeArchiveSql, connection, transaction))
        {
            command.Parameters.AddWithValue(id);
            command.Parameters.AddWithValue(now);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        const string completeFoldersSql = """
            UPDATE folders
            SET message_count = (SELECT COUNT(*) FROM messages WHERE folder_id = folders.id)
            WHERE archive_id = (SELECT archive_id FROM import_jobs WHERE id = $1)
            """;
        await using (var command = new NpgsqlCommand(completeFoldersSql, connection, transaction))
        {
            command.Parameters.AddWithValue(id);
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    public Task<(int Active, int Queued)> CountsAsync(CancellationToken cancellationToken) => CountsAsync(null, cancellationToken);

    public async Task<(int Active, int Queued)> CountsAsync(string? ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT COUNT(*) FILTER (WHERE job.status = 'running'),
                   COUNT(*) FILTER (WHERE job.status = 'queued')
            FROM import_jobs job JOIN archives archive ON archive.id=job.archive_id
            WHERE job.source_type <> 'gmail'
              AND (@owner IS NULL OR archive.owner_user_id=@owner)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.Add(new NpgsqlParameter { ParameterName = "owner", NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text, Value = (object?)ownerUserId ?? DBNull.Value });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        await reader.ReadAsync(cancellationToken);
        return (Convert.ToInt32(reader.GetInt64(0)), Convert.ToInt32(reader.GetInt64(1)));
    }

    public async Task SetStagingAsync(
        string id,
        string stagingPath,
        long totalItems,
        ImportCheckpoint checkpoint,
        CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE import_jobs
            SET phase = 'parsing', staging_path = $2,
                parser_name = CASE WHEN source_type = 'pst' THEN 'readpst+mimekit' ELSE 'mimekit-mbox' END,
                total_items = $3, checkpoint_json = $4, updated_at = $5
            WHERE id = $1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(stagingPath);
        command.Parameters.AddWithValue(totalItems);
        command.Parameters.AddWithValue(JsonSerializer.Serialize(checkpoint));
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task UpdateStateAsync(
        string id,
        string status,
        string message,
        bool canResume,
        CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE import_jobs
            SET status = $2, message = $3, can_resume = $4,
                worker_id = NULL, lease_until = NULL, updated_at = $5
            WHERE id = $1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(status);
        command.Parameters.AddWithValue(message);
        command.Parameters.AddWithValue(canResume ? 1 : 0);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static ImportJobDto ReadPublic(NpgsqlDataReader reader) => new(
        reader.GetString(0),
        reader.IsDBNull(1) ? null : reader.GetString(1),
        reader.GetString(2),
        reader.GetString(3),
        reader.GetString(4),
        reader.GetString(5),
        Convert.ToInt64(reader.GetValue(6)),
        reader.IsDBNull(7) ? null : Convert.ToInt64(reader.GetValue(7)),
        Convert.ToInt64(reader.GetValue(8)),
        Convert.ToInt64(reader.GetValue(9)),
        Convert.ToInt64(reader.GetValue(10)),
        reader.GetBoolean(11),
        reader.GetBoolean(12),
        reader.IsDBNull(13) ? null : reader.GetString(13),
        reader.GetString(14),
        reader.GetString(15));

    private static ImportJobRecord ReadRecord(NpgsqlDataReader reader) => new(
        ReadPublic(reader),
        reader.GetString(16),
        reader.GetBoolean(17),
        JsonDocument.Parse(reader.IsDBNull(18) ? "{}" : reader.GetString(18)),
        reader.IsDBNull(19) ? null : reader.GetString(19),
        reader.IsDBNull(20) ? null : reader.GetString(20),
        Convert.ToInt32(reader.GetValue(21)));
}
