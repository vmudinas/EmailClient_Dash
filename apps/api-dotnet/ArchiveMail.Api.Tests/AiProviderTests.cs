using System.Net;
using System.Text;
using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Endpoints;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class AiProviderTests
{
    [Fact]
    public void ExtractsProviderErrorWithoutReturningTheWholeResponse()
    {
        var result = DatabaseSettingsEndpoints.ProviderError(
            """{"error":{"message":"The selected model is unavailable","type":"invalid_request_error"}}""");

        Assert.Equal("The selected model is unavailable", result);
    }

    [Fact]
    public void BoundsPlainTextProviderErrors()
    {
        var result = DatabaseSettingsEndpoints.ProviderError(new string('x', 500));

        Assert.Equal(300, result.Length);
    }

    [Fact]
    public async Task SendsDeepSeekAnalysisAndParsesItsJsonMessage()
    {
        var handler = new RecordingHandler(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                """{"choices":[{"message":{"content":"{\"summary\":\"Mock summary\",\"confidence\":0.9}"}}]}""",
                Encoding.UTF8,
                "application/json")
        });

        var result = await AiProviderClient.AnalyzeAsync(
            new HttpClient(handler),
            "deepseek",
            "deepseek-v4-flash",
            "test-key",
            "Subject: Integration test",
            CancellationToken.None);

        Assert.Equal("Mock summary", result.GetProperty("summary").GetString());
        Assert.Equal("https://api.deepseek.com/chat/completions", handler.RequestUri);
        Assert.Equal("Bearer test-key", handler.Authorization);
        Assert.Contains("\"model\":\"deepseek-v4-flash\"", handler.RequestBody, StringComparison.Ordinal);
        Assert.Contains("\"response_format\":{\"type\":\"json_object\"}", handler.RequestBody, StringComparison.Ordinal);
    }

    [Fact]
    public async Task SurfacesBoundedProviderFailureFromMockTransport()
    {
        var handler = new RecordingHandler(new HttpResponseMessage(HttpStatusCode.TooManyRequests)
        {
            Content = new StringContent("""{"error":{"message":"rate limited"}}""")
        });

        var error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            AiProviderClient.DraftReplyAsync(
                new HttpClient(handler),
                "openai",
                "gpt-test",
                "test-key",
                "Hello",
                CancellationToken.None));

        Assert.Contains("AI provider returned 429", error.Message, StringComparison.Ordinal);
    }

    private sealed class RecordingHandler(HttpResponseMessage response) : HttpMessageHandler
    {
        internal string? RequestUri { get; private set; }
        internal string? Authorization { get; private set; }
        internal string RequestBody { get; private set; } = "";

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestUri = request.RequestUri?.ToString();
            Authorization = request.Headers.Authorization?.ToString();
            RequestBody = request.Content is null
                ? ""
                : await request.Content.ReadAsStringAsync(cancellationToken);
            return response;
        }
    }
}
