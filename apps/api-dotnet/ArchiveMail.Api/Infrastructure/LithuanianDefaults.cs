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

    /// <summary>
    /// Writes the per-word breakdown for a phrase. A small chat model is enough: the task is a
    /// dictionary gloss plus a short pronunciation note, not reasoning.
    /// </summary>
    public const string HintModel = AiModelDefaults.OpenAi;

    /// <summary>
    /// Turns the English the learner typed into the Lithuanian he practises. Shares the hint
    /// model's tier for the same reason -- this is dictionary work, not reasoning -- but is
    /// configurable on its own, because a wrong translation is worse than a wrong hint: it becomes
    /// the recorded target.
    /// </summary>
    public const string TranslationModel = AiModelDefaults.OpenAi;

    public const string ChatEndpoint = "https://api.openai.com/v1/chat/completions";

    /// <summary>
    /// Percentage a take must reach to pass. Adjustable per installation, because how strict this
    /// should be depends on the learner -- an eight-year-old's first weeks are not the same bar as
    /// a fluent speaker polishing an accent.
    /// </summary>
    public const int PassMark = 85;

    public const int MinimumPassMark = 50;
    public const int MaximumPassMark = 100;

    /// <summary>Longest phrase accepted, in characters and in words.</summary>
    public const int MaxPhraseLength = 200;
    public const int MaxPhraseWords = 12;
    public const int MaxWordLength = 64;
}
