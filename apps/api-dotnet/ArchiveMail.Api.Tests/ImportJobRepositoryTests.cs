using ArchiveMail.Api.Imports;
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
}
