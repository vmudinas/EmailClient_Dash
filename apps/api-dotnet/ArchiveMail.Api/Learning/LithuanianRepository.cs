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
    string CreatedAt,
    IReadOnlyList<LithuanianRecordingDto> Recordings);

public sealed record LithuanianWordCreateRequest(string Lithuanian, string English);

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
    LithuanianTranscriptionService transcription)
{
    internal const long MaxRecordingBytes = 8 * 1024 * 1024;
    internal const string StorageFolder = "lithuanian-recordings";

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
        const string sql = """
            SELECT w.id, w.lithuanian, w.english, w.created_at,
                   r.id, r.content_type, r.size_bytes, r.duration_ms, r.transcript, r.score, r.recorded_at
            FROM lithuanian_words w
            LEFT JOIN lithuanian_recordings r ON r.word_id = w.id
            WHERE w.owner_user_id = @owner
            ORDER BY w.created_at DESC, r.recorded_at DESC
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("owner", owner);
        await using var reader = await command.ExecuteReaderAsync(token);
        var order = new List<string>();
        var words = new Dictionary<string, (string Lithuanian, string English, string CreatedAt, List<LithuanianRecordingDto> Recordings)>();
        while (await reader.ReadAsync(token))
        {
            var wordId = reader.GetString(0);
            if (!words.TryGetValue(wordId, out var word))
            {
                word = (reader.GetString(1), reader.GetString(2), reader.GetString(3), []);
                words[wordId] = word;
                order.Add(wordId);
            }
            if (reader.IsDBNull(4)) continue;
            var score = reader.IsDBNull(9) ? (int?)null : (int)reader.GetInt64(9);
            word.Recordings.Add(new LithuanianRecordingDto(
                reader.GetString(4), wordId, reader.GetString(5), reader.GetInt64(6), reader.GetInt64(7),
                reader.IsDBNull(8) ? null : reader.GetString(8),
                score, score is null ? null : LithuanianScoring.Passed(score.Value),
                reader.GetString(10)));
        }
        return order
            .Select(id => new LithuanianWordDto(id, words[id].Lithuanian, words[id].English, words[id].CreatedAt, words[id].Recordings))
            .ToArray();
    }

    public async Task<LithuanianWordDto> CreateWordAsync(
        LithuanianWordCreateRequest request,
        string owner,
        CancellationToken token)
    {
        var lithuanian = ValidateWord(request.Lithuanian, "Lithuanian");
        var english = ValidateWord(request.English, "English");
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO lithuanian_words(id, owner_user_id, lithuanian, english, created_at, updated_at)
            VALUES(@id, @owner, @lithuanian, @english, @now, @now)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", owner);
        command.Parameters.AddWithValue("lithuanian", lithuanian);
        command.Parameters.AddWithValue("english", english);
        command.Parameters.AddWithValue("now", now);
        try { await command.ExecuteNonQueryAsync(token); }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.UniqueViolation)
        { throw new ArgumentException("That word pair is already on the list"); }
        return new LithuanianWordDto(id, lithuanian, english, now, []);
    }

    public async Task DeleteWordAsync(string wordId, string owner, CancellationToken token)
    {
        var keys = await StorageKeysAsync(
            "SELECT storage_key FROM lithuanian_recordings WHERE word_id = @id AND owner_user_id = @owner",
            wordId, owner, token);
        await using var command = database.CreateCommand(
            "DELETE FROM lithuanian_words WHERE id = @id AND owner_user_id = @owner");
        command.Parameters.AddWithValue("id", wordId);
        command.Parameters.AddWithValue("owner", owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("Word not found");
        foreach (var key in keys) await DeleteUnreferencedFileAsync(key, token);
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
            score, score is null ? null : LithuanianScoring.Passed(score.Value),
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
        while (await reader.ReadAsync(token)) keys.Add(reader.GetString(0));
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

    internal static string ValidateWord(string? value, string label)
    {
        var word = value?.Trim() ?? "";
        if (word.Length is < 1 or > 64) throw new ArgumentException($"Enter one {label} word");
        if (word.Any(char.IsWhiteSpace)) throw new ArgumentException($"Enter a single {label} word without spaces");
        return word;
    }

    internal static string ValidateContentType(string? value)
    {
        // MediaRecorder reports codecs as a parameter, for example audio/webm;codecs=opus.
        var type = (value ?? "").Split(';')[0].Trim();
        if (!RecordingTypes.ContainsKey(type)) throw new ArgumentException("Only audio recordings can be saved");
        return type.ToLowerInvariant();
    }
}
