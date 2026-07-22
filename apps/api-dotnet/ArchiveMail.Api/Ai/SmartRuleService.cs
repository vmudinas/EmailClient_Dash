using System.Text.Json;
using ArchiveMail.Api.Mail;
using Npgsql;

namespace ArchiveMail.Api.Ai;

public sealed class SmartRuleService(NpgsqlDataSource database, ILogger<SmartRuleService> logger)
    : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<IReadOnlyList<object>> ListAsync(
        string? archiveId,
        string owner,
        CancellationToken token
    )
    {
        const string sql =
            "SELECT r.id,r.archive_id,a.name,r.name,r.instruction,r.match_mode,r.sender_contains_json,r.subject_contains_json,r.body_contains_json,r.has_attachments,r.target_folder_id,f.path,r.mark_read<>0,r.star<>0,r.enabled<>0,r.matched_messages,r.created_at,r.updated_at FROM smart_mail_rules r JOIN archives a ON a.id=r.archive_id LEFT JOIN folders f ON f.id=r.target_folder_id WHERE a.owner_user_id=$1 AND ($2::text IS NULL OR r.archive_id=$2::text) ORDER BY r.created_at DESC";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(archiveId ?? (object)DBNull.Value);
        await using var reader = await command.ExecuteReaderAsync(token);
        var list = new List<object>();
        while (await reader.ReadAsync(token))
            list.Add(Rule(reader));
        return list;
    }

    public async Task<object> CreateAsync(JsonElement input, string owner, CancellationToken token)
    {
        var archive = Required(input, "archiveId");
        await EnsureArchive(archive, owner, token);
        var conditions = input.GetProperty("conditions");
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql =
            "INSERT INTO smart_mail_rules(id,archive_id,name,instruction,match_mode,sender_contains_json,subject_contains_json,body_contains_json,has_attachments,target_folder_id,mark_read,star,enabled,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(archive);
        command.Parameters.AddWithValue(Required(input, "name"));
        command.Parameters.AddWithValue(Required(input, "instruction"));
        command.Parameters.AddWithValue(String(conditions, "match") ?? "all");
        command.Parameters.AddWithValue(RawArray(conditions, "senderContains"));
        command.Parameters.AddWithValue(RawArray(conditions, "subjectContains"));
        command.Parameters.AddWithValue(RawArray(conditions, "bodyContains"));
        command.Parameters.AddWithValue(
            NullableBool(conditions, "hasAttachments") is { } has
                ? has
                    ? 1
                    : 0
                : DBNull.Value
        );
        command.Parameters.AddWithValue(String(input, "targetFolderId") ?? (object)DBNull.Value);
        command.Parameters.AddWithValue(Boolean(input, "markRead") ? 1 : 0);
        command.Parameters.AddWithValue(Boolean(input, "star") ? 1 : 0);
        command.Parameters.AddWithValue(
            !input.TryGetProperty("enabled", out var enabled) || enabled.GetBoolean() ? 1 : 0
        );
        command.Parameters.AddWithValue(now);
        await command.ExecuteNonQueryAsync(token);
        var created = (await ListAsync(archive, owner, token)).Single(rule =>
            Property(rule, "id") == id
        );
        if (
            input.TryGetProperty("applyExisting", out var apply)
            && apply.ValueKind == JsonValueKind.True
        )
            await EnqueueAsync(archive, [id], "all", owner, token);
        return created;
    }

    public async Task<object?> UpdateAsync(
        string id,
        JsonElement input,
        string owner,
        CancellationToken token
    )
    {
        var current = (await ListAsync(null, owner, token)).FirstOrDefault(rule =>
            Property(rule, "id") == id
        );
        if (current is null)
            return null;
        var archive = Property(current, "archiveId")!;
        var updates = new List<string>();
        var parameters = new List<object?>();
        void Add(string column, object? value)
        {
            updates.Add($"{column}=${parameters.Count + 2}");
            parameters.Add(value);
        }
        if (String(input, "name") is { } name)
            Add("name", name);
        if (String(input, "instruction") is { } instruction)
            Add("instruction", instruction);
        if (input.TryGetProperty("conditions", out var conditions))
        {
            Add("match_mode", String(conditions, "match") ?? "all");
            Add("sender_contains_json", RawArray(conditions, "senderContains"));
            Add("subject_contains_json", RawArray(conditions, "subjectContains"));
            Add("body_contains_json", RawArray(conditions, "bodyContains"));
            Add(
                "has_attachments",
                NullableBool(conditions, "hasAttachments") is { } h
                    ? h
                        ? 1
                        : 0
                    : null
            );
        }
        if (input.TryGetProperty("targetFolderId", out var target))
            Add(
                "target_folder_id",
                target.ValueKind == JsonValueKind.Null ? null : target.GetString()
            );
        if (input.TryGetProperty("markRead", out var read))
            Add("mark_read", read.GetBoolean() ? 1 : 0);
        if (input.TryGetProperty("star", out var star))
            Add("star", star.GetBoolean() ? 1 : 0);
        if (input.TryGetProperty("enabled", out var enabled))
            Add("enabled", enabled.GetBoolean() ? 1 : 0);
        if (updates.Count == 0)
            throw new ArgumentException("At least one rule field is required");
        var sql =
            "UPDATE smart_mail_rules SET "
            + string.Join(',', updates)
            + ",updated_at=$1 WHERE id=$"
            + (parameters.Count + 2);
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        foreach (var value in parameters)
            command.Parameters.AddWithValue(value ?? DBNull.Value);
        command.Parameters.AddWithValue(id);
        await command.ExecuteNonQueryAsync(token);
        if (
            input.TryGetProperty("applyExisting", out var apply)
            && apply.ValueKind == JsonValueKind.True
        )
            await EnqueueAsync(archive, [id], "all", owner, token);
        return (await ListAsync(archive, owner, token)).Single(rule => Property(rule, "id") == id);
    }

    public async Task DeleteAsync(string id, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "DELETE FROM smart_mail_rules r USING archives a WHERE r.id=$1 AND a.id=r.archive_id AND a.owner_user_id=$2"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        if (await command.ExecuteNonQueryAsync(token) == 0)
            throw new MailNotFoundException("Mail rule not found");
    }

    public object Suggest(JsonElement input) =>
        new
        {
            name = "Suggested mail rule",
            instruction = Required(input, "instruction"),
            conditions = new
            {
                match = "all",
                senderContains = System.Array.Empty<string>(),
                subjectContains = new[] { Required(input, "instruction") },
                bodyContains = System.Array.Empty<string>(),
                hasAttachments = (bool?)null,
            },
            targetFolderId = (string?)null,
            targetFolderPath = (string?)null,
            markRead = false,
            star = true,
            explanation = "A conservative rule based on the requested subject text. Review it before applying.",
            confidence = .55,
        };

    public async Task<object> EnqueueAsync(
        string archive,
        string[] rules,
        string scope,
        string owner,
        CancellationToken token
    )
    {
        await EnsureArchive(archive, owner, token);
        if (scope is not ("inbox" or "all"))
            throw new ArgumentException("Choose a valid rule scope");
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using var command = database.CreateCommand(
            "INSERT INTO mailbox_tasks(id,status,archive_id,scope,rule_ids_json,total_rules,created_at) VALUES($1,'queued',$2,$3,$4,$5,$6)"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(archive);
        command.Parameters.AddWithValue(scope);
        command.Parameters.AddWithValue(JsonSerializer.Serialize(rules));
        command.Parameters.AddWithValue(rules.Length);
        command.Parameters.AddWithValue(now);
        await command.ExecuteNonQueryAsync(token);
        return (await TaskAsync(id, owner, token))!;
    }

    public async Task<object?> TaskAsync(string id, string owner, CancellationToken token)
    {
        const string sql =
            "SELECT t.* FROM mailbox_tasks t JOIN archives a ON a.id=t.archive_id WHERE t.id=$1 AND a.owner_user_id=$2";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) ? TaskDto(reader) : null;
    }

    public async Task<object?> CancelAsync(string id, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE mailbox_tasks t SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status='queued' THEN $3 ELSE completed_at END FROM archives a WHERE t.id=$1 AND a.id=t.archive_id AND a.owner_user_id=$2"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
        return await TaskAsync(id, owner, token);
    }

    protected override async Task ExecuteAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var id = await Claim(token);
                if (id is null)
                    await Task.Delay(800, token);
                else
                    await Run(id, token);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch (Exception error)
            {
                logger.LogError(error, "Smart mailbox worker failed");
                await Task.Delay(1500, token);
            }
        }
    }

    private async Task Run(string id, CancellationToken token)
    {
        try
        {
            await using var command = database.CreateCommand(
                "SELECT archive_id,scope,rule_ids_json FROM mailbox_tasks WHERE id=$1"
            );
            command.Parameters.AddWithValue(id);
            await using var reader = await command.ExecuteReaderAsync(token);
            await reader.ReadAsync(token);
            var archive = reader.GetString(0);
            var scope = reader.GetString(1);
            var rules = JsonSerializer.Deserialize<string[]>(reader.GetString(2)) ?? [];
            await reader.CloseAsync();
            long matched = 0,
                moved = 0,
                marked = 0,
                starred = 0,
                processed = 0;
            foreach (var ruleId in rules)
            {
                if (await Cancelled(id, token))
                    break;
                var rule = await RuleRecord(ruleId, token);
                if (rule is null)
                    continue;
                await SetCurrent(id, ruleId, rule.Name, token);
                var conditions = new List<string> { "m.archive_id=$1" };
                var parameters = new List<object> { archive };
                var tests = new List<string>();
                void Contains(string column, string[] values)
                {
                    foreach (var value in values)
                    {
                        parameters.Add("%" + EscapeLike(value.ToLowerInvariant()) + "%");
                        tests.Add($"lower({column}) LIKE ${parameters.Count} ESCAPE '\\'");
                    }
                }
                Contains("m.sender_address", rule.Senders);
                Contains("m.subject", rule.Subjects);
                Contains("m.body_text", rule.Bodies);
                if (rule.HasAttachments is { } has)
                    tests.Add(has ? "m.has_attachments<>0" : "m.has_attachments=0");
                if (tests.Count > 0)
                    conditions.Add(
                        "(" + string.Join(rule.Match == "any" ? " OR " : " AND ", tests) + ")"
                    );
                if (scope == "inbox")
                    conditions.Add("lower(f.path) LIKE '%inbox%'");
                var select =
                    "SELECT m.id FROM messages m JOIN folders f ON f.id=m.folder_id WHERE "
                    + string.Join(" AND ", conditions);
                await using var find = database.CreateCommand(select);
                for (var index = 0; index < parameters.Count; index++)
                    find.Parameters.AddWithValue(parameters[index]);
                await using var found = await find.ExecuteReaderAsync(token);
                var ids = new List<string>();
                while (await found.ReadAsync(token))
                    ids.Add(found.GetString(0));
                processed += ids.Count;
                matched += ids.Count;
                if (ids.Count > 0)
                {
                    if (rule.Target is not null)
                    {
                        await using var update = database.CreateCommand(
                            "UPDATE messages SET folder_id=$1 WHERE id=ANY($2)"
                        );
                        update.Parameters.AddWithValue(rule.Target);
                        update.Parameters.AddWithValue(ids.ToArray());
                        moved += await update.ExecuteNonQueryAsync(token);
                    }
                    if (rule.MarkRead || rule.Star)
                    {
                        await using var state = database.CreateCommand(
                            "INSERT INTO message_state(message_id,is_read,is_starred,tags_json,note,updated_at) SELECT id,$2,$3,'[]','',$4 FROM messages WHERE id=ANY($1) ON CONFLICT(message_id) DO UPDATE SET is_read=CASE WHEN $2=1 THEN 1 ELSE message_state.is_read END,is_starred=CASE WHEN $3=1 THEN 1 ELSE message_state.is_starred END,updated_at=$4"
                        );
                        state.Parameters.AddWithValue(ids.ToArray());
                        state.Parameters.AddWithValue(rule.MarkRead ? 1 : 0);
                        state.Parameters.AddWithValue(rule.Star ? 1 : 0);
                        state.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
                        await state.ExecuteNonQueryAsync(token);
                        if (rule.MarkRead)
                            marked += ids.Count;
                        if (rule.Star)
                            starred += ids.Count;
                    }
                }
                await using (var bumpRule = database.CreateCommand(
                    "UPDATE smart_mail_rules SET matched_messages=matched_messages+$2,updated_at=$3 WHERE id=$1"))
                {
                    bumpRule.Parameters.AddWithValue(ruleId);
                    bumpRule.Parameters.AddWithValue(ids.Count);
                    bumpRule.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
                    await bumpRule.ExecuteNonQueryAsync(token);
                }
                await using (var bumpTask = database.CreateCommand(
                    "UPDATE mailbox_tasks SET completed_rules=completed_rules+1,processed_messages=$1,matched_messages=$2,moved_messages=$3,marked_read_messages=$4,starred_messages=$5 WHERE id=$6"))
                {
                    bumpTask.Parameters.AddWithValue(processed);
                    bumpTask.Parameters.AddWithValue(matched);
                    bumpTask.Parameters.AddWithValue(moved);
                    bumpTask.Parameters.AddWithValue(marked);
                    bumpTask.Parameters.AddWithValue(starred);
                    bumpTask.Parameters.AddWithValue(id);
                    await bumpTask.ExecuteNonQueryAsync(token);
                }
            }
            await Finish(id, await Cancelled(id, token) ? "cancelled" : "completed", null, token);
        }
        catch (Exception error)
        {
            await Finish(id, "failed", error.Message, token);
        }
    }

    private async Task<string?> Claim(CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE mailbox_tasks SET status='running',started_at=$1 WHERE id=(SELECT id FROM mailbox_tasks WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id"
        );
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        return Convert.ToString(await command.ExecuteScalarAsync(token));
    }

    private async Task Finish(string id, string status, string? error, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE mailbox_tasks SET status=$2,error=$3,current_rule_id=NULL,current_rule_name=NULL,completed_at=$4 WHERE id=$1"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(status);
        command.Parameters.AddWithValue(error ?? (object)DBNull.Value);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
    }

    private async Task<bool> Cancelled(string id, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT cancel_requested<>0 FROM mailbox_tasks WHERE id=$1"
        );
        command.Parameters.AddWithValue(id);
        return Convert.ToBoolean(await command.ExecuteScalarAsync(token));
    }

    private async Task SetCurrent(string id, string rule, string name, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE mailbox_tasks SET current_rule_id=$2,current_rule_name=$3 WHERE id=$1"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(rule);
        command.Parameters.AddWithValue(name);
        await command.ExecuteNonQueryAsync(token);
    }

    private async Task<RuleData?> RuleRecord(string id, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT name,match_mode,sender_contains_json,subject_contains_json,body_contains_json,has_attachments,target_folder_id,mark_read<>0,star<>0 FROM smart_mail_rules WHERE id=$1 AND enabled<>0"
        );
        command.Parameters.AddWithValue(id);
        await using var r = await command.ExecuteReaderAsync(token);
        return await r.ReadAsync(token)
            ? new(
                r.GetString(0),
                r.GetString(1),
                Parse(r.GetString(2)),
                Parse(r.GetString(3)),
                Parse(r.GetString(4)),
                r.IsDBNull(5) ? null : r.GetInt64(5) != 0,
                r.IsDBNull(6) ? null : r.GetString(6),
                r.GetBoolean(7),
                r.GetBoolean(8)
            )
            : null;
    }

    private async Task EnsureArchive(string id, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT EXISTS(SELECT 1 FROM archives WHERE id=$1 AND owner_user_id=$2)"
        );
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        if (!Convert.ToBoolean(await command.ExecuteScalarAsync(token)))
            throw new MailNotFoundException("Archive not found");
    }

    private static object Rule(NpgsqlDataReader r) =>
        new
        {
            id = r.GetString(0),
            archiveId = r.GetString(1),
            archiveName = r.GetString(2),
            name = r.GetString(3),
            instruction = r.GetString(4),
            conditions = new
            {
                match = r.GetString(5),
                senderContains = Parse(r.GetString(6)),
                subjectContains = Parse(r.GetString(7)),
                bodyContains = Parse(r.GetString(8)),
                hasAttachments = r.IsDBNull(9) ? (bool?)null : r.GetInt64(9) != 0,
            },
            targetFolderId = r.IsDBNull(10) ? null : r.GetString(10),
            targetFolderPath = r.IsDBNull(11) ? null : r.GetString(11),
            markRead = r.GetBoolean(12),
            star = r.GetBoolean(13),
            enabled = r.GetBoolean(14),
            matchedMessages = r.GetInt64(15),
            createdAt = r.GetString(16),
            updatedAt = r.GetString(17),
        };

    private static object TaskDto(NpgsqlDataReader r) =>
        new
        {
            id = r["id"],
            type = r["type"],
            status = r["status"],
            archiveId = r["archive_id"],
            scope = r["scope"],
            ruleIds = Parse((string)r["rule_ids_json"]),
            totalRules = r["total_rules"],
            completedRules = r["completed_rules"],
            currentRuleId = r["current_rule_id"] is DBNull ? null : r["current_rule_id"],
            currentRuleName = r["current_rule_name"] is DBNull ? null : r["current_rule_name"],
            totalMessages = r["total_messages"],
            processedMessages = r["processed_messages"],
            matchedMessages = r["matched_messages"],
            movedMessages = r["moved_messages"],
            markedReadMessages = r["marked_read_messages"],
            starredMessages = r["starred_messages"],
            cancelRequested = (long)r["cancel_requested"] != 0,
            error = r["error"] is DBNull ? null : r["error"],
            createdAt = r["created_at"],
            startedAt = r["started_at"] is DBNull ? null : r["started_at"],
            completedAt = r["completed_at"] is DBNull ? null : r["completed_at"],
        };

    private sealed record RuleData(
        string Name,
        string Match,
        string[] Senders,
        string[] Subjects,
        string[] Bodies,
        bool? HasAttachments,
        string? Target,
        bool MarkRead,
        bool Star
    );

    private static string[] Parse(string value)
    {
        try
        {
            return JsonSerializer.Deserialize<string[]>(value, JsonOptions) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static string? Property(object value, string name) =>
        value.GetType().GetProperty(name)?.GetValue(value)?.ToString();

    private static string Required(JsonElement input, string name) =>
        String(input, name) ?? throw new ArgumentException($"{name} is required");

    private static string? String(JsonElement input, string name) =>
        input.ValueKind == JsonValueKind.Object
        && input.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.Trim()
            : null;

    private static bool Boolean(JsonElement input, string name) =>
        input.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;

    private static bool? NullableBool(JsonElement input, string name) =>
        input.TryGetProperty(name, out var value)
            ? value.ValueKind == JsonValueKind.Null
                ? null
                : value.GetBoolean()
            : null;

    private static string RawArray(JsonElement input, string name) =>
        input.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array
            ? value.GetRawText()
            : "[]";

    private static string EscapeLike(string value) =>
        value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
}
