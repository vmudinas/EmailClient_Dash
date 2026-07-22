using System.Text;
using System.Text.Json;
using ArchiveMail.Api.Imports;
using Npgsql;

namespace ArchiveMail.Api.Mail;

public sealed class MailRepository(NpgsqlDataSource database)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> InboxCategories =
    ["primary", "promotions", "social", "updates", "bills", "medical", "mail_tracking"];

    public async Task<IReadOnlyList<ArchiveDto>> ListArchivesAsync(string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, name, source_type, status, size_bytes, message_count, unread_count,
                   starred_count, starred_unread_count, folder_count, attachment_count,
                   error_count, imported_at, created_at
            FROM archives
            WHERE status <> 'failed' AND owner_user_id = @owner
            ORDER BY COALESCE(imported_at, created_at) DESC
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var items = new List<ArchiveDto>();
        while (await reader.ReadAsync(cancellationToken)) items.Add(ReadArchive(reader));
        return items;
    }

    public async Task<ArchiveDto?> GetArchiveAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, name, source_type, status, size_bytes, message_count, unread_count,
                   starred_count, starred_unread_count, folder_count, attachment_count,
                   error_count, imported_at, created_at
            FROM archives WHERE id = @id AND owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadArchive(reader) : null;
    }

    public async Task<ArchiveDto> RenameArchiveAsync(
        string id,
        string ownerUserId,
        string name,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizeName(name, "Archive name");
        const string sql = "UPDATE archives SET name = @name WHERE id = @id AND owner_user_id = @owner";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("name", normalized);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) throw new MailNotFoundException("Archive not found");
        return (await GetArchiveAsync(id, ownerUserId, cancellationToken))!;
    }

    public async Task DeleteArchiveAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string sql = "DELETE FROM archives WHERE id = @id AND owner_user_id = @owner";
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) throw new MailNotFoundException("Archive not found");
        await DeleteOrphanBlobsAsync(connection, transaction, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<ArchiveMergeResult> CombineArchivesAsync(string sourceId, string targetId, string ownerUserId, CancellationToken cancellationToken)
    {
        if (sourceId == targetId) throw new ArgumentException("Choose two different archives");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string lockSql = "SELECT id,name,status FROM archives WHERE id=ANY(@ids) AND owner_user_id=@owner FOR UPDATE";
        await using var locked = new NpgsqlCommand(lockSql, connection, transaction);
        locked.Parameters.AddWithValue("ids", new[] { sourceId, targetId }); locked.Parameters.AddWithValue("owner", ownerUserId);
        var rows = new Dictionary<string, (string Name, string Status)>();
        await using (var reader = await locked.ExecuteReaderAsync(cancellationToken))
            while (await reader.ReadAsync(cancellationToken)) rows[reader.GetString(0)] = (reader.GetString(1), reader.GetString(2));
        if (rows.Count != 2) throw new MailNotFoundException("Archive not found");
        if (rows.Values.Any(value => value.Status == "importing")) throw new MailConflictException("Wait for imports to finish before combining archives");
        var prefix = NormalizeMailboxName(rows[sourceId].Name);
        var suffix = 1;
        while (await ScalarStringAsync(connection, transaction, "SELECT id FROM folders WHERE archive_id=@archive AND lower(path)=lower(@path)", [new("archive", targetId), new("path", prefix)], cancellationToken) is not null)
            prefix = $"{rows[sourceId].Name} ({++suffix})";
        var counts = await CountsAsync(connection, transaction, sourceId, cancellationToken);
        var rootId = Guid.NewGuid().ToString();
        await ExecuteAsync(connection, transaction, "INSERT INTO folders(id,archive_id,parent_id,name,path,message_count,unread_count) VALUES(@id,@archive,NULL,@name,@path,0,0)", [new("id",rootId),new("archive",targetId),new("name",prefix),new("path",prefix)], cancellationToken);
        await ExecuteAsync(connection, transaction, "UPDATE messages SET source_key=@source || ':' || source_key WHERE archive_id=@source", [new("source", sourceId)], cancellationToken);
        await ExecuteAsync(connection, transaction, "UPDATE folders SET archive_id=@target,parent_id=CASE WHEN parent_id IS NULL THEN @root ELSE parent_id END,path=@prefix || '/' || path WHERE archive_id=@source", [new("target", targetId),new("root",rootId),new("prefix",prefix),new("source",sourceId)], cancellationToken);
        await ExecuteAsync(connection, transaction, "UPDATE messages SET archive_id=@target WHERE archive_id=@source", [new("target",targetId),new("source",sourceId)], cancellationToken);
        await ExecuteAsync(connection, transaction, "DELETE FROM archives WHERE id=@source", [new("source",sourceId)], cancellationToken);
        await RecountArchiveAsync(connection, transaction, targetId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new((await GetArchiveAsync(targetId, ownerUserId, cancellationToken))!, counts.Messages, counts.Folders, counts.Attachments);
    }

    public async Task<IReadOnlyList<FolderDto>> ListFoldersAsync(
        string archiveId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT f.id, f.archive_id, f.parent_id, f.name, f.path, f.message_count, f.unread_count
            FROM folders f JOIN archives a ON a.id = f.archive_id
            WHERE f.archive_id = @archive AND a.owner_user_id = @owner
            ORDER BY f.path
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var items = new List<FolderDto>();
        while (await reader.ReadAsync(cancellationToken)) items.Add(ReadFolder(reader));
        return items;
    }

    public async Task<FolderDto> CreateFolderAsync(
        string archiveId,
        string ownerUserId,
        string name,
        string? parentId,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizeMailboxName(name);
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var archiveStatus = await ScalarStringAsync(connection, transaction,
            "SELECT status FROM archives WHERE id = @archive AND owner_user_id = @owner",
            [new("archive", archiveId), new("owner", ownerUserId)], cancellationToken);
        if (archiveStatus is null) throw new MailNotFoundException("Archive not found");
        if (archiveStatus == "importing") throw new MailConflictException("Wait for the archive import to finish before creating a mailbox");

        string? parentPath = null;
        if (!string.IsNullOrWhiteSpace(parentId))
        {
            parentPath = await ScalarStringAsync(connection, transaction,
                "SELECT path FROM folders WHERE id = @parent AND archive_id = @archive",
                [new("parent", parentId), new("archive", archiveId)], cancellationToken);
            if (parentPath is null) throw new MailNotFoundException("Parent mailbox not found");
        }
        var path = parentPath is null ? normalized : $"{parentPath}/{normalized}";
        var id = Guid.NewGuid().ToString();
        const string insertSql = """
            INSERT INTO folders (id, archive_id, parent_id, name, path, message_count, unread_count)
            VALUES (@id, @archive, @parent, @name, @path, 0, 0)
            """;
        await using (var insert = new NpgsqlCommand(insertSql, connection, transaction))
        {
            insert.Parameters.AddWithValue("id", id);
            insert.Parameters.AddWithValue("archive", archiveId);
            insert.Parameters.AddWithValue("parent", (object?)parentId ?? DBNull.Value);
            insert.Parameters.AddWithValue("name", normalized);
            insert.Parameters.AddWithValue("path", path);
            try { await insert.ExecuteNonQueryAsync(cancellationToken); }
            catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
            { throw new MailConflictException("A mailbox with that name already exists here"); }
        }
        await RecountArchiveAsync(connection, transaction, archiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(id, archiveId, parentId, normalized, path, 0, 0);
    }

    public async Task<FolderDto> RenameFolderAsync(
        string id,
        string ownerUserId,
        string name,
        CancellationToken cancellationToken)
    {
        var normalized = NormalizeMailboxName(name);
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var row = await GetFolderRowAsync(connection, transaction, id, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Mailbox not found");
        if (row.Status == "importing") throw new MailConflictException("Wait for the archive import to finish before renaming a mailbox");
        var parentPath = row.Path.Contains('/') ? row.Path[..row.Path.LastIndexOf('/')] : null;
        var newPath = parentPath is null ? normalized : $"{parentPath}/{normalized}";
        const string sql = """
            UPDATE folders
            SET name = CASE WHEN id = @id THEN @name ELSE name END,
                path = @new_path || substring(path FROM length(@old_path) + 1)
            WHERE archive_id = @archive AND (path = @old_path OR path LIKE @child_pattern ESCAPE '\\')
            """;
        await using var update = new NpgsqlCommand(sql, connection, transaction);
        update.Parameters.AddWithValue("id", id);
        update.Parameters.AddWithValue("name", normalized);
        update.Parameters.AddWithValue("new_path", newPath);
        update.Parameters.AddWithValue("old_path", row.Path);
        update.Parameters.AddWithValue("archive", row.ArchiveId);
        update.Parameters.AddWithValue("child_pattern", $"{EscapeLike(row.Path)}/%");
        try { await update.ExecuteNonQueryAsync(cancellationToken); }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        { throw new MailConflictException("A mailbox with that name already exists here"); }
        await transaction.CommitAsync(cancellationToken);
        return new(id, row.ArchiveId, row.ParentId, normalized, newPath, row.MessageCount, row.UnreadCount);
    }

    public async Task DeleteFolderAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var row = await GetFolderRowAsync(connection, transaction, id, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Mailbox not found");
        if (row.Status == "importing") throw new MailConflictException("Wait for the archive import to finish before deleting this mailbox");
        await using (var delete = new NpgsqlCommand("DELETE FROM folders WHERE id = @id", connection, transaction))
        {
            delete.Parameters.AddWithValue("id", id);
            await delete.ExecuteNonQueryAsync(cancellationToken);
        }
        await DeleteOrphanBlobsAsync(connection, transaction, cancellationToken);
        await RecountArchiveAsync(connection, transaction, row.ArchiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<MailboxMoveResult> MoveFolderAsync(string id, string? targetParentId, string ownerUserId, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var source = await GetFolderRowAsync(connection, transaction, id, ownerUserId, cancellationToken) ?? throw new MailNotFoundException("Mailbox not found");
        if (source.Status == "importing") throw new MailConflictException("Wait for the archive import to finish before moving a mailbox");
        string? parentPath = null;
        if (!string.IsNullOrWhiteSpace(targetParentId))
        {
            var parent = await GetFolderRowAsync(connection, transaction, targetParentId, ownerUserId, cancellationToken) ?? throw new MailNotFoundException("Destination mailbox not found");
            if (parent.ArchiveId != source.ArchiveId) throw new ArgumentException("Destination mailbox belongs to another archive");
            if (parent.Path == source.Path || parent.Path.StartsWith(source.Path + "/", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("A mailbox cannot be moved into itself");
            parentPath = parent.Path;
        }
        var name = source.Path[(source.Path.LastIndexOf('/') + 1)..];
        var newPath = parentPath is null ? name : $"{parentPath}/{name}";
        var moved = await ExecuteAsync(connection, transaction, "UPDATE folders SET parent_id=CASE WHEN id=@id THEN @parent ELSE parent_id END,path=@new || substring(path FROM length(@old)+1) WHERE archive_id=@archive AND (path=@old OR path LIKE @children ESCAPE '\\\\')", [new("id",id),new("parent",(object?)targetParentId??DBNull.Value),new("new",newPath),new("old",source.Path),new("archive",source.ArchiveId),new("children",$"{EscapeLike(source.Path)}/%")], cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(new(id, source.ArchiveId, targetParentId, name, newPath, source.MessageCount, source.UnreadCount), moved);
    }

    public async Task<MailboxMergeResult> CombineFoldersAsync(string sourceId, string targetId, string ownerUserId, CancellationToken cancellationToken)
    {
        if (sourceId == targetId) throw new ArgumentException("Choose two different mailboxes");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        var source = await GetFolderRowAsync(connection, transaction, sourceId, ownerUserId, cancellationToken) ?? throw new MailNotFoundException("Mailbox not found");
        var target = await GetFolderRowAsync(connection, transaction, targetId, ownerUserId, cancellationToken) ?? throw new MailNotFoundException("Destination mailbox not found");
        if (source.ArchiveId != target.ArchiveId) throw new ArgumentException("Mailboxes belong to different archives");
        if (target.Path.StartsWith(source.Path + "/", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("A mailbox cannot be combined into its child");
        var ids = new List<string>();
        await using (var command = new NpgsqlCommand("SELECT id FROM folders WHERE archive_id=@archive AND (path=@path OR path LIKE @children ESCAPE '\\\\')", connection, transaction))
        { command.Parameters.AddWithValue("archive",source.ArchiveId);command.Parameters.AddWithValue("path",source.Path);command.Parameters.AddWithValue("children",$"{EscapeLike(source.Path)}/%");await using var reader=await command.ExecuteReaderAsync(cancellationToken);while(await reader.ReadAsync(cancellationToken)) ids.Add(reader.GetString(0)); }
        var moved = Convert.ToInt64(await ScalarAsync(connection,transaction,"SELECT COUNT(*) FROM messages WHERE folder_id=ANY(@ids)",[new("ids",ids.ToArray())],cancellationToken));
        var attachments = Convert.ToInt64(await ScalarAsync(connection,transaction,"SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.folder_id=ANY(@ids)",[new("ids",ids.ToArray())],cancellationToken));
        await ExecuteAsync(connection,transaction,"UPDATE messages SET folder_id=@target WHERE folder_id=ANY(@ids)",[new("target",targetId),new("ids",ids.ToArray())],cancellationToken);
        await ExecuteAsync(connection,transaction,"DELETE FROM folders WHERE id=@source",[new("source",sourceId)],cancellationToken);
        await RecountArchiveAsync(connection,transaction,source.ArchiveId,cancellationToken); await transaction.CommitAsync(cancellationToken);
        var result=(await ListFoldersAsync(source.ArchiveId,ownerUserId,cancellationToken)).Single(folder=>folder.Id==targetId);
        return new(result,moved,ids.Count,attachments);
    }

    public async Task<CursorPageDto<MessageSummaryDto>> ListMessagesAsync(
        MessageFilters filters,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var limit = ClampLimit(filters.Limit);
        var offset = DecodeOffset(filters.Cursor);
        var (where, parameters) = BuildFilters(filters, ownerUserId);
        var sql = $"""
            SELECT {SummaryColumns}
            {SummaryJoins}
            WHERE {where}
            ORDER BY COALESCE(m.received_at, m.sent_at, '') DESC, m.created_at DESC, m.id DESC
            LIMIT @limit OFFSET @offset
            """;
        await using var command = database.CreateCommand(sql);
        AddParameters(command, parameters);
        command.Parameters.AddWithValue("limit", limit + 1);
        command.Parameters.AddWithValue("offset", offset);
        var rows = await ReadSummariesAsync(command, cancellationToken);
        var hasMore = rows.Count > limit;
        if (hasMore) rows.RemoveAt(rows.Count - 1);
        return new(rows, hasMore ? EncodeOffset(offset + limit) : null);
    }

    public async Task<InboxCategoryCountsDto> CountCategoriesAsync(
        MessageFilters filters,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var categoryFilters = filters with { InboxCategory = null, From = null, To = null, After = null, Before = null, HasAttachment = null };
        var (where, parameters) = BuildFilters(categoryFilters, ownerUserId);
        var sql = $"""
            SELECT m.inbox_category, COUNT(*)
            FROM messages m
            LEFT JOIN message_state s ON s.message_id = m.id
            JOIN archives owner_archive ON owner_archive.id = m.archive_id
            WHERE {where}
            GROUP BY m.inbox_category
            """;
        await using var command = database.CreateCommand(sql);
        AddParameters(command, parameters);
        var counts = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken)) counts[reader.GetString(0)] = reader.GetInt64(1);
        return new(
            counts.GetValueOrDefault("primary"), counts.GetValueOrDefault("promotions"),
            counts.GetValueOrDefault("social"), counts.GetValueOrDefault("updates"),
            counts.GetValueOrDefault("bills"), counts.GetValueOrDefault("medical"),
            counts.GetValueOrDefault("mail_tracking"));
    }

    public async Task<CursorPageDto<SearchHitDto>> SearchAsync(
        string query,
        string? sort,
        MessageFilters filters,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(query)) return new([], null);
        if (query.Length > 500) throw new ArgumentException("Search query is too long");
        var limit = ClampLimit(filters.Limit);
        var offset = DecodeOffset(filters.Cursor);
        var (where, parameters) = BuildFilters(filters, ownerUserId);
        var ordering = sort == "newest"
            ? "COALESCE(m.received_at, m.sent_at, '') DESC, ranked.rank DESC, m.created_at DESC, m.id DESC"
            : "ranked.rank DESC, COALESCE(m.received_at, m.sent_at, '') DESC, m.created_at DESC, m.id DESC";
        var sql = $"""
            WITH search_query AS (SELECT websearch_to_tsquery('simple', @query) AS value),
            raw_hits AS (
              SELECT m.id AS message_id,
                ts_rank_cd(to_tsvector('simple', COALESCE(m.subject, '') || ' ' || COALESCE(m.sender_name, '') || ' ' ||
                  COALESCE(m.sender_address, '') || ' ' || COALESCE(m.recipients_text, '') || ' ' || COALESCE(m.body_text, '')),
                  search_query.value) AS rank,
                'message' AS matched_in, NULL::text AS attachment_id, NULL::text AS attachment_name,
                ts_headline('simple', COALESCE(m.subject, '') || ' ' || COALESCE(m.body_text, ''), search_query.value,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8') AS hit_snippet
              FROM messages m CROSS JOIN search_query
              WHERE to_tsvector('simple', COALESCE(m.subject, '') || ' ' || COALESCE(m.sender_name, '') || ' ' ||
                COALESCE(m.sender_address, '') || ' ' || COALESCE(m.recipients_text, '') || ' ' || COALESCE(m.body_text, '')) @@ search_query.value
              UNION ALL
              SELECT a.message_id,
                ts_rank_cd(to_tsvector('simple', COALESCE(a.filename, '') || ' ' || COALESCE(a.extracted_text, '')), search_query.value) * 0.8,
                'attachment', a.id, a.filename,
                ts_headline('simple', COALESCE(a.filename, '') || ' ' || COALESCE(a.extracted_text, ''), search_query.value,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=24, MinWords=8')
              FROM attachments a CROSS JOIN search_query
              WHERE to_tsvector('simple', COALESCE(a.filename, '') || ' ' || COALESCE(a.extracted_text, '')) @@ search_query.value
            ), ranked AS (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY rank DESC) AS hit_order FROM raw_hits
            )
            SELECT {SummaryColumns}, ranked.rank, ranked.matched_in, ranked.attachment_id, ranked.attachment_name, ranked.hit_snippet
            FROM ranked
            JOIN messages m ON m.id = ranked.message_id
            JOIN folders f ON f.id = m.folder_id
            LEFT JOIN message_state s ON s.message_id = m.id
            JOIN archives owner_archive ON owner_archive.id = m.archive_id
            WHERE ranked.hit_order = 1 AND {where}
            ORDER BY {ordering}
            LIMIT @limit OFFSET @offset
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("query", query.Trim());
        AddParameters(command, parameters);
        command.Parameters.AddWithValue("limit", limit + 1);
        command.Parameters.AddWithValue("offset", offset);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var hits = new List<SearchHitDto>();
        while (await reader.ReadAsync(cancellationToken))
        {
            var message = ReadSummary(reader);
            hits.Add(new(
                message,
                reader.GetDouble(23),
                reader.GetString(24),
                reader.IsDBNull(25) ? null : reader.GetString(25),
                reader.IsDBNull(26) ? null : reader.GetString(26),
                reader.IsDBNull(27) ? "" : reader.GetString(27)));
        }
        var hasMore = hits.Count > limit;
        if (hasMore) hits.RemoveAt(hits.Count - 1);
        return new(hits, hasMore ? EncodeOffset(offset + limit) : null);
    }

    public async Task<MessageDetailDto?> GetMessageAsync(
        string id,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var sql = $"""
            SELECT {SummaryColumns}, m.cc_json, m.bcc_json, m.body_text, m.body_html, m.headers_json
            {SummaryJoins}
            WHERE m.id = @id AND owner_archive.owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var summary = ReadSummary(reader);
        var cc = ParseJson<List<EmailAddressDto>>(reader.IsDBNull(23) ? null : reader.GetString(23), []);
        var bcc = ParseJson<List<EmailAddressDto>>(reader.IsDBNull(24) ? null : reader.GetString(24), []);
        var bodyText = reader.IsDBNull(25) ? "" : reader.GetString(25);
        var bodyHtml = EmailHtmlSanitizer.Sanitize(reader.IsDBNull(26) ? null : reader.GetString(26));
        var headers = ParseJson<Dictionary<string, string>>(reader.IsDBNull(27) ? null : reader.GetString(27), []);
        await reader.CloseAsync();
        var attachments = await ListAttachmentsAsync(id, cancellationToken);
        return new(
            summary.Id, summary.ArchiveId, summary.FolderId, summary.FolderPath, summary.Subject,
            summary.Sender, summary.Recipients, summary.SentAt, summary.ReceivedAt, summary.Preview,
            summary.HasAttachments, summary.AttachmentCount, summary.InboxCategory, summary.HasAiAnalysis,
            summary.HasCalendarEvent, summary.HasPendingFollowUp, summary.HasReply, summary.State,
            summary.Recipients, cc, bcc, bodyText, bodyHtml, headers, attachments, summary.Shipment);
    }

    public async Task<MessageThreadDto> GetThreadAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sourceSql = """
            SELECT m.conversation_key FROM messages m JOIN archives a ON a.id = m.archive_id
            WHERE m.id = @id AND a.owner_user_id = @owner
            """;
        await using var source = database.CreateCommand(sourceSql);
        source.Parameters.AddWithValue("id", id);
        source.Parameters.AddWithValue("owner", ownerUserId);
        var key = await source.ExecuteScalarAsync(cancellationToken);
        if (key is null) throw new MailNotFoundException("Message not found");
        if (key is DBNull || string.IsNullOrWhiteSpace(Convert.ToString(key)))
        {
            var one = await GetMessageAsync(id, ownerUserId, cancellationToken);
            return new(id, 1, one is null ? [] : [SummaryFromDetail(one)]);
        }
        var conversationKey = Convert.ToString(key)!;
        const string countSql = "SELECT COUNT(*) FROM messages WHERE conversation_key = @key";
        await using var count = database.CreateCommand(countSql);
        count.Parameters.AddWithValue("key", conversationKey);
        var total = Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken));
        var sql = $"""
            SELECT {SummaryColumns}
            {SummaryJoins}
            WHERE m.conversation_key = @key AND owner_archive.owner_user_id = @owner
            ORDER BY COALESCE(m.received_at, m.sent_at, m.created_at), m.id LIMIT 50
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("key", conversationKey);
        command.Parameters.AddWithValue("owner", ownerUserId);
        return new(id, total, await ReadSummariesAsync(command, cancellationToken));
    }

    public async Task<AttachmentContentDto?> GetAttachmentContentAsync(
        string attachmentId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT at.filename, at.content_type, at.size_bytes, b.relative_path
            FROM attachments at
            JOIN blobs b ON b.sha256 = at.blob_sha256
            JOIN messages m ON m.id = at.message_id
            JOIN archives a ON a.id = m.archive_id
            WHERE at.id = @id AND a.owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", attachmentId);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new(reader.GetString(0), reader.GetString(1), reader.GetInt64(2), reader.GetString(3))
            : null;
    }

    public async Task<LocalMessageStateDto> UpdateStateAsync(
        string id,
        string ownerUserId,
        MessageStatePatch patch,
        CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string selectSql = """
            SELECT s.is_read, s.is_starred, s.tags_json, s.note, s.updated_at, m.archive_id
            FROM message_state s JOIN messages m ON m.id = s.message_id JOIN archives a ON a.id = m.archive_id
            WHERE s.message_id = @id AND a.owner_user_id = @owner FOR UPDATE
            """;
        await using var select = new NpgsqlCommand(selectSql, connection, transaction);
        select.Parameters.AddWithValue("id", id);
        select.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await select.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) throw new MailNotFoundException("Message not found");
        var currentRead = reader.GetInt64(0) != 0;
        var currentStarred = reader.GetInt64(1) != 0;
        var currentTags = ParseJson<string[]>(reader.GetString(2), []);
        var currentNote = reader.GetString(3);
        var archiveId = reader.GetString(5);
        await reader.CloseAsync();
        var tags = patch.Tags is null
            ? currentTags
            : patch.Tags.Select(item => item.Trim()).Where(item => item.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string updateSql = """
            UPDATE message_state SET is_read = @read, is_starred = @starred, tags_json = @tags, note = @note, updated_at = @now
            WHERE message_id = @id
            """;
        await using var update = new NpgsqlCommand(updateSql, connection, transaction);
        update.Parameters.AddWithValue("read", patch.IsRead ?? currentRead ? 1 : 0);
        update.Parameters.AddWithValue("starred", patch.IsStarred ?? currentStarred ? 1 : 0);
        update.Parameters.AddWithValue("tags", JsonSerializer.Serialize(tags, JsonOptions));
        update.Parameters.AddWithValue("note", patch.Note ?? currentNote);
        update.Parameters.AddWithValue("now", now);
        update.Parameters.AddWithValue("id", id);
        await update.ExecuteNonQueryAsync(cancellationToken);
        await RecountArchiveAsync(connection, transaction, archiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(patch.IsRead ?? currentRead, patch.IsStarred ?? currentStarred, tags, patch.Note ?? currentNote, now);
    }

    public async Task MoveMessageAsync(
        string messageId,
        string folderId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(folderId)) throw new ArgumentException("Choose a destination mailbox");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string sql = """
            UPDATE messages m SET folder_id = @folder
            FROM folders target, archives a
            WHERE m.id = @message AND a.id = m.archive_id AND a.owner_user_id = @owner
              AND target.id = @folder AND target.archive_id = m.archive_id
            RETURNING m.archive_id
            """;
        await using var update = new NpgsqlCommand(sql, connection, transaction);
        update.Parameters.AddWithValue("folder", folderId);
        update.Parameters.AddWithValue("message", messageId);
        update.Parameters.AddWithValue("owner", ownerUserId);
        var archiveId = Convert.ToString(await update.ExecuteScalarAsync(cancellationToken));
        if (string.IsNullOrEmpty(archiveId)) throw new MailConflictException("Message or destination mailbox not found");
        await RecountArchiveAsync(connection, transaction, archiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<BulkReadResult> BulkReadAsync(string[] ids, string ownerUserId, CancellationToken cancellationToken)
    {
        var unique = ids.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().Take(500).ToArray();
        if (unique.Length == 0) throw new ArgumentException("Choose one or more messages");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string selectSql = """
            SELECT m.id, s.is_read, m.archive_id FROM messages m
            JOIN message_state s ON s.message_id = m.id JOIN archives a ON a.id = m.archive_id
            WHERE m.id = ANY(@ids) AND a.owner_user_id = @owner
            """;
        await using var select = new NpgsqlCommand(selectSql, connection, transaction);
        select.Parameters.AddWithValue("ids", unique);
        select.Parameters.AddWithValue("owner", ownerUserId);
        var pending = new List<string>();
        var archives = new HashSet<string>();
        long alreadyRead = 0;
        await using (var reader = await select.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                archives.Add(reader.GetString(2));
                if (reader.GetInt64(1) != 0) alreadyRead++;
                else pending.Add(reader.GetString(0));
            }
        }
        if (pending.Count > 0)
        {
            await using var update = new NpgsqlCommand(
                "UPDATE message_state SET is_read = 1, updated_at = @now WHERE message_id = ANY(@ids)", connection, transaction);
            update.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
            update.Parameters.AddWithValue("ids", pending.ToArray());
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
        foreach (var archive in archives) await RecountArchiveAsync(connection, transaction, archive, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(pending.Count, alreadyRead, unique.Length - pending.Count - alreadyRead);
    }

    public async Task<BulkFolderMoveResult> BulkMoveToFolderAsync(
        string[] ids,
        string folderId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var unique = ids.Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().Take(500).ToArray();
        if (unique.Length == 0) throw new ArgumentException("Choose one or more messages");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string folderSql = """
            SELECT f.archive_id, f.path FROM folders f JOIN archives a ON a.id = f.archive_id
            WHERE f.id = @folder AND a.owner_user_id = @owner
            """;
        await using var folder = new NpgsqlCommand(folderSql, connection, transaction);
        folder.Parameters.AddWithValue("folder", folderId);
        folder.Parameters.AddWithValue("owner", ownerUserId);
        await using var folderReader = await folder.ExecuteReaderAsync(cancellationToken);
        if (!await folderReader.ReadAsync(cancellationToken)) throw new MailNotFoundException("Destination mailbox not found");
        var archiveId = folderReader.GetString(0);
        var path = folderReader.GetString(1);
        await folderReader.CloseAsync();
        const string countSql = """
            SELECT COUNT(*) FILTER (WHERE folder_id = @folder), COUNT(*) FILTER (WHERE folder_id <> @folder)
            FROM messages WHERE id = ANY(@ids) AND archive_id = @archive
            """;
        await using var count = new NpgsqlCommand(countSql, connection, transaction);
        count.Parameters.AddWithValue("folder", folderId);
        count.Parameters.AddWithValue("ids", unique);
        count.Parameters.AddWithValue("archive", archiveId);
        await using var countReader = await count.ExecuteReaderAsync(cancellationToken);
        await countReader.ReadAsync(cancellationToken);
        var already = countReader.GetInt64(0);
        var moved = countReader.GetInt64(1);
        await countReader.CloseAsync();
        await using var update = new NpgsqlCommand(
            "UPDATE messages SET folder_id = @folder WHERE id = ANY(@ids) AND archive_id = @archive AND folder_id <> @folder",
            connection, transaction);
        update.Parameters.AddWithValue("folder", folderId);
        update.Parameters.AddWithValue("ids", unique);
        update.Parameters.AddWithValue("archive", archiveId);
        await update.ExecuteNonQueryAsync(cancellationToken);
        await RecountArchiveAsync(connection, transaction, archiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(folderId, path, moved, already, unique.Length - moved - already);
    }

    private async Task<IReadOnlyList<AttachmentDto>> ListAttachmentsAsync(string messageId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, message_id, filename, content_type, size_bytes, content_id, disposition, text_status
            FROM attachments WHERE message_id = @message
            ORDER BY CASE disposition WHEN 'inline' THEN 1 ELSE 0 END, lower(filename)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("message", messageId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var items = new List<AttachmentDto>();
        while (await reader.ReadAsync(cancellationToken)) items.Add(new(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetInt64(4),
            reader.IsDBNull(5) ? null : reader.GetString(5), reader.GetString(6), reader.GetString(7)));
        return items;
    }

    private static (string Sql, List<NpgsqlParameter> Parameters) BuildFilters(MessageFilters filters, string ownerUserId)
    {
        var conditions = new List<string> { "owner_archive.owner_user_id = @owner" };
        var parameters = new List<NpgsqlParameter> { new("owner", ownerUserId) };
        void Add(string condition, string name, object value) { conditions.Add(condition); parameters.Add(new(name, value)); }
        if (!string.IsNullOrWhiteSpace(filters.ArchiveId)) Add("m.archive_id = @archive", "archive", filters.ArchiveId);
        if (!string.IsNullOrWhiteSpace(filters.FolderId)) Add("m.folder_id = @folder", "folder", filters.FolderId);
        if (filters.IsRead is not null) Add("COALESCE(s.is_read, 0) = @read", "read", filters.IsRead.Value ? 1 : 0);
        if (filters.Starred is not null) Add("COALESCE(s.is_starred, 0) = @starred", "starred", filters.Starred.Value ? 1 : 0);
        if (!string.IsNullOrWhiteSpace(filters.InboxCategory))
        {
            if (!InboxCategories.Contains(filters.InboxCategory)) throw new ArgumentException("Invalid inbox category");
            Add("m.inbox_category = @category", "category", filters.InboxCategory);
        }
        if (!string.IsNullOrWhiteSpace(filters.From)) Add("lower(m.sender_address || ' ' || COALESCE(m.sender_name, '')) LIKE @from ESCAPE '\\'", "from", $"%{EscapeLike(filters.From.ToLowerInvariant())}%");
        if (!string.IsNullOrWhiteSpace(filters.To)) Add("lower(m.recipients_text) LIKE @to ESCAPE '\\'", "to", $"%{EscapeLike(filters.To.ToLowerInvariant())}%");
        if (!string.IsNullOrWhiteSpace(filters.After)) Add("COALESCE(m.received_at, m.sent_at) >= @after", "after", filters.After);
        if (!string.IsNullOrWhiteSpace(filters.Before)) Add("COALESCE(m.received_at, m.sent_at) <= @before", "before", filters.Before);
        if (filters.HasAttachment is not null)
        {
            conditions.Add($"{(filters.HasAttachment.Value ? "" : "NOT ")}EXISTS (SELECT 1 FROM attachments fa WHERE fa.message_id = m.id AND (fa.disposition <> 'inline' OR fa.content_id IS NULL OR trim(fa.content_id) = ''))");
        }
        return (string.Join(" AND ", conditions), parameters);
    }

    private static void AddParameters(NpgsqlCommand command, IEnumerable<NpgsqlParameter> parameters)
    {
        foreach (var parameter in parameters) command.Parameters.Add(parameter);
    }

    private static async Task<List<MessageSummaryDto>> ReadSummariesAsync(NpgsqlCommand command, CancellationToken cancellationToken)
    {
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var rows = new List<MessageSummaryDto>();
        while (await reader.ReadAsync(cancellationToken)) rows.Add(ReadSummary(reader));
        return rows;
    }

    private static MessageSummaryDto ReadSummary(NpgsqlDataReader reader)
    {
        var body = reader.IsDBNull(11) ? "" : reader.GetString(11);
        var preview = string.Join(' ', body.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        if (preview.Length > 220) preview = preview[..220];
        var senderName = reader.IsDBNull(5) ? null : reader.GetString(5);
        var senderAddress = reader.IsDBNull(6) ? "" : reader.GetString(6);
        var subject = string.IsNullOrEmpty(reader.GetString(4)) ? "(No subject)" : reader.GetString(4);
        var sentAt = reader.IsDBNull(8) ? null : reader.GetString(8);
        var receivedAt = reader.IsDBNull(9) ? null : reader.GetString(9);
        return new(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
            subject,
            new(senderName, senderAddress),
            ParseJson<List<EmailAddressDto>>(reader.GetString(7), []),
            sentAt, receivedAt,
            preview, reader.GetInt64(12) > 0, reader.GetInt64(12), reader.GetString(13),
            reader.GetBoolean(14), reader.GetBoolean(15), reader.GetBoolean(16), reader.GetBoolean(17),
            new(reader.GetInt64(18) != 0, reader.GetInt64(19) != 0,
                ParseJson<string[]>(reader.GetString(20), []), reader.GetString(21), reader.IsDBNull(22) ? null : reader.GetString(22)),
            ShipmentExtractor.Extract(senderName, senderAddress, subject, body, receivedAt, sentAt));
    }

    private static MessageSummaryDto SummaryFromDetail(MessageDetailDto message) => new(
        message.Id, message.ArchiveId, message.FolderId, message.FolderPath, message.Subject,
        message.Sender, message.Recipients, message.SentAt, message.ReceivedAt, message.Preview,
        message.HasAttachments, message.AttachmentCount, message.InboxCategory, message.HasAiAnalysis,
        message.HasCalendarEvent, message.HasPendingFollowUp, message.HasReply, message.State, message.Shipment);

    private static ArchiveDto ReadArchive(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        reader.GetInt64(4), reader.GetInt64(5), reader.GetInt64(6), reader.GetInt64(7), reader.GetInt64(8),
        reader.GetInt64(9), reader.GetInt64(10), reader.GetInt64(11),
        reader.IsDBNull(12) ? null : reader.GetString(12), reader.GetString(13));

    private static FolderDto ReadFolder(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
        reader.GetString(3), reader.GetString(4), reader.GetInt64(5), reader.GetInt64(6));

    private static T ParseJson<T>(string? json, T fallback)
    {
        if (string.IsNullOrWhiteSpace(json)) return fallback;
        try { return JsonSerializer.Deserialize<T>(json, JsonOptions) ?? fallback; }
        catch (JsonException) { return fallback; }
    }

    private static string NormalizeName(string? value, string label)
    {
        var normalized = value?.Trim() ?? "";
        if (normalized.Length is < 1 or > 200) throw new ArgumentException($"{label} must be between 1 and 200 characters");
        return normalized;
    }

    private static string NormalizeMailboxName(string value)
    {
        var normalized = NormalizeName(value, "Mailbox name");
        if (normalized.Contains('/') || normalized.Contains('\\') || normalized.Any(char.IsControl))
            throw new ArgumentException("Mailbox names cannot contain slashes or control characters");
        return normalized;
    }

    private static int ClampLimit(int? limit) => Math.Clamp(limit ?? 50, 1, 100);
    private static string EncodeOffset(int offset) => Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { offset })))
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static int DecodeOffset(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor)) return 0;
        try
        {
            var normalized = cursor.Replace('-', '+').Replace('_', '/');
            normalized += new string('=', (4 - normalized.Length % 4) % 4);
            using var json = JsonDocument.Parse(Convert.FromBase64String(normalized));
            return json.RootElement.TryGetProperty("offset", out var value) && value.TryGetInt32(out var offset) && offset >= 0 ? offset : 0;
        }
        catch { return 0; }
    }

    private static string EscapeLike(string value) => value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");

    private static async Task<string?> ScalarStringAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string sql,
        IReadOnlyList<NpgsqlParameter> parameters,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        foreach (var parameter in parameters) command.Parameters.Add(parameter);
        return Convert.ToString(await command.ExecuteScalarAsync(cancellationToken));
    }

    private static async Task<object?> ScalarAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string sql,
        IReadOnlyList<NpgsqlParameter> parameters, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        foreach (var parameter in parameters) command.Parameters.Add(parameter);
        return await command.ExecuteScalarAsync(cancellationToken);
    }

    private static async Task<int> ExecuteAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, string sql,
        IReadOnlyList<NpgsqlParameter> parameters, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        foreach (var parameter in parameters) command.Parameters.Add(parameter);
        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<(long Messages, long Folders, long Attachments)> CountsAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string archiveId, CancellationToken cancellationToken)
    {
        const string sql = "SELECT (SELECT COUNT(*) FROM messages WHERE archive_id=@archive),(SELECT COUNT(*) FROM folders WHERE archive_id=@archive),(SELECT COUNT(*) FROM attachments a JOIN messages m ON m.id=a.message_id WHERE m.archive_id=@archive)";
        await using var command = new NpgsqlCommand(sql, connection, transaction); command.Parameters.AddWithValue("archive", archiveId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken); await reader.ReadAsync(cancellationToken);
        return (reader.GetInt64(0), reader.GetInt64(1), reader.GetInt64(2));
    }

    private sealed record FolderRow(
        string ArchiveId, string? ParentId, string Path, long MessageCount, long UnreadCount, string Status);

    private static async Task<FolderRow?> GetFolderRowAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string id,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT f.archive_id, f.parent_id, f.path, f.message_count, f.unread_count, a.status
            FROM folders f JOIN archives a ON a.id = f.archive_id
            WHERE f.id = @id AND a.owner_user_id = @owner FOR UPDATE
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? new(reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.GetString(2),
                reader.GetInt64(3), reader.GetInt64(4), reader.GetString(5))
            : null;
    }

    private static async Task RecountArchiveAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        string archiveId,
        CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE folders f SET
              message_count = (SELECT COUNT(*) FROM messages m WHERE m.folder_id = f.id),
              unread_count = (SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id = m.id WHERE m.folder_id = f.id AND s.is_read = 0)
            WHERE f.archive_id = @archive;
            UPDATE archives a SET
              message_count = (SELECT COUNT(*) FROM messages m WHERE m.archive_id = a.id),
              folder_count = (SELECT COUNT(*) FROM folders f WHERE f.archive_id = a.id),
              attachment_count = (SELECT COUNT(*) FROM attachments at JOIN messages m ON m.id = at.message_id WHERE m.archive_id = a.id),
              unread_count = (SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id = m.id WHERE m.archive_id = a.id AND s.is_read = 0),
              starred_count = (SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id = m.id WHERE m.archive_id = a.id AND s.is_starred = 1),
              starred_unread_count = (SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id = m.id WHERE m.archive_id = a.id AND s.is_starred = 1 AND s.is_read = 0)
            WHERE a.id = @archive;
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("archive", archiveId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task DeleteOrphanBlobsAsync(
        NpgsqlConnection connection,
        NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        const string sql = "DELETE FROM blobs b WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.blob_sha256 = b.sha256)";
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private const string SummaryColumns = """
        m.id, m.archive_id, m.folder_id, f.path, m.subject, m.sender_name, m.sender_address, m.to_json,
        m.sent_at, m.received_at, m.created_at, substring(m.body_text FROM 1 FOR 2000),
        (SELECT COUNT(*) FROM attachments sa WHERE sa.message_id = m.id AND
          (sa.disposition <> 'inline' OR sa.content_id IS NULL OR trim(sa.content_id) = '')) AS attachment_count,
        m.inbox_category,
        false AS has_ai_analysis,
        EXISTS(SELECT 1 FROM message_calendar_events ce WHERE ce.message_id = m.id) AS has_calendar_event,
        EXISTS(SELECT 1 FROM message_follow_ups fu WHERE fu.conversation_key = m.conversation_key AND fu.status = 'pending') AS has_pending_follow_up,
        EXISTS(SELECT 1 FROM conversation_replies cr WHERE cr.conversation_key = m.conversation_key) AS has_reply,
        COALESCE(s.is_read, 0), COALESCE(s.is_starred, 0), COALESCE(s.tags_json, '[]'), COALESCE(s.note, ''), s.updated_at
        """;

    private const string SummaryJoins = """
        FROM messages m
        JOIN folders f ON f.id = m.folder_id
        LEFT JOIN message_state s ON s.message_id = m.id
        JOIN archives owner_archive ON owner_archive.id = m.archive_id
        """;
}
