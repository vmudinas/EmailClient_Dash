using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ImportJobRepositoryTests
{
    [Fact]
    public void FileImportWorkerClaimsOnlyArchiveFileJobs()
    {
        // This used to exclude 'gmail' by name. A denylist silently opts every source type added
        // later into the file importer, which combines cannot survive - their source_path is an
        // archive id, not a path on disk - so the claim is an allowlist now.
        Assert.Contains(
            "source_type IN ('pst', 'mbox')",
            ImportJobRepository.ClaimNextSql,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("gmail")]
    [InlineData(ImportJobRepository.CombineSourceType)]
    public void FileImportWorkerCannotClaimJobsItHasNoSourceFileFor(string sourceType)
    {
        Assert.DoesNotContain(sourceType, ImportJobRepository.ClaimNextSql, StringComparison.Ordinal);
    }

    [Fact]
    public void CombinesAreClaimedByTheirOwnWorker()
    {
        // The two claim queries have to partition the table between them: anything the importer
        // stops taking has to be picked up here, or a queued combine sits forever.
        Assert.Contains(
            $"source_type = '{ImportJobRepository.CombineSourceType}'",
            ArchiveCombineCoordinator.ClaimSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void ClearingACombineDoesNotDeleteTheArchiveThatSurvivedIt()
    {
        // A combine job's archive_id is the DESTINATION - the merged mail. Clearing it the way a
        // file import is cleared would delete exactly what the merge just produced.
        var sql = ImportJobRepository.ClearSqlFor(ImportJobRepository.CombineSourceType);

        Assert.DoesNotContain("DELETE FROM archives", sql, StringComparison.Ordinal);
        Assert.Contains("DELETE FROM import_jobs", sql, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("pst")]
    [InlineData("mbox")]
    public void ClearingAFileImportStillDiscardsTheArchiveItProduced(string sourceType)
    {
        Assert.Contains(
            "DELETE FROM archives",
            ImportJobRepository.ClearSqlFor(sourceType),
            StringComparison.Ordinal);
    }

    [Fact]
    public void ActiveCombinesAreMatchedByTheirSourceAsWellAsTheirDestination()
    {
        // An archive combine stores its destination in archive_id and its SOURCE in source_path.
        // Matching only archive_id let a second combine queue against a source already being
        // drained, and let a job be queued into an archive a running combine was about to delete
        // - which cascaded the queued job's own row away.
        Assert.Contains(
            "archive_id = ANY($1) OR source_path = ANY($1)",
            ImportJobRepository.ActiveCombineTouchingSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "status IN ('queued', 'running')",
            ImportJobRepository.ActiveCombineTouchingSql,
            StringComparison.Ordinal);
    }

    [Fact]
    public void FinishingACombineIsScopedToJobsStillRunning()
    {
        // Cancellation is a row update the merge only notices through a progress write throttled
        // to once a second. Finalization takes the status under FOR UPDATE in the same
        // transaction as the delete, and completion is scoped to 'running', so a cancel arriving
        // inside that window cannot lose the source archive and then be overwritten by
        // 'completed'.
        Assert.Contains("FOR UPDATE", ArchiveCombineService.LockJobStatusSql, StringComparison.Ordinal);
        Assert.Contains(
            "AND status = 'running'",
            ArchiveCombineCoordinator.CompleteSql,
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
