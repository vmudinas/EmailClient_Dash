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
        Assert.Contains("app_data_migrations", Contract.Tables);
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

    [Fact]
    public void LegacyAppleCalendarsAreAssignedToOneOwnerBeforeOwnershipBecomesRequired()
    {
        var owner = Assert.Single(Contract.Columns,
            value => value.Table == "calendar_accounts" && value.Column == "owner_user_id");

        Assert.True(owner.NotNull);
        Assert.Contains(
            "lower(gmail.email) = lower(account.username)",
            DatabaseInitializer.LegacyOwnershipRepairSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE calendar_accounts ALTER COLUMN owner_user_id SET NOT NULL;",
            DatabaseInitializer.LegacyOwnershipRepairSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "calendar_accounts_owner_idx ON calendar_accounts(owner_user_id",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void CareerBackfillIsDurablyMarkedAndRunsInBoundedHighConfidenceBatches()
    {
        Assert.Equal(2_000, DatabaseInitializer.CareerCategoryBackfillBatchSize);
        Assert.Contains("app_data_migrations", DatabaseInitializer.CareerCategoryMigrationAppliedSql, StringComparison.Ordinal);
        Assert.Contains("app_data_migrations", DatabaseInitializer.CareerCategoryMigrationRecordSql, StringComparison.Ordinal);
        Assert.Contains("pg_advisory_xact_lock", DatabaseInitializer.CareerCategoryMigrationLockSql, StringComparison.Ordinal);

        var sql = DatabaseInitializer.CareerCategoryBackfillSql;
        Assert.Contains("lower(trim(folder.name)) = 'inbox'", sql, StringComparison.Ordinal);
        Assert.Contains("LIMIT $1", sql, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE OF message SKIP LOCKED", sql, StringComparison.Ordinal);
        Assert.Contains("message.inbox_category IN ('primary', 'updates', 'promotions', 'social')", sql, StringComparison.Ordinal);
        Assert.Contains("'indeed.com'", sql, StringComparison.Ordinal);
        Assert.Contains("'greenhouse.io'", sql, StringComparison.Ordinal);
        Assert.Contains("application[[:space:]]+(received|status|update)", sql, StringComparison.Ordinal);
        Assert.Contains("interview[[:space:]]+(for|with|invitation|request|scheduled|availability|confirmation)", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("body_text", sql, StringComparison.Ordinal);
    }

    [Fact]
    public void CareerBackfillExplicitlyLeavesRepliesAndExistingImportantCategoriesAlone()
    {
        var sql = DatabaseInitializer.CareerCategoryBackfillSql;

        Assert.Contains("lower(message.subject) !~ '^[[:space:]]*(\\[[^]]+\\][[:space:]]*)*(re|fwd?):[[:space:]]*'", sql, StringComparison.Ordinal);
        Assert.Contains("message.headers_json !~* '\"(in-reply-to|references)\"[[:space:]]*:'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'bills'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'medical'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("'mail_tracking'", sql, StringComparison.Ordinal);
        Assert.DoesNotContain("inbox_category <> 'jobs'", sql, StringComparison.Ordinal);
        Assert.NotEmpty(DatabaseInitializer.CareerCategoryMigrationId);
    }

    [Fact]
    public void Legacy_messages_recover_conversation_keys_without_parsing_json()
    {
        Assert.Contains("WITH conversation_roots AS", DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
        Assert.Contains("substring(headers_json FROM '\"references\"", DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
        Assert.Contains("'archive:' || roots.archive_id || ':rfc822:'", DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
        Assert.DoesNotContain("headers_json::json", DatabaseInitializer.CoreSchemaSql, StringComparison.Ordinal);
    }
}
