using System.Text.Json;
using System.Xml.Linq;
using ArchiveMail.Api.Infrastructure;

namespace ArchiveMail.Api.Endpoints;

public static class TickerEndpoints
{
    private static readonly IReadOnlyDictionary<string, (string Name, string Url)> Feeds =
        new Dictionary<string, (string, string)>
        {
            ["cnn"] = ("CNN", "http://rss.cnn.com/rss/edition.rss"),
            ["bbc"] = ("BBC News", "https://feeds.bbci.co.uk/news/rss.xml"),
            ["aljazeera"] = ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
            ["foxnews"] = ("Fox News", "https://moxie.foxnews.com/google-publisher/latest.xml")
        };

    public static IEndpointRouteBuilder MapTickerEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/stocks/display-settings", (AppSettingsService settings) =>
        {
            var value = settings.Current().StocksValue;
            return Results.Ok(new { symbols = value.Symbols ?? Array.Empty<string>(), value.SecondsPerSymbol });
        }).WithName("StockDisplaySettings").WithTags("Stocks");

        app.MapGet("/api/stocks/quotes", async (AppSettingsService settings, IHttpClientFactory clients, CancellationToken token) =>
        {
            var symbols = settings.Current().StocksValue.Symbols ?? Array.Empty<string>();
            var tasks = symbols.Select(symbol => QuoteAsync(symbol, clients.CreateClient("external"), token));
            return Results.Ok(await Task.WhenAll(tasks));
        }).WithName("StockQuotes").WithTags("Stocks");

        app.MapGet("/api/news/display-settings", (AppSettingsService settings) =>
        {
            var value = settings.Current().NewsValue;
            return Results.Ok(new { enabledSources = value.EnabledSources ?? Array.Empty<string>(), value.SecondsPerHeadline });
        }).WithName("NewsDisplaySettings").WithTags("News");

        app.MapGet("/api/news/headlines", async (AppSettingsService settings, IHttpClientFactory clients, CancellationToken token) =>
        {
            var enabled = settings.Current().NewsValue.EnabledSources ?? Array.Empty<string>();
            var tasks = enabled.Where(Feeds.ContainsKey).Select(id => HeadlinesAsync(id, Feeds[id], clients.CreateClient("external"), token));
            var items = (await Task.WhenAll(tasks)).SelectMany(value => value)
                .OrderByDescending(value => value.PublishedAt).Take(40).ToArray();
            return Results.Ok(items);
        }).WithName("NewsHeadlines").WithTags("News");
        return app;
    }

    internal static async Task<object> QuoteAsync(string symbol, HttpClient client, CancellationToken token)
    {
        var quotedAt = DateTimeOffset.UtcNow.ToString("O");
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"https://query1.finance.yahoo.com/v8/finance/chart/{Uri.EscapeDataString(symbol)}?interval=1d&range=1d");
            request.Headers.UserAgent.ParseAdd("ArchiveMail/1.0");
            using var response = await client.SendAsync(request, token);
            response.EnsureSuccessStatusCode();
            using var payload = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(token));
            var meta = payload.RootElement.GetProperty("chart").GetProperty("result")[0].GetProperty("meta");
            var price = Number(meta, "regularMarketPrice");
            var previous = Number(meta, "chartPreviousClose") ?? Number(meta, "previousClose");
            var change = price is not null && previous is not null ? price - previous : null;
            var time = Number(meta, "regularMarketTime");
            if (time is not null) quotedAt = DateTimeOffset.FromUnixTimeSeconds(Convert.ToInt64(time)).ToString("O");
            return new
            {
                symbol,
                name = Text(meta, "longName") ?? Text(meta, "shortName"),
                price,
                currency = Text(meta, "currency"),
                change,
                changePercent = previous is > 0 && change is not null ? change / previous * 100 : null,
                marketState = Text(meta, "marketState"),
                quotedAt,
                error = (string?)null
            };
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or KeyNotFoundException or TaskCanceledException)
        {
            return new { symbol, name = (string?)null, price = (double?)null, currency = (string?)null,
                change = (double?)null, changePercent = (double?)null, marketState = (string?)null, quotedAt, error = error.Message };
        }
    }

    internal static async Task<IReadOnlyList<Headline>> HeadlinesAsync(
        string id, (string Name, string Url) source, HttpClient client, CancellationToken token)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, source.Url);
            request.Headers.UserAgent.ParseAdd("ArchiveMail/1.0");
            using var response = await client.SendAsync(request, token);
            response.EnsureSuccessStatusCode();
            var document = XDocument.Load(await response.Content.ReadAsStreamAsync(token));
            return document.Descendants().Where(element => element.Name.LocalName == "item").Take(12)
                .Select(item =>
                {
                    var title = Child(item, "title") ?? "";
                    var link = Child(item, "link") ?? "";
                    var published = DateTimeOffset.TryParse(Child(item, "pubDate"), out var date) ? date.ToString("O") : null;
                    return new Headline(link, id, source.Name, title, link, published);
                }).Where(item => item.Title.Length > 0 && Uri.TryCreate(item.Link, UriKind.Absolute, out _)).ToArray();
        }
        catch (Exception error) when (error is HttpRequestException or System.Xml.XmlException or TaskCanceledException)
        {
            return Array.Empty<Headline>();
        }
    }

    private static string? Child(XElement element, string name) =>
        element.Elements().FirstOrDefault(child => child.Name.LocalName == name)?.Value.Trim();
    private static string? Text(JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;
    private static double? Number(JsonElement value, string name) =>
        value.TryGetProperty(name, out var item) && item.TryGetDouble(out var result) ? result : null;
    internal sealed record Headline(string Id, string SourceId, string SourceName, string Title, string Link, string? PublishedAt);
}
