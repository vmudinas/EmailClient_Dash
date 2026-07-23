using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class DatabaseSchemaContractTests
{
    private static readonly DatabaseSchemaContract Contract = DatabaseSchemaContract.FromSql(
        DatabaseInitializer.CoreSchemaSql,
        DatabaseInitializer.ConnectedServicesSchemaSql,
        DatabaseInitializer.PropertySchemaSql);

    [Fact]
    public void Contract_covers_every_declared_table_and_named_unique_index()
    {
        Assert.True(Contract.Tables.Count >= 50);
        Assert.Contains("users", Contract.Tables);
        Assert.Contains("gmail_connections", Contract.Tables);
        Assert.Contains("ai_jobs", Contract.Tables);
        Assert.Contains("managed_properties", Contract.Tables);
        Assert.Contains("messages_archive_source_key_conflict_idx", Contract.UniqueIndexes);
        Assert.Contains("ai_jobs_active_message_idx", Contract.UniqueIndexes);
        Assert.Contains("ai_message_analysis_message_conflict_idx", Contract.UniqueIndexes);
        Assert.Contains("ai_analysis_reviews_message_conflict_idx", Contract.UniqueIndexes);
    }

    [Theory]
    [InlineData("ai_jobs", "attempts", "0")]
    [InlineData("gmail_connections", "processed_items", "0")]
    [InlineData("messages", "subject", "''")]
    [InlineData("managed_properties", "address_line2", "''")]
    [InlineData("property_leases", "security_deposit_cents", "0")]
    public void Contract_repairs_defaults_that_legacy_sqlite_migrations_can_drop(
        string table,
        string column,
        string expectedDefault)
    {
        var expected = Assert.Single(Contract.Columns,
            value => value.Table == table && value.Column == column);

        Assert.Equal(expectedDefault, expected.DefaultSql);
        Assert.Contains(
            $"ALTER TABLE \"{table}\" ALTER COLUMN \"{column}\" SET DEFAULT {expectedDefault};",
            Contract.DefaultRepairSql);
    }

    [Fact]
    public void Contract_records_required_columns_and_nullability()
    {
        var sourceFolder = Assert.Single(Contract.Columns,
            value => value.Table == "sender_filing_rules" && value.Column == "source_folder_id");
        var totalItems = Assert.Single(Contract.Columns,
            value => value.Table == "gmail_connections" && value.Column == "total_items");

        Assert.False(sourceFolder.NotNull);
        Assert.False(totalItems.NotNull);
    }

    [Fact]
    public void Legacy_todos_are_owned_before_enforcing_the_schema_contract()
    {
        Assert.Contains("WHERE owner_user_id IS NULL", DatabaseInitializer.LegacyOwnershipRepairSql);
        Assert.Contains(
            "ALTER TABLE todos ALTER COLUMN owner_user_id SET NOT NULL;",
            DatabaseInitializer.LegacyOwnershipRepairSql);
    }
}
