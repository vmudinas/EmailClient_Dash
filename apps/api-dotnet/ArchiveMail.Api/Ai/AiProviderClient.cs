using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace ArchiveMail.Api.Ai;

internal static class AiProviderClient
{
    internal static async Task<JsonElement> AnalyzeAsync(
        HttpClient client,
        string provider,
        string model,
        string apiKey,
        string content,
        CancellationToken token)
    {
        var body = await SendAsync(client, provider, apiKey, new
        {
            model,
            messages = new[]
            {
                new
                {
                    role = "system",
                    content = "Analyze the email. Return only JSON with summary, categories, priority, actionRequired, actionSummary, spamProbability, phishingProbability, draftRecommended, confidence, signals."
                },
                new { role = "user", content = content[..Math.Min(content.Length, 50_000)] }
            },
            response_format = new { type = "json_object" }
        }, token);
        using var envelope = JsonDocument.Parse(body);
        var output = envelope.RootElement.GetProperty("choices")[0]
            .GetProperty("message").GetProperty("content").GetString() ?? "{}";
        using var parsed = JsonDocument.Parse(output);
        return parsed.RootElement.Clone();
    }

    internal static async Task<string> DraftReplyAsync(
        HttpClient client,
        string provider,
        string model,
        string apiKey,
        string content,
        CancellationToken token)
    {
        var body = await SendAsync(client, provider, apiKey, new
        {
            model,
            messages = new[]
            {
                new
                {
                    role = "system",
                    content = "Draft a concise, professional plain-text email reply. Do not invent facts. Return only the reply body."
                },
                new { role = "user", content = content[..Math.Min(content.Length, 50_000)] }
            }
        }, token);
        using var envelope = JsonDocument.Parse(body);
        return envelope.RootElement.GetProperty("choices")[0]
            .GetProperty("message").GetProperty("content").GetString() ?? "";
    }

    private static async Task<string> SendAsync(
        HttpClient client,
        string provider,
        string apiKey,
        object payload,
        CancellationToken token)
    {
        var endpoint = provider == "deepseek"
            ? "https://api.deepseek.com/chat/completions"
            : "https://api.openai.com/v1/chat/completions";
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        request.Content = JsonContent.Create(payload);
        using var response = await client.SendAsync(request, token);
        var body = await response.Content.ReadAsStringAsync(token);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(
                $"AI provider returned {(int)response.StatusCode}: {body[..Math.Min(body.Length, 500)]}");
        return body;
    }
}
