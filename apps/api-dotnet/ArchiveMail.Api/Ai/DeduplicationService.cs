using System.Text.Json;
using ArchiveMail.Api.Mail;
using Npgsql;

namespace ArchiveMail.Api.Ai;

/// <summary>
/// Deterministic duplicate detection (plan tiers 0-3). Runs entirely locally: no AI provider and no
/// API cost. A background loop backfills message fingerprints; a scan groups messages with union-find
/// and records reviewable duplicate groups. Nothing is ever deleted.
/// </summary>
public sealed class DeduplicationService(
    NpgsqlDataSource database,
    MailRepository mail,
    ILogger<DeduplicationService> logger) : BackgroundService
{
    /// <summary>
    /// Maximum differing SimHash bits for two messages to count as near-duplicates. Email bodies are
    /// short, so a single edited word already moves ~4 bits; 6 keeps quote-trimmed and lightly edited
    /// copies together while remaining astronomically selective across 64 bits. False positives are
    /// further constrained by the sender/subject and digit-signature guards, and every group still
    /// requires owner confirmation before anything is collapsed.
    /// </summary>
    internal const int NearDuplicateHammingThreshold = 6;
    private const int FingerprintBatchSize = 200;
    private const int NearDuplicateScanLimit = 50_000;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // ---------- read/review API ----------

    public async Task<object> ListGroupsAsync(string? status, string owner, CancellationToken token)
    {
        var filter = status is "pending" or "confirmed" or "dismissed" ? status : null;
        var sql = "SELECT id,group_key,preferred_message_id,detection_tier,confidence,member_count,review_status,reviewed_at,created_at,updated_at "
            + "FROM ai_duplicate_groups WHERE owner_user_id=$1"
            + (filter is null ? "" : " AND review_status=$2")
            + " ORDER BY member_count DESC, updated_at DESC LIMIT 200";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(owner);
        if (filter is not null) command.Parameters.AddWithValue(filter);
        var groups = new List<object>();
        await using (var reader = await command.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token)) groups.Add(GroupRow(reader));
        var pending = await CountAsync("pending", owner, token);
        return new { groups, totalPending = pending };
    }

    public async Task<object?> GetGroupAsync(string id, string owner, CancellationToken token)
    {
        const string sql = "SELECT id,group_key,preferred_message_id,detection_tier,confidence,member_count,review_status,reviewed_at,created_at,updated_at "
            + "FROM ai_duplicate_groups WHERE id=$1 AND owner_user_id=$2";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        object? group;
        await using (var reader = await command.ExecuteReaderAsync(token))
            group = await reader.ReadAsync(token) ? GroupRow(reader) : null;
        if (group is null) return null;

        var members = new List<object>();
        await using var memberCommand = database.CreateCommand(
            "SELECT message_id,relation,evidence_json FROM ai_duplicate_members WHERE group_id=$1 ORDER BY created_at");
        memberCommand.Parameters.AddWithValue(id);
        var rows = new List<(string MessageId, string Relation, string Evidence)>();
        await using (var reader = await memberCommand.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token))
                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        foreach (var row in rows)
        {
            var message = await mail.GetMessageAsync(row.MessageId, owner, token);
            if (message is not null)
                members.Add(new { message, relation = row.Relation, evidence = ParseArray(row.Evidence) });
        }
        return new { group, members };
    }

    /// <summary>Confirm a group, dismiss it (remembering the pair so it never regroups), or repoint the preferred copy.</summary>
    public async Task<object?> UpdateGroupAsync(string id, JsonElement input, string owner, CancellationToken token)
    {
        if (await GetGroupAsync(id, owner, token) is null) return null;
        var now = DateTimeOffset.UtcNow.ToString("O");
        var status = String(input, "reviewStatus");
        var preferred = String(input, "preferredMessageId");
        if (status is not (null or "pending" or "confirmed" or "dismissed"))
            throw new ArgumentException("reviewStatus must be pending, confirmed, or dismissed");

        if (preferred is not null)
        {
            await using var owns = database.CreateCommand(
                "SELECT EXISTS(SELECT 1 FROM ai_duplicate_members WHERE group_id=$1 AND message_id=$2)");
            owns.Parameters.AddWithValue(id);
            owns.Parameters.AddWithValue(preferred);
            if (!Convert.ToBoolean(await owns.ExecuteScalarAsync(token)))
                throw new ArgumentException("preferredMessageId must be a member of the group");
            await using var update = database.CreateCommand(
                "UPDATE ai_duplicate_groups SET preferred_message_id=$2,updated_at=$3 WHERE id=$1");
            update.Parameters.AddWithValue(id);
            update.Parameters.AddWithValue(preferred);
            update.Parameters.AddWithValue(now);
            await update.ExecuteNonQueryAsync(token);
        }

        if (status == "dismissed")
        {
            await RememberNotDuplicateAsync(id, owner, now, token);
            await using var drop = database.CreateCommand("DELETE FROM ai_duplicate_groups WHERE id=$1 AND owner_user_id=$2");
            drop.Parameters.AddWithValue(id);
            drop.Parameters.AddWithValue(owner);
            await drop.ExecuteNonQueryAsync(token);
            return new { id, reviewStatus = "dismissed", reviewedAt = now, removed = true };
        }

        if (status is not null)
        {
            await using var update = database.CreateCommand(
                "UPDATE ai_duplicate_groups SET review_status=$2,reviewed_at=$3,updated_at=$3 WHERE id=$1 AND owner_user_id=$4");
            update.Parameters.AddWithValue(id);
            update.Parameters.AddWithValue(status);
            update.Parameters.AddWithValue(now);
            update.Parameters.AddWithValue(owner);
            await update.ExecuteNonQueryAsync(token);
        }
        return await GetGroupAsync(id, owner, token);
    }

    /// <summary>Records every pairwise combination of a dismissed group so a later scan cannot recreate it.</summary>
    private async Task RememberNotDuplicateAsync(string groupId, string owner, string now, CancellationToken token)
    {
        var members = new List<string>();
        await using (var command = database.CreateCommand("SELECT message_id FROM ai_duplicate_members WHERE group_id=$1"))
        {
            command.Parameters.AddWithValue(groupId);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token)) members.Add(reader.GetString(0));
        }
        members.Sort(StringComparer.Ordinal);
        for (var left = 0; left < members.Count; left++)
            for (var right = left + 1; right < members.Count; right++)
            {
                await using var insert = database.CreateCommand(
                    "INSERT INTO ai_not_duplicate_pairs(owner_user_id,left_message_id,right_message_id,created_at) "
                    + "VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING");
                insert.Parameters.AddWithValue(owner);
                insert.Parameters.AddWithValue(members[left]);
                insert.Parameters.AddWithValue(members[right]);
                insert.Parameters.AddWithValue(now);
                await insert.ExecuteNonQueryAsync(token);
            }
    }

    // ---------- scan ----------

    /// <summary>
    /// Rebuilds pending duplicate groups for one owner. Confirmed groups and dismissed pairs are
    /// preserved: their members are excluded so an owner decision is never undone by a rescan.
    /// </summary>
    public async Task<object> ScanAsync(string owner, CancellationToken token)
    {
        var fingerprinted = await FingerprintOwnerAsync(owner, token);
        await using (var clear = database.CreateCommand(
            "DELETE FROM ai_duplicate_groups WHERE owner_user_id=$1 AND review_status='pending'"))
        {
            clear.Parameters.AddWithValue(owner);
            await clear.ExecuteNonQueryAsync(token);
        }

        var excluded = await LoadDecidedMessagesAsync(owner, token);
        var notDuplicate = await LoadNotDuplicatePairsAsync(owner, token);
        var pairs = new List<(string Left, string Right, string Tier, string Evidence)>();
        pairs.AddRange(await ExactPairsAsync(owner, token));
        pairs.AddRange(await NearDuplicatePairsAsync(owner, token));

        var union = new UnionFind();
        var tiers = new Dictionary<string, string>(StringComparer.Ordinal);
        var evidence = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var (left, right, tier, reason) in pairs)
        {
            if (excluded.Contains(left) || excluded.Contains(right)) continue;
            if (notDuplicate.Contains(PairKey(left, right))) continue;
            union.Union(left, right);
            foreach (var id in new[] { left, right })
            {
                if (!tiers.TryGetValue(id, out var existing) || TierRank(tier) < TierRank(existing)) tiers[id] = tier;
                if (!evidence.TryGetValue(id, out var list)) evidence[id] = list = [];
                if (!list.Contains(reason, StringComparer.Ordinal)) list.Add(reason);
            }
        }

        var clusters = union.Clusters().Where(cluster => cluster.Count > 1).ToList();
        var now = DateTimeOffset.UtcNow.ToString("O");
        var created = 0;
        foreach (var cluster in clusters)
        {
            cluster.Sort(StringComparer.Ordinal);
            var key = "u:" + cluster[0];
            var tier = cluster.Select(id => tiers.GetValueOrDefault(id, "near_duplicate"))
                .OrderBy(TierRank).First();
            var preferred = await PreferredCopyAsync(cluster, token);
            var groupId = Guid.NewGuid().ToString();
            await using (var insert = database.CreateCommand(
                "INSERT INTO ai_duplicate_groups(id,owner_user_id,group_key,preferred_message_id,detection_tier,confidence,member_count,review_status,created_at,updated_at) "
                + "VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$8) "
                + "ON CONFLICT(owner_user_id,group_key) DO UPDATE SET preferred_message_id=EXCLUDED.preferred_message_id,"
                + "detection_tier=EXCLUDED.detection_tier,confidence=EXCLUDED.confidence,member_count=EXCLUDED.member_count,updated_at=EXCLUDED.updated_at "
                + "RETURNING id"))
            {
                insert.Parameters.AddWithValue(groupId);
                insert.Parameters.AddWithValue(owner);
                insert.Parameters.AddWithValue(key);
                insert.Parameters.AddWithValue((object?)preferred ?? DBNull.Value);
                insert.Parameters.AddWithValue(tier);
                insert.Parameters.AddWithValue(TierConfidence(tier));
                insert.Parameters.AddWithValue((long)cluster.Count);
                insert.Parameters.AddWithValue(now);
                groupId = Convert.ToString(await insert.ExecuteScalarAsync(token)) ?? groupId;
            }
            await using (var wipe = database.CreateCommand("DELETE FROM ai_duplicate_members WHERE group_id=$1"))
            {
                wipe.Parameters.AddWithValue(groupId);
                await wipe.ExecuteNonQueryAsync(token);
            }
            foreach (var member in cluster)
            {
                await using var insert = database.CreateCommand(
                    "INSERT INTO ai_duplicate_members(group_id,message_id,relation,evidence_json,created_at) "
                    + "VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING");
                insert.Parameters.AddWithValue(groupId);
                insert.Parameters.AddWithValue(member);
                insert.Parameters.AddWithValue("same_message");
                insert.Parameters.AddWithValue(JsonSerializer.Serialize(
                    evidence.GetValueOrDefault(member, []), JsonOptions));
                insert.Parameters.AddWithValue(now);
                await insert.ExecuteNonQueryAsync(token);
            }
            created++;
        }
        return new
        {
            fingerprinted,
            groupsCreated = created,
            duplicateMessages = clusters.Sum(cluster => cluster.Count),
            scannedAt = now
        };
    }

    /// <summary>Tiers 0-1: identical Message-ID, raw bytes, or normalized content hash.</summary>
    private async Task<List<(string, string, string, string)>> ExactPairsAsync(string owner, CancellationToken token)
    {
        const string sql = """
            WITH owned AS (
              SELECT m.id, m.archive_id, m.internet_message_id, m.raw_sha256, m.content_sha256
              FROM messages m JOIN archives a ON a.id = m.archive_id
              WHERE a.owner_user_id = $1
            )
            SELECT left_side.id, right_side.id, 'exact_id'
            FROM owned left_side JOIN owned right_side
              ON right_side.internet_message_id = left_side.internet_message_id AND right_side.id > left_side.id
            WHERE left_side.internet_message_id IS NOT NULL AND left_side.internet_message_id <> ''
            UNION ALL
            SELECT left_side.id, right_side.id, 'raw_hash'
            FROM owned left_side JOIN owned right_side
              ON right_side.raw_sha256 = left_side.raw_sha256 AND right_side.id > left_side.id
            WHERE left_side.raw_sha256 IS NOT NULL AND left_side.raw_sha256 <> ''
            UNION ALL
            SELECT left_side.id, right_side.id, 'content_hash'
            FROM owned left_side JOIN owned right_side
              ON right_side.content_sha256 = left_side.content_sha256 AND right_side.id > left_side.id
            WHERE left_side.content_sha256 IS NOT NULL AND left_side.content_sha256 <> ''
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(owner);
        var pairs = new List<(string, string, string, string)>();
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
        {
            var tier = reader.GetString(2);
            pairs.Add((reader.GetString(0), reader.GetString(1), tier, EvidenceFor(tier)));
        }
        return pairs;
    }

    /// <summary>
    /// Tier 2: SimHash banding. Candidates share a 16-bit band; a pair is kept only when the Hamming
    /// distance is within threshold AND the sender or normalized subject matches, so unrelated short
    /// messages are not collapsed together.
    /// </summary>
    private async Task<List<(string, string, string, string)>> NearDuplicatePairsAsync(string owner, CancellationToken token)
    {
        const string sql = """
            SELECT m.id, m.simhash, lower(COALESCE(m.sender_address, '')), COALESCE(m.subject, ''), COALESCE(m.body_text, '')
            FROM messages m JOIN archives a ON a.id = m.archive_id
            WHERE a.owner_user_id = $1 AND m.simhash IS NOT NULL AND m.simhash <> 0
            ORDER BY m.created_at DESC LIMIT $2
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue((long)NearDuplicateScanLimit);
        var rows = new List<(string Id, long SimHash, string Sender, string Subject, string Digits)>();
        await using (var reader = await command.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token))
                rows.Add((reader.GetString(0), reader.GetInt64(1), reader.GetString(2),
                    MessageFingerprint.NormalizeSubject(reader.GetString(3)),
                    MessageFingerprint.DigitSignature(reader.GetString(4))));

        var buckets = new Dictionary<string, List<int>>(StringComparer.Ordinal);
        for (var index = 0; index < rows.Count; index++)
            foreach (var band in MessageFingerprint.Bands(rows[index].SimHash))
            {
                if (!buckets.TryGetValue(band, out var list)) buckets[band] = list = [];
                list.Add(index);
            }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pairs = new List<(string, string, string, string)>();
        foreach (var bucket in buckets.Values)
        {
            if (bucket.Count < 2 || bucket.Count > 400) continue; // skip degenerate buckets
            for (var left = 0; left < bucket.Count; left++)
                for (var right = left + 1; right < bucket.Count; right++)
                {
                    var first = rows[bucket[left]];
                    var second = rows[bucket[right]];
                    var key = PairKey(first.Id, second.Id);
                    if (!seen.Add(key)) continue;
                    var distance = MessageFingerprint.HammingDistance(first.SimHash, second.SimHash);
                    if (distance > NearDuplicateHammingThreshold) continue;
                    var sameSender = first.Sender.Length > 0 && first.Sender == second.Sender;
                    var sameSubject = first.Subject.Length > 0 && first.Subject == second.Subject;
                    if (!sameSender && !sameSubject) continue;
                    // Same template, different order/invoice/amount is not a duplicate.
                    if (first.Digits != second.Digits) continue;
                    pairs.Add((first.Id, second.Id, "near_duplicate",
                        $"near-duplicate body (hamming {distance}, {(sameSubject ? "same subject" : "same sender")})"));
                }
        }
        return pairs;
    }

    private async Task<string?> PreferredCopyAsync(List<string> cluster, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT id FROM messages WHERE id=ANY($1) ORDER BY COALESCE(received_at, sent_at, created_at), id LIMIT 1");
        command.Parameters.AddWithValue(cluster.ToArray());
        return Convert.ToString(await command.ExecuteScalarAsync(token));
    }

    private async Task<HashSet<string>> LoadDecidedMessagesAsync(string owner, CancellationToken token)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        await using var command = database.CreateCommand(
            "SELECT d.message_id FROM ai_duplicate_members d JOIN ai_duplicate_groups g ON g.id=d.group_id "
            + "WHERE g.owner_user_id=$1 AND g.review_status<>'pending'");
        command.Parameters.AddWithValue(owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) ids.Add(reader.GetString(0));
        return ids;
    }

    private async Task<HashSet<string>> LoadNotDuplicatePairsAsync(string owner, CancellationToken token)
    {
        var pairs = new HashSet<string>(StringComparer.Ordinal);
        await using var command = database.CreateCommand(
            "SELECT left_message_id,right_message_id FROM ai_not_duplicate_pairs WHERE owner_user_id=$1");
        command.Parameters.AddWithValue(owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) pairs.Add(PairKey(reader.GetString(0), reader.GetString(1)));
        return pairs;
    }

    // ---------- fingerprint backfill ----------

    /// <summary>Fingerprints this owner's unfingerprinted messages; returns how many were written.</summary>
    public async Task<int> FingerprintOwnerAsync(string owner, CancellationToken token)
    {
        var total = 0;
        while (true)
        {
            var written = await FingerprintBatchAsync(owner, token);
            total += written;
            if (written < FingerprintBatchSize) break;
        }
        return total;
    }

    private async Task<int> FingerprintBatchAsync(string? owner, CancellationToken token)
    {
        var sql = "SELECT m.id,m.subject,m.sender_address,m.body_text,m.headers_json FROM messages m "
            + (owner is null ? "" : "JOIN archives a ON a.id=m.archive_id ")
            + "WHERE m.fingerprinted_at IS NULL "
            + (owner is null ? "" : "AND a.owner_user_id=$2 ")
            + "ORDER BY m.created_at LIMIT $1";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue((long)FingerprintBatchSize);
        if (owner is not null) command.Parameters.AddWithValue(owner);
        var rows = new List<(string Id, string Subject, string Sender, string Body, string Headers)>();
        await using (var reader = await command.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token))
                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    reader.GetString(3), reader.GetString(4)));

        var now = DateTimeOffset.UtcNow.ToString("O");
        foreach (var row in rows)
        {
            var attachments = await AttachmentHashesAsync(row.Id, token);
            var content = MessageFingerprint.ContentHash(row.Subject, row.Sender, row.Body, attachments);
            var raw = MessageFingerprint.RawHash($"{row.Headers}\n\n{row.Subject}\n{row.Sender}\n{row.Body}");
            var simhash = MessageFingerprint.SimHash(row.Body);
            await using var update = database.CreateCommand(
                "UPDATE messages SET content_sha256=$2,raw_sha256=$3,simhash=$4,fingerprinted_at=$5 WHERE id=$1");
            update.Parameters.AddWithValue(row.Id);
            update.Parameters.AddWithValue(content);
            update.Parameters.AddWithValue(raw);
            update.Parameters.AddWithValue(simhash);
            update.Parameters.AddWithValue(now);
            await update.ExecuteNonQueryAsync(token);
        }
        return rows.Count;
    }

    private async Task<List<string>> AttachmentHashesAsync(string messageId, CancellationToken token)
    {
        var hashes = new List<string>();
        await using var command = database.CreateCommand(
            "SELECT blob_sha256 FROM attachments WHERE message_id=$1");
        command.Parameters.AddWithValue(messageId);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
            if (!reader.IsDBNull(0)) hashes.Add(reader.GetString(0));
        return hashes;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                var written = await FingerprintBatchAsync(null, stoppingToken);
                await Task.Delay(written == 0 ? TimeSpan.FromSeconds(30) : TimeSpan.FromMilliseconds(250), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                logger.LogError(error, "Duplicate fingerprint backfill iteration failed");
                await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
            }
        }
    }

    // ---------- helpers ----------

    private async Task<long> CountAsync(string status, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT COUNT(*) FROM ai_duplicate_groups WHERE owner_user_id=$1 AND review_status=$2");
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(status);
        return Convert.ToInt64(await command.ExecuteScalarAsync(token));
    }

    internal static string PairKey(string left, string right) =>
        string.CompareOrdinal(left, right) <= 0 ? $"{left}|{right}" : $"{right}|{left}";

    private static int TierRank(string tier) => tier switch
    {
        "exact_id" => 0, "raw_hash" => 1, "content_hash" => 2, _ => 3
    };

    private static double TierConfidence(string tier) => tier switch
    {
        "exact_id" => 1.0, "raw_hash" => 1.0, "content_hash" => 0.95, _ => 0.8
    };

    private static string EvidenceFor(string tier) => tier switch
    {
        "exact_id" => "identical Message-ID header",
        "raw_hash" => "identical raw message bytes",
        "content_hash" => "identical normalized content and attachments",
        _ => "near-duplicate body"
    };

    private static object GroupRow(NpgsqlDataReader r) => new
    {
        id = r.GetString(0),
        groupKey = r.GetString(1),
        preferredMessageId = r.IsDBNull(2) ? null : r.GetString(2),
        detectionTier = r.GetString(3),
        confidence = r.GetDouble(4),
        memberCount = r.GetInt64(5),
        reviewStatus = r.GetString(6),
        reviewedAt = r.IsDBNull(7) ? null : r.GetString(7),
        createdAt = r.GetString(8),
        updatedAt = r.GetString(9)
    };

    private static string[] ParseArray(string value)
    {
        try { return JsonSerializer.Deserialize<string[]>(value, JsonOptions) ?? []; }
        catch { return []; }
    }

    private static string? String(JsonElement input, string name) =>
        input.ValueKind == JsonValueKind.Object && input.TryGetProperty(name, out var value)
            && value.ValueKind == JsonValueKind.String ? value.GetString()?.Trim() : null;

    /// <summary>Minimal union-find over message ids, used to turn duplicate pairs into clusters.</summary>
    internal sealed class UnionFind
    {
        private readonly Dictionary<string, string> parents = new(StringComparer.Ordinal);

        public string Find(string id)
        {
            parents.TryAdd(id, id);
            var root = id;
            while (parents[root] != root) root = parents[root];
            while (parents[id] != root) (parents[id], id) = (root, parents[id]);
            return root;
        }

        public void Union(string left, string right)
        {
            var leftRoot = Find(left);
            var rightRoot = Find(right);
            if (leftRoot == rightRoot) return;
            if (string.CompareOrdinal(leftRoot, rightRoot) <= 0) parents[rightRoot] = leftRoot;
            else parents[leftRoot] = rightRoot;
        }

        public IEnumerable<List<string>> Clusters()
        {
            var clusters = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var id in parents.Keys.ToList())
            {
                var root = Find(id);
                if (!clusters.TryGetValue(root, out var list)) clusters[root] = list = [];
                list.Add(id);
            }
            return clusters.Values;
        }
    }
}
