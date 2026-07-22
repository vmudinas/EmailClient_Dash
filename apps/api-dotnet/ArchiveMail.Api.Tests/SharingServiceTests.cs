using ArchiveMail.Api.Endpoints;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class SharingServiceTests
{
    [Fact]
    public void IssuesValidTokenizedUrlAndExpiresItAfterEightHours()
    {
        var now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);
        var service = new SharingService(() => now);
        var context = Context();

        var state = service.Set(true, context);

        Assert.True(state.Enabled);
        Assert.NotNull(state.Url);
        var token = new Uri(state.Url).Query.TrimStart('?').Split('=', 2)[1];
        token = Uri.UnescapeDataString(token);
        Assert.True(service.TryValidate(token, out var expiresAt));
        Assert.Equal(now.AddHours(8), expiresAt);
        Assert.False(service.TryValidate(token + "changed", out _));

        now = now.AddHours(8).AddSeconds(1);
        Assert.False(service.TryValidate(token, out _));
        Assert.False(service.State(context).Enabled);
    }

    [Fact]
    public void DisablingSharingInvalidatesTheCurrentToken()
    {
        var service = new SharingService();
        var context = Context();
        var token = Uri.UnescapeDataString(new Uri(service.Set(true, context).Url!).Query.Split('=', 2)[1]);

        var disabled = service.Set(false, context);

        Assert.False(disabled.Enabled);
        Assert.Null(disabled.Url);
        Assert.False(service.TryValidate(token, out _));
    }

    private static DefaultHttpContext Context()
    {
        var context = new DefaultHttpContext();
        context.Request.Scheme = "https";
        context.Request.Host = new HostString("mail.example.com");
        return context;
    }
}
