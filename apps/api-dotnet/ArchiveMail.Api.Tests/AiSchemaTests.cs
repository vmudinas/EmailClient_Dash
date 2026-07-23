using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class AiSchemaTests
{
    [Fact]
    public void ExistingCutoverSchemaGetsAiColumnsAndConflictIndexRepaired()
    {
        Assert.Contains(
            "ALTER TABLE ai_message_analysis ADD COLUMN IF NOT EXISTS thread_message_count BIGINT NOT NULL DEFAULT 1;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE ai_message_analysis ADD COLUMN IF NOT EXISTS related_context_json TEXT NOT NULL DEFAULT '[]';",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS schedule_id TEXT;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE ai_jobs ALTER COLUMN attempts SET DEFAULT 0;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE ai_jobs ALTER COLUMN max_attempts SET DEFAULT 2;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "DROP INDEX IF EXISTS ai_jobs_active_message_idx;",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "CREATE UNIQUE INDEX ai_jobs_active_message_idx ON ai_jobs(message_id, task)",
            DatabaseInitializer.ConnectedServicesSchemaSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void AiJobInsertDoesNotDependOnMigratedPostgresDefaults()
    {
        Assert.Contains(
            "content_hash,attempts,max_attempts,created_at,updated_at",
            ArchiveMail.Api.Ai.AiService.EnqueueSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "'pending',0,2,$9,$9",
            ArchiveMail.Api.Ai.AiService.EnqueueSql,
            StringComparison.Ordinal);
    }
}
