using System.Text.Json;
using Npgsql;
using NpgsqlTypes;
using ArchiveMail.Api.Mail;

namespace ArchiveMail.Api.Imports;

public sealed class ImportBatchWriter(NpgsqlDataSource database, ILogger<ImportBatchWriter> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const int ImportCommandTimeoutSeconds = 120;

    public async Task CommitAsync(
        ImportJobRecord job,
        IReadOnlyList<ParsedMessage> messages,
        ImportCheckpoint checkpoint,
        TimeSpan lease,
        CancellationToken cancellationToken)
    {
        const int maxAttempts = 3;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                await CommitOnceAsync(job, messages, checkpoint, lease, cancellationToken);
                return;
            }
            catch (NpgsqlException error) when (
                attempt < maxAttempts
                && IsTransientDatabaseFailure(error)
                && !cancellationToken.IsCancellationRequested)
            {
                var delay = TimeSpan.FromSeconds(1 << (attempt - 1));
                logger.LogWarning(
                    error,
                    "Import batch for job {JobId} timed out or was blocked; retrying attempt {Attempt} of {MaxAttempts} after {DelaySeconds} seconds",
                    job.Public.Id,
                    attempt + 1,
                    maxAttempts,
                    delay.TotalSeconds);
                await Task.Delay(delay, cancellationToken);
            }
        }
    }

    private async Task CommitOnceAsync(
        ImportJobRecord job,
        IReadOnlyList<ParsedMessage> messages,
        ImportCheckpoint checkpoint,
        TimeSpan lease,
        CancellationToken cancellationToken)
    {
        if (job.Public.ArchiveId is null) throw new InvalidOperationException("Import job has no archive");
        if (messages.Count == 0) return;

        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using (var limits = new NpgsqlCommand(
            "SET LOCAL lock_timeout = '15s'; SET LOCAL statement_timeout = '120s';",
            connection,
            transaction))
        {
            await limits.ExecuteNonQueryAsync(cancellationToken);
        }
        var preparedMessages = await ApplyTabSettingsAsync(
            connection, transaction, job.Public.ArchiveId, messages, cancellationToken);
        await EnsureFoldersAsync(connection, transaction, job.Public.ArchiveId, preparedMessages, cancellationToken);
        await CreateStagingTableAsync(connection, transaction, cancellationToken);
        await CopyMessagesAsync(connection, preparedMessages, cancellationToken);

        const string messageMergeSql = """
            INSERT INTO messages (
              id, archive_id, folder_id, source_key, internet_message_id, conversation_key,
              subject, sender_name, sender_address, to_json, cc_json, bcc_json,
              recipients_text, sent_at, received_at, body_text, body_html, headers_json,
              has_attachments, attachment_count, size_bytes, inbox_category, created_at
            )
            SELECT batch.id, batch.archive_id, COALESCE(filing.folder_id, folder.id), batch.source_key,
                   batch.internet_message_id, batch.conversation_key, batch.subject,
                   batch.sender_name, batch.sender_address, batch.to_json, batch.cc_json,
                   batch.bcc_json, batch.recipients_text, batch.sent_at, batch.received_at,
                   batch.body_text, batch.body_html, batch.headers_json,
                   batch.has_attachments, batch.attachment_count, batch.size_bytes, batch.inbox_category, batch.created_at
            FROM csharp_message_batch batch
            JOIN folders folder
              ON folder.archive_id = batch.archive_id AND folder.path = batch.folder_path
            LEFT JOIN LATERAL (
              SELECT rule.folder_id
              FROM (
                SELECT 'from'::text AS match_field,
                       lower(trim(batch.sender_address)) AS sender_address
                UNION ALL
                SELECT 'to'::text,
                       lower(trim(COALESCE(recipient->>'address', '')))
                FROM jsonb_array_elements(batch.to_json::jsonb) recipient
              ) candidate
              JOIN sender_filing_rules rule
                ON rule.archive_id = batch.archive_id
               AND rule.match_field = candidate.match_field
               AND rule.sender_address = candidate.sender_address
              JOIN folders target ON target.id = rule.folder_id AND target.archive_id = batch.archive_id
              WHERE candidate.sender_address <> ''
                AND (
                  rule.source_scope = 'all'
                  OR (rule.source_scope = 'inbox' AND lower(trim(folder.name)) = 'inbox')
                  OR (rule.source_scope = 'folder' AND rule.source_folder_id = folder.id)
                )
              ORDER BY CASE rule.source_scope WHEN 'folder' THEN 0 WHEN 'inbox' THEN 1 ELSE 2 END,
                rule.updated_at DESC
              LIMIT 1
            ) filing ON TRUE
            ON CONFLICT (archive_id, source_key) DO NOTHING
            """;
        await using (var merge = new NpgsqlCommand(messageMergeSql, connection, transaction)
        {
            CommandTimeout = ImportCommandTimeoutSeconds
        })
            await merge.ExecuteNonQueryAsync(cancellationToken);

        const string stateMergeSql = """
            INSERT INTO message_state (message_id, is_read, is_starred, tags_json, note)
            SELECT message.id, 0, 0, '[]', ''
            FROM csharp_message_batch batch
            JOIN messages message
              ON message.archive_id = batch.archive_id AND message.source_key = batch.source_key
            ON CONFLICT (message_id) DO NOTHING
            """;
        await using (var states = new NpgsqlCommand(stateMergeSql, connection, transaction)
        {
            CommandTimeout = ImportCommandTimeoutSeconds
        })
            await states.ExecuteNonQueryAsync(cancellationToken);

        const string deferredMergeSql = """
            INSERT INTO deferred_attachment_jobs (
              id, job_id, message_id, staging_path, source_file, status,
              attempts, created_at, updated_at
            )
            SELECT md5($1 || ':' || message.id), $1, message.id, $2, batch.source_file,
                   'queued', 0, $3, $3
            FROM csharp_message_batch batch
            JOIN messages message
              ON message.archive_id = batch.archive_id AND message.source_key = batch.source_key
            WHERE batch.has_attachments <> 0
            ON CONFLICT (message_id) DO NOTHING
            """;
        await using (var merge = new NpgsqlCommand(deferredMergeSql, connection, transaction)
        {
            CommandTimeout = ImportCommandTimeoutSeconds
        })
        {
            merge.Parameters.AddWithValue(job.Public.Id);
            merge.Parameters.AddWithValue(job.StagingPath
                ?? throw new InvalidOperationException("Import job has no staging path"));
            merge.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
            await merge.ExecuteNonQueryAsync(cancellationToken);
        }

        const string checkpointSql = """
            UPDATE import_jobs
            SET phase = 'indexing', processed_items = $2,
                processed_bytes = LEAST(total_bytes, processed_bytes + $3),
                checkpoint_json = $4, checkpoint_version = 2,
                lease_until = $5, message = 'Importing emails', updated_at = $6
            WHERE id = $1 AND status = 'running'
            """;
        await using (var update = new NpgsqlCommand(checkpointSql, connection, transaction)
        {
            CommandTimeout = ImportCommandTimeoutSeconds
        })
        {
            update.Parameters.AddWithValue(job.Public.Id);
            update.Parameters.AddWithValue(checkpoint.CommittedItems);
            update.Parameters.AddWithValue(preparedMessages.Sum(message => message.SizeBytes));
            update.Parameters.AddWithValue(JsonSerializer.Serialize(checkpoint, JsonOptions));
            update.Parameters.AddWithValue(DateTimeOffset.UtcNow.Add(lease).ToString("O"));
            update.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
            var changed = await update.ExecuteNonQueryAsync(cancellationToken);
            if (changed != 1) throw new OperationCanceledException("Import job is no longer running");
        }

        await transaction.CommitAsync(cancellationToken);
    }

    internal static bool IsTransientDatabaseFailure(NpgsqlException error) =>
        error.IsTransient
        || error.InnerException is TimeoutException
        || error.SqlState is "40001" or "40P01" or "55P03" or "57014";

    private static async Task CreateStagingTableAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = """
            CREATE TEMP TABLE csharp_message_batch (
              id TEXT NOT NULL,
              archive_id TEXT NOT NULL,
              folder_path TEXT NOT NULL,
              source_key TEXT NOT NULL,
              internet_message_id TEXT,
              conversation_key TEXT,
              subject TEXT NOT NULL,
              sender_name TEXT,
              sender_address TEXT NOT NULL,
              to_json TEXT NOT NULL,
              cc_json TEXT NOT NULL,
              bcc_json TEXT NOT NULL,
              recipients_text TEXT NOT NULL,
              sent_at TEXT,
              received_at TEXT,
              body_text TEXT NOT NULL,
              body_html TEXT,
              headers_json TEXT NOT NULL,
              has_attachments INTEGER NOT NULL,
              attachment_count INTEGER NOT NULL,
              size_bytes BIGINT NOT NULL,
              inbox_category TEXT NOT NULL,
              created_at TEXT NOT NULL,
              source_file TEXT NOT NULL
            ) ON COMMIT DROP
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task CopyMessagesAsync(
        NpgsqlConnection connection,
        IReadOnlyList<ParsedMessage> messages,
        CancellationToken cancellationToken)
    {
        const string copy = """
            COPY csharp_message_batch (
              id, archive_id, folder_path, source_key, internet_message_id, conversation_key,
              subject, sender_name, sender_address, to_json, cc_json, bcc_json,
              recipients_text, sent_at, received_at, body_text, body_html, headers_json,
              has_attachments, attachment_count, size_bytes, inbox_category, created_at, source_file
            ) FROM STDIN (FORMAT BINARY)
            """;
        await using var writer = await connection.BeginBinaryImportAsync(copy, cancellationToken);
        foreach (var message in messages)
        {
            await writer.StartRowAsync(cancellationToken);
            await writer.WriteAsync(message.Id, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.ArchiveId, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.FolderPath, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.SourceKey, NpgsqlDbType.Text, cancellationToken);
            await WriteNullableAsync(writer, message.InternetMessageId, cancellationToken);
            await WriteNullableAsync(writer, message.ConversationKey, cancellationToken);
            await writer.WriteAsync(message.Subject, NpgsqlDbType.Text, cancellationToken);
            await WriteNullableAsync(writer, message.SenderName, cancellationToken);
            await writer.WriteAsync(message.SenderAddress, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.ToJson, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.CcJson, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.BccJson, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.RecipientsText, NpgsqlDbType.Text, cancellationToken);
            await WriteNullableAsync(writer, message.SentAt, cancellationToken);
            await WriteNullableAsync(writer, message.ReceivedAt, cancellationToken);
            await writer.WriteAsync(message.BodyText, NpgsqlDbType.Text, cancellationToken);
            await WriteNullableAsync(writer, message.BodyHtml, cancellationToken);
            await writer.WriteAsync(message.HeadersJson, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.HasAttachments ? 1 : 0, NpgsqlDbType.Integer, cancellationToken);
            await writer.WriteAsync(message.AttachmentCount, NpgsqlDbType.Integer, cancellationToken);
            await writer.WriteAsync(message.SizeBytes, NpgsqlDbType.Bigint, cancellationToken);
            await writer.WriteAsync(message.InboxCategory, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.CreatedAt, NpgsqlDbType.Text, cancellationToken);
            await writer.WriteAsync(message.SourceFile, NpgsqlDbType.Text, cancellationToken);
        }
        await writer.CompleteAsync(cancellationToken);
    }

    private static async Task WriteNullableAsync(
        NpgsqlBinaryImporter writer,
        string? value,
        CancellationToken cancellationToken)
    {
        if (value is null) await writer.WriteNullAsync(cancellationToken);
        else await writer.WriteAsync(value, NpgsqlDbType.Text, cancellationToken);
    }

    private static async Task<IReadOnlyList<ParsedMessage>> ApplyTabSettingsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string archiveId,
        IReadOnlyList<ParsedMessage> messages,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("SELECT tabs_json FROM inbox_tab_settings WHERE archive_id=$1", connection, transaction);
        command.Parameters.AddWithValue(archiveId);
        var json = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken));
        if (string.IsNullOrWhiteSpace(json)) return messages;
        IReadOnlyList<InboxTabDefinitionDto>? tabs;
        try { tabs = JsonSerializer.Deserialize<List<InboxTabDefinitionDto>>(json, JsonOptions); }
        catch (JsonException) { return messages; }
        if (tabs is null || tabs.Count == 0) return messages;
        return messages.Select(message =>
        {
            IReadOnlyDictionary<string, string> headers;
            try { headers = JsonSerializer.Deserialize<Dictionary<string, string>>(message.HeadersJson, JsonOptions) ?? []; }
            catch (JsonException) { headers = new Dictionary<string, string>(); }
            return message with
            {
                InboxCategory = MessageCategorizer.ClassifyWithTabs(
                    message.SenderAddress, message.Subject, message.BodyText, headers, tabs)
            };
        }).ToArray();
    }

    private static async Task EnsureFoldersAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string archiveId,
        IReadOnlyList<ParsedMessage> messages,
        CancellationToken cancellationToken)
    {
        var cache = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var folderPath in messages.Select(message => message.FolderPath).Distinct(StringComparer.Ordinal))
        {
            string? parentId = null;
            var segments = folderPath.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            var currentPath = string.Empty;
            foreach (var segment in segments.Length == 0 ? ["Mailbox"] : segments)
            {
                currentPath = currentPath.Length == 0 ? segment : $"{currentPath}/{segment}";
                if (cache.TryGetValue(currentPath, out var cachedId))
                {
                    parentId = cachedId;
                    continue;
                }

                const string selectSql = "SELECT id FROM folders WHERE archive_id = $1 AND path = $2";
                await using var select = new NpgsqlCommand(selectSql, connection, transaction);
                select.Parameters.AddWithValue(archiveId);
                select.Parameters.AddWithValue(currentPath);
                var id = await select.ExecuteScalarAsync(cancellationToken) as string;
                if (id is null)
                {
                    id = Guid.NewGuid().ToString();
                    const string insertSql = """
                        INSERT INTO folders (id, archive_id, parent_id, name, path, message_count)
                        VALUES ($1, $2, $3, $4, $5, 0)
                        ON CONFLICT (archive_id, path) DO NOTHING
                        """;
                    await using var insert = new NpgsqlCommand(insertSql, connection, transaction);
                    insert.Parameters.AddWithValue(id);
                    insert.Parameters.AddWithValue(archiveId);
                    insert.Parameters.Add(new NpgsqlParameter
                    {
                        NpgsqlDbType = NpgsqlDbType.Text,
                        Value = (object?)parentId ?? DBNull.Value
                    });
                    insert.Parameters.AddWithValue(segment);
                    insert.Parameters.AddWithValue(currentPath);
                    await insert.ExecuteNonQueryAsync(cancellationToken);

                    await using var reread = new NpgsqlCommand(selectSql, connection, transaction);
                    reread.Parameters.AddWithValue(archiveId);
                    reread.Parameters.AddWithValue(currentPath);
                    id = (string)(await reread.ExecuteScalarAsync(cancellationToken)
                        ?? throw new InvalidOperationException("Unable to create archive folder"));
                }
                cache[currentPath] = id;
                parentId = id;
            }
        }
    }
}
