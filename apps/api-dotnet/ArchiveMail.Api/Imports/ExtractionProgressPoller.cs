namespace ArchiveMail.Api.Imports;

/// <summary>
/// Periodically samples "bytes read so far" for a running extraction process and reports it
/// through a callback. Kept separate from <see cref="PstStager"/> so the timing, capping, and
/// callback-invocation logic can be unit tested with a fake reader instead of a real child
/// process and a real Linux /proc filesystem.
/// </summary>
internal static class ExtractionProgressPoller
{
    public static readonly TimeSpan DefaultInterval = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Repeatedly waits <paramref name="interval"/>, reads the current byte count via
    /// <paramref name="readBytesRead"/>, and invokes <paramref name="onBytesRead"/> with the
    /// result (clamped to <paramref name="cap"/> when supplied). Returns cleanly - without
    /// throwing - as soon as <paramref name="cancellationToken"/> is cancelled. A failing or
    /// null-returning read simply skips that tick; it never terminates the loop or propagates.
    /// </summary>
    public static async Task RunAsync(
        int processId,
        Func<int, long?> readBytesRead,
        Action<long> onBytesRead,
        long? cap,
        TimeSpan interval,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(interval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (cancellationToken.IsCancellationRequested) return;

            long? bytesRead;
            try
            {
                bytesRead = readBytesRead(processId);
            }
            catch
            {
                // Defensive: an injected or platform reader must never take the loop down.
                bytesRead = null;
            }

            if (bytesRead is not { } value) continue;
            onBytesRead(cap.HasValue ? Math.Min(value, cap.Value) : value);
        }
    }
}
