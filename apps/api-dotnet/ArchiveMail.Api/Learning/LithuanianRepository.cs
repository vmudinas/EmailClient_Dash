using System.Text.Json;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using Npgsql;

namespace ArchiveMail.Api.Learning;

public sealed record LithuanianRecordingDto(
    string Id,
    string WordId,
    string ContentType,
    long SizeBytes,
    long DurationMs,
    string? Transcript,
    int? Score,
    bool? Passed,
    string RecordedAt);

public sealed record LithuanianWordDto(
    string Id,
    string Lithuanian,
    string English,
    /// <summary>"word" or "phrase" -- the learner chooses which they are adding.</summary>
    string Kind,
    string CreatedAt,
    /// <summary>Per-word breakdown of a phrase. Always empty for a single word.</summary>
    IReadOnlyList<LithuanianHint> Hints,
    /// <summary>
    /// Whether a reference pronunciation has been generated. False falls the screen back to the
    /// browser's own voice, which is only right on a device with a Lithuanian voice installed.
    /// </summary>
    bool HasPronunciation,
    IReadOnlyList<LithuanianRecordingDto> Recordings);

public sealed record LithuanianWordCreateRequest(string Lithuanian, string English, string? Kind);

public sealed record LithuanianPracticeDto(
    int PassMark,
    /// <summary>The best game so far, or 0 before any has been played.</summary>
    int BestScore,
    IReadOnlyList<LithuanianWordDto> Words);

public sealed record LithuanianGameRequest(int Score, int BestCombo);

public sealed record LithuanianGameResultDto(int Score, int BestScore, bool Record);

/// <summary>
/// Word pairs and pronunciation recordings for the Lithuanian practice screen. Only the
/// Lithuanian side is ever spoken or recorded; the English word is the translation. Recordings
/// are written to the data directory instead of the database because a single practice session
/// can produce several megabytes of audio, and the row keeps the metadata, the score, and the
/// date it was recorded.
/// </summary>
public sealed class LithuanianRepository(
    NpgsqlDataSource database,
    ActiveDatabaseConfiguration active,
    AppSettingsService settings,
    LithuanianTranscriptionService transcription,
    LithuanianHintService hints,
    LithuanianSpeechService speech)
{
    private static readonly JsonSerializerOptions HintJson = new(JsonSerializerDefaults.Web);

    public int PassMark => settings.Current().LithuanianValue.PassMark;

    internal const long MaxRecordingBytes = 8 * 1024 * 1024;
    internal const string StorageFolder = "lithuanian-recordings";

    /// <summary>Kept apart from the learner's own takes: one is generated, the other is his.</summary>
    internal const string SpeechFolder = "lithuanian-speech";

    // Browsers pick their own container: Chrome and Firefox record WebM/Opus, Safari records
    // MP4 or a raw Core Audio stream. Anything outside this list is rejected rather than stored
    // under a guessed extension.
    private static readonly Dictionary<string, string> RecordingTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["audio/webm"] = ".webm",
        ["audio/ogg"] = ".ogg",
        ["audio/mp4"] = ".m4a",
        ["audio/mpeg"] = ".mp3",
        ["audio/aac"] = ".aac",
        ["audio/wav"] = ".wav",
        ["audio/x-wav"] = ".wav",
        ["audio/wave"] = ".wav"
    };

    public async Task<IReadOnlyList<LithuanianWordDto>> ListAsync(string owner, CancellationToken token)
    {
        var passMark = PassMark;
        const string sql = """
            SELECT w.id, w.lithuanian, w.english, w.kind, w.hints_json, w.created_at,
                   r.id, r.content_type, r.size_bytes, r.duration_ms, r.transcript, r.score, r.recorded_at,
                   w.pronunciation_key
            FROM lithuanian_words w
            LEFT JOIN lithuanian_recordings r ON r.word_id = w.id
            WHERE w.owner_user_id = @owner
            ORDER BY w.created_at DESC, r.recorded_at DESC
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("owner", owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        var order = new List<string>();
        var words = new Dictionary<string, (string Lithuanian, string English, string Kind, IReadOnlyList<LithuanianHint> Hints, string CreatedAt, bool Spoken, List<LithuanianRecordingDto> Recordings)>();
        while (await reader.ReadAsync(token))
        {
            var wordId = reader.GetString(0);
            if (!words.TryGetValue(wordId, out var word))
            {
                word = (
                    reader.GetString(1), reader.GetString(2), reader.GetString(3),
                    ParseHints(reader.IsDBNull(4) ? null : reader.GetString(4)),
                    reader.GetString(5), !reader.IsDBNull(13), []);
                words[wordId] = word;
                order.Add(wordId);
            }
            if (reader.IsDBNull(6)) continue;
            var score = reader.IsDBNull(11) ? (int?)null : (int)reader.GetInt64(11);
            word.Recordings.Add(new LithuanianRecordingDto(
                reader.GetString(6), wordId, reader.GetString(7), reader.GetInt64(8), reader.GetInt64(9),
                reader.IsDBNull(10) ? null : reader.GetString(10),
                score, score is null ? null : LithuanianScoring.Passed(score.Value, passMark),
                reader.GetString(12)));
        }
        return order
            .Select(id => new LithuanianWordDto(
                id, words[id].Lithuanian, words[id].English, words[id].Kind,
                words[id].CreatedAt, words[id].Hints, words[id].Spoken, words[id].Recordings))
            .ToArray();
    }

    private static IReadOnlyList<LithuanianHint> ParseHints(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try { return JsonSerializer.Deserialize<LithuanianHint[]>(json, HintJson) ?? []; }
        catch (JsonException) { return []; }
    }

    public async Task<LithuanianWordDto> CreateWordAsync(
        LithuanianWordCreateRequest request,
        string owner,
        CancellationToken token)
    {
        var kind = ValidateKind(request.Kind);
        var lithuanian = ValidateEntry(request.Lithuanian, kind, "Lithuanian");
        var english = ValidateEntry(request.English, kind, "English");

        // A phrase is broken down word by word so it does not arrive as an opaque block. Best
        // effort: no key, or a model that misbehaves, costs the hints and not the phrase.
        var breakdown = kind == "phrase"
            ? await hints.GenerateAsync(lithuanian, english, token)
            : [];

        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        // Said aloud once and kept, so every device plays the same reference rather than whatever
        // voice it happens to have. Best effort for the same reason as the hints.
        var spokenKey = await StoreSpeechAsync(id, lithuanian, token);
        const string sql = """
            INSERT INTO lithuanian_words(
              id, owner_user_id, lithuanian, english, kind, hints_json,
              pronunciation_key, pronunciation_type, created_at, updated_at)
            VALUES(@id, @owner, @lithuanian, @english, @kind, @hints, @speech, @speechType, @now, @now)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", owner);
        command.Parameters.AddWithValue("lithuanian", lithuanian);
        command.Parameters.AddWithValue("english", english);
        command.Parameters.AddWithValue("kind", kind);
        AddNullable(command, "hints",
            breakdown.Count == 0 ? null : JsonSerializer.Serialize(breakdown, HintJson),
            NpgsqlTypes.NpgsqlDbType.Text);
        AddNullable(command, "speech", spokenKey, NpgsqlTypes.NpgsqlDbType.Text);
        AddNullable(command, "speechType",
            spokenKey is null ? null : LithuanianDefaults.SpeechContentType,
            NpgsqlTypes.NpgsqlDbType.Text);
        command.Parameters.AddWithValue("now", now);
        try { await command.ExecuteNonQueryAsync(token); }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            DeleteSpeech(spokenKey);
            throw new ArgumentException($"That {kind} is already on the list");
        }
        catch
        {
            DeleteSpeech(spokenKey);
            throw;
        }
        return new LithuanianWordDto(id, lithuanian, english, kind, now, breakdown, spokenKey is not null, []);
    }

    /// <summary>
    /// Writes the generated audio beside the learner's recordings and returns its storage key, or
    /// null when none could be produced -- which is not an error: the screen falls back to the
    /// browser's own voice.
    /// </summary>
    private async Task<string?> StoreSpeechAsync(string wordId, string lithuanian, CancellationToken token)
    {
        var audio = await speech.GenerateAsync(lithuanian, token);
        if (audio is null) return null;
        var directory = Path.Combine(active.DataDirectory, SpeechFolder);
        Directory.CreateDirectory(directory);
        var key = $"{SpeechFolder}/{wordId}{LithuanianDefaults.SpeechExtension}";
        var path = Path.Combine(active.DataDirectory, key);
        try
        {
            await File.WriteAllBytesAsync(path, audio, token);
            return key;
        }
        catch (Exception)
        {
            if (File.Exists(path)) File.Delete(path);
            return null;
        }
    }

    private void DeleteSpeech(string? key)
    {
        if (key is null) return;
        var path = Path.Combine(active.DataDirectory, key);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>The cached reference pronunciation for a word.</summary>
    public async Task<(string Path, string ContentType)> PronunciationContentAsync(
        string wordId,
        string owner,
        CancellationToken token)
    {
        const string sql = """
            SELECT pronunciation_key, pronunciation_type FROM lithuanian_words
            WHERE id = @id AND owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", wordId);
        command.Parameters.AddWithValue("owner", owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) throw new MailNotFoundException("Word not found");
        if (reader.IsDBNull(0)) throw new MailNotFoundException("This word has no spoken version yet");
        var path = Path.Combine(active.DataDirectory, reader.GetString(0));
        if (!File.Exists(path)) throw new MailNotFoundException("The spoken version is missing");
        return (path, reader.IsDBNull(1) ? LithuanianDefaults.SpeechContentType : reader.GetString(1));
    }

    /// <summary>
    /// Says a word again, for one added before a key was configured or when the voice has since
    /// been changed in Admin settings.
    /// </summary>
    public async Task<LithuanianWordDto> RefreshPronunciationAsync(
        string wordId,
        string owner,
        CancellationToken token)
    {
        const string selectSql = """
            SELECT lithuanian, pronunciation_key FROM lithuanian_words
            WHERE id = @id AND owner_user_id = @owner
            """;
        await using var select = database.CreateCommand(selectSql);
        select.Parameters.AddWithValue("id", wordId);
        select.Parameters.AddWithValue("owner", owner);
        string lithuanian;
        string? previous;
        await using (var reader = await select.ExecuteReaderAsync(token))
        {
            if (!await reader.ReadAsync(token)) throw new MailNotFoundException("Word not found");
            lithuanian = reader.GetString(0);
            previous = reader.IsDBNull(1) ? null : reader.GetString(1);
        }

        var key = await StoreSpeechAsync(wordId, lithuanian, token);
        if (key is null)
            throw new ArgumentException(
                "The spoken version is unavailable. Check the Lithuanian trainer key in Admin settings.");

        await using var update = database.CreateCommand("""
            UPDATE lithuanian_words
            SET pronunciation_key = @key, pronunciation_type = @type, updated_at = @now
            WHERE id = @id AND owner_user_id = @owner
            """);
        update.Parameters.AddWithValue("key", key);
        update.Parameters.AddWithValue("type", LithuanianDefaults.SpeechContentType);
        update.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
        update.Parameters.AddWithValue("id", wordId);
        update.Parameters.AddWithValue("owner", owner);
        await update.ExecuteNonQueryAsync(token);

        // Only once the row points at the new file, and only when the name actually changed.
        if (previous is not null && previous != key) DeleteSpeech(previous);

        return (await ListAsync(owner, token)).First(word => word.Id == wordId);
    }

    /// <summary>
    /// Rebuilds the per-word breakdown, for a phrase added before a key was configured or when the
    /// first attempt came back empty.
    /// </summary>
    public async Task<LithuanianWordDto> RefreshHintsAsync(string wordId, string owner, CancellationToken token)
    {
        const string selectSql = """
            SELECT lithuanian, english, kind FROM lithuanian_words
            WHERE id = @id AND owner_user_id = @owner
            """;
        await using var select = database.CreateCommand(selectSql);
        select.Parameters.AddWithValue("id", wordId);
        select.Parameters.AddWithValue("owner", owner);
        string lithuanian, english, kind;
        await using (var reader = await select.ExecuteReaderAsync(token))
        {
            if (!await reader.ReadAsync(token)) throw new MailNotFoundException("Word not found");
            lithuanian = reader.GetString(0);
            english = reader.GetString(1);
            kind = reader.GetString(2);
        }
        if (kind != "phrase") throw new ArgumentException("Only a phrase has a word-by-word breakdown");

        var breakdown = await hints.GenerateAsync(lithuanian, english, token);
        if (breakdown.Count == 0)
            throw new ArgumentException("Hints are unavailable. Check the Lithuanian trainer key in Admin settings.");

        await using var update = database.CreateCommand(
            "UPDATE lithuanian_words SET hints_json = @hints, updated_at = @now WHERE id = @id AND owner_user_id = @owner");
        update.Parameters.AddWithValue("hints", JsonSerializer.Serialize(breakdown, HintJson));
        update.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
        update.Parameters.AddWithValue("id", wordId);
        update.Parameters.AddWithValue("owner", owner);
        await update.ExecuteNonQueryAsync(token);

        return (await ListAsync(owner, token)).First(word => word.Id == wordId);
    }

    public async Task DeleteWordAsync(string wordId, string owner, CancellationToken token)
    {
        var keys = await StorageKeysAsync(
            "SELECT storage_key FROM lithuanian_recordings WHERE word_id = @id AND owner_user_id = @owner",
            wordId, owner, token);
        // The generated audio goes with the word, or it would outlive the row that names it.
        var spoken = await StorageKeysAsync(
            "SELECT pronunciation_key FROM lithuanian_words WHERE id = @id AND owner_user_id = @owner",
            wordId, owner, token);
        await using var command = database.CreateCommand(
            "DELETE FROM lithuanian_words WHERE id = @id AND owner_user_id = @owner");
        command.Parameters.AddWithValue("id", wordId);
        command.Parameters.AddWithValue("owner", owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("Word not found");
        foreach (var key in keys) await DeleteUnreferencedFileAsync(key, token);
        foreach (var key in spoken) DeleteSpeech(key);
    }

    public async Task<LithuanianRecordingDto> SaveRecordingAsync(
        string wordId,
        string? transcript,
        string? contentType,
        long durationMs,
        Stream body,
        string owner,
        CancellationToken token)
    {
        var normalizedType = ValidateContentType(contentType);
        // Scored against the stored word, never against a target supplied by the caller.
        var target = await WordTextAsync(wordId, owner, token);

        var id = Guid.NewGuid().ToString();
        var directory = Path.Combine(active.DataDirectory, StorageFolder);
        Directory.CreateDirectory(directory);
        var key = $"{StorageFolder}/{id}{RecordingTypes[normalizedType]}";
        var path = Path.Combine(active.DataDirectory, key);
        long bytes;
        try
        {
            await using var output = File.Create(path);
            bytes = await CopyLimitedAsync(body, output, token);
        }
        catch
        {
            if (File.Exists(path)) File.Delete(path);
            throw;
        }
        if (bytes == 0)
        {
            File.Delete(path);
            throw new ArgumentException("The recording is empty");
        }

        // The server's own transcription is the authority: it is the same model for every browser
        // and cannot be shaped by the client. What the browser recognised is only a fallback for
        // when no key is configured or the call did not come back.
        var serverHeard = await transcription.TranscribeAsync(path, normalizedType, token);
        var heard = LithuanianScoring.NormalizeTranscript(serverHeard ?? transcript);
        var score = LithuanianScoring.Score(heard, target);

        var recordedAt = DateTimeOffset.UtcNow.ToString("O");
        var duration = Math.Clamp(durationMs, 0, 3_600_000);
        const string sql = """
            INSERT INTO lithuanian_recordings(
              id, word_id, owner_user_id, content_type, size_bytes, duration_ms,
              transcript, score, storage_key, recorded_at)
            VALUES(@id, @word, @owner, @type, @bytes, @duration, @transcript, @score, @key, @now)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("word", wordId);
        command.Parameters.AddWithValue("owner", owner);
        command.Parameters.AddWithValue("type", normalizedType);
        command.Parameters.AddWithValue("bytes", bytes);
        command.Parameters.AddWithValue("duration", duration);
        AddNullable(command, "transcript", heard.Length == 0 ? null : heard, NpgsqlTypes.NpgsqlDbType.Text);
        AddNullable(command, "score", (long?)score, NpgsqlTypes.NpgsqlDbType.Bigint);
        command.Parameters.AddWithValue("key", key);
        command.Parameters.AddWithValue("now", recordedAt);
        try { await command.ExecuteNonQueryAsync(token); }
        catch
        {
            if (File.Exists(path)) File.Delete(path);
            throw;
        }
        return new LithuanianRecordingDto(
            id, wordId, normalizedType, bytes, duration,
            heard.Length == 0 ? null : heard,
            score, score is null ? null : LithuanianScoring.Passed(score.Value, PassMark),
            recordedAt);
    }

    public async Task<(string Path, string ContentType)> RecordingContentAsync(
        string recordingId,
        string owner,
        CancellationToken token)
    {
        const string sql = """
            SELECT storage_key, content_type FROM lithuanian_recordings
            WHERE id = @id AND owner_user_id = @owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", recordingId);
        command.Parameters.AddWithValue("owner", owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) throw new MailNotFoundException("Recording not found");
        var path = Path.Combine(active.DataDirectory, reader.GetString(0));
        if (!File.Exists(path)) throw new MailNotFoundException("Recording audio is missing");
        return (path, reader.GetString(1));
    }

    public async Task DeleteRecordingAsync(string recordingId, string owner, CancellationToken token)
    {
        var keys = await StorageKeysAsync(
            "SELECT storage_key FROM lithuanian_recordings WHERE id = @id AND owner_user_id = @owner",
            recordingId, owner, token);
        await using var command = database.CreateCommand(
            "DELETE FROM lithuanian_recordings WHERE id = @id AND owner_user_id = @owner");
        command.Parameters.AddWithValue("id", recordingId);
        command.Parameters.AddWithValue("owner", owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("Recording not found");
        foreach (var key in keys) await DeleteUnreferencedFileAsync(key, token);
    }

    public async Task<LithuanianPracticeDto> PracticeAsync(string owner, CancellationToken token) =>
        new(PassMark, await BestScoreAsync(owner, token), await ListAsync(owner, token));

    /// <summary>Highest score this learner has reached, or 0 before the first game.</summary>
    public async Task<int> BestScoreAsync(string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT COALESCE(MAX(score), 0) FROM lithuanian_games WHERE owner_user_id = @owner");
        command.Parameters.AddWithValue("owner", owner);
        var best = await command.ExecuteScalarAsync(token);
        return best is long value ? (int)Math.Clamp(value, 0, int.MaxValue) : 0;
    }

    /// <summary>
    /// Records a finished game and says whether it beat the previous best. The score is clamped
    /// rather than trusted: it arrives from the browser, where it was counted.
    /// </summary>
    public async Task<LithuanianGameResultDto> SaveGameAsync(
        LithuanianGameRequest request,
        string owner,
        CancellationToken token)
    {
        var score = Math.Clamp(request.Score, 0, MaxGameScore);
        var combo = Math.Clamp(request.BestCombo, 0, MaxGameCombo);
        var previousBest = await BestScoreAsync(owner, token);

        await using var command = database.CreateCommand("""
            INSERT INTO lithuanian_games(id, owner_user_id, score, best_combo, played_at)
            VALUES(@id, @owner, @score, @combo, @now)
            """);
        command.Parameters.AddWithValue("id", Guid.NewGuid().ToString());
        command.Parameters.AddWithValue("owner", owner);
        command.Parameters.AddWithValue("score", (long)score);
        command.Parameters.AddWithValue("combo", (long)combo);
        command.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);

        return new LithuanianGameResultDto(score, Math.Max(previousBest, score), score > previousBest);
    }

    /// <summary>
    /// Far above anything the rules can produce in one round, and low enough that a bad or
    /// tampered-with number cannot become an unbeatable high score.
    /// </summary>
    internal const int MaxGameScore = 100_000;

    internal const int MaxGameCombo = 1_000;

    private async Task<string> WordTextAsync(string wordId, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT lithuanian FROM lithuanian_words WHERE id = @id AND owner_user_id = @owner");
        command.Parameters.AddWithValue("id", wordId);
        command.Parameters.AddWithValue("owner", owner);
        return await command.ExecuteScalarAsync(token) as string
            ?? throw new MailNotFoundException("Word not found");
    }

    private static void AddNullable(NpgsqlCommand command, string name, object? value, NpgsqlTypes.NpgsqlDbType type) =>
        command.Parameters.Add(new NpgsqlParameter
        {
            ParameterName = name,
            NpgsqlDbType = type,
            Value = value ?? DBNull.Value
        });

    private async Task<IReadOnlyList<string>> StorageKeysAsync(
        string sql,
        string id,
        string owner,
        CancellationToken token)
    {
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        var keys = new List<string>();
        // A word keeps its spoken version in a nullable column, so a row without one is a normal
        // result here rather than a key.
        while (await reader.ReadAsync(token))
            if (!reader.IsDBNull(0)) keys.Add(reader.GetString(0));
        return keys;
    }

    private async Task DeleteUnreferencedFileAsync(string key, CancellationToken token)
    {
        await using var command = database.CreateCommand(
            "SELECT 1 FROM lithuanian_recordings WHERE storage_key = @key LIMIT 1");
        command.Parameters.AddWithValue("key", key);
        if (await command.ExecuteScalarAsync(token) is not null) return;
        var path = Path.Combine(active.DataDirectory, key);
        if (File.Exists(path)) File.Delete(path);
    }

    private static async Task<long> CopyLimitedAsync(Stream source, Stream destination, CancellationToken token)
    {
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, token);
            if (read == 0) break;
            total += read;
            if (total > MaxRecordingBytes) throw new ArgumentException("The recording is too long. Keep it under 8 MB.");
            await destination.WriteAsync(buffer.AsMemory(0, read), token);
        }
        return total;
    }

    internal static string ValidateKind(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        null or "" or "word" => "word",
        "phrase" => "phrase",
        _ => throw new ArgumentException("Choose a word or a phrase")
    };

    /// <summary>
    /// A single word rejects spaces; a phrase allows them and is bounded by word count as well as
    /// length, so "phrase" cannot become a way to store a paragraph.
    /// </summary>
    internal static string ValidateEntry(string? value, string kind, string label)
    {
        var entry = Collapse(value);
        if (kind == "word")
        {
            if (entry.Length is < 1 or > LithuanianDefaults.MaxWordLength)
                throw new ArgumentException($"Enter one {label} word");
            if (entry.Contains(' '))
                throw new ArgumentException($"Enter a single {label} word, or switch to a phrase");
            return entry;
        }

        if (entry.Length is < 1 or > LithuanianDefaults.MaxPhraseLength)
            throw new ArgumentException($"Enter a {label} phrase of up to {LithuanianDefaults.MaxPhraseLength} characters");
        if (entry.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length > LithuanianDefaults.MaxPhraseWords)
            throw new ArgumentException($"Keep the {label} phrase to {LithuanianDefaults.MaxPhraseWords} words or fewer");
        return entry;
    }

    /// <summary>Trims and reduces internal runs of whitespace to one space.</summary>
    private static string Collapse(string? value) =>
        string.Join(' ', (value ?? "").Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    internal static string ValidateContentType(string? value)
    {
        // MediaRecorder reports codecs as a parameter, for example audio/webm;codecs=opus.
        var type = (value ?? "").Split(';')[0].Trim();
        if (!RecordingTypes.ContainsKey(type)) throw new ArgumentException("Only audio recordings can be saved");
        return type.ToLowerInvariant();
    }
}
