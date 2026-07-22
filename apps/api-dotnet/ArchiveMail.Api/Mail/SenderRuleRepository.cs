using System.Net.Mail;
using Npgsql;

namespace ArchiveMail.Api.Mail;

public sealed class SenderRuleRepository(NpgsqlDataSource database)
{
    public async Task<SenderFilingStatusDto?> GetStatusAsync(
        string archiveId,
        string ownerUserId,
        CancellationToken cancellationToken,
        NpgsqlConnection? existingConnection = null,
        NpgsqlTransaction? transaction = null)
    {
        var ownsConnection = existingConnection is null;
        await using var ownedConnection = ownsConnection ? await database.OpenConnectionAsync(cancellationToken) : null;
        var connection = existingConnection ?? ownedConnection!;
        const string archiveSql = "SELECT name FROM archives WHERE id = @archive AND owner_user_id = @owner";
        await using var archive = new NpgsqlCommand(archiveSql, connection, transaction);
        archive.Parameters.AddWithValue("archive", archiveId);
        archive.Parameters.AddWithValue("owner", ownerUserId);
        var archiveName = Convert.ToString(await archive.ExecuteScalarAsync(cancellationToken));
        if (string.IsNullOrEmpty(archiveName)) return null;

        const string rulesSql = """
            SELECT r.id, r.archive_id, r.match_field, r.sender_address, r.sender_name, r.rule_type,
              r.source_scope, r.source_folder_id, source.path, r.folder_id, target.path,
              (SELECT COUNT(*) FROM messages m
               WHERE m.archive_id = r.archive_id AND m.folder_id = r.folder_id AND (
                 (r.match_field = 'from' AND lower(trim(m.sender_address)) = r.sender_address)
                 OR (r.match_field = 'to' AND EXISTS (
                   SELECT 1 FROM jsonb_array_elements(m.to_json::jsonb) recipient
                   WHERE lower(trim(COALESCE(recipient->>'address', ''))) = r.sender_address
                 ))
               )) AS live_message_count,
              r.created_at, r.updated_at
            FROM sender_filing_rules r
            JOIN folders target ON target.id = r.folder_id
            LEFT JOIN folders source ON source.id = r.source_folder_id
            WHERE r.archive_id = @archive
            ORDER BY live_message_count DESC, lower(r.sender_address)
            """;
        await using var rulesCommand = new NpgsqlCommand(rulesSql, connection, transaction);
        rulesCommand.Parameters.AddWithValue("archive", archiveId);
        var rules = new List<SenderFilingRuleDto>();
        await using (var reader = await rulesCommand.ExecuteReaderAsync(cancellationToken))
        {
            while (await reader.ReadAsync(cancellationToken))
            {
                var address = reader.GetString(3);
                rules.Add(new(
                    reader.GetString(0), reader.GetString(1), reader.GetString(2), address, address,
                    reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5), reader.GetString(6),
                    reader.IsDBNull(7) ? null : reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8),
                    reader.GetString(9), reader.GetString(10), reader.GetInt64(11), reader.GetString(12), reader.GetString(13)));
            }
        }

        const string runSql = "SELECT moved_messages, created_folders, ran_at FROM sender_filing_runs WHERE archive_id = @archive";
        await using var run = new NpgsqlCommand(runSql, connection, transaction);
        run.Parameters.AddWithValue("archive", archiveId);
        await using var runReader = await run.ExecuteReaderAsync(cancellationToken);
        long moved = 0;
        long created = 0;
        string? ranAt = null;
        if (await runReader.ReadAsync(cancellationToken))
        {
            moved = runReader.GetInt64(0);
            created = runReader.GetInt64(1);
            ranAt = runReader.GetString(2);
        }
        return new(archiveId, archiveName, rules.Count > 0, rules, ranAt, moved, created);
    }

    public async Task<SenderFilingRuleCreateResultDto> CreateAsync(
        SenderFilingRuleCreateRequest request,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var matchAddress = NormalizeAddress(request.MatchAddress);
        var archiveScope = OneOf(request.ArchiveScope, "archive", "all");
        var matchField = OneOf(request.MatchField, "from", "to");
        var sourceScope = OneOf(request.SourceScope, "inbox", "folder", "all");
        if (sourceScope == "folder" && string.IsNullOrWhiteSpace(request.SourceFolderId))
            throw new ArgumentException("Choose the folder to apply this rule to");
        if (archiveScope == "all" && sourceScope == "folder")
            throw new ArgumentException("A specific source folder can only be used with one archive");
        var hasFolderId = !string.IsNullOrWhiteSpace(request.DestinationFolderId);
        var hasFolderName = !string.IsNullOrWhiteSpace(request.DestinationFolderName);
        if (hasFolderId == hasFolderName) throw new ArgumentException("Choose an existing destination or enter a new folder name");
        if (archiveScope == "all" && hasFolderId)
            throw new ArgumentException("Use a new folder name when applying a rule to all archives");
        var folderName = hasFolderName ? NormalizeFolderName(request.DestinationFolderName!) : null;

        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string selectedSql = """
            SELECT id, name, status FROM archives
            WHERE id = @archive AND owner_user_id = @owner FOR UPDATE
            """;
        await using var selected = new NpgsqlCommand(selectedSql, connection, transaction);
        selected.Parameters.AddWithValue("archive", request.ArchiveId);
        selected.Parameters.AddWithValue("owner", ownerUserId);
        await using var selectedReader = await selected.ExecuteReaderAsync(cancellationToken);
        if (!await selectedReader.ReadAsync(cancellationToken)) throw new MailNotFoundException("Archive not found");
        var selectedStatus = selectedReader.GetString(2);
        await selectedReader.CloseAsync();
        if (selectedStatus is not ("ready" or "ready_with_errors"))
            throw new MailConflictException("Wait for the archive import to finish before creating sender rules");

        var archiveIds = new List<string>();
        if (archiveScope == "all")
        {
            const string allSql = """
                SELECT id FROM archives WHERE owner_user_id = @owner
                  AND status IN ('ready', 'ready_with_errors') ORDER BY lower(name), id FOR UPDATE
                """;
            await using var all = new NpgsqlCommand(allSql, connection, transaction);
            all.Parameters.AddWithValue("owner", ownerUserId);
            await using var reader = await all.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) archiveIds.Add(reader.GetString(0));
        }
        else archiveIds.Add(request.ArchiveId);
        if (archiveIds.Count == 0) throw new MailConflictException("No ready archives are available");

        if (sourceScope == "folder")
        {
            const string sourceSql = "SELECT 1 FROM folders WHERE id = @folder AND archive_id = @archive";
            await using var source = new NpgsqlCommand(sourceSql, connection, transaction);
            source.Parameters.AddWithValue("folder", request.SourceFolderId!);
            source.Parameters.AddWithValue("archive", request.ArchiveId);
            if (await source.ExecuteScalarAsync(cancellationToken) is null)
                throw new MailConflictException("Source mailbox must belong to the selected archive");
        }

        long createdRules = 0;
        long createdFolders = 0;
        long movedMessages = 0;
        foreach (var archiveId in archiveIds)
        {
            var target = hasFolderId
                ? await ExistingFolderAsync(connection, transaction, archiveId, request.DestinationFolderId!, cancellationToken)
                : await GetOrCreateRootFolderAsync(connection, transaction, archiveId, folderName!, cancellationToken);
            if (target is null) throw new MailConflictException("Destination mailbox must belong to the selected archive");
            if (target.Value.Created) createdFolders++;
            var sourceFolderId = sourceScope == "folder" ? request.SourceFolderId : null;
            var senderName = matchField == "from"
                ? await SenderNameAsync(connection, transaction, archiveId, matchAddress, cancellationToken)
                : null;
            var now = DateTimeOffset.UtcNow.ToString("O");
            const string ruleSql = """
                INSERT INTO sender_filing_rules (
                  id, archive_id, sender_address, sender_name, match_field, source_scope,
                  source_folder_id, rule_type, folder_id, created_at, updated_at
                ) VALUES (@id, @archive, @address, @name, @field, @scope, @source, 'folder', @folder, @now, @now)
                ON CONFLICT (archive_id, match_field, sender_address, source_scope, (COALESCE(source_folder_id, '')))
                DO UPDATE SET sender_name = COALESCE(EXCLUDED.sender_name, sender_filing_rules.sender_name),
                  folder_id = EXCLUDED.folder_id, rule_type = 'folder', updated_at = EXCLUDED.updated_at
                """;
            await using var rule = new NpgsqlCommand(ruleSql, connection, transaction);
            rule.Parameters.AddWithValue("id", Guid.NewGuid().ToString());
            rule.Parameters.AddWithValue("archive", archiveId);
            rule.Parameters.AddWithValue("address", matchAddress);
            rule.Parameters.AddWithValue("name", (object?)senderName ?? DBNull.Value);
            rule.Parameters.AddWithValue("field", matchField);
            rule.Parameters.AddWithValue("scope", sourceScope);
            rule.Parameters.AddWithValue("source", (object?)sourceFolderId ?? DBNull.Value);
            rule.Parameters.AddWithValue("folder", target.Value.Id);
            rule.Parameters.AddWithValue("now", now);
            await rule.ExecuteNonQueryAsync(cancellationToken);
            createdRules++;

            var moved = request.ApplyExisting
                ? await MoveMatchesAsync(connection, transaction, archiveId, matchField, matchAddress, sourceScope,
                    sourceFolderId, target.Value.Id, null, cancellationToken)
                : 0;
            movedMessages += moved;
            await RecountAsync(connection, transaction, archiveId, cancellationToken);
            await RecordRunAsync(connection, transaction, archiveId, moved, target.Value.Created ? 1 : 0, now, cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
        var statuses = new List<SenderFilingStatusDto>();
        foreach (var archiveId in archiveIds)
            statuses.Add((await GetStatusAsync(archiveId, ownerUserId, cancellationToken))!);
        return new(statuses, createdRules, createdFolders, movedMessages);
    }

    public async Task<SenderFilingStatusDto> UpdateFolderAsync(
        string ruleId,
        string targetFolderId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string ruleSql = """
            SELECT r.archive_id, r.sender_address, r.match_field, r.source_scope, r.source_folder_id, r.folder_id
            FROM sender_filing_rules r JOIN archives a ON a.id = r.archive_id
            WHERE r.id = @rule AND a.owner_user_id = @owner FOR UPDATE
            """;
        await using var rule = new NpgsqlCommand(ruleSql, connection, transaction);
        rule.Parameters.AddWithValue("rule", ruleId);
        rule.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await rule.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) throw new MailNotFoundException("Sender rule not found");
        var archiveId = reader.GetString(0);
        var address = reader.GetString(1);
        var field = reader.GetString(2);
        var scope = reader.GetString(3);
        var sourceFolder = reader.IsDBNull(4) ? null : reader.GetString(4);
        var oldFolder = reader.GetString(5);
        await reader.CloseAsync();
        var target = await ExistingFolderAsync(connection, transaction, archiveId, targetFolderId, cancellationToken)
            ?? throw new MailConflictException("Destination mailbox must belong to the sender rule archive");
        var type = string.Equals(target.Name, "spam", StringComparison.OrdinalIgnoreCase) ? "spam" : "folder";
        await using (var update = new NpgsqlCommand(
            "UPDATE sender_filing_rules SET folder_id=@folder, rule_type=@type, updated_at=@now WHERE id=@rule", connection, transaction))
        {
            update.Parameters.AddWithValue("folder", target.Id);
            update.Parameters.AddWithValue("type", type);
            update.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
            update.Parameters.AddWithValue("rule", ruleId);
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
        await MoveMatchesAsync(connection, transaction, archiveId, field, address, scope, sourceFolder, target.Id, oldFolder, cancellationToken);
        await RecountAsync(connection, transaction, archiveId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return (await GetStatusAsync(archiveId, ownerUserId, cancellationToken))!;
    }

    public async Task<SenderFilingStatusDto> OrganizeTopSendersAsync(
        string archiveId,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(archiveId)) throw new ArgumentException("Choose a valid archive");
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string archiveSql = "SELECT status FROM archives WHERE id=@archive AND owner_user_id=@owner FOR UPDATE";
        await using var archive = new NpgsqlCommand(archiveSql, connection, transaction);
        archive.Parameters.AddWithValue("archive", archiveId);
        archive.Parameters.AddWithValue("owner", ownerUserId);
        var status = Convert.ToString(await archive.ExecuteScalarAsync(cancellationToken));
        if (string.IsNullOrEmpty(status)) throw new MailNotFoundException("Archive not found");
        if (status is not ("ready" or "ready_with_errors"))
            throw new MailConflictException("Wait for the archive import to finish before organizing senders");

        await using var existingCount = new NpgsqlCommand(
            "SELECT COUNT(*) FROM sender_filing_rules WHERE archive_id=@archive AND rule_type='folder'", connection, transaction);
        existingCount.Parameters.AddWithValue("archive", archiveId);
        var available = Math.Max(0, 20 - Convert.ToInt32(await existingCount.ExecuteScalarAsync(cancellationToken)));
        var candidates = new List<(string Address, string? Name)>();
        if (available > 0)
        {
            const string candidateSql = """
                SELECT lower(trim(m.sender_address)), MAX(NULLIF(trim(m.sender_name), '')) AS sender_name
                FROM messages m JOIN folders f ON f.id=m.folder_id
                WHERE m.archive_id=@archive AND lower(trim(f.name))='inbox' AND trim(m.sender_address)<>''
                  AND NOT EXISTS (SELECT 1 FROM sender_filing_rules r
                    WHERE r.archive_id=m.archive_id AND r.match_field='from'
                      AND r.sender_address=lower(trim(m.sender_address)))
                GROUP BY lower(trim(m.sender_address))
                ORDER BY COUNT(*) DESC, lower(trim(m.sender_address)) LIMIT @limit
                """;
            await using var candidateCommand = new NpgsqlCommand(candidateSql, connection, transaction);
            candidateCommand.Parameters.AddWithValue("archive", archiveId);
            candidateCommand.Parameters.AddWithValue("limit", available);
            await using var reader = await candidateCommand.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
                candidates.Add((reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1)));
        }

        long createdFolders = 0;
        if (candidates.Count > 0)
        {
            var root = await GetOrCreateRootFolderAsync(connection, transaction, archiveId, "Top Senders", cancellationToken);
            if (root.Created) createdFolders++;
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            await using (var pathCommand = new NpgsqlCommand("SELECT path FROM folders WHERE archive_id=@archive", connection, transaction))
            {
                pathCommand.Parameters.AddWithValue("archive", archiveId);
                await using var reader = await pathCommand.ExecuteReaderAsync(cancellationToken);
                while (await reader.ReadAsync(cancellationToken)) paths.Add(reader.GetString(0));
            }
            var now = DateTimeOffset.UtcNow.ToString("O");
            foreach (var candidate in candidates)
            {
                var name = UniqueSenderFolderName(root.Path, candidate.Name ?? candidate.Address, candidate.Address, paths);
                var path = $"{root.Path}/{name}";
                var folderId = Guid.NewGuid().ToString();
                await using (var folder = new NpgsqlCommand(
                    "INSERT INTO folders(id,archive_id,parent_id,name,path,message_count,unread_count) VALUES(@id,@archive,@parent,@name,@path,0,0)", connection, transaction))
                {
                    folder.Parameters.AddWithValue("id", folderId);
                    folder.Parameters.AddWithValue("archive", archiveId);
                    folder.Parameters.AddWithValue("parent", root.Id);
                    folder.Parameters.AddWithValue("name", name);
                    folder.Parameters.AddWithValue("path", path);
                    await folder.ExecuteNonQueryAsync(cancellationToken);
                }
                await using (var rule = new NpgsqlCommand("""
                    INSERT INTO sender_filing_rules(id,archive_id,sender_address,sender_name,match_field,source_scope,
                      source_folder_id,rule_type,folder_id,created_at,updated_at)
                    VALUES(@id,@archive,@address,@name,'from','inbox',NULL,'folder',@folder,@now,@now)
                    """, connection, transaction))
                {
                    rule.Parameters.AddWithValue("id", Guid.NewGuid().ToString());
                    rule.Parameters.AddWithValue("archive", archiveId);
                    rule.Parameters.AddWithValue("address", candidate.Address);
                    rule.Parameters.AddWithValue("name", (object?)candidate.Name ?? DBNull.Value);
                    rule.Parameters.AddWithValue("folder", folderId);
                    rule.Parameters.AddWithValue("now", now);
                    await rule.ExecuteNonQueryAsync(cancellationToken);
                }
                paths.Add(path);
                createdFolders++;
            }
        }

        var filingRules = new List<(string Field, string Address, string Scope, string? Source, string Target)>();
        await using (var command = new NpgsqlCommand(
            "SELECT match_field,sender_address,source_scope,source_folder_id,folder_id FROM sender_filing_rules WHERE archive_id=@archive", connection, transaction))
        {
            command.Parameters.AddWithValue("archive", archiveId);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) filingRules.Add((
                reader.GetString(0), reader.GetString(1), reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetString(4)));
        }
        long moved = 0;
        foreach (var rule in filingRules)
            moved += await MoveMatchesAsync(connection, transaction, archiveId, rule.Field, rule.Address,
                rule.Scope, rule.Source, rule.Target, null, cancellationToken);
        await RecountAsync(connection, transaction, archiveId, cancellationToken);
        await RecordRunAsync(connection, transaction, archiveId, moved, createdFolders,
            DateTimeOffset.UtcNow.ToString("O"), cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return (await GetStatusAsync(archiveId, ownerUserId, cancellationToken))!;
    }

    public async Task<SenderFilingStatusDto> ClearAsync(string archiveId, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            DELETE FROM sender_filing_rules r USING archives a
            WHERE r.archive_id = @archive AND a.id = r.archive_id AND a.owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return await GetStatusAsync(archiveId, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Archive not found");
    }

    private static async Task<long> MoveMatchesAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string archiveId, string field, string address,
        string sourceScope, string? sourceFolderId, string targetFolderId, string? previousTargetFolderId,
        CancellationToken cancellationToken)
    {
        var match = field == "to"
            ? "EXISTS (SELECT 1 FROM jsonb_array_elements(m.to_json::jsonb) recipient WHERE lower(trim(COALESCE(recipient->>'address', ''))) = @address)"
            : "lower(trim(m.sender_address)) = @address";
        var source = sourceScope switch
        {
            "all" => "TRUE",
            "folder" when previousTargetFolderId is not null => "m.folder_id IN (@source, @previous)",
            "folder" => "m.folder_id = @source",
            _ when previousTargetFolderId is not null => "(m.folder_id = @previous OR EXISTS (SELECT 1 FROM folders sf WHERE sf.id=m.folder_id AND sf.archive_id=m.archive_id AND lower(trim(sf.name))='inbox'))",
            _ => "EXISTS (SELECT 1 FROM folders sf WHERE sf.id=m.folder_id AND sf.archive_id=m.archive_id AND lower(trim(sf.name))='inbox')"
        };
        var sql = $"UPDATE messages m SET folder_id=@target WHERE m.archive_id=@archive AND {match} AND {source} AND m.folder_id<>@target";
        await using var update = new NpgsqlCommand(sql, connection, transaction);
        update.Parameters.AddWithValue("target", targetFolderId);
        update.Parameters.AddWithValue("archive", archiveId);
        update.Parameters.AddWithValue("address", address);
        if (sourceFolderId is not null) update.Parameters.AddWithValue("source", sourceFolderId);
        if (previousTargetFolderId is not null) update.Parameters.AddWithValue("previous", previousTargetFolderId);
        return await update.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task<(string Id, string Name, string Path, bool Created)?> ExistingFolderAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string archiveId, string folderId,
        CancellationToken cancellationToken)
    {
        const string sql = "SELECT id, name, path FROM folders WHERE id=@folder AND archive_id=@archive";
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("folder", folderId);
        command.Parameters.AddWithValue("archive", archiveId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken)
            ? (reader.GetString(0), reader.GetString(1), reader.GetString(2), false)
            : null;
    }

    private static async Task<(string Id, string Name, string Path, bool Created)> GetOrCreateRootFolderAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, string archiveId, string name,
        CancellationToken cancellationToken)
    {
        const string selectSql = "SELECT id, name, path FROM folders WHERE archive_id=@archive AND parent_id IS NULL AND lower(path)=lower(@name) LIMIT 1";
        await using var select = new NpgsqlCommand(selectSql, connection, transaction);
        select.Parameters.AddWithValue("archive", archiveId);
        select.Parameters.AddWithValue("name", name);
        await using var reader = await select.ExecuteReaderAsync(cancellationToken);
        if (await reader.ReadAsync(cancellationToken))
        {
            var existing = (reader.GetString(0), reader.GetString(1), reader.GetString(2), false);
            await reader.CloseAsync();
            return existing;
        }
        await reader.CloseAsync();
        var id = Guid.NewGuid().ToString();
        const string insertSql = "INSERT INTO folders (id,archive_id,parent_id,name,path,message_count,unread_count) VALUES (@id,@archive,NULL,@name,@name,0,0)";
        await using var insert = new NpgsqlCommand(insertSql, connection, transaction);
        insert.Parameters.AddWithValue("id", id);
        insert.Parameters.AddWithValue("archive", archiveId);
        insert.Parameters.AddWithValue("name", name);
        await insert.ExecuteNonQueryAsync(cancellationToken);
        return (id, name, name, true);
    }

    private static async Task<string?> SenderNameAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string archiveId, string address, CancellationToken cancellationToken)
    {
        const string sql = "SELECT MAX(NULLIF(trim(sender_name), '')) FROM messages WHERE archive_id=@archive AND lower(trim(sender_address))=@address";
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("address", address);
        return Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)) is { Length: > 0 } value ? value : null;
    }

    private static async Task RecountAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string archiveId, CancellationToken cancellationToken)
    {
        const string sql = """
            UPDATE folders f SET message_count=(SELECT COUNT(*) FROM messages m WHERE m.folder_id=f.id),
              unread_count=(SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id=m.id WHERE m.folder_id=f.id AND s.is_read=0)
            WHERE f.archive_id=@archive;
            UPDATE archives a SET folder_count=(SELECT COUNT(*) FROM folders f WHERE f.archive_id=a.id),
              message_count=(SELECT COUNT(*) FROM messages m WHERE m.archive_id=a.id),
              unread_count=(SELECT COUNT(*) FROM messages m JOIN message_state s ON s.message_id=m.id WHERE m.archive_id=a.id AND s.is_read=0)
            WHERE a.id=@archive;
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("archive", archiveId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task RecordRunAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string archiveId, long moved, long created, string now, CancellationToken cancellationToken)
    {
        const string sql = """
            INSERT INTO sender_filing_runs (archive_id,moved_messages,created_folders,ran_at)
            VALUES (@archive,@moved,@created,@now)
            ON CONFLICT (archive_id) DO UPDATE SET moved_messages=EXCLUDED.moved_messages,
              created_folders=EXCLUDED.created_folders, ran_at=EXCLUDED.ran_at
            """;
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("moved", moved);
        command.Parameters.AddWithValue("created", created);
        command.Parameters.AddWithValue("now", now);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static string NormalizeAddress(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant() ?? "";
        try { _ = new MailAddress(normalized); }
        catch { throw new ArgumentException("Enter a valid email address"); }
        if (normalized.Length > 320) throw new ArgumentException("Email address is too long");
        return normalized;
    }

    private static string NormalizeFolderName(string value)
    {
        var normalized = value.Trim();
        if (normalized.Length is < 1 or > 120 || normalized.Contains('/') || normalized.Contains('\\') || normalized.Any(char.IsControl))
            throw new ArgumentException("Enter a valid folder name without slashes or control characters");
        return normalized;
    }

    private static string UniqueSenderFolderName(
        string rootPath,
        string displayValue,
        string address,
        ISet<string> usedPaths)
    {
        static string Safe(string value)
        {
            var cleaned = new string(value.Select(character =>
                character is '/' or '\\' || char.IsControl(character) ? '-' : character).ToArray());
            cleaned = string.Join(' ', cleaned.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim();
            return cleaned.Length == 0 ? "Unknown sender" : cleaned[..Math.Min(100, cleaned.Length)];
        }
        var basis = Safe(displayValue);
        var candidate = basis;
        if (!usedPaths.Contains($"{rootPath}/{candidate}")) return candidate;
        var suffix = Safe(address);
        candidate = $"{basis[..Math.Min(basis.Length, Math.Max(1, 96 - suffix.Length))]} — {suffix}";
        var number = 2;
        while (usedPaths.Contains($"{rootPath}/{candidate}"))
        {
            var numbered = $" ({number++})";
            candidate = $"{basis[..Math.Min(basis.Length, 100 - numbered.Length)]}{numbered}";
        }
        return candidate;
    }

    private static string OneOf(string? value, params string[] allowed)
    {
        var normalized = value?.Trim().ToLowerInvariant() ?? "";
        return allowed.Contains(normalized, StringComparer.Ordinal) ? normalized : throw new ArgumentException("Invalid rule option");
    }
}
