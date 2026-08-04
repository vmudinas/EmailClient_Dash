using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class DeduplicationServiceTests
{
    [Fact]
    public void Pair_key_is_order_independent()
    {
        Assert.Equal(
            DeduplicationService.PairKey("a", "b"),
            DeduplicationService.PairKey("b", "a"));
    }

    [Fact]
    public void Union_find_groups_transitive_duplicates_into_one_cluster()
    {
        var union = new DeduplicationService.UnionFind();
        union.Union("a", "b");
        union.Union("b", "c");
        var clusters = union.Clusters().ToList();
        var cluster = Assert.Single(clusters);
        Assert.Equal(["a", "b", "c"], cluster.OrderBy(value => value, StringComparer.Ordinal));
    }

    [Fact]
    public void Union_find_keeps_unrelated_pairs_in_separate_clusters()
    {
        var union = new DeduplicationService.UnionFind();
        union.Union("a", "b");
        union.Union("c", "d");
        var clusters = union.Clusters().Select(cluster => cluster.OrderBy(v => v, StringComparer.Ordinal).ToArray()).ToList();
        Assert.Equal(2, clusters.Count);
        Assert.Contains(clusters, cluster => cluster.SequenceEqual(["a", "b"]));
        Assert.Contains(clusters, cluster => cluster.SequenceEqual(["c", "d"]));
    }

    [Fact]
    public void Union_find_merges_two_clusters_when_a_bridging_pair_arrives()
    {
        var union = new DeduplicationService.UnionFind();
        union.Union("a", "b");
        union.Union("c", "d");
        union.Union("b", "c");
        var cluster = Assert.Single(union.Clusters().ToList());
        Assert.Equal(4, cluster.Count);
    }

    [Fact]
    public void Duplicate_schema_creates_group_member_and_decision_tables()
    {
        foreach (var expected in new[]
        {
            "CREATE TABLE IF NOT EXISTS ai_duplicate_groups (",
            "CREATE TABLE IF NOT EXISTS ai_duplicate_members (",
            "CREATE TABLE IF NOT EXISTS ai_not_duplicate_pairs (",
            "CREATE UNIQUE INDEX IF NOT EXISTS ai_duplicate_groups_key_idx"
        })
            Assert.Contains(expected, DatabaseInitializer.ConnectedServicesSchemaSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Existing_cutover_schema_gets_message_fingerprint_columns_repaired()
    {
        foreach (var expected in new[]
        {
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_sha256 TEXT;",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_sha256 TEXT;",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS simhash BIGINT;",
            "ALTER TABLE messages ADD COLUMN IF NOT EXISTS fingerprinted_at TEXT;"
        })
            Assert.Contains(expected, DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Duplicate_groups_are_never_deleted_by_schema_cascade_from_messages()
    {
        // A message removal must not silently drop the group; only the membership row cascades.
        Assert.Contains(
            "preferred_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Scan_is_a_claimable_job_rather_than_work_done_on_the_request()
    {
        // The inline scan timed out at the proxy on any real archive. The job table is what lets
        // the enqueue return immediately and the work survive a restart.
        Assert.Contains(
            "CREATE TABLE IF NOT EXISTS ai_duplicate_scans (",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Only_one_scan_per_owner_can_be_active_at_a_time()
    {
        // Enforced by the database, not by a check-then-insert two clicks can both pass.
        Assert.Contains(
            "CREATE UNIQUE INDEX IF NOT EXISTS ai_duplicate_scans_active_idx",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ON ai_duplicate_scans(owner_user_id) WHERE status IN ('queued', 'running');",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void Cross_archive_match_columns_are_indexed_for_the_way_the_scan_joins_them()
    {
        // messages_internet_id_idx leads with archive_id, so it cannot serve an owner-wide join on
        // internet_message_id alone, and raw_sha256 had no index at all. Two of the three exact
        // tiers were sequential scans over the whole table.
        foreach (var expected in new[]
        {
            "CREATE INDEX IF NOT EXISTS messages_internet_id_global_idx ON messages(internet_message_id)",
            "CREATE INDEX IF NOT EXISTS messages_raw_hash_idx ON messages(raw_sha256)"
        })
            Assert.Contains(expected, DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Fingerprints_are_written_a_batch_at_a_time()
    {
        // One UPDATE and one attachment SELECT per message was 1.2 million round trips on a 600k
        // archive. The set-returning write is what keeps a batch to a single statement.
        Assert.Contains("FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[])",
            DeduplicationService.FingerprintWriteSql, StringComparison.Ordinal);
        Assert.Contains("AS fingerprint(id, content, raw, simhash)",
            DeduplicationService.FingerprintWriteSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Group_members_are_written_in_one_statement()
    {
        Assert.Contains("FROM unnest($2::text[], $3::text[]) AS member(message_id, evidence)",
            DeduplicationService.MemberInsertSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Group_detail_batches_every_member_past_the_summary_lookup_limit()
    {
        var limit = MailRepository.MessageSummaryLookupLimit;
        var ids = Enumerable.Range(0, limit * 2 + 1)
            .Select(index => $"message-{index}")
            .Append("message-0")
            .Append("");

        var batches = DeduplicationService.GroupMemberSummaryBatches(ids).ToArray();

        Assert.Equal([limit, limit, 1], batches.Select(batch => batch.Length));
        Assert.Equal(limit * 2 + 1,
            batches.SelectMany(batch => batch).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Scan_queries_are_given_room_to_outlast_the_default_command_timeout()
    {
        // A timeout in the middle of the candidate join used to surface as a failed scan that had
        // already done all of its work.
        Assert.True(DeduplicationService.ScanCommandTimeoutSeconds >= 600);
    }

    [Fact]
    public void Ask_history_table_records_questions_without_storing_excerpt_bodies()
    {
        Assert.Contains(
            "CREATE TABLE IF NOT EXISTS ai_questions (",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "excerpt_bodies", DatabaseInitializer.ConnectedServicesSchemaSql, StringComparison.Ordinal);
    }
}
