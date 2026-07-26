using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ImportJobRepositoryTests
{
    [Fact]
    public void FileImportWorkerCannotClaimGmailSyncJobs()
    {
        Assert.Contains(
            "source_type <> 'gmail'",
            ImportJobRepository.ClaimNextSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void FinalizingAnImportDoesNotRunOnNpgsqlsDefaultCommandTimeout()
    {
        // Completion recounts every message, folder and attachment in the archive. On Npgsql's
        // 30 second default those counts time out on a large archive, and the importer reports a
        // job that committed every single message as failed.
        Assert.True(
            ImportJobRepository.FinalizeCommandTimeoutSeconds >= 300,
            "Import finalization counts need a ceiling well above the 30s default.");
    }

    [Fact]
    public void DeferredAttachmentRefCountsAreIndexed()
    {
        // AttachmentMaterializer recounts a blob's references once per attachment it stores.
        // Unindexed, that recount is a sequential scan of the whole attachments table, and the
        // backlog released when an import completes degrades quadratically from there.
        Assert.Contains(
            "CREATE INDEX IF NOT EXISTS attachments_blob_idx ON attachments(blob_sha256);",
            DatabaseInitializer.CoreSchemaSql,
            StringComparison.Ordinal);
    }
}
