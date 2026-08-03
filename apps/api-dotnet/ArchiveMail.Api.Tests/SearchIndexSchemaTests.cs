using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

/// <summary>
/// A GIN expression index recomputes its expression on every INSERT, so an unbounded
/// to_tsvector(...) over a message body let one oversized email fail an entire import
/// batch with Postgres 54000 ("string is too long for tsvector"). These guard the bound.
/// </summary>
public sealed class SearchIndexSchemaTests
{
    private const string Schema = DatabaseInitializer.CoreSchemaSql;

    [Fact]
    public void SchemaMigrationsDoNotRunOnNpgsqlsDefaultCommandTimeout()
    {
        // Replacing a GIN index rebuilds it over every existing row. On Npgsql's 30 second
        // default that throws out of startup and crash-loops the container before it can
        // serve, which is exactly how the first attempt at this fix took the app down.
        Assert.True(
            DatabaseInitializer.SchemaCommandTimeoutSeconds >= 300,
            "Schema DDL needs a ceiling well above the 30s default to survive an index rebuild.");
    }

    [Fact]
    public void SearchExcerptCapsInputWellUnderThePostgresTsvectorByteLimit()
    {
        Assert.Contains("CREATE OR REPLACE FUNCTION archive_mail_search_excerpt", Schema, StringComparison.Ordinal);

        // Postgres caps to_tsvector input at 1048575 bytes. left() counts characters, and
        // UTF-8 reaches 4 bytes per character, so the character bound has to leave a 4x
        // margin to be safe for non-ASCII mail.
        const int limit = 131072;
        Assert.Contains($"left(COALESCE(p_document, ''), {limit})", Schema, StringComparison.Ordinal);
        Assert.True(limit * 4 < 1_048_575, "The character bound must hold even at 4 bytes per character.");

        // The bound is repeated (the indexed functions inline left() on purpose), so every
        // occurrence has to agree or one index would admit more text than the others.
        var occurrences = Schema.Split($", {limit})").Length - 1;
        Assert.Equal(3, occurrences);
    }

    [Fact]
    public void IndexedFunctionsInlineTheBoundInsteadOfCallingTheHelper()
    {
        // An unqualified call inside an indexed function resolves through the executing
        // session's search_path. Keeping the indexed path self-contained avoids that.
        foreach (var function in new[] { "archive_mail_message_search", "archive_mail_attachment_search" })
        {
            var declaration = Schema.IndexOf(
                $"CREATE OR REPLACE FUNCTION {function}", StringComparison.Ordinal);
            var body = Schema[declaration..];
            var terminator = body.IndexOf("$archive_mail_search$;", StringComparison.Ordinal);
            Assert.DoesNotContain("archive_mail_search_excerpt", body[..terminator], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void SearchHelpersAreImmutableSoTheyCanBackAnExpressionIndex()
    {
        // Postgres only accepts IMMUTABLE functions in an index expression; a STABLE
        // helper would make the CREATE INDEX below fail outright at startup.
        foreach (var function in new[]
                 {
                     "archive_mail_search_excerpt",
                     "archive_mail_message_search",
                     "archive_mail_attachment_search"
                 })
        {
            var declaration = Schema.IndexOf(
                $"CREATE OR REPLACE FUNCTION {function}", StringComparison.Ordinal);
            Assert.True(declaration >= 0, $"{function} should be defined in the core schema.");

            var body = Schema[declaration..];
            var terminator = body.IndexOf("$archive_mail_search$;", StringComparison.Ordinal);
            Assert.True(terminator > 0, $"{function} should be dollar-quoted and terminated.");
            Assert.Contains("IMMUTABLE", body[..terminator], StringComparison.Ordinal);
        }
    }

    [Fact]
    public void BothSearchIndexesGoThroughTheBoundedHelpers()
    {
        Assert.Contains(
            "archive_mail_message_search(subject, sender_name, sender_address, recipients_text, body_text)",
            Schema,
            StringComparison.Ordinal);
        Assert.Contains("archive_mail_attachment_search(filename, extracted_text)", Schema, StringComparison.Ordinal);
    }

    [Fact]
    public void MailListIndexesMatchTheCoalescedActivitySortAndInboxCounts()
    {
        Assert.Contains("CREATE INDEX IF NOT EXISTS messages_archive_activity_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("CREATE INDEX IF NOT EXISTS messages_folder_activity_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("(COALESCE(received_at, sent_at, '')) DESC, created_at DESC, id DESC", Schema, StringComparison.Ordinal);
        Assert.Contains("DROP INDEX IF EXISTS messages_archive_category_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("DROP INDEX IF EXISTS messages_folder_category_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("CREATE INDEX IF NOT EXISTS messages_archive_category_activity_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("CREATE INDEX IF NOT EXISTS messages_folder_category_activity_idx", Schema, StringComparison.Ordinal);
        Assert.Contains("CREATE INDEX IF NOT EXISTS message_calendar_events_message_idx", Schema, StringComparison.Ordinal);
    }

    [Fact]
    public void ReviewFolderSuggestionsHaveACaseInsensitiveSenderIndex()
    {
        Assert.Contains(
            "CREATE INDEX IF NOT EXISTS messages_archive_sender_lower_folder_idx",
            Schema,
            StringComparison.Ordinal);
        Assert.Contains("archive_id, lower(sender_address), folder_id", Schema, StringComparison.Ordinal);
    }

    [Fact]
    public void LegacyUnboundedIndexesAreDroppedByName()
    {
        // The replacements use new names, so the old ones must be dropped explicitly.
        // Reusing the old names instead would either skip the fix (CREATE INDEX IF NOT
        // EXISTS sees the stale index) or rebuild a 600k-row GIN index on every boot.
        Assert.Contains("DROP INDEX IF EXISTS messages_postgres_search_idx;", Schema, StringComparison.Ordinal);
        Assert.Contains("DROP INDEX IF EXISTS attachments_postgres_search_idx;", Schema, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE INDEX IF NOT EXISTS messages_postgres_search_idx", Schema, StringComparison.Ordinal);
        Assert.DoesNotContain("CREATE INDEX IF NOT EXISTS attachments_postgres_search_idx", Schema, StringComparison.Ordinal);
    }

    [Fact]
    public void NoSearchExpressionBuildsATsvectorWithoutTheExcerptBound()
    {
        // Assembled at runtime so a future find-and-replace over the fixture can't quietly
        // make this vacuous.
        var unbounded = "to_" + "tsvector('simple', COALESCE(";
        Assert.DoesNotContain(unbounded, Schema, StringComparison.Ordinal);
    }
}
