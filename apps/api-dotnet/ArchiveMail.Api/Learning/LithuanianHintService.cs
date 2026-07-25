using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using ArchiveMail.Api.Infrastructure;

namespace ArchiveMail.Api.Learning;

public sealed record LithuanianHint(string Word, string Meaning, string Tip);

/// <summary>
/// Breaks a Lithuanian phrase into its words and explains each one, so a phrase learned for
/// context does not arrive as an opaque block. Uses the trainer's own OpenAI key -- the same one
/// that pays for transcription -- and degrades to no hints rather than failing the save.
/// </summary>
public sealed class LithuanianHintService(
    AppSettingsService settings,
    IHttpClientFactory clients,
    ILogger<LithuanianHintService> logger)
{
    private const string Instruction = """
        You help a child learn Lithuanian. Given a Lithuanian phrase and its English meaning,
        break the phrase into its individual Lithuanian words in the order they appear.
        Return only JSON: {"hints":[{"word":"","meaning":"","tip":""}]}
        - word: the Lithuanian word exactly as it appears in the phrase.
        - meaning: its English meaning on its own, at most four words.
        - tip: one short, concrete pronunciation or grammar note a child can act on,
          at most twelve words. Plain language, no phonetic alphabets.
        Cover every word in the phrase. Add nothing that is not in the phrase.
        """;

    public async Task<IReadOnlyList<LithuanianHint>> GenerateAsync(
        string phrase,
        string english,
        CancellationToken token)
    {
        var configured = settings.Current().LithuanianValue;
        if (configured.ApiKey.Length == 0) return [];

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, LithuanianDefaults.ChatEndpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configured.ApiKey);
            request.Content = JsonContent.Create(new
            {
                model = configured.HintModel,
                messages = new[]
                {
                    new { role = "system", content = Instruction },
                    new { role = "user", content = $"Phrase: {phrase}\nMeaning: {english}" }
                },
                response_format = new { type = "json_object" }
            });

            using var response = await clients.CreateClient("ai").SendAsync(request, token);
            var body = await response.Content.ReadAsStringAsync(token);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning(
                    "Lithuanian hints failed with {Status}: {Body}",
                    (int)response.StatusCode,
                    body[..Math.Min(body.Length, 500)]);
                return [];
            }

            using var envelope = JsonDocument.Parse(body);
            var content = envelope.RootElement.GetProperty("choices")[0]
                .GetProperty("message").GetProperty("content").GetString();
            return Parse(content);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            logger.LogWarning(error, "Lithuanian hints could not be generated");
            return [];
        }
    }

    /// <summary>
    /// Reads the model's reply defensively: a malformed or padded response costs the hints, never
    /// the word the learner just added.
    /// </summary>
    internal static IReadOnlyList<LithuanianHint> Parse(string? content)
    {
        if (string.IsNullOrWhiteSpace(content)) return [];
        try
        {
            using var parsed = JsonDocument.Parse(content);
            if (!parsed.RootElement.TryGetProperty("hints", out var hints)
                || hints.ValueKind != JsonValueKind.Array) return [];
            var results = new List<LithuanianHint>();
            foreach (var entry in hints.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) continue;
                var word = Text(entry, "word", LithuanianDefaults.MaxWordLength);
                if (word.Length == 0) continue;
                results.Add(new LithuanianHint(word, Text(entry, "meaning", 80), Text(entry, "tip", 160)));
                if (results.Count >= LithuanianDefaults.MaxPhraseWords) break;
            }
            return results;
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static string Text(JsonElement entry, string name, int limit)
    {
        if (!entry.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String) return "";
        var text = value.GetString()?.Trim() ?? "";
        return text.Length > limit ? text[..limit] : text;
    }
}
