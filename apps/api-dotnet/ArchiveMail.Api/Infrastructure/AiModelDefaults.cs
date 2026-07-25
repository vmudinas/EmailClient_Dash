namespace ArchiveMail.Api.Infrastructure;

/// <summary>
/// Default model names per AI provider, in one place so a provider renaming a model does not leave
/// stale literals scattered through the settings code.
///
/// Providers do retire model names, and when they do every request fails with an HTTP 400 rather than
/// degrading — so a retired name is mapped forward to the current default instead of being sent and
/// failing on every job.
/// </summary>
public static class AiModelDefaults
{
    public const string OpenAi = "gpt-5-mini";

    /// <summary>
    /// DeepSeek's high-volume model. Chosen as the default because the main workload is message
    /// classification; use the pro model where answer quality matters more than cost.
    /// </summary>
    public const string DeepSeek = "deepseek-v4-flash";

    /// <summary>
    /// Model names DeepSeek no longer accepts. "deepseek-chat" was retired in favour of the v4 names
    /// and now returns: "The supported API model names are deepseek-v4-pro or deepseek-v4-flash".
    /// </summary>
    private static readonly IReadOnlySet<string> RetiredDeepSeekModels =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "deepseek-chat" };

    /// <summary>
    /// Returns a DeepSeek model name that the provider still accepts. A blank or retired name becomes
    /// the current default; anything else is passed through untouched so a deliberately configured
    /// model (including a newer one this build has never heard of) is never overridden.
    /// </summary>
    public static string NormalizeDeepSeekModel(string? model)
    {
        var value = model?.Trim();
        if (string.IsNullOrEmpty(value)) return DeepSeek;
        return RetiredDeepSeekModels.Contains(value) ? DeepSeek : value;
    }

    /// <summary>True when the stored name is one the provider has retired.</summary>
    public static bool IsRetiredDeepSeekModel(string? model) =>
        model?.Trim() is { Length: > 0 } value && RetiredDeepSeekModels.Contains(value);
}
