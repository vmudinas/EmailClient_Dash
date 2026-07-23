using System.Net;
using System.Text;
using System.Text.Json;
using ArchiveMail.Api.Endpoints;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class TickerProviderTests
{
    [Fact]
    public async Task ParsesMockYahooQuoteAndCalculatesChange()
    {
        using var client = new HttpClient(new StaticHandler(
            HttpStatusCode.OK,
            """
            {"chart":{"result":[{"meta":{
              "regularMarketPrice":105.0,
              "chartPreviousClose":100.0,
              "regularMarketTime":1784808000,
              "longName":"Example Corp",
              "currency":"USD",
              "marketState":"REGULAR"
            }}]}}
            """,
            "application/json"));

        var result = JsonSerializer.SerializeToElement(
            await TickerEndpoints.QuoteAsync("TEST", client, CancellationToken.None));

        Assert.Equal(105, result.GetProperty("price").GetDouble());
        Assert.Equal(5, result.GetProperty("change").GetDouble());
        Assert.Equal(5, result.GetProperty("changePercent").GetDouble());
        Assert.Equal(JsonValueKind.Null, result.GetProperty("error").ValueKind);
    }

    [Fact]
    public async Task ParsesMockRssAndDropsIncompleteItems()
    {
        using var client = new HttpClient(new StaticHandler(
            HttpStatusCode.OK,
            """
            <rss><channel>
              <item><title>Valid headline</title><link>https://example.test/story</link><pubDate>Thu, 23 Jul 2026 12:00:00 GMT</pubDate></item>
              <item><title>Missing link</title></item>
            </channel></rss>
            """,
            "application/rss+xml"));

        var result = await TickerEndpoints.HeadlinesAsync(
            "test",
            ("Test News", "https://example.test/rss"),
            client,
            CancellationToken.None);

        var headline = Assert.Single(result);
        Assert.Equal("Valid headline", headline.Title);
        Assert.Equal("https://example.test/story", headline.Link);
    }

    [Fact]
    public async Task InvalidProviderPayloadReturnsAStableFallback()
    {
        using var client = new HttpClient(new StaticHandler(
            HttpStatusCode.OK,
            "not-json",
            "application/json"));

        var result = JsonSerializer.SerializeToElement(
            await TickerEndpoints.QuoteAsync("TEST", client, CancellationToken.None));

        Assert.Equal(JsonValueKind.Null, result.GetProperty("price").ValueKind);
        Assert.Equal(JsonValueKind.String, result.GetProperty("error").ValueKind);
    }

    private sealed class StaticHandler(
        HttpStatusCode status,
        string body,
        string contentType) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(body, Encoding.UTF8, contentType)
            });
    }
}
