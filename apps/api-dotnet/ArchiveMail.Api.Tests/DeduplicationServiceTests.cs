using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Infrastructure;
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
