using System.Net.Http.Headers;
using System.Net.Http.Json;
using ArchiveMail.Api.Infrastructure;

namespace ArchiveMail.Api.Learning;

/// <summary>
/// Reads a Lithuanian word aloud on the server, once, so the audio can be cached and replayed.
///
/// The browser's own speech only speaks Lithuanian when the device happens to have a Lithuanian
/// voice installed; without one it reads the word with an English voice, which teaches the wrong
/// sounds. Generating here fixes that for every device at once, and gives the learner one stable
/// reference sound rather than a different voice per device.
///
/// Best effort, like the hints: no key or a bad reply costs the recording, never the word.
/// </summary>
public sealed class LithuanianSpeechService(
    AppSettingsService settings,
    IHttpClientFactory clients,
    ILogger<LithuanianSpeechService> logger)
{
    /// <summary>The spoken audio, or null when it could not be produced.</summary>
    public async Task<byte[]?> GenerateAsync(string lithuanian, CancellationToken token)
    {
        var text = lithuanian.Trim();
        if (text.Length == 0 || text.Length > LithuanianDefaults.MaxPhraseLength) return null;

        var configured = settings.Current().LithuanianValue;
        if (configured.ApiKey.Length == 0) return null;

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, LithuanianDefaults.SpeechEndpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configured.ApiKey);
            request.Content = JsonContent.Create(new
            {
                model = configured.SpeechModel,
                voice = configured.SpeechVoice,
                input = text,
                // Said as a Lithuanian speaker would, not as an English speaker reading the
                // letters, and slowly enough for a learner to copy.
                instructions = "Speak in Lithuanian, clearly and slowly, as a native Lithuanian speaker would.",
                response_format = "mp3"
            });

            using var response = await clients.CreateClient("ai").SendAsync(request, token);
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(token);
                logger.LogWarning(
                    "Lithuanian speech failed with {Status}: {Body}",
                    (int)response.StatusCode,
                    body[..Math.Min(body.Length, 500)]);
                return null;
            }

            var audio = await response.Content.ReadAsByteArrayAsync(token);
            // An empty or absurd body is treated as no audio rather than written to disk.
            return audio.Length is > 0 and <= MaxSpeechBytes ? audio : null;
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            logger.LogWarning(error, "Lithuanian speech could not be generated");
            return null;
        }
    }

    /// <summary>A spoken word is seconds long; anything larger is a wrong answer, not audio.</summary>
    internal const int MaxSpeechBytes = 4 * 1024 * 1024;
}
