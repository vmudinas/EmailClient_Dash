using ArchiveMail.Api.Endpoints;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class GoogleOAuthRedirectTests
{
    [Fact]
    public void Resolve_AllowsHttpLoopbackForLocalDevelopment()
    {
        Assert.Equal(
            "http://127.0.0.1:3302/api/gmail/oauth/callback",
            GoogleOAuthRedirect.Resolve(null, "http", new HostString("127.0.0.1:3302")));
    }

    [Fact]
    public void Resolve_UsesConfiguredHttpsOrigin()
    {
        Assert.Equal(
            "https://mail.example.com/api/gmail/oauth/callback",
            GoogleOAuthRedirect.Resolve("https://mail.example.com/", "http", new HostString("synology.local:3001")));
    }

    [Theory]
    [InlineData(null, "http", "synology.local:3001")]
    [InlineData("https://synology.local:3001", "http", "localhost:3001")]
    [InlineData("https://192.168.1.20:3001", "http", "localhost:3001")]
    public void Resolve_RejectsCallbacksGoogleWillNotAccept(string? configuredUrl, string scheme, string host)
    {
        var error = Assert.Throws<InvalidOperationException>(() =>
            GoogleOAuthRedirect.Resolve(configuredUrl, scheme, new HostString(host)));

        Assert.Contains("HTTPS domain", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("/api/gmail/oauth/callback", error.Message, StringComparison.Ordinal);
    }
}
