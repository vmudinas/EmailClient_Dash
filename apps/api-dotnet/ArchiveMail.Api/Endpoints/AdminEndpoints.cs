using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public sealed record SharingState(bool Enabled, string? Url, string? ExpiresAt);

public sealed class SharingService
{
    private static readonly TimeSpan SharingDuration = TimeSpan.FromHours(8);
    private readonly Lock _lock = new();
    private readonly Func<DateTimeOffset> _utcNow;
    private string? _token;
    private byte[]? _tokenHash;
    private DateTimeOffset? _expiresAt;

    public SharingService() : this(() => DateTimeOffset.UtcNow) { }
    internal SharingService(Func<DateTimeOffset> utcNow) => _utcNow = utcNow;

    public SharingState State(HttpContext context)
    {
        lock (_lock) return Current(context);
    }

    public SharingState Set(bool enabled, HttpContext context)
    {
        lock (_lock)
        {
            Clear();
            if (enabled)
            {
                _token = Base64Url(RandomNumberGenerator.GetBytes(32));
                _tokenHash = Hash(_token);
                _expiresAt = _utcNow().Add(SharingDuration);
            }
            return Current(context);
        }
    }

    public bool TryValidate(string? token, out DateTimeOffset expiresAt)
    {
        lock (_lock)
        {
            expiresAt = default;
            if (!IsActive() || string.IsNullOrWhiteSpace(token) || _tokenHash is null) return false;
            var suppliedHash = Hash(token);
            if (!CryptographicOperations.FixedTimeEquals(_tokenHash, suppliedHash)) return false;
            expiresAt = _expiresAt!.Value;
            return true;
        }
    }

    private SharingState Current(HttpContext context)
    {
        if (!IsActive())
        {
            Clear();
            return new(false, null, null);
        }
        var origin = $"{context.Request.Scheme}://{context.Request.Host}";
        return new(true, $"{origin}/?share={Uri.EscapeDataString(_token!)}", _expiresAt!.Value.ToString("O"));
    }

    private bool IsActive() => _token is not null && _tokenHash is not null && _expiresAt > _utcNow();
    private void Clear() { _token = null; _tokenHash = null; _expiresAt = null; }
    private static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));
    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public static class AdminEndpoints
{
    public static IEndpointRouteBuilder MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/sharing",(HttpContext context,SharingService sharing)=>Admin(context)?Results.Ok(sharing.State(context)):Results.Forbid()).WithTags("Sharing");
        app.MapPost("/api/admin/sharing",async(JsonElement input,HttpContext context,SharingService sharing,AuthService auth,CancellationToken token)=>
        {
            if(!Admin(context))return Results.Forbid();
            var state=sharing.Set(input.TryGetProperty("enabled",out var value)&&value.ValueKind==JsonValueKind.True,context);
            await auth.RevokeViewerSessionsAsync(token);
            return Results.Ok(state);
        }).WithTags("Sharing");
        app.MapGet("/api/admin/insights",async(HttpContext context,NpgsqlDataSource database,CancellationToken token)=>
        {
            if(!Admin(context))return Results.Forbid();var owner=Session(context).User.Id;
            const string totals="SELECT (SELECT COUNT(*) FROM messages m JOIN archives a ON a.id=m.archive_id WHERE a.owner_user_id=$1),(SELECT COUNT(*) FROM attachments x JOIN messages m ON m.id=x.message_id JOIN archives a ON a.id=m.archive_id WHERE a.owner_user_id=$1)";await using var command=database.CreateCommand(totals);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);await reader.ReadAsync(token);var messages=reader.GetInt64(0);var attachments=reader.GetInt64(1);await reader.CloseAsync();
            async Task<List<object>> Contacts(string column){var sql=$"SELECT lower(trim({column})),MAX(NULLIF(trim(m.sender_name),'')),COUNT(*) FROM messages m JOIN archives a ON a.id=m.archive_id WHERE a.owner_user_id=$1 AND trim({column})<>'' GROUP BY lower(trim({column})) ORDER BY COUNT(*) DESC LIMIT 20";await using var item=database.CreateCommand(sql);item.Parameters.AddWithValue(owner);await using var rows=await item.ExecuteReaderAsync(token);var list=new List<object>();while(await rows.ReadAsync(token))list.Add(new{address=rows.GetString(0),name=rows.IsDBNull(1)?null:rows.GetString(1),count=rows.GetInt64(2)});return list;}
            const string endpoints="SELECT m.id,m.subject,m.sender_name,m.sender_address,COALESCE(m.received_at,m.sent_at,m.created_at) FROM messages m JOIN archives a ON a.id=m.archive_id WHERE a.owner_user_id=$1 ORDER BY COALESCE(m.received_at,m.sent_at,m.created_at) ASC LIMIT 1";async Task<object?> Endpoint(bool newest){await using var item=database.CreateCommand(endpoints.Replace(" ASC ",newest?" DESC ":" ASC "));item.Parameters.AddWithValue(owner);await using var row=await item.ExecuteReaderAsync(token);return await row.ReadAsync(token)?new{id=row.GetString(0),subject=row.GetString(1),senderName=row.IsDBNull(2)?null:row.GetString(2),senderAddress=row.GetString(3),date=row.GetString(4)}:null;}
            return Results.Ok(new{generatedAt=DateTimeOffset.UtcNow.ToString("O"),totalMessages=messages,totalAttachments=attachments,endpoints=new{oldest=await Endpoint(false),newest=await Endpoint(true)},topSenders=await Contacts("m.sender_address"),topRecipients=System.Array.Empty<object>(),analysis=(object?)null});
        }).WithTags("Administration");
        return app;
    }
    private static SessionRecord Session(HttpContext context)=>(SessionRecord)context.Items[AuthService.SessionItemKey]!;private static bool Admin(HttpContext context)=>Session(context).Role=="admin";
}
