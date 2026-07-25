using ArchiveMail.Api.Infrastructure;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class StaticAssetCachingTests
{
    [Theory]
    [InlineData("/assets/index-iNCkCC9h.js")]
    [InlineData("/assets/index-4Kd91js2.css")]
    [InlineData("/assets/logo-ab12cd34.svg")]
    public void ContentHashedBundlesAreCachedPermanently(string path)
    {
        // The filename contains the content hash, so this URL can never change contents and
        // revalidating it is a wasted round trip on every page load.
        Assert.Equal(StaticAssetCaching.ImmutableCacheControl, StaticAssetCaching.ResolveCacheControl(path));
        Assert.True(StaticAssetCaching.IsImmutableAsset(path));
    }

    [Theory]
    [InlineData("/")]
    [InlineData("/index.html")]
    [InlineData("/mail")]
    [InlineData("/assets/index.html")]
    public void DocumentsAndRoutesAlwaysRevalidate(string path)
    {
        // index.html names the hashed bundles. Caching it would pin a browser to a previous
        // deployment, which looks like a broken deploy rather than a caching decision.
        Assert.Equal(StaticAssetCaching.RevalidateCacheControl, StaticAssetCaching.ResolveCacheControl(path));
        Assert.False(StaticAssetCaching.IsImmutableAsset(path));
    }

    [Fact]
    public void AnHtmlFileUnderAssetsIsStillTreatedAsADocument()
    {
        // Guards the ordering inside IsImmutableAsset: living under /assets must not be enough
        // to make a document cacheable forever.
        Assert.True(StaticAssetCaching.IsDocument("/assets/index.html"));
        Assert.False(StaticAssetCaching.IsImmutableAsset("/assets/index.html"));
    }

    [Fact]
    public void TheImmutableDirectiveCarriesAMatchingMaxAge()
    {
        Assert.Contains($"max-age={StaticAssetCaching.ImmutableMaxAgeSeconds}", StaticAssetCaching.ImmutableCacheControl, StringComparison.Ordinal);
        Assert.Contains("immutable", StaticAssetCaching.ImmutableCacheControl, StringComparison.Ordinal);
        Assert.Contains("public", StaticAssetCaching.ImmutableCacheControl, StringComparison.Ordinal);
    }

    [Fact]
    public void TheRevalidateDirectiveActuallyPreventsReuse()
    {
        // "no-cache" alone still permits a stored response to be reused after validation, and
        // some intermediaries are lenient, so the directive is explicit on all three counts.
        Assert.Contains("no-cache", StaticAssetCaching.RevalidateCacheControl, StringComparison.Ordinal);
        Assert.Contains("no-store", StaticAssetCaching.RevalidateCacheControl, StringComparison.Ordinal);
        Assert.Contains("must-revalidate", StaticAssetCaching.RevalidateCacheControl, StringComparison.Ordinal);
    }

    [Fact]
    public void AnEmptyPathIsTreatedAsTheDocument()
    {
        Assert.True(StaticAssetCaching.IsDocument(new PathString()));
        Assert.Equal(StaticAssetCaching.RevalidateCacheControl, StaticAssetCaching.ResolveCacheControl(new PathString()));
    }
}
