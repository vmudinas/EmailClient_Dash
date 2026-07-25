using System.Text.Json;
using ArchiveMail.Api.Gmail;
using Xunit;

namespace ArchiveMail.Api.Tests;

/// <summary>
/// AccessTokenAsync runs on every Gmail operation, so a throw here repeats on every sync.
/// Reading expires_in with JsonElement.GetInt32() did exactly that whenever the token
/// endpoint returned the value quoted: "requires an element of type 'Number', but the
/// target element has type 'String'", looping in the logs.
/// </summary>
public sealed class GmailTokenExpiryTests
{
    private static JsonElement Body(string json) => JsonDocument.Parse(json).RootElement;

    [Fact]
    public void ReadsTheNumericFormTheSpecDescribes()
    {
        Assert.Equal(3599, GmailService.Seconds(Body("""{"expires_in":3599}"""), "expires_in", 3600));
    }

    [Fact]
    public void ReadsTheQuotedFormThatUsedToThrow()
    {
        // The regression: some token endpoints and proxies return expires_in as a string.
        Assert.Equal(3599, GmailService.Seconds(Body("""{"expires_in":"3599"}"""), "expires_in", 3600));
    }

    [Theory]
    [InlineData("""{}""")]
    [InlineData("""{"expires_in":null}""")]
    [InlineData("""{"expires_in":true}""")]
    [InlineData("""{"expires_in":"not-a-number"}""")]
    [InlineData("""{"expires_in":{"seconds":60}}""")]
    public void FallsBackInsteadOfThrowingOnAnythingUnusable(string json)
    {
        Assert.Equal(3600, GmailService.Seconds(Body(json), "expires_in", 3600));
    }

    [Theory]
    [InlineData("""{"expires_in":0}""")]
    [InlineData("""{"expires_in":-1}""")]
    [InlineData("""{"expires_in":"-5"}""")]
    public void TreatsANonPositiveLifetimeAsMissing(string json)
    {
        // A zero or negative lifetime marks the token already expired, so every call would
        // refresh again: the same runaway loop the exception caused, just without a throw.
        Assert.Equal(3600, GmailService.Seconds(Body(json), "expires_in", 3600));
    }

    [Fact]
    public void IgnoresANonObjectPayload()
    {
        Assert.Equal(3600, GmailService.Seconds(Body("""[1,2,3]"""), "expires_in", 3600));
    }
}
