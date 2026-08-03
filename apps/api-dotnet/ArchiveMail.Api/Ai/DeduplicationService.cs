using System.Text.Json;
using ArchiveMail.Api.Mail;
using Npgsql;

namespace ArchiveMail.Api.Ai;

/// <summary>
/// Deterministic duplicate detection (plan tiers 0-3). Runs entirely locally: no AI provider and no
/// API cost. Fingerprints are backfilled in batches; a scan groups messages with union-find and
/// records reviewable duplicate groups. Nothing is ever deleted.
///
/// A scan is a claimed job (<c>ai_duplicate_scans</c>) driven by
/// <see cref="DuplicateScanCoordinator"/>, not work done on the request thread. Every write below
/// is batched for the same reason: the original scan issued two statements per message during
/// fingerprinting and one per member and per dismissed pair afterwards, which on a real archive was
/// hundreds of thousands of round trips inside a single HTTP request. It timed out at the proxy
/// long before it finished, and while it ran nothing else could get a connection.
/// </summary>
public sealed class DeduplicationService(NpgsqlDataSource database, MailRepository mail)
{
    /// <summary>
    /// Maximum differing SimHash bits for two messages to count as near-duplicates. Email bodies are
    /// short, so a single edited word already moves ~4 bits; 6 keeps quote-trimmed and lightly edited
    /// copies together while remaining astronomically selective across 64 bits. False positives are
    /// further constrained by the sender/subject and digit-signature guards, and every group still
    /// requires owner confirmation before anything is collapsed.
    /// </summary>
    internal const int NearDuplicateHammingThreshold = 6;

    /// <summary>Batch size for the idle backfill, which runs beside a live API and stays small.</summary>
    internal const int FingerprintBatchSize = 200;

    /// <summary>
    /// Batch size while a scan is running. Larger than the idle backfill because a batch is now two
    /// statements regardless of its size, so the round-trip cost no longer scales with the count.
    /// </summary>
    internal const int ScanFingerprintBatchSize = 1_000;

    /// <summary>
    /// A pause between scan batches. The scan is background work behind a progress bar and nobody
    /// is waiting on any single batch, so it deliberately leaves the connection pool and the disk
    /// to whatever the user is doing in the app meanwhile.
    /// </summary>
    internal static readonly TimeSpan BatchPause = TimeSpan.FromMilliseconds(75);

    /// <summary>
    /// The candidate joins and the banding pass both run over an entire owner's mail, which on a
    /// large archive is well past Npgsql's 30 second default. A timeout there used to surface as a
    /// failed scan that had done all of its work.
    /// </summary>
    internal const int ScanCommandTimeoutSeconds = 600;

    internal const int NearDuplicateScanLimit = 50_000;
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
        // The in-flight scan rides along so opening the dialog - or reloading the page mid-scan -
        // shows the running job straight away instead of an idle button.
        return new { groups, totalPending = pending, scan = await LatestScanAsync(owner, token) };
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
        var summaries = (await mail.GetMessageSummariesAsync(rows.Select(row => row.MessageId), owner, token))
            .ToDictionary(message => message.Id, StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (summaries.TryGetValue(row.MessageId, out var message))
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
        var lefts = new List<string>();
        var rights = new List<string>();
        for (var left = 0; left < members.Count; left++)
            for (var right = left + 1; right < members.Count; right++)
            {
                lefts.Add(members[left]);
                rights.Add(members[right]);
            }
        if (lefts.Count == 0) return;
        // Every pair in one statement: the combinations grow quadratically, so dismissing a group
        // of thirty copies was 435 separate inserts while the user waited on the click.
        await using var insert = database.CreateCommand(
            "INSERT INTO ai_not_duplicate_pairs(owner_user_id,left_message_id,right_message_id,created_at) "
            + "SELECT $1, pair.left_id, pair.right_id, $4 FROM unnest($2::text[], $3::text[]) AS pair(left_id, right_id) "
            + "ON CONFLICT DO NOTHING");
        insert.Parameters.AddWithValue(owner);
        insert.Parameters.AddWithValue(lefts.ToArray());
        insert.Parameters.AddWithValue(rights.ToArray());
        insert.Parameters.AddWithValue(now);
        await insert.ExecuteNonQueryAsync(token);
    }

    // ---------- scan job ----------

    private const string ScanColumns =
        "id,status,phase,processed_items,total_items,fingerprinted,groups_created,duplicate_messages,"
        + "scanned_messages,skipped_messages,message,created_at,updated_at,finished_at";

    /// <summary>
    /// Queues a scan and returns immediately. When one is already queued or running for this owner
    /// the existing job comes back untouched: the active partial unique index makes that a database
    /// guarantee, so two clicks - or two browser tabs - cannot start two passes over the same mail.
    /// </summary>
    public async Task<object> EnqueueScanAsync(string owner, CancellationToken token)
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using (var insert = database.CreateCommand(
            "INSERT INTO ai_duplicate_scans(id,owner_user_id,status,phase,message,created_at,updated_at) "
            + "VALUES($1,$2,'queued','queued','Waiting for a worker',$3,$3) "
            + "ON CONFLICT (owner_user_id) WHERE status IN ('queued','running') DO NOTHING"))
        {
            insert.Parameters.AddWithValue(Guid.NewGuid().ToString());
            insert.Parameters.AddWithValue(owner);
            insert.Parameters.AddWithValue(now);
            await insert.ExecuteNonQueryAsync(token);
        }
        return await LatestScanAsync(owner, token)
            ?? throw new InvalidOperationException("The duplicate scan could not be queued");
    }

    /// <summary>The owner's most recent scan, running or finished, or null if they have never run one.</summary>
    public async Task<object?> LatestScanAsync(string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            $"SELECT {ScanColumns} FROM ai_duplicate_scans WHERE owner_user_id=$1 "
            + "ORDER BY CASE WHEN status IN ('queued','running') THEN 0 ELSE 1 END, created_at DESC LIMIT 1");
        command.Parameters.AddWithValue(owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) ? ScanRow(reader) : null;
    }

    /// <summary>
    /// Flips an active scan to cancelled. The worker finds out at its next progress write, which is
    /// scoped to status = 'running' - the same mechanism a combine uses - so it stops at a batch
    /// boundary rather than being killed mid-statement.
    /// </summary>
    public async Task<object?> CancelScanAsync(string owner, CancellationToken token)
    {
        var now = DateTimeOffset.UtcNow.ToString("O");
        await using (var command = database.CreateCommand(
            "UPDATE ai_duplicate_scans SET status='cancelled',message='Scan cancelled',worker_id=NULL,"
            + "lease_until=NULL,finished_at=$2,updated_at=$2 "
            + "WHERE owner_user_id=$1 AND status IN ('queued','running')"))
        {
            command.Parameters.AddWithValue(owner);
            command.Parameters.AddWithValue(now);
            if (await command.ExecuteNonQueryAsync(token) == 0) return null;
        }
        return await LatestScanAsync(owner, token);
    }

    /// <summary>
    /// Claims one queued scan, or one whose lease has expired because the worker holding it died.
    /// Returns the scan id and the owner it belongs to.
    /// </summary>
    public async Task<(string Id, string Owner)?> ClaimScanAsync(
        string workerId, TimeSpan lease, CancellationToken token)
    {
        const string sql = """
            WITH candidate AS (
              SELECT id FROM ai_duplicate_scans
              WHERE status = 'queued'
                 OR (status = 'running' AND (lease_until IS NULL OR lease_until < $1))
              ORDER BY updated_at
              FOR UPDATE SKIP LOCKED
              LIMIT 1
            )
            UPDATE ai_duplicate_scans AS scan
            SET status='running', phase='fingerprinting', worker_id=$2, lease_until=$3,
                message='Fingerprinting messages', updated_at=$1
            FROM candidate
            WHERE scan.id = candidate.id
            RETURNING scan.id, scan.owner_user_id
            """;
        var now = DateTimeOffset.UtcNow;
        await using var connection = await database.OpenConnectionAsync(token);
        await using var transaction = await connection.BeginTransactionAsync(token);
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.AddWithValue(now.ToString("O"));
        command.Parameters.AddWithValue(workerId);
        command.Parameters.AddWithValue(now.Add(lease).ToString("O"));
        (string, string)? claimed = null;
        await using (var reader = await command.ExecuteReaderAsync(token))
            if (await reader.ReadAsync(token)) claimed = (reader.GetString(0), reader.GetString(1));
        await transaction.CommitAsync(token);
        return claimed;
    }

    /// <summary>
    /// Writes progress and renews the lease in one statement, scoped to status = 'running'. Matching
    /// nothing means the scan was cancelled or reclaimed, so the run gives up here rather than
    /// carrying on writing groups nobody asked for.
    /// </summary>
    private async Task ReportAsync(
        string scanId, string phase, string message, long processed, TimeSpan lease, CancellationToken token)
    {
        var now = DateTimeOffset.UtcNow;
        await using var command = database.CreateCommand(
            "UPDATE ai_duplicate_scans SET phase=$2,message=$3,processed_items=$4,lease_until=$5,updated_at=$6 "
            + "WHERE id=$1 AND status='running'");
        command.Parameters.AddWithValue(scanId);
        command.Parameters.AddWithValue(phase);
        command.Parameters.AddWithValue(message);
        command.Parameters.AddWithValue(processed);
        command.Parameters.AddWithValue(now.Add(lease).ToString("O"));
        command.Parameters.AddWithValue(now.ToString("O"));
        if (await command.ExecuteNonQueryAsync(token) != 1)
            throw new OperationCanceledException("This duplicate scan is no longer running");
    }

    public async Task MarkScanFailedAsync(string scanId, string message, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE ai_duplicate_scans SET status='failed',message=$2,worker_id=NULL,lease_until=NULL,"
            + "finished_at=$3,updated_at=$3 WHERE id=$1 AND status='running'");
        command.Parameters.AddWithValue(scanId);
        command.Parameters.AddWithValue(Truncate(message));
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
    }

    /// <summary>Failure text goes straight to the dialog, so it is bounded before it is stored.</summary>
    private static string Truncate(string value) =>
        value.Length <= 300 ? value : value[..300];

    // ---------- scan ----------

    /// <summary>
    /// Rebuilds pending duplicate groups for one owner. Confirmed groups and dismissed pairs are
    /// preserved: their members are excluded so an owner decision is never undone by a rescan.
    ///
    /// Runs under a claimed job: every phase reports progress, and a report that matches no running
    /// row aborts the scan, which is how a cancel gets in.
    /// </summary>
    public async Task RunScanAsync(string scanId, string owner, TimeSpan lease, CancellationToken token)
    {
        var fingerprinted = await FingerprintForScanAsync(scanId, owner, lease, token);
        await ReportAsync(scanId, "matching", "Looking for identical copies", fingerprinted, lease, token);

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
        await ReportAsync(scanId, "matching", "Comparing similar messages", fingerprinted, lease, token);
        var (nearPairs, scanned, skipped) = await NearDuplicatePairsAsync(owner, token);
        pairs.AddRange(nearPairs);
        await ReportAsync(scanId, "grouping", "Grouping copies", fingerprinted, lease, token);

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
        var preferred = await PreferredCopiesAsync(clusters, token);
        var created = 0;
        foreach (var cluster in clusters)
        {
            cluster.Sort(StringComparer.Ordinal);
            var key = "u:" + cluster[0];
            var tier = cluster.Select(id => tiers.GetValueOrDefault(id, "near_duplicate"))
                .OrderBy(TierRank).First();
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
                insert.Parameters.AddWithValue((object?)preferred.GetValueOrDefault(key) ?? DBNull.Value);
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
            await using (var insert = database.CreateCommand(MemberInsertSql))
            {
                insert.Parameters.AddWithValue(groupId);
                insert.Parameters.AddWithValue(cluster.ToArray());
                insert.Parameters.AddWithValue(cluster
                    .Select(member => JsonSerializer.Serialize(evidence.GetValueOrDefault(member, []), JsonOptions))
                    .ToArray());
                insert.Parameters.AddWithValue(now);
                await insert.ExecuteNonQueryAsync(token);
            }
            created++;
            // Groups land as they are built, so a scan cancelled halfway still leaves reviewable
            // work behind, and the count in the dialog climbs while it runs.
            if (created % 25 == 0)
                await ReportAsync(scanId, "grouping", $"Grouping copies ({created} groups)", fingerprinted, lease, token);
        }

        await CompleteScanAsync(
            scanId,
            fingerprinted,
            created,
            clusters.Sum(cluster => cluster.Count),
            scanned,
            skipped,
            token);
    }

    /// <summary>
    /// One statement for a whole group's members instead of one per member. Member counts are
    /// usually small, but a scan that finds thousands of groups pays this per group.
    /// </summary>
    internal const string MemberInsertSql = """
        INSERT INTO ai_duplicate_members(group_id,message_id,relation,evidence_json,created_at)
        SELECT $1, member.message_id, 'same_message', member.evidence, $4
        FROM unnest($2::text[], $3::text[]) AS member(message_id, evidence)
        ON CONFLICT DO NOTHING
        """;

    /// <summary>
    /// Records the outcome. Scoped to status = 'running' so a scan cancelled while the last groups
    /// were being written is not reported back to the user as a completed one.
    /// </summary>
    private async Task CompleteScanAsync(
        string scanId,
        long fingerprinted,
        long groupsCreated,
        long duplicateMessages,
        long scannedMessages,
        long skippedMessages,
        CancellationToken token)
    {
        // Near-duplicate coverage is capped, so a scan that did not look at everything says so
        // rather than reporting a clean result over mail it never compared.
        var message = skippedMessages > 0
            ? $"Scan complete. {skippedMessages:N0} messages were past the near-duplicate limit and were only checked for identical copies."
            : "Scan complete";
        await using var command = database.CreateCommand(
            "UPDATE ai_duplicate_scans SET status='completed',phase='done',message=$2,fingerprinted=$3,"
            + "groups_created=$4,duplicate_messages=$5,scanned_messages=$6,skipped_messages=$7,"
            + "processed_items=$3,worker_id=NULL,lease_until=NULL,finished_at=$8,updated_at=$8 "
            + "WHERE id=$1 AND status='running'");
        command.Parameters.AddWithValue(scanId);
        command.Parameters.AddWithValue(message);
        command.Parameters.AddWithValue(fingerprinted);
        command.Parameters.AddWithValue(groupsCreated);
        command.Parameters.AddWithValue(duplicateMessages);
        command.Parameters.AddWithValue(scannedMessages);
        command.Parameters.AddWithValue(skippedMessages);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
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
        command.CommandTimeout = ScanCommandTimeoutSeconds;
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
    ///
    /// Coverage is capped at <see cref="NearDuplicateScanLimit"/>, so this also reports how many of
    /// the owner's fingerprinted messages it compared and how many it did not reach - a cap that
    /// says nothing reads as "no near-duplicates" when it means "not looked at".
    /// </summary>
    private async Task<(List<(string, string, string, string)> Pairs, long Scanned, long Skipped)>
        NearDuplicatePairsAsync(string owner, CancellationToken token)
    {
        const string sql = """
            SELECT m.id, m.simhash, lower(COALESCE(m.sender_address, '')), COALESCE(m.subject, ''), COALESCE(m.body_text, '')
            FROM messages m JOIN archives a ON a.id = m.archive_id
            WHERE a.owner_user_id = $1 AND m.simhash IS NOT NULL AND m.simhash <> 0
            ORDER BY m.created_at DESC LIMIT $2
            """;
        await using var command = database.CreateCommand(sql);
        command.CommandTimeout = ScanCommandTimeoutSeconds;
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue((long)NearDuplicateScanLimit);
        var rows = new List<(string Id, long SimHash, string Sender, string Subject, string Digits)>();
        await using (var reader = await command.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token))
                rows.Add((reader.GetString(0), reader.GetInt64(1), reader.GetString(2),
                    MessageFingerprint.NormalizeSubject(reader.GetString(3)),
                    MessageFingerprint.DigitSignature(reader.GetString(4))));
        var skipped = rows.Count < NearDuplicateScanLimit
            ? 0
            : Math.Max(0, await CountComparableAsync(owner, token) - rows.Count);

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
        return (pairs, rows.Count, skipped);
    }

    private async Task<long> CountComparableAsync(string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT COUNT(*) FROM messages m JOIN archives a ON a.id=m.archive_id "
            + "WHERE a.owner_user_id=$1 AND m.simhash IS NOT NULL AND m.simhash <> 0");
        command.CommandTimeout = ScanCommandTimeoutSeconds;
        command.Parameters.AddWithValue(owner);
        return Convert.ToInt64(await command.ExecuteScalarAsync(token));
    }

    /// <summary>
    /// Picks the oldest copy in every cluster at once, keyed by group key. One query per cluster
    /// meant a scan finding a few thousand groups spent a few thousand round trips deciding which
    /// copy to prefer.
    /// </summary>
    private async Task<Dictionary<string, string?>> PreferredCopiesAsync(
        List<List<string>> clusters, CancellationToken token)
    {
        var preferred = new Dictionary<string, string?>(StringComparer.Ordinal);
        if (clusters.Count == 0) return preferred;
        var all = clusters.SelectMany(cluster => cluster).Distinct(StringComparer.Ordinal).ToArray();
        var order = new Dictionary<string, string>(StringComparer.Ordinal);
        await using (var command = database.CreateCommand(
            "SELECT id, COALESCE(received_at, sent_at, created_at) FROM messages WHERE id=ANY($1)"))
        {
            command.CommandTimeout = ScanCommandTimeoutSeconds;
            command.Parameters.AddWithValue(all);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token)) order[reader.GetString(0)] = reader.GetString(1);
        }
        foreach (var cluster in clusters)
        {
            var sorted = cluster.OrderBy(id => order.GetValueOrDefault(id, ""), StringComparer.Ordinal)
                .ThenBy(id => id, StringComparer.Ordinal);
            preferred["u:" + cluster.Min(StringComparer.Ordinal)] = sorted.FirstOrDefault();
        }
        return preferred;
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

    /// <summary>
    /// Fingerprints this owner's unfingerprinted messages under a running scan, reporting progress
    /// and pausing between batches. Returns how many were written.
    /// </summary>
    private async Task<long> FingerprintForScanAsync(
        string scanId, string owner, TimeSpan lease, CancellationToken token)
    {
        var pending = await CountUnfingerprintedAsync(owner, token);
        await SetScanTotalAsync(scanId, pending, token);
        var total = 0L;
        while (true)
        {
            var written = await FingerprintBatchAsync(owner, ScanFingerprintBatchSize, token);
            if (written == 0) break;
            total += written;
            await ReportAsync(
                scanId, "fingerprinting", $"Fingerprinting messages ({total:N0} of {pending:N0})", total, lease, token);
            await Task.Delay(BatchPause, token);
        }
        return total;
    }

    /// <summary>One batch for the idle backfill loop, outside any scan.</summary>
    public Task<int> FingerprintIdleBatchAsync(CancellationToken token) =>
        FingerprintBatchAsync(null, FingerprintBatchSize, token);

    private async Task<long> CountUnfingerprintedAsync(string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT COUNT(*) FROM messages m JOIN archives a ON a.id=m.archive_id "
            + "WHERE a.owner_user_id=$1 AND m.fingerprinted_at IS NULL");
        command.CommandTimeout = ScanCommandTimeoutSeconds;
        command.Parameters.AddWithValue(owner);
        return Convert.ToInt64(await command.ExecuteScalarAsync(token));
    }

    private async Task SetScanTotalAsync(string scanId, long total, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "UPDATE ai_duplicate_scans SET total_items=$2,updated_at=$3 WHERE id=$1");
        command.Parameters.AddWithValue(scanId);
        command.Parameters.AddWithValue(total);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
    }

    /// <summary>
    /// Writes a whole batch of fingerprints back in one statement. This used to be one attachment
    /// query and one UPDATE per message: 1.2 million round trips for a 600k archive, all of them on
    /// the request thread, which is what turned a scan into a 504 and starved everything else of
    /// connections while it ran.
    /// </summary>
    internal const string FingerprintWriteSql = """
        UPDATE messages AS message
        SET content_sha256 = fingerprint.content,
            raw_sha256 = fingerprint.raw,
            simhash = fingerprint.simhash,
            fingerprinted_at = $5
        FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])
          AS fingerprint(id, content, raw, simhash)
        WHERE message.id = fingerprint.id
        """;

    private async Task<int> FingerprintBatchAsync(string? owner, int batchSize, CancellationToken token)
    {
        var sql = "SELECT m.id,m.subject,m.sender_address,m.body_text,m.headers_json FROM messages m "
            + (owner is null ? "" : "JOIN archives a ON a.id=m.archive_id ")
            + "WHERE m.fingerprinted_at IS NULL "
            + (owner is null ? "" : "AND a.owner_user_id=$2 ")
            + "ORDER BY m.created_at LIMIT $1";
        await using var command = database.CreateCommand(sql);
        command.CommandTimeout = ScanCommandTimeoutSeconds;
        command.Parameters.AddWithValue((long)batchSize);
        if (owner is not null) command.Parameters.AddWithValue(owner);
        var rows = new List<(string Id, string Subject, string Sender, string Body, string Headers)>();
        await using (var reader = await command.ExecuteReaderAsync(token))
            while (await reader.ReadAsync(token))
                rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                    reader.GetString(3), reader.GetString(4)));
        if (rows.Count == 0) return 0;

        var attachments = await AttachmentHashesAsync(rows.Select(row => row.Id).ToArray(), token);
        var ids = new string[rows.Count];
        var contents = new string[rows.Count];
        var raws = new string[rows.Count];
        var simhashes = new long[rows.Count];
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            ids[index] = row.Id;
            contents[index] = MessageFingerprint.ContentHash(
                row.Subject, row.Sender, row.Body, attachments.GetValueOrDefault(row.Id));
            raws[index] = MessageFingerprint.RawHash($"{row.Headers}\n\n{row.Subject}\n{row.Sender}\n{row.Body}");
            simhashes[index] = MessageFingerprint.SimHash(row.Body);
        }

        await using var write = database.CreateCommand(FingerprintWriteSql);
        write.CommandTimeout = ScanCommandTimeoutSeconds;
        write.Parameters.AddWithValue(ids);
        write.Parameters.AddWithValue(contents);
        write.Parameters.AddWithValue(raws);
        write.Parameters.AddWithValue(simhashes);
        write.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await write.ExecuteNonQueryAsync(token);
        return rows.Count;
    }

    /// <summary>Attachment digests for a whole batch, keyed by message.</summary>
    private async Task<Dictionary<string, List<string>>> AttachmentHashesAsync(
        string[] messageIds, CancellationToken token)
    {
        var hashes = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        await using var command = database.CreateCommand(
            "SELECT message_id, blob_sha256 FROM attachments WHERE message_id=ANY($1) AND blob_sha256 IS NOT NULL");
        command.CommandTimeout = ScanCommandTimeoutSeconds;
        command.Parameters.AddWithValue(messageIds);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetString(0);
            if (!hashes.TryGetValue(id, out var list)) hashes[id] = list = [];
            list.Add(reader.GetString(1));
        }
        return hashes;
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

    private static object ScanRow(NpgsqlDataReader r) => new
    {
        id = r.GetString(0),
        status = r.GetString(1),
        phase = r.GetString(2),
        processedItems = r.GetInt64(3),
        totalItems = r.IsDBNull(4) ? (long?)null : r.GetInt64(4),
        fingerprinted = r.GetInt64(5),
        groupsCreated = r.GetInt64(6),
        duplicateMessages = r.GetInt64(7),
        scannedMessages = r.GetInt64(8),
        skippedMessages = r.GetInt64(9),
        message = r.GetString(10),
        createdAt = r.GetString(11),
        updatedAt = r.GetString(12),
        finishedAt = r.IsDBNull(13) ? null : r.GetString(13)
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
