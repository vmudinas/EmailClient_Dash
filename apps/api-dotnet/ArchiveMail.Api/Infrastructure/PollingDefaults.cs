namespace ArchiveMail.Api.Infrastructure;

/// <summary>
/// The catalog of periodic client refreshes the admin screen can see and control.
///
/// These loops run in every open browser tab, so their cost lands on the server whether or
/// not anyone is looking at the result. During a large import that matters: the import-jobs
/// loop alone polls roughly forty times a minute while a job is active, and the review queue
/// pulls a hundred message bodies out of TOAST storage on each pass. Being able to slow a
/// loop down, or stop it outright, is the difference between a sluggish app and a usable one.
/// </summary>
public sealed record PollingLoopDefinition(
    string Key,
    string Label,
    string Description,
    int IntervalMs,
    int? ActiveIntervalMs = null,
    string? ActiveLabel = null);

public static class PollingDefaults
{
    // A floor keeps an accidental "0.1s" from turning the admin screen into a denial of
    // service against the user's own NAS. The ceiling is an hour, which is already far
    // slower than any of these loops is useful at.
    public const int MinimumIntervalMs = 1_000;
    public const int MaximumIntervalMs = 3_600_000;

    public const string ImportJobs = "importJobs";
    public const string GmailConnections = "gmailConnections";
    public const string ReviewQueue = "reviewQueue";
    public const string StockQuotes = "stockQuotes";
    public const string NewsHeadlines = "newsHeadlines";

    public static readonly IReadOnlyList<PollingLoopDefinition> Catalog =
    [
        new(ImportJobs, "Import progress",
            "Refreshes import job progress. Polls far more often while an import is running.",
            IntervalMs: 15_000, ActiveIntervalMs: 1_500, ActiveLabel: "While importing"),
        new(GmailConnections, "Gmail sync status",
            "Refreshes Gmail connection status while the Gmail screen is open or a sync is running.",
            IntervalMs: 1_500),
        new(ReviewQueue, "AI review queue",
            "Loads pending AI analyses. The heaviest loop: it reads full message bodies, and it runs even when the review panel is closed.",
            IntervalMs: 30_000),
        new(StockQuotes, "Stock ticker", "Refreshes ticker quotes.", IntervalMs: 60_000),
        new(NewsHeadlines, "News headlines", "Refreshes the news ticker.", IntervalMs: 600_000)
    ];

    public static PollingLoopDefinition? Find(string key) =>
        Catalog.FirstOrDefault(entry => string.Equals(entry.Key, key, StringComparison.Ordinal));

    public static bool IsKnown(string key) => Find(key) is not null;

    public static int ClampInterval(int intervalMs) =>
        Math.Clamp(intervalMs, MinimumIntervalMs, MaximumIntervalMs);
}
