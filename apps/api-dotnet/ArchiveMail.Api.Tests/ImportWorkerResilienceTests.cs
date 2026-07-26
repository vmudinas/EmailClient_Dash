using ArchiveMail.Api.Imports;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Npgsql;
using Xunit;

namespace ArchiveMail.Api.Tests;

/// <summary>
/// The host's default BackgroundServiceExceptionBehavior is StopHost, so an exception escaping
/// a worker's ExecuteAsync stops the entire application - the mail UI included. Both import
/// workers used to run their claim query outside the loop's try/catch, so one transient Npgsql
/// failure took the API down and the reverse proxy answered 502 until the container restarted.
/// Every other background service in this codebase already guards its whole loop body; these
/// pin the two that did not.
/// </summary>
public sealed class ImportWorkerResilienceTests
{
    /// <summary>Port 1 refuses immediately, which is the cheapest way to make every query throw.</summary>
    private const string UnreachableDatabase =
        "Host=127.0.0.1;Port=1;Username=nobody;Password=nobody;Database=nothing;Timeout=1;Pooling=false";

    private static IOptions<ImportOptions> EnabledOptions() =>
        Options.Create(new ImportOptions { Enabled = true, DataDirectory = Path.GetTempPath() });

    [Fact]
    public async Task Import_coordinator_survives_a_database_that_never_answers()
    {
        await using var database = NpgsqlDataSource.Create(UnreachableDatabase);
        var options = EnabledOptions();
        using var coordinator = new ImportCoordinator(
            new ImportJobRepository(database),
            new ImportBatchWriter(database, NullLogger<ImportBatchWriter>.Instance),
            new ArchiveStager(
                new PstStager(options, NullLogger<PstStager>.Instance),
                new MboxStager(options, NullLogger<MboxStager>.Instance)),
            options,
            NullLogger<ImportCoordinator>.Instance);

        await AssertStaysAliveAsync(coordinator);
    }

    [Fact]
    public async Task Attachment_materializer_survives_a_database_that_never_answers()
    {
        await using var database = NpgsqlDataSource.Create(UnreachableDatabase);
        using var materializer = new AttachmentMaterializer(
            database,
            EnabledOptions(),
            NullLogger<AttachmentMaterializer>.Instance);

        await AssertStaysAliveAsync(materializer);
    }

    /// <summary>
    /// Runs the worker long enough for its claim query to fail at least once, then asserts the
    /// hosted task is still running rather than faulted. A faulted task is what the host watches
    /// for before it calls StopApplication.
    /// </summary>
    private static async Task AssertStaysAliveAsync(BackgroundService worker)
    {
        await worker.StartAsync(CancellationToken.None);
        try
        {
            var execution = worker.ExecuteTask;
            Assert.NotNull(execution);

            // A worker that cannot survive the failure faults on its first iteration, and a
            // refused connection to port 1 takes microseconds - so this window is margin, not a
            // race. WhenAny returns the moment it faults, which keeps a red run fast.
            await Task.WhenAny(execution, Task.Delay(TimeSpan.FromSeconds(3)));

            Assert.False(
                execution.IsCompleted,
                "The worker stopped instead of retrying, which stops the whole host: "
                    + (execution.Exception?.ToString() ?? "it ran to completion"));
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None);
        }
    }
}
