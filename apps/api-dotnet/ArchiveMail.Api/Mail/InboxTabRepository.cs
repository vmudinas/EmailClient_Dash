using System.Text.Json;
using Npgsql;

namespace ArchiveMail.Api.Mail;

public sealed record InboxTabDefinitionDto(
    string Id, string Label, string Description, bool Enabled, int Position, string Color,
    string[] Keywords, string[] SenderDomains, bool KeywordOnly);
public sealed record InboxTabSettingsDto(
    string ArchiveId, IReadOnlyList<InboxTabDefinitionDto> Tabs, bool AiEnabled,
    double AiConfidenceThreshold, string? UpdatedAt);
public sealed record InboxTabSettingsUpdateRequest(
    IReadOnlyList<InboxTabDefinitionDto> Tabs, bool AiEnabled, double AiConfidenceThreshold);
public sealed record InboxTabReclassifyResultDto(InboxTabSettingsDto Settings, long ScannedMessages, long ChangedMessages);

public sealed class InboxTabRepository(NpgsqlDataSource database)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly string[] CategoryIds = ["primary", "promotions", "social", "updates", "bills", "medical", "mail_tracking"];
    private static readonly InboxTabDefinitionDto[] Defaults =
    [
        new("primary", "Primary", "Personal and important conversations.", true, 0, "#1a73e8", [], [], false),
        new("promotions", "Promotions", "Deals, offers, newsletters, and marketing.", true, 1, "#188038", [], [], false),
        new("social", "Social", "Social network activity and community updates.", true, 2, "#9334e6", [], [], false),
        new("updates", "Updates", "Automated confirmations, alerts, and account updates.", true, 3, "#b06000", [], [], false),
        new("bills", "Bills", "Invoices, statements, balances, and payment notices.", true, 4, "#137333", [], [], false),
        new("medical", "Medical", "Health care, pharmacy, and appointment messages.", true, 5, "#c5221f", [], [], false),
        new("mail_tracking", "Mail/Tracking", "Shipping, delivery, and package tracking.", true, 6, "#1967d2", [], [], false)
    ];

    public async Task<InboxTabSettingsDto?> GetAsync(string archiveId, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT settings.tabs_json,settings.ai_enabled<>0,settings.ai_confidence_threshold,settings.updated_at
            FROM archives archive LEFT JOIN inbox_tab_settings settings ON settings.archive_id=archive.id
            WHERE archive.id=@archive AND archive.owner_user_id=@owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var stored = reader.IsDBNull(0) ? [] : ParseTabs(reader.GetString(0));
        return new(archiveId, Normalize(stored), !reader.IsDBNull(1) && reader.GetBoolean(1),
            reader.IsDBNull(2) ? 0.8 : reader.GetDouble(2), reader.IsDBNull(3) ? null : reader.GetString(3));
    }

    public async Task<InboxTabSettingsDto> UpdateAsync(string archiveId, InboxTabSettingsUpdateRequest request,
        string ownerUserId, CancellationToken cancellationToken)
    {
        var tabs = Validate(request);
        const string sql = """
            INSERT INTO inbox_tab_settings(archive_id,tabs_json,ai_enabled,ai_confidence_threshold,updated_at)
            SELECT a.id,@tabs,@ai,@confidence,@now FROM archives a WHERE a.id=@archive AND a.owner_user_id=@owner
            ON CONFLICT(archive_id) DO UPDATE SET tabs_json=EXCLUDED.tabs_json,ai_enabled=EXCLUDED.ai_enabled,
              ai_confidence_threshold=EXCLUDED.ai_confidence_threshold,updated_at=EXCLUDED.updated_at
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("tabs", JsonSerializer.Serialize(tabs, JsonOptions));
        command.Parameters.AddWithValue("ai", request.AiEnabled ? 1 : 0);
        command.Parameters.AddWithValue("confidence", request.AiConfidenceThreshold);
        command.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("archive", archiveId);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) throw new MailNotFoundException("Archive not found");
        return (await GetAsync(archiveId, ownerUserId, cancellationToken))!;
    }

    public async Task<InboxTabReclassifyResultDto> ReclassifyAsync(string archiveId, string ownerUserId, CancellationToken cancellationToken)
    {
        var settings = await GetAsync(archiveId, ownerUserId, cancellationToken)
            ?? throw new MailNotFoundException("Archive not found");
        string lastId = "";
        long scanned = 0;
        long changed = 0;
        while (true)
        {
            const string sql = """
                SELECT m.id,m.inbox_category,m.sender_address,m.subject,substring(m.body_text FROM 1 FOR 2000),m.headers_json
                FROM messages m JOIN folders f ON f.id=m.folder_id
                WHERE m.archive_id=@archive AND lower(trim(f.name))='inbox' AND m.id>@last
                ORDER BY m.id LIMIT 500
                """;
            await using var connection = await database.OpenConnectionAsync(cancellationToken);
            await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
            await using var select = new NpgsqlCommand(sql, connection, transaction);
            select.Parameters.AddWithValue("archive", archiveId);
            select.Parameters.AddWithValue("last", lastId);
            var rows = new List<(string Id, string Existing, string Sender, string Subject, string Body, Dictionary<string, string> Headers)>();
            await using (var reader = await select.ExecuteReaderAsync(cancellationToken))
            {
                while (await reader.ReadAsync(cancellationToken)) rows.Add((
                    reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4),
                    ParseHeaders(reader.GetString(5))));
            }
            if (rows.Count == 0) { await transaction.RollbackAsync(cancellationToken); break; }
            foreach (var row in rows)
            {
                var category = MessageCategorizer.ClassifyWithTabs(row.Sender, row.Subject, row.Body, row.Headers, settings.Tabs);
                if (category == row.Existing) continue;
                await using var update = new NpgsqlCommand("UPDATE messages SET inbox_category=@category WHERE id=@id", connection, transaction);
                update.Parameters.AddWithValue("category", category);
                update.Parameters.AddWithValue("id", row.Id);
                changed += await update.ExecuteNonQueryAsync(cancellationToken);
            }
            scanned += rows.Count;
            lastId = rows[^1].Id;
            await transaction.CommitAsync(cancellationToken);
        }
        return new(settings, scanned, changed);
    }

    private static IReadOnlyList<InboxTabDefinitionDto> Validate(InboxTabSettingsUpdateRequest request)
    {
        if (request.Tabs is null) throw new ArgumentException("Configure every built-in Inbox tab exactly once");
        if (request.AiConfidenceThreshold is < 0 or > 1) throw new ArgumentException("AI confidence must be between 0 and 1");
        if (request.Tabs.Count != CategoryIds.Length || request.Tabs.Any(tab => tab is null)
            || request.Tabs.Select(tab => tab.Id).Distinct().Count() != CategoryIds.Length
            || CategoryIds.Any(id => request.Tabs.All(tab => tab.Id != id)))
            throw new ArgumentException("Configure every built-in Inbox tab exactly once");
        if (request.Tabs.Select(tab => tab.Position).Distinct().Count() != CategoryIds.Length)
            throw new ArgumentException("Each Inbox tab needs a unique position");
        if (request.Tabs.First(tab => tab.Id == "primary").Enabled is false)
            throw new ArgumentException("Primary must remain enabled");
        foreach (var tab in request.Tabs)
        {
            if (string.IsNullOrWhiteSpace(tab.Id) || string.IsNullOrWhiteSpace(tab.Label) || tab.Description is null
                || tab.Label.Trim().Length is < 1 or > 40 || tab.Description.Trim().Length > 240
                || string.IsNullOrWhiteSpace(tab.Color)
                || !System.Text.RegularExpressions.Regex.IsMatch(tab.Color, "^#[0-9a-fA-F]{6}$")
                || tab.Keywords is null || tab.SenderDomains is null
                || tab.Keywords.Any(value => value is null) || tab.SenderDomains.Any(value => value is null)
                || tab.Keywords.Length > 40 || tab.SenderDomains.Length > 40)
                throw new ArgumentException("Invalid Inbox tab settings");
        }
        return request.Tabs.OrderBy(tab => tab.Position).Select(tab => tab with
        {
            Label = tab.Label.Trim(),
            Description = tab.Description.Trim(),
            Keywords = tab.Keywords.Select(value => value.Trim().ToLowerInvariant()).Where(value => value.Length > 0).Distinct().ToArray(),
            SenderDomains = tab.SenderDomains.Select(value => value.Trim().ToLowerInvariant()).Where(value => value.Length > 0).Distinct().ToArray()
        }).ToArray();
    }

    private static IReadOnlyList<InboxTabDefinitionDto> Normalize(IReadOnlyList<InboxTabDefinitionDto> stored)
    {
        var byId = stored.ToDictionary(tab => tab.Id, StringComparer.Ordinal);
        return Defaults.Select(value => byId.TryGetValue(value.Id, out var existing)
            ? existing with { Enabled = value.Id == "primary" || existing.Enabled }
            : value).OrderBy(value => value.Position).ToArray();
    }
    private static IReadOnlyList<InboxTabDefinitionDto> ParseTabs(string json)
    {
        try { return JsonSerializer.Deserialize<List<InboxTabDefinitionDto>>(json, JsonOptions) ?? []; }
        catch (JsonException) { return []; }
    }
    private static Dictionary<string, string> ParseHeaders(string json)
    {
        try { return JsonSerializer.Deserialize<Dictionary<string, string>>(json, JsonOptions) ?? []; }
        catch (JsonException) { return []; }
    }
}
