using ArchiveMail.Api.Imports;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ExtractionProgressPollerTests
{
    private static readonly TimeSpan TinyInterval = TimeSpan.FromMilliseconds(1);

    [Fact]
    public async Task Invokes_the_callback_once_per_tick_with_whatever_the_reader_returns()
    {
        var readings = new Queue<long>([100, 250, 400]);
        var observed = new List<long>();
        using var cts = new CancellationTokenSource();

        await ExtractionProgressPoller.RunAsync(
            processId: 4242,
            readBytesRead: pid =>
            {
                Assert.Equal(4242, pid);
                var value = readings.Dequeue();
                if (readings.Count == 0) cts.Cancel();
                return value;
            },
            onBytesRead: observed.Add,
            cap: null,
            interval: TinyInterval,
            cancellationToken: cts.Token);

        Assert.Equal([100L, 250L, 400L], observed);
    }

    [Fact]
    public async Task Clamps_reported_bytes_to_the_supplied_cap()
    {
        var observed = new List<long>();
        using var cts = new CancellationTokenSource();
        var tick = 0;

        await ExtractionProgressPoller.RunAsync(
            processId: 1,
            readBytesRead: _ =>
            {
                tick++;
                if (tick >= 2) cts.Cancel();
                return 999_999L;
            },
            onBytesRead: observed.Add,
            cap: 1_000L,
            interval: TinyInterval,
            cancellationToken: cts.Token);

        Assert.All(observed, value => Assert.Equal(1_000L, value));
        Assert.NotEmpty(observed);
    }

    [Fact]
    public async Task A_null_reading_skips_the_tick_without_invoking_the_callback()
    {
        var observed = new List<long>();
        using var cts = new CancellationTokenSource();
        var tick = 0;

        await ExtractionProgressPoller.RunAsync(
            processId: 1,
            readBytesRead: _ =>
            {
                tick++;
                if (tick >= 3) cts.Cancel();
                return tick == 2 ? 42L : null;
            },
            onBytesRead: observed.Add,
            cap: null,
            interval: TinyInterval,
            cancellationToken: cts.Token);

        Assert.Equal([42L], observed);
    }

    [Fact]
    public async Task A_throwing_reader_skips_the_tick_instead_of_faulting_the_loop()
    {
        var observed = new List<long>();
        using var cts = new CancellationTokenSource();
        var tick = 0;

        await ExtractionProgressPoller.RunAsync(
            processId: 1,
            readBytesRead: _ =>
            {
                tick++;
                if (tick >= 3) cts.Cancel();
                if (tick == 1) throw new InvalidOperationException("process already exited");
                return 7L;
            },
            onBytesRead: observed.Add,
            cap: null,
            interval: TinyInterval,
            cancellationToken: cts.Token);

        Assert.Equal([7L, 7L], observed);
    }

    [Fact]
    public async Task Returns_promptly_without_invoking_the_callback_when_already_cancelled()
    {
        var observed = new List<long>();
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await ExtractionProgressPoller.RunAsync(
            processId: 1,
            readBytesRead: _ => 1L,
            onBytesRead: observed.Add,
            cap: null,
            interval: TimeSpan.FromSeconds(30),
            cancellationToken: cts.Token);

        Assert.Empty(observed);
    }

    [Fact]
    public void The_default_reader_returns_null_when_proc_io_is_unavailable()
    {
        // On this test host (a real /proc/{pid}/io is a Linux-only concept) or for a bogus pid,
        // the production reader must degrade to null rather than throw.
        Assert.Null(PstStager.ReadCumulativeBytesRead(int.MaxValue));
    }
}
