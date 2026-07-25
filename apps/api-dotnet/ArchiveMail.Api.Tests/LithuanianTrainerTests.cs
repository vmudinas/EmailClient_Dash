using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Learning;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class LithuanianTrainerTests
{
    [Theory]
    [InlineData("labas", "labas")]
    [InlineData("  ačiū  ", "ačiū")]
    [InlineData("ąžuolas", "ąžuolas")]
    public void AcceptsASingleWordAndTrimsIt(string input, string expected)
    {
        Assert.Equal(expected, LithuanianRepository.ValidateWord(input, "Lithuanian"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("labas rytas")]
    [InlineData("labas\trytas")]
    public void RejectsEmptyAndMultiWordEntries(string? input)
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateWord(input, "Lithuanian"));
    }

    [Fact]
    public void RejectsAnOverlongWord()
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateWord(new string('a', 65), "English"));
    }

    [Theory]
    // MediaRecorder appends the codec as a parameter, which must not defeat the allowlist.
    [InlineData("audio/webm;codecs=opus", "audio/webm")]
    [InlineData("audio/mp4", "audio/mp4")]
    [InlineData("AUDIO/WAV", "audio/wav")]
    public void AcceptsTheAudioTypesBrowsersRecord(string input, string expected)
    {
        Assert.Equal(expected, LithuanianRepository.ValidateContentType(input));
    }

    [Theory]
    [InlineData("text/html")]
    [InlineData("application/octet-stream")]
    [InlineData("video/mp4")]
    [InlineData(null)]
    public void RejectsAnythingThatIsNotAudio(string? input)
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateContentType(input));
    }

    [Fact]
    public void RecordingsAreCappedSoOneUploadCannotFillTheDataDirectory()
    {
        Assert.InRange(LithuanianRepository.MaxRecordingBytes, 1_000_000L, 32L * 1024 * 1024);
    }

    [Fact]
    public void SchemaCreatesTheWordAndRecordingTables()
    {
        var schema = DatabaseInitializer.LearningSchemaSql;

        Assert.Contains("CREATE TABLE IF NOT EXISTS lithuanian_words", schema, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS lithuanian_recordings", schema, StringComparison.Ordinal);
        // A recording is worthless without the date it was made.
        Assert.Contains("recorded_at TEXT NOT NULL", schema, StringComparison.Ordinal);
        // Deleting the account or the word must not strand rows or files.
        Assert.Contains("REFERENCES lithuanian_words(id) ON DELETE CASCADE", schema, StringComparison.Ordinal);
        Assert.Contains("REFERENCES users(id) ON DELETE CASCADE", schema, StringComparison.Ordinal);
    }

    [Fact]
    public void SchemaRetiresTheEnglishRecordingColumnOnUpgrade()
    {
        // English is no longer recorded. A database created by the first cut of this feature still
        // has language NOT NULL, which would reject every insert after this change.
        Assert.Contains(
            "ALTER TABLE lithuanian_recordings DROP COLUMN IF EXISTS language;",
            DatabaseInitializer.LearningSchemaSql,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE lithuanian_recordings ADD COLUMN IF NOT EXISTS score BIGINT;",
            DatabaseInitializer.LearningSchemaSql,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("labas", "labas", 100)]
    [InlineData("  Labas  ", "labas", 100)]
    [InlineData("Labas!", "labas", 100)]
    // Recognizers are inconsistent about Lithuanian diacritics, and the learner is being judged
    // on the sounds produced rather than on the recognizer's spelling.
    [InlineData("aciu", "ačiū", 100)]
    [InlineData("ačiū", "aciu", 100)]
    [InlineData("labai", "labas", 80)]
    [InlineData("namas", "labas", 60)]
    [InlineData("sveiki", "labas", 0)]
    public void ScoresWhatWasHeardAgainstTheTargetWord(string heard, string target, int expected)
    {
        Assert.Equal(expected, LithuanianScoring.Score(heard, target));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("!!!")]
    public void LeavesATakeUnscoredWhenNothingWasHeard(string? heard)
    {
        // An unscored take is still saved: the audio and its date are the point of the history.
        Assert.Null(LithuanianScoring.Score(heard, "labas"));
    }

    [Theory]
    [InlineData(100, true)]
    [InlineData(86, true)]
    [InlineData(85, true)]
    [InlineData(84, false)]
    [InlineData(0, false)]
    public void PassesAtEightyFivePercent(int score, bool passed)
    {
        Assert.Equal(passed, LithuanianScoring.Passed(score));
    }

    [Fact]
    public void PassMarkMatchesTheSharedConstant()
    {
        // packages/shared/src/index.ts exports LITHUANIAN_PASS_MARK = 85 for the UI copy.
        Assert.Equal(85, LithuanianScoring.PassMark);
    }

    [Fact]
    public void CapsAnOverlongTranscriptInsteadOfStoringIt()
    {
        var transcript = LithuanianScoring.NormalizeTranscript(new string('a', 500));

        Assert.Equal(LithuanianScoring.MaxTranscriptLength, transcript.Length);
    }

    [Fact]
    public void TranscriptionTargetsOpenAiSpeechToTextInLithuanian()
    {
        Assert.Equal("https://api.openai.com/v1/audio/transcriptions", LithuanianDefaults.TranscriptionEndpoint);
        // ISO-639-1, which is what the API expects; a wrong code silently degrades accuracy.
        Assert.Equal("lt", LithuanianDefaults.Language);
        Assert.Equal("gpt-4o-transcribe", LithuanianDefaults.TranscriptionModel);
    }

    [Fact]
    public void TrainerKeyIsSeparateFromTheMailAiProviderKeys()
    {
        // Revoking the trainer key must not disturb mail analysis, and the mail keys must not
        // silently start paying for a child's practice uploads.
        Assert.Equal("LITHUANIAN_OPENAI_API_KEY", LithuanianDefaults.ApiKeyVariable);
        Assert.NotEqual("OPENAI_API_KEY", LithuanianDefaults.ApiKeyVariable);

        var settings = new AppRuntimeSettings(
            Ai: new AiRuntimeSettings(OpenAi: new AiProviderRuntimeSettings("mail-key", "gpt-5.6")));

        Assert.Equal("", settings.LithuanianValue.ApiKey);
        Assert.Equal(LithuanianDefaults.TranscriptionModel, settings.LithuanianValue.Model);
    }

    [Fact]
    public void SchemaContractCoversTheLearningTables()
    {
        var contract = DatabaseSchemaContract.FromSql(DatabaseInitializer.LearningSchemaSql);

        Assert.Contains("lithuanian_words", contract.Tables);
        Assert.Contains("lithuanian_recordings", contract.Tables);
        Assert.Contains("lithuanian_words_owner_pair_unique", contract.UniqueIndexes);
    }

    [Fact]
    public void ExistingInstallationsMigrateTheRoleConstraintsForLucas()
    {
        // CREATE TABLE IF NOT EXISTS is a no-op on an existing database, so both role checks
        // have to be dropped and re-added or a lucas account cannot be inserted after upgrade.
        var schema = string.Join(' ', DatabaseInitializer.CoreSchemaSql.Split(
            (char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        Assert.Contains("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;", schema, StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE users ADD CONSTRAINT users_role_check CHECK(role IN ('admin', 'user', 'renter', 'lucas'));",
            schema,
            StringComparison.Ordinal);
        Assert.Contains(
            "ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_effective_role_check CHECK(effective_role IN ('admin', 'user', 'renter', 'lucas'));",
            schema,
            StringComparison.Ordinal);
    }
}
