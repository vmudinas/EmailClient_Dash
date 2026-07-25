namespace ArchiveMail.Api.Infrastructure;

public static class LithuanianDefaults
{
    /// <summary>
    /// OpenAI's speech-to-text model. gpt-4o-transcribe has a materially lower word error rate on
    /// lower-resource languages than whisper-1, which matters for Lithuanian. Overridable from
    /// Admin settings so a model change does not need a deploy.
    /// </summary>
    public const string TranscriptionModel = "gpt-4o-transcribe";

    public const string TranscriptionEndpoint = "https://api.openai.com/v1/audio/transcriptions";

    /// <summary>ISO-639-1 hint. Supplying it improves both accuracy and latency.</summary>
    public const string Language = "lt";

    /// <summary>Environment override, checked ahead of the saved key like the other providers.</summary>
    public const string ApiKeyVariable = "LITHUANIAN_OPENAI_API_KEY";
}
