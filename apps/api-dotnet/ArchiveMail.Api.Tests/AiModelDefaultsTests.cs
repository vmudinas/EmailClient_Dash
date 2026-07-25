using ArchiveMail.Api.Infrastructure;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class AiModelDefaultsTests
{
    // Assembled at runtime so a blanket find-and-replace over test fixtures cannot silently turn the
    // retired name into a current one and leave these assertions vacuously passing.
    private const string Retired = "deepseek" + "-" + "chat";

    [Fact]
    public void The_retired_deepseek_model_is_mapped_forward_instead_of_failing_every_job()
    {
        // DeepSeek returns HTTP 400 for this name, so sending it fails 100% of AI jobs.
        Assert.True(AiModelDefaults.IsRetiredDeepSeekModel(Retired));
        Assert.Equal(AiModelDefaults.DeepSeek, AiModelDefaults.NormalizeDeepSeekModel(Retired));
    }

    [Fact]
    public void The_retired_name_is_matched_regardless_of_case_or_padding()
    {
        Assert.Equal(AiModelDefaults.DeepSeek, AiModelDefaults.NormalizeDeepSeekModel(Retired.ToUpperInvariant()));
        Assert.Equal(AiModelDefaults.DeepSeek, AiModelDefaults.NormalizeDeepSeekModel($"  {Retired}  "));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_model_falls_back_to_the_default(string? stored) =>
        Assert.Equal(AiModelDefaults.DeepSeek, AiModelDefaults.NormalizeDeepSeekModel(stored));

    [Theory]
    [InlineData("deepseek-v4-pro")]
    [InlineData("deepseek-v4-flash")]
    [InlineData("some-model-released-after-this-build")]
    public void A_deliberately_configured_model_is_never_overridden(string stored)
    {
        Assert.Equal(stored, AiModelDefaults.NormalizeDeepSeekModel(stored));
        Assert.False(AiModelDefaults.IsRetiredDeepSeekModel(stored));
    }

    [Fact]
    public void The_default_is_one_of_the_names_deepseek_currently_accepts() =>
        Assert.Contains(AiModelDefaults.DeepSeek, new[] { "deepseek-v4-pro", "deepseek-v4-flash" });

    [Fact]
    public void Settings_no_longer_carry_the_retired_name_as_a_default()
    {
        var settings = new AppRuntimeSettings().AiValue;
        Assert.Equal(AiModelDefaults.DeepSeek, settings.DeepSeek?.Model);
        Assert.Equal(AiModelDefaults.OpenAi, settings.OpenAi?.Model);
        Assert.NotEqual(Retired, settings.DeepSeek?.Model);
    }
}
