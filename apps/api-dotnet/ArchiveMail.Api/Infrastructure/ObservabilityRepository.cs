using System.Text.Json;
using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Infrastructure;

public sealed record DiagnosticEventDto(
    string Id, string Level, string Category, string Message, string? Stack, string? JobId,
    string? ArchiveId, string? SourceName, IReadOnlyDictionary<string, JsonElement> Context, string CreatedAt);
public sealed record ClientDiagnosticRequest(
    string Level, string Message, string? Stack, Dictionary<string, JsonElement>? Context);
public sealed record AuditEventDto(
    string Id, string? SessionId, string? UserId, string? Username, string? DisplayName, string? Role,
    string Action, string? Method, string? Path, long StatusCode, bool Success, string IpAddress,
    string? UserAgent, IReadOnlyDictionary<string, JsonElement> Details, string CreatedAt);
public sealed record AuditPageDto(IReadOnlyList<AuditEventDto> Items, string? NextCursor);

public sealed class ObservabilityRepository(NpgsqlDataSource database, ILogger<ObservabilityRepository> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<DiagnosticEventDto> RecordDiagnosticAsync(
        string ownerUserId, ClientDiagnosticRequest request, string? userAgent, CancellationToken cancellationToken)
    {
        var level = request.Level?.Trim().ToLowerInvariant() ?? "";
        if (level is not ("debug" or "info" or "warning" or "error")) throw new ArgumentException("Invalid diagnostic level");
        if (string.IsNullOrWhiteSpace(request.Message) || request.Message.Length > 4_000) throw new ArgumentException("Invalid diagnostic message");
        if (request.Stack?.Length > 20_000) throw new ArgumentException("Diagnostic stack is too long");
        var context = request.Context is null
            ? new Dictionary<string, JsonElement>()
            : new Dictionary<string, JsonElement>(request.Context);
        context["userAgent"] = JsonSerializer.SerializeToElement(userAgent);
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO diagnostic_events(id,level,category,message,stack,context_json,created_at,owner_user_id)
            VALUES(@id,@level,'client',@message,@stack,@context,@now,@owner)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("level", level);
        command.Parameters.AddWithValue("message", request.Message.Trim());
        AddNullable(command, "stack", request.Stack);
        command.Parameters.AddWithValue("context", JsonSerializer.Serialize(context, JsonOptions));
        command.Parameters.AddWithValue("now", now);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await command.ExecuteNonQueryAsync(cancellationToken);
        return new(id, level, "client", request.Message.Trim(), request.Stack, null, null, null, context, now);
    }

    public async Task RecordServerDiagnosticAsync(
        string ownerUserId,
        string category,
        string message,
        Exception exception,
        string? jobId,
        string? archiveId,
        string? sourceName,
        object? context,
        CancellationToken cancellationToken)
    {
        var normalizedMessage = string.IsNullOrWhiteSpace(message) ? exception.Message : message.Trim();
        if (normalizedMessage.Length > 4_000) normalizedMessage = normalizedMessage[..4_000];
        var stack = exception.ToString();
        if (stack.Length > 20_000) stack = stack[..20_000];
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO diagnostic_events(
              id,level,category,message,stack,job_id,archive_id,source_name,context_json,created_at,owner_user_id
            ) VALUES(@id,'error',@category,@message,@stack,@job,@archive,@source,@context,@now,@owner)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("category", category.Trim().ToLowerInvariant());
        command.Parameters.AddWithValue("message", normalizedMessage);
        command.Parameters.AddWithValue("stack", stack);
        AddNullable(command, "job", jobId);
        AddNullable(command, "archive", archiveId);
        AddNullable(command, "source", sourceName);
        command.Parameters.AddWithValue("context", JsonSerializer.Serialize(context ?? new { }, JsonOptions));
        command.Parameters.AddWithValue("now", now);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<DiagnosticEventDto>> ListDiagnosticsAsync(
        string ownerUserId, string? level, string? category, string? jobId, int? limit, CancellationToken cancellationToken)
    {
        var conditions = new List<string> { "owner_user_id=@owner" };
        await using var command = database.CreateCommand("");
        command.Parameters.AddWithValue("owner", ownerUserId);
        void Add(string sql, string name, string value) { conditions.Add(sql); command.Parameters.AddWithValue(name, value); }
        if (!string.IsNullOrWhiteSpace(level)) Add("level=@level", "level", level.Trim().ToLowerInvariant());
        if (!string.IsNullOrWhiteSpace(category)) Add("category=@category", "category", category.Trim().ToLowerInvariant());
        if (!string.IsNullOrWhiteSpace(jobId)) Add("job_id=@job", "job", jobId.Trim());
        command.CommandText = $"""
            SELECT id,level,category,message,stack,job_id,archive_id,source_name,context_json,created_at
            FROM diagnostic_events WHERE {string.Join(" AND ", conditions)} ORDER BY created_at DESC,id DESC LIMIT @limit
            """;
        command.Parameters.AddWithValue("limit", Math.Clamp(limit ?? 300, 1, 1_000));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var events = new List<DiagnosticEventDto>();
        while (await reader.ReadAsync(cancellationToken)) events.Add(ReadDiagnostic(reader));
        return events;
    }

    public async Task ClearDiagnosticsAsync(string ownerUserId, CancellationToken cancellationToken)
    {
        await using var command = database.CreateCommand("DELETE FROM diagnostic_events WHERE owner_user_id=@owner");
        command.Parameters.AddWithValue("owner", ownerUserId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task RecordAuditAsync(HttpContext context, SessionRecord? session, CancellationToken cancellationToken)
    {
        try
        {
            var path = context.Request.Path.Value ?? "";
            var action = $"{context.Request.Method.ToLowerInvariant()} {RouteTemplate(context) ?? path}";
            const string sql = """
                INSERT INTO audit_events(id,session_id,user_id,username,display_name,role,action,method,path,
                  status_code,success,ip_address,user_agent,details_json,created_at)
                VALUES(@id,@session,@user,@username,@display,@role,@action,@method,@path,@status,@success,@ip,@agent,'{}',@now)
                """;
            await using var command = database.CreateCommand(sql);
            command.Parameters.AddWithValue("id", Guid.NewGuid().ToString());
            AddNullable(command, "session", session?.Id);
            AddNullable(command, "user", session?.User.Id);
            AddNullable(command, "username", session?.User.Username);
            AddNullable(command, "display", session?.User.DisplayName);
            AddNullable(command, "role", session?.Role);
            command.Parameters.AddWithValue("action", action);
            command.Parameters.AddWithValue("method", context.Request.Method);
            command.Parameters.AddWithValue("path", path);
            command.Parameters.AddWithValue("status", context.Response.StatusCode);
            command.Parameters.AddWithValue("success", context.Response.StatusCode < 400 ? 1 : 0);
            command.Parameters.AddWithValue("ip", AuthService.ClientIp(context));
            AddNullable(command, "agent", context.Request.Headers.UserAgent.ToString());
            command.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Audit event could not be persisted");
        }
    }

    public async Task<AuditPageDto> ListAuditAsync(
        string? username, string? action, string? ipAddress, bool? success, string? cursor, int? limit,
        CancellationToken cancellationToken)
    {
        var offset = DecodeOffset(cursor);
        var take = Math.Clamp(limit ?? 100, 1, 500);
        var conditions = new List<string>();
        await using var command = database.CreateCommand("");
        void Add(string sql, string name, object value) { conditions.Add(sql); command.Parameters.AddWithValue(name, value); }
        if (!string.IsNullOrWhiteSpace(username)) Add("lower(username)=lower(@username)", "username", username.Trim());
        if (!string.IsNullOrWhiteSpace(action)) Add("action ILIKE @action", "action", $"%{action.Trim().Replace("%", "\\%").Replace("_", "\\_")}%");
        if (!string.IsNullOrWhiteSpace(ipAddress)) Add("ip_address=@ip", "ip", ipAddress.Trim());
        if (success is not null) Add("success=@success", "success", success.Value ? 1 : 0);
        command.CommandText = $"""
            SELECT id,session_id,user_id,username,display_name,role,action,method,path,status_code,success<>0,
              ip_address,user_agent,details_json,created_at FROM audit_events
            {(conditions.Count == 0 ? "" : $"WHERE {string.Join(" AND ", conditions)}")}
            ORDER BY created_at DESC,id DESC LIMIT @limit OFFSET @offset
            """;
        command.Parameters.AddWithValue("limit", take + 1);
        command.Parameters.AddWithValue("offset", offset);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var events = new List<AuditEventDto>();
        while (await reader.ReadAsync(cancellationToken)) events.Add(ReadAudit(reader));
        var hasMore = events.Count > take;
        if (hasMore) events.RemoveAt(events.Count - 1);
        return new(events, hasMore ? Convert.ToBase64String(BitConverter.GetBytes(offset + take)) : null);
    }

    private static DiagnosticEventDto ReadDiagnostic(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        reader.IsDBNull(4) ? null : reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5),
        reader.IsDBNull(6) ? null : reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7),
        ParseObject(reader.GetString(8)), reader.GetString(9));
    private static AuditEventDto ReadAudit(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.IsDBNull(1) ? null : reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2),
        reader.IsDBNull(3) ? null : reader.GetString(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.IsDBNull(5) ? null : reader.GetString(5),
        reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8),
        reader.GetInt64(9), reader.GetBoolean(10), reader.GetString(11), reader.IsDBNull(12) ? null : reader.GetString(12),
        ParseObject(reader.GetString(13)), reader.GetString(14));
    private static Dictionary<string, JsonElement> ParseObject(string json)
    {
        try { return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json, JsonOptions) ?? []; }
        catch (JsonException) { return []; }
    }
    private static string? RouteTemplate(HttpContext context) => (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
    private static int DecodeOffset(string? cursor)
    {
        if (string.IsNullOrWhiteSpace(cursor)) return 0;
        try { return Math.Max(0, BitConverter.ToInt32(Convert.FromBase64String(cursor))); } catch { return 0; }
    }
    private static void AddNullable(NpgsqlCommand command, string name, string? value) => command.Parameters.Add(new NpgsqlParameter
    {
        ParameterName = name,
        NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
        Value = (object?)value ?? DBNull.Value
    });
}
