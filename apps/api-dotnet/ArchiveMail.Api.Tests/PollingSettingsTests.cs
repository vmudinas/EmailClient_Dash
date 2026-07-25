using System.Text.Json;
using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class PollingDefaultsTests
{
    [Fact]
    public void CatalogCoversEveryLoopTheClientRegisters()
    {
        // The client mirrors these keys in lib/polling.ts. A key that exists on only one side
        // silently falls back to a built-in interval and can never be tuned from the admin UI.
        Assert.Equal(
            new[] { "gmailConnections", "importJobs", "newsHeadlines", "reviewQueue", "stockQuotes" },
            PollingDefaults.Catalog.Select(entry => entry.Key).OrderBy(key => key, StringComparer.Ordinal));
    }

    [Fact]
    public void EveryLoopHasAUsableDefaultInterval()
    {
        foreach (var definition in PollingDefaults.Catalog)
        {
            Assert.InRange(definition.IntervalMs, PollingDefaults.MinimumIntervalMs, PollingDefaults.MaximumIntervalMs);
            Assert.False(string.IsNullOrWhiteSpace(definition.Label));
            Assert.False(string.IsNullOrWhiteSpace(definition.Description));
        }
    }

    [Fact]
    public void OnlyTheImportLoopDeclaresABusyRate()
    {
        var withBusyRate = PollingDefaults.Catalog.Where(entry => entry.ActiveIntervalMs is not null).ToArray();
        var loop = Assert.Single(withBusyRate);
        Assert.Equal(PollingDefaults.ImportJobs, loop.Key);
        // The busy rate must actually be faster, or the flag means nothing.
        Assert.True(loop.ActiveIntervalMs < loop.IntervalMs);
        Assert.False(string.IsNullOrWhiteSpace(loop.ActiveLabel));
    }

    [Theory]
    [InlineData(0, PollingDefaults.MinimumIntervalMs)]
    [InlineData(-5_000, PollingDefaults.MinimumIntervalMs)]
    [InlineData(500, PollingDefaults.MinimumIntervalMs)]
    [InlineData(int.MaxValue, PollingDefaults.MaximumIntervalMs)]
    [InlineData(45_000, 45_000)]
    public void IntervalsAreClampedToASaneRange(int requested, int expected)
    {
        // A "0.1 second" typo in the admin screen must not become a denial of service against
        // the user's own server.
        Assert.Equal(expected, PollingDefaults.ClampInterval(requested));
    }

    [Fact]
    public void UnknownLoopsAreNotRecognised()
    {
        Assert.True(PollingDefaults.IsKnown(PollingDefaults.ReviewQueue));
        Assert.False(PollingDefaults.IsKnown("somethingElse"));
        Assert.Null(PollingDefaults.Find("somethingElse"));
    }
}

public sealed class PollingRuntimeSettingsTests
{
    [Fact]
    public void AnUnconfiguredLoopReportsEnabledWithNoOverrides()
    {
        var settings = new PollingRuntimeSettings();
        var loop = settings.For(PollingDefaults.ReviewQueue);
        Assert.True(loop.Enabled);
        Assert.Null(loop.IntervalMs);
        Assert.Null(loop.ActiveIntervalMs);
    }

    [Fact]
    public void ConfiguredOverridesAreReturned()
    {
        var settings = new PollingRuntimeSettings(new Dictionary<string, PollingLoopSettings>
        {
            [PollingDefaults.ReviewQueue] = new(Enabled: false, IntervalMs: 120_000)
        });
        var loop = settings.For(PollingDefaults.ReviewQueue);
        Assert.False(loop.Enabled);
        Assert.Equal(120_000, loop.IntervalMs);
        // A different loop is unaffected by another's override.
        Assert.True(settings.For(PollingDefaults.ImportJobs).Enabled);
    }

    [Fact]
    public void SettingsSurviveAJsonRoundTrip()
    {
        // These are persisted as JSON, so a dictionary that does not round-trip would silently
        // drop every override on the next restart.
        var original = new PollingRuntimeSettings(new Dictionary<string, PollingLoopSettings>
        {
            [PollingDefaults.ImportJobs] = new(Enabled: true, IntervalMs: 30_000, ActiveIntervalMs: 5_000)
        });
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var restored = JsonSerializer.Deserialize<PollingRuntimeSettings>(
            JsonSerializer.Serialize(original, options), options);

        Assert.NotNull(restored);
        var loop = restored!.For(PollingDefaults.ImportJobs);
        Assert.True(loop.Enabled);
        Assert.Equal(30_000, loop.IntervalMs);
        Assert.Equal(5_000, loop.ActiveIntervalMs);
    }
}
