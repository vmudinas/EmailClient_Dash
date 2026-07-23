using ArchiveMail.Api.Imports;
using Npgsql;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ImportBatchWriterTests
{
    [Fact]
    public void TreatsDatabaseReadTimeoutAsTransient()
    {
        var error = new NpgsqlException(
            "Exception while reading from stream",
            new TimeoutException("Timeout during reading attempt"));

        Assert.True(ImportBatchWriter.IsTransientDatabaseFailure(error));
    }
}
