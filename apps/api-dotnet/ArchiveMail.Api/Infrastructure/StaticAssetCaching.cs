using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.FileProviders;

namespace ArchiveMail.Api.Infrastructure;

/// <summary>
/// Cache headers for the built React app.
///
/// Vite emits content-hashed filenames (index-iNCkCC9h.js), so a given asset URL can never
/// change contents: a rebuild produces a new name. Those are safe to cache permanently, which
/// removes a revalidation round trip per asset on every page load. That matters most on a
/// contended NAS, which is exactly when the app feels slowest.
///
/// index.html is the opposite case. It is the document that names the hashed assets, so
/// caching it would pin a browser to an old deployment indefinitely. It must always be
/// revalidated.
/// </summary>
public static class StaticAssetCaching
{
    /// <summary>One year, the maximum age HTTP caches are expected to honour.</summary>
    internal const int ImmutableMaxAgeSeconds = 31_536_000;

    internal const string ImmutableCacheControl = "public,max-age=31536000,immutable";
    internal const string RevalidateCacheControl = "no-cache,no-store,must-revalidate";

    /// <summary>
    /// True for files whose URL is content-addressed and may be cached forever. Vite writes
    /// these into /assets, so the directory is the signal rather than a filename pattern that
    /// would have to track Vite's hash format.
    /// </summary>
    internal static bool IsImmutableAsset(PathString path) =>
        path.StartsWithSegments("/assets") && !IsDocument(path);

    /// <summary>
    /// True for the entry document. Serving a stale one strands the browser on assets that
    /// may no longer exist, which looks like a broken deploy rather than a caching choice.
    /// </summary>
    internal static bool IsDocument(PathString path) =>
        !path.HasValue
        || path.Value!.EndsWith('/')
        || path.Value.EndsWith(".html", StringComparison.OrdinalIgnoreCase);

    internal static string ResolveCacheControl(PathString path) =>
        IsImmutableAsset(path) ? ImmutableCacheControl : RevalidateCacheControl;

    public static void ApplyCacheHeaders(StaticFileResponseContext context)
    {
        var headers = context.Context.Response.GetTypedHeaders();
        var path = context.Context.Request.Path;
        context.Context.Response.Headers.CacheControl = ResolveCacheControl(path);
        if (!IsImmutableAsset(path))
        {
            // Belt and braces: some proxies fall back to Expires when they do not understand
            // a Cache-Control directive, and Synology sits in front of this app.
            headers.Expires = DateTimeOffset.UnixEpoch;
        }
    }

    public static StaticFileOptions Options() => new() { OnPrepareResponse = ApplyCacheHeaders };

    public static StaticFileOptions Options(IFileProvider fileProvider) =>
        new() { FileProvider = fileProvider, OnPrepareResponse = ApplyCacheHeaders };
}
