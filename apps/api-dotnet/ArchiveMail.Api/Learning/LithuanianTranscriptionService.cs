using System.Net.Http.Headers;
using System.Text.Json;
using ArchiveMail.Api.Infrastructure;

namespace ArchiveMail.Api.Learning;

/// <summary>
/// Transcribes a practice recording with OpenAI's speech-to-text API so the attempt can be
/// scored on the server rather than trusting whatever the browser managed to recognise.
///
/// This sends the learner's audio to OpenAI. It only runs when an administrator has configured
/// a key for the trainer specifically -- the mail AI provider keys are deliberately not reused,
/// so this transfer is a separate, revocable decision.
/// </summary>
public sealed class LithuanianTranscriptionService(
    AppSettingsService settings,
    IHttpClientFactory clients,
    ILogger<LithuanianTranscriptionService> logger)
{
    public bool Configured => settings.Current().LithuanianValue.ApiKey.Length > 0;

    /// <summary>
    /// Returns what the recording sounded like, or null when transcription is not configured or
    /// did not succeed. A null is not an error the learner should see: the take is still saved
    /// with its date, just without a score.
    /// </summary>
    public async Task<string?> TranscribeAsync(
        string path,
        string contentType,
        CancellationToken cancellationToken)
    {
        var configured = settings.Current().LithuanianValue;
        if (configured.ApiKey.Length == 0) return null;

        try
        {
            using var content = new MultipartFormDataContent();
            await using var audio = File.OpenRead(path);
            using var file = new StreamContent(audio);
            file.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            content.Add(file, "file", Path.GetFileName(path));
            content.Add(new StringContent(configured.Model), "model");
            // An ISO-639-1 hint improves both accuracy and latency, and stops a mumbled Lithuanian
            // word being transcribed as though it were English.
            content.Add(new StringContent(LithuanianDefaults.Language), "language");
            content.Add(new StringContent("json"), "response_format");
            // Deliberately no prompt: passing the expected word would bias the recogniser toward
            // returning it and inflate every score.

            using var request = new HttpRequestMessage(HttpMethod.Post, LithuanianDefaults.TranscriptionEndpoint)
            {
                Content = content
            };
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configured.ApiKey);

            using var response = await clients.CreateClient("ai").SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                // The body can name a retired model or an invalid key, which is worth an operator
                // seeing. It never contains the key itself.
                logger.LogWarning(
                    "Lithuanian transcription failed with {Status}: {Body}",
                    (int)response.StatusCode,
                    Truncate(body));
                return null;
            }

            using var parsed = JsonDocument.Parse(body);
            return parsed.RootElement.TryGetProperty("text", out var text) && text.ValueKind == JsonValueKind.String
                ? text.GetString()
                : null;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            logger.LogWarning(error, "Lithuanian transcription could not be completed");
            return null;
        }
    }

    private static string Truncate(string value) => value.Length <= 500 ? value : value[..500];
}
