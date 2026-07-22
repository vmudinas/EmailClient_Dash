using System.Security.Cryptography;
using MimeKit;
using Microsoft.Extensions.Options;
using Npgsql;

namespace ArchiveMail.Api.Imports;

public sealed class AttachmentMaterializer(
    NpgsqlDataSource database,
    IOptions<ImportOptions> options,
    ILogger<AttachmentMaterializer> logger) : BackgroundService
{
    private readonly ImportOptions _options = options.Value;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            var work = await ClaimAsync(stoppingToken);
            if (work is null)
            {
                await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
                continue;
            }
            try
            {
                await MaterializeAsync(work, stoppingToken);
                await FinishAsync(work.Id, null, stoppingToken);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                logger.LogWarning(exception, "Deferred attachment extraction failed for message {MessageId}", work.MessageId);
                await FinishAsync(work.Id, exception.Message, stoppingToken);
            }
        }
    }

    private async Task<AttachmentWork?> ClaimAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            WITH candidate AS (
              SELECT id FROM deferred_attachment_jobs
              WHERE status = 'queued'
                AND NOT EXISTS (SELECT 1 FROM import_jobs WHERE status = 'running')
              ORDER BY updated_at
              FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE deferred_attachment_jobs job
            SET status = 'running', attempts = attempts + 1, updated_at = $1
            FROM candidate WHERE job.id = candidate.id
            RETURNING job.id, job.message_id, job.staging_path, job.source_file, job.attempts
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new AttachmentWork(
                reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.GetString(3), Convert.ToInt32(reader.GetValue(4)))
            : null;
    }

    private async Task MaterializeAsync(AttachmentWork work, CancellationToken cancellationToken)
    {
        var stagingRoot = Path.GetFullPath(work.StagingPath);
        var sourcePath = Path.GetFullPath(Path.Combine(stagingRoot, work.SourceFile));
        if (!sourcePath.StartsWith(stagingRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new InvalidOperationException("Deferred attachment source escaped its staging directory");

        await using var source = File.OpenRead(sourcePath);
        var message = await MimeMessage.LoadAsync(source, cancellationToken);
        var stored = new List<StoredAttachment>();
        var index = 0;
        foreach (var entity in message.Attachments)
        {
            stored.Add(await StoreAsync(work.MessageId, index++, entity, cancellationToken));
        }

        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        foreach (var attachment in stored)
        {
            const string blobSql = """
                INSERT INTO blobs (sha256, relative_path, size_bytes, ref_count)
                VALUES ($1, $2, $3, 0)
                ON CONFLICT (sha256) DO NOTHING
                """;
            await using (var blob = new NpgsqlCommand(blobSql, connection, transaction))
            {
                blob.Parameters.AddWithValue(attachment.Sha256);
                blob.Parameters.AddWithValue(attachment.RelativePath);
                blob.Parameters.AddWithValue(attachment.SizeBytes);
                await blob.ExecuteNonQueryAsync(cancellationToken);
            }

            const string attachmentSql = """
                INSERT INTO attachments (
                  id, message_id, filename, content_type, size_bytes, content_id,
                  disposition, text_status, extracted_text, blob_sha256
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', '', $8)
                ON CONFLICT (id) DO NOTHING
                """;
            await using (var insert = new NpgsqlCommand(attachmentSql, connection, transaction))
            {
                insert.Parameters.AddWithValue(attachment.Id);
                insert.Parameters.AddWithValue(work.MessageId);
                insert.Parameters.AddWithValue(attachment.Filename);
                insert.Parameters.AddWithValue(attachment.ContentType);
                insert.Parameters.AddWithValue(attachment.SizeBytes);
                insert.Parameters.Add(new NpgsqlParameter
                {
                    NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
                    Value = (object?)attachment.ContentId ?? DBNull.Value
                });
                insert.Parameters.AddWithValue(attachment.Disposition);
                insert.Parameters.AddWithValue(attachment.Sha256);
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            const string recountSql = """
                UPDATE blobs SET ref_count = (
                  SELECT COUNT(*) FROM attachments WHERE blob_sha256 = $1
                ) WHERE sha256 = $1
                """;
            await using var recount = new NpgsqlCommand(recountSql, connection, transaction);
            recount.Parameters.AddWithValue(attachment.Sha256);
            await recount.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
    }

    private async Task<StoredAttachment> StoreAsync(
        string messageId,
        int index,
        MimeEntity entity,
        CancellationToken cancellationToken)
    {
        var blobRoot = Path.Combine(_options.DataDirectory, "blobs");
        var temporaryRoot = Path.Combine(blobRoot, ".tmp");
        Directory.CreateDirectory(temporaryRoot);
        var temporaryPath = Path.Combine(temporaryRoot, Guid.NewGuid().ToString("N"));
        await using (var output = new FileStream(
            temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
        {
            if (entity is MimePart { Content: { } } part) await part.Content.DecodeToAsync(output, cancellationToken);
            else await entity.WriteToAsync(output, cancellationToken);
        }

        await using var input = File.OpenRead(temporaryPath);
        var hash = Convert.ToHexString(await SHA256.HashDataAsync(input, cancellationToken)).ToLowerInvariant();
        var relativePath = Path.Combine(hash[..2], hash[2..4], hash).Replace(Path.DirectorySeparatorChar, '/');
        var destination = Path.Combine(blobRoot, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        var size = new FileInfo(temporaryPath).Length;
        if (File.Exists(destination)) File.Delete(temporaryPath);
        else
        {
            try
            {
                File.Move(temporaryPath, destination);
            }
            catch (IOException) when (File.Exists(destination))
            {
                File.Delete(temporaryPath);
            }
        }

        var mimePart = entity as MimePart;
        var filename = mimePart?.FileName;
        if (string.IsNullOrWhiteSpace(filename)) filename = $"attachment-{index + 1}";
        var idHash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{messageId}:{index}"));
        var id = new Guid(idHash.AsSpan(0, 16)).ToString();
        return new StoredAttachment(
            id,
            filename,
            entity.ContentType.MimeType,
            size,
            mimePart?.ContentId?.Trim('<', '>'),
            mimePart?.ContentDisposition?.Disposition == "inline" ? "inline" : "attachment",
            hash,
            relativePath);
    }

    private async Task FinishAsync(string id, string? error, CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE deferred_attachment_jobs
            SET status = CASE WHEN $2::text IS NULL THEN 'completed'
                              WHEN attempts < 3 THEN 'queued' ELSE 'failed' END,
                error = $2, updated_at = $3
            WHERE id = $1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)error ?? DBNull.Value
        });
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private sealed record AttachmentWork(string Id, string MessageId, string StagingPath, string SourceFile, int Attempts);
    private sealed record StoredAttachment(
        string Id,
        string Filename,
        string ContentType,
        long SizeBytes,
        string? ContentId,
        string Disposition,
        string Sha256,
        string RelativePath);
}
