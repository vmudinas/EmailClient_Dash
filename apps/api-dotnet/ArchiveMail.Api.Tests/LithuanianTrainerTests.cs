using System.Text.Json;
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
        Assert.Equal(expected, LithuanianRepository.ValidateEntry(input, "word", "Lithuanian"));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    [InlineData("labas rytas")]
    [InlineData("labas\trytas")]
    public void RejectsEmptyAndMultiWordEntriesInWordMode(string? input)
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateEntry(input, "word", "Lithuanian"));
    }

    [Fact]
    public void RejectsAnOverlongWord()
    {
        Assert.Throws<ArgumentException>(
            () => LithuanianRepository.ValidateEntry(new string('a', 65), "word", "English"));
    }

    [Theory]
    [InlineData("labas rytas", "labas rytas")]
    // Ragged spacing from a phone keyboard collapses so the same phrase is never stored twice.
    [InlineData("  labas   rytas  ", "labas rytas")]
    [InlineData("labas\trytas", "labas rytas")]
    [InlineData("labas", "labas")]
    public void AcceptsAPhraseAndCollapsesItsSpacing(string input, string expected)
    {
        Assert.Equal(expected, LithuanianRepository.ValidateEntry(input, "phrase", "Lithuanian"));
    }

    [Fact]
    public void RejectsAPhraseBeyondTheWordLimit()
    {
        var tooMany = string.Join(' ', Enumerable.Repeat("labas", LithuanianDefaults.MaxPhraseWords + 1));

        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateEntry(tooMany, "phrase", "Lithuanian"));
    }

    [Fact]
    public void RejectsAPhraseBeyondTheLengthLimit()
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateEntry(
            new string('a', LithuanianDefaults.MaxPhraseLength + 1), "phrase", "Lithuanian"));
    }

    [Theory]
    [InlineData(null, "word")]
    [InlineData("", "word")]
    [InlineData("word", "word")]
    [InlineData("PHRASE", "phrase")]
    public void DefaultsToASingleWordWhenNoKindIsGiven(string? input, string expected)
    {
        Assert.Equal(expected, LithuanianRepository.ValidateKind(input));
    }

    [Fact]
    public void RejectsAnUnknownKind()
    {
        Assert.Throws<ArgumentException>(() => LithuanianRepository.ValidateKind("sentence"));
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
    [InlineData(100, 85, true)]
    [InlineData(85, 85, true)]
    [InlineData(84, 85, false)]
    // An administrator can lower the bar while a learner is starting out.
    [InlineData(70, 60, true)]
    [InlineData(70, 90, false)]
    public void PassesAtWhicheverMarkIsConfigured(int score, int passMark, bool passed)
    {
        Assert.Equal(passed, LithuanianScoring.Passed(score, passMark));
    }

    [Fact]
    public void DefaultPassMarkMatchesTheSharedConstant()
    {
        // packages/shared/src/index.ts exports LITHUANIAN_PASS_MARK = 85 for the UI copy.
        Assert.Equal(85, LithuanianDefaults.PassMark);
        Assert.Equal(50, LithuanianDefaults.MinimumPassMark);
        Assert.Equal(100, LithuanianDefaults.MaximumPassMark);
    }

    [Fact]
    public void SettingsClampThePassMarkIntoRange()
    {
        var settings = new AppSettingsService(Configuration());

        Assert.Equal(60, Save(settings, 60).PassMark);
        Assert.Equal(LithuanianDefaults.MaximumPassMark, Save(settings, 500).PassMark);
        Assert.Equal(LithuanianDefaults.MinimumPassMark, Save(settings, 1).PassMark);
    }

    /// <summary>
    /// A settings file written before the pass mark existed deserialises it as 0, which would pass
    /// every take rather than none.
    /// </summary>
    [Fact]
    public void AMissingPassMarkFallsBackToTheDefaultRatherThanZero()
    {
        var settings = new AppRuntimeSettings(Lithuanian: new LithuanianRuntimeSettings(PassMark: 0));

        Assert.Equal(0, settings.LithuanianValue.PassMark);
        Assert.False(LithuanianScoring.Passed(0, LithuanianDefaults.PassMark));
    }

    private static LithuanianRuntimeSettings Save(AppSettingsService settings, int passMark) =>
        settings.UpdateLithuanian(JsonSerializer.SerializeToElement(new { passMark })).LithuanianValue;

    private static ActiveDatabaseConfiguration Configuration()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"archive-mail-lt-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        return new ActiveDatabaseConfiguration(
            DatabaseProviderIds.PostgreSql, "Host=localhost", "test", directory,
            Path.Combine(directory, "settings.json"), false);
    }

    [Theory]
    // Spaces separate words so a phrase is compared word for word. Without them "labas rytas"
    // and "labasrytas" would be identical and a run-together attempt would score as perfect.
    [InlineData("labas rytas", "labas rytas", 100)]
    [InlineData("Labas, rytas!", "labas rytas", 100)]
    [InlineData("labasrytas", "labas rytas", 91)]
    [InlineData("labas", "labas rytas", 45)]
    public void ScoresAPhraseWordForWord(string heard, string target, int expected)
    {
        Assert.Equal(expected, LithuanianScoring.Score(heard, target));
    }

    [Fact]
    public void HintParsingSurvivesAMalformedReply()
    {
        // A bad reply costs the hints, never the phrase the learner just added.
        Assert.Empty(LithuanianHintService.Parse("not json"));
        Assert.Empty(LithuanianHintService.Parse("""{"hints":"nope"}"""));
        Assert.Empty(LithuanianHintService.Parse(null));
        Assert.Empty(LithuanianHintService.Parse("""{"hints":[{"meaning":"hello"}]}"""));
    }

    [Fact]
    public void HintParsingKeepsTheWordsItCanRead()
    {
        var hints = LithuanianHintService.Parse(
            """{"hints":[{"word":"labas","meaning":"hello","tip":"Short a."},{"word":"rytas","meaning":"morning","tip":""}]}""");

        Assert.Equal(2, hints.Count);
        Assert.Equal("labas", hints[0].Word);
        Assert.Equal("hello", hints[0].Meaning);
        Assert.Equal("morning", hints[1].Meaning);
    }

    [Fact]
    public void HintParsingIsBoundedSoOneReplyCannotFillTheRow()
    {
        var padded = string.Join(',', Enumerable.Range(0, 40)
            .Select(index => $$"""{"word":"w{{index}}","meaning":"m","tip":"t"}"""));

        Assert.Equal(
            LithuanianDefaults.MaxPhraseWords,
            LithuanianHintService.Parse($$"""{"hints":[{{padded}}]}""").Count);
    }

    [Fact]
    public void TranslationParsingSurvivesAMalformedReply()
    {
        // No suggestion is a normal answer: the learner types the Lithuanian himself.
        Assert.Empty(LithuanianTranslationService.Parse("not json", "word").Lithuanian);
        Assert.Empty(LithuanianTranslationService.Parse(null, "word").Lithuanian);
        Assert.Empty(LithuanianTranslationService.Parse("""{"lithuanian":123}""", "word").Lithuanian);
        Assert.Empty(LithuanianTranslationService.Parse("""{"other":"ačiū"}""", "word").Lithuanian);
        Assert.Empty(LithuanianTranslationService.Parse("""{"lithuanian":"   "}""", "word").Lithuanian);
    }

    [Theory]
    [InlineData("""{"lithuanian":"ačiū"}""", "ačiū")]
    [InlineData("""{"lithuanian":"  ačiū  "}""", "ačiū")]
    public void TranslationParsingTrimsWhatItCanRead(string content, string expected)
    {
        Assert.Equal(expected, LithuanianTranslationService.Parse(content, "word").Lithuanian);
    }

    [Fact]
    public void TranslationParsingRejectsASentenceWhereAWordWasAsked()
    {
        // A single word is what gets recorded and scored, so an explanatory answer is dropped
        // rather than becoming an unpronounceable practice target.
        Assert.Empty(
            LithuanianTranslationService.Parse("""{"lithuanian":"ačiū labai draugas"}""", "word").Lithuanian);
        Assert.Equal(
            "labas rytas",
            LithuanianTranslationService.Parse("""{"lithuanian":"labas rytas"}""", "phrase").Lithuanian);
    }

    [Fact]
    public void TranslationParsingEnforcesTheSameLimitsAsSaving()
    {
        // Anything the create endpoint would reject is dropped here, so an auto-filled value can
        // never fail on save.
        var longWord = new string('a', LithuanianDefaults.MaxWordLength + 1);
        Assert.Empty(
            LithuanianTranslationService.Parse($$"""{"lithuanian":"{{longWord}}"}""", "word").Lithuanian);

        var tooManyWords = string.Join(' ', Enumerable.Range(0, LithuanianDefaults.MaxPhraseWords + 1)
            .Select(index => $"w{index}"));
        Assert.Empty(
            LithuanianTranslationService.Parse($$"""{"lithuanian":"{{tooManyWords}}"}""", "phrase").Lithuanian);
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
