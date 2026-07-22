using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace ArchiveMail.Api.Imports;

public sealed class UploadService(
    NpgsqlDataSource database,
    ImportJobRepository jobs,
    IOptions<ImportOptions> options)
{
    private readonly ImportOptions _options = options.Value;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new();

    public async Task<UploadSessionDto> CreateOrResumeAsync(
        CreateUploadRequest request,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        ValidateFilename(request.Filename);
        if (request.SizeBytes <= 0) throw new InvalidOperationException("Upload size must be greater than zero");
        var clientKey = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"{request.Filename}\0{request.SizeBytes}\0{request.LastModified}\0{request.OcrEnabled}"))).ToLowerInvariant();

        var existing = await FindByClientKeyAsync(clientKey, ownerUserId, cancellationToken);
        if (existing is not null && File.Exists(existing.TempPath)) return existing.Public;
        if (existing is not null)
            await UpdateAsync(existing.Public.Id, status: "cancelled", message: "Partial upload file was missing", cancellationToken: cancellationToken);

        var incoming = Path.GetFullPath(Path.Combine(_options.DataDirectory, "incoming"));
        Directory.CreateDirectory(incoming);
        var id = Guid.NewGuid().ToString();
        var safeName = SafeFilename(request.Filename);
        var extension = Path.GetExtension(safeName).ToLowerInvariant();
        var tempPath = Path.Combine(incoming, $"{id}{(extension.Length == 0 ? ".mbox" : extension)}");
        await using (File.Create(tempPath)) { }
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO upload_sessions (
              id, owner_user_id, client_key, filename, expected_size, received_size,
              temp_path, status, ocr_enabled, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, 0, $6, 'uploading', $7, $8, $8
            )
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(ownerUserId);
        command.Parameters.AddWithValue(clientKey);
        command.Parameters.AddWithValue(safeName);
        command.Parameters.AddWithValue(request.SizeBytes);
        command.Parameters.AddWithValue(tempPath);
        command.Parameters.AddWithValue(request.OcrEnabled ? 1 : 0);
        command.Parameters.AddWithValue(now);
        try
        {
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }
        return (await GetAsync(id, ownerUserId, cancellationToken))!.Public;
    }

    public async Task<IReadOnlyList<UploadSessionDto>> ListAsync(string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, filename, expected_size, received_size, status, ocr_enabled <> 0,
                   job_id, message, created_at, updated_at
            FROM upload_sessions WHERE owner_user_id=$1 ORDER BY updated_at DESC LIMIT 25
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var sessions = new List<UploadSessionDto>();
        while (await reader.ReadAsync(cancellationToken)) sessions.Add(ReadPublic(reader));
        return sessions;
    }

    public async Task<UploadSessionRecord?> GetAsync(string id, CancellationToken cancellationToken)
        => await GetAsync(id, null, cancellationToken);

    public async Task<UploadSessionRecord?> GetAsync(string id, string? ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, filename, expected_size, received_size, status, ocr_enabled <> 0,
                   job_id, message, created_at, updated_at, client_key, temp_path, owner_user_id
            FROM upload_sessions WHERE id = $1 AND ($2::text IS NULL OR owner_user_id=$2)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Text, Value = (object?)ownerUserId ?? DBNull.Value });
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        return new UploadSessionRecord(
            ReadPublic(reader), reader.GetString(10), reader.GetString(11),
            reader.IsDBNull(12) ? null : reader.GetString(12));
    }

    public async Task<UploadSessionDto> AppendAsync(
        string id,
        long offset,
        Stream body,
        string ownerUserId,
        CancellationToken cancellationToken)
    {
        var gate = _locks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var session = await GetAsync(id, ownerUserId, cancellationToken)
                ?? throw new KeyNotFoundException("Upload session not found");
            if (session.Public.Status is "cancelled" or "completed")
                throw new InvalidOperationException($"Upload is already {session.Public.Status}");
            if (offset != session.Public.ReceivedBytes)
                throw new UploadOffsetException($"Expected upload offset {session.Public.ReceivedBytes}");

            await using var target = new FileStream(
                session.TempPath, FileMode.Open, FileAccess.Write, FileShare.None,
                1024 * 1024, FileOptions.Asynchronous | FileOptions.RandomAccess);
            target.Position = offset;
            var buffer = new byte[1024 * 1024];
            long written = 0;
            while (true)
            {
                var read = await body.ReadAsync(buffer, cancellationToken);
                if (read == 0) break;
                written += read;
                if (offset + written > session.Public.SizeBytes)
                    throw new InvalidOperationException("Upload exceeds the declared file size");
                await target.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            }
            if (written == 0) throw new InvalidOperationException("Upload chunk is empty");
            await target.FlushAsync(cancellationToken);
            return await UpdateAsync(
                id,
                receivedBytes: offset + written,
                status: "uploading",
                message: $"Received {offset + written} of {session.Public.SizeBytes} bytes",
                cancellationToken: cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<UploadSessionDto> CompleteAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        var gate = _locks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var session = await GetAsync(id, ownerUserId, cancellationToken)
                ?? throw new KeyNotFoundException("Upload session not found");
            if (session.Public.Status == "completed") return session.Public;
            if (session.Public.ReceivedBytes != session.Public.SizeBytes)
                throw new UploadOffsetException(
                    $"Upload is incomplete: received {session.Public.ReceivedBytes} of {session.Public.SizeBytes} bytes");
            await ValidateArchiveHeaderAsync(session.Public.Filename, session.TempPath, cancellationToken);
            await UpdateAsync(id, status: "ready", message: "Upload complete; creating import job", cancellationToken: cancellationToken);
            await jobs.CreateAsync(
                session.TempPath,
                session.Public.OcrEnabled,
                session.Public.Filename,
                temporarySource: true,
                session.OwnerUserId,
                uploadId: id,
                cancellationToken);
            return (await GetAsync(id, ownerUserId, cancellationToken))!.Public;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<UploadSessionDto> CancelAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        var gate = _locks.GetOrAdd(id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var session = await GetAsync(id, ownerUserId, cancellationToken)
                ?? throw new KeyNotFoundException("Upload session not found");
            if (session.Public.Status == "completed")
                throw new InvalidOperationException("The import has already started; cancel the import job instead");
            File.Delete(session.TempPath);
            return await UpdateAsync(id, status: "cancelled", message: "Upload cancelled and partial file removed", cancellationToken: cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<UploadSessionRecord?> FindByClientKeyAsync(string clientKey, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id FROM upload_sessions
            WHERE client_key = $1 AND owner_user_id=$2 AND status IN ('uploading', 'ready', 'failed')
            ORDER BY updated_at DESC LIMIT 1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(clientKey);
        command.Parameters.AddWithValue(ownerUserId);
        var id = await command.ExecuteScalarAsync(cancellationToken) as string;
        return id is null ? null : await GetAsync(id, ownerUserId, cancellationToken);
    }

    private async Task<UploadSessionDto> UpdateAsync(
        string id,
        long? receivedBytes = null,
        string? status = null,
        string? message = null,
        CancellationToken cancellationToken = default)
    {
        const string sql = """
            UPDATE upload_sessions SET
              received_size = COALESCE($2, received_size),
              status = COALESCE($3, status), message = COALESCE($4, message), updated_at = $5
            WHERE id = $1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlDbType.Bigint,
            Value = (object?)receivedBytes ?? DBNull.Value
        });
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlDbType.Text,
            Value = (object?)status ?? DBNull.Value
        });
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlDbType.Text,
            Value = (object?)message ?? DBNull.Value
        });
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
        return (await GetAsync(id, cancellationToken))!.Public;
    }

    private static async Task ValidateArchiveHeaderAsync(string filename, string path, CancellationToken cancellationToken)
    {
        if (!string.Equals(Path.GetExtension(filename), ".pst", StringComparison.OrdinalIgnoreCase)) return;
        var header = new byte[4];
        await using var stream = File.OpenRead(path);
        if (await stream.ReadAsync(header, cancellationToken) != header.Length || Encoding.ASCII.GetString(header) != "!BDN")
            throw new InvalidOperationException("The uploaded file does not have a PST header");
    }

    private static UploadSessionDto ReadPublic(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), Convert.ToInt64(reader.GetValue(2)),
        Convert.ToInt64(reader.GetValue(3)), reader.GetString(4), reader.GetBoolean(5),
        reader.IsDBNull(6) ? null : reader.GetString(6),
        reader.IsDBNull(7) ? null : reader.GetString(7), reader.GetString(8), reader.GetString(9));

    private static void ValidateFilename(string filename)
    {
        if (Path.GetExtension(filename).ToLowerInvariant() is not (".pst" or ".mbox" or ".mbx"))
            throw new InvalidOperationException("Choose a .pst, .mbox, or .mbx archive");
    }

    private static string SafeFilename(string value)
    {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var cleaned = new string(Path.GetFileName(value).Select(character =>
            char.IsControl(character) || invalid.Contains(character) ? '_' : character).ToArray());
        return cleaned.Length > 240 ? cleaned[..240] : cleaned;
    }
}

public sealed record CreateUploadRequest(string Filename, long SizeBytes, long LastModified, bool OcrEnabled);
public sealed class UploadOffsetException(string message) : Exception(message);
