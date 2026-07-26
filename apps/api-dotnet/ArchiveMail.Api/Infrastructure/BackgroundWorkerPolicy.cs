namespace ArchiveMail.Api.Infrastructure;

/// <summary>
/// Eight background workers run beside the API - imports, combines, attachment materialization,
/// Gmail sync, AI, smart rules, deduplication and property automation. The host's default
/// <see cref="BackgroundServiceExceptionBehavior"/> is StopHost, so an exception escaping any one
/// of their <c>ExecuteAsync</c> methods stopped the entire application: the reverse proxy answered
/// 502 and the browser reported "Failed to fetch" until Docker restarted the container. A combine
/// is exactly when that is most likely - it keeps the database saturated for as long as it runs, so
/// a claim query in some unrelated worker times out - and least excusable, because the merge is
/// making progress and only the API disappeared.
///
/// Each worker does guard its own loop, but that is a promise every future worker has to remember
/// to keep, and one was already missed. This makes a crashed worker cost only that worker.
/// </summary>
public static class BackgroundWorkerPolicy
{
    public static IServiceCollection AddResilientBackgroundWorkers(this IServiceCollection services) =>
        services.Configure<HostOptions>(options =>
            options.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore);
}
