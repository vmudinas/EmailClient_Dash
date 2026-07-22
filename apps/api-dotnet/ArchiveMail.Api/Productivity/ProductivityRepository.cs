using System.Security.Cryptography;
using System.Text.Json;
using Npgsql;
using NpgsqlTypes;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;

namespace ArchiveMail.Api.Productivity;

public sealed record DraftDto(
    string Id, string ConnectionId, string ConnectionEmail, string? SourceMessageId,
    string? SourceMessageSubject, string? ScheduleId, string? ScheduleName, string Source,
    string? FromAddress, string[] To, string[] Cc, string[] Bcc, string Subject, string BodyText,
    string? ResumeId, string? ResumeName, string? ResumeFilename, bool? WorkRelated,
    bool? DevelopmentOpportunity, string? AiReason, double? AiConfidence, string CreatedAt, string UpdatedAt);
public sealed record ReplyStyleDto(string Id, string Name, string Tone, string Instructions, bool IsDefault, string CreatedAt, string UpdatedAt);
public sealed record ResumeDto(string Id, string Name, string Filename, string ContentType, long SizeBytes, string CreatedAt, string UpdatedAt);
public sealed record ResumeContent(string Filename, string ContentType, string FullPath);

public sealed class ProductivityRepository(NpgsqlDataSource database, ActiveDatabaseConfiguration active)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<IReadOnlyList<DraftDto>> ListDraftsAsync(string owner, CancellationToken token)
    {
        const string sql = """
            SELECT d.id,d.connection_id,g.email,d.source_message_id,m.subject,d.schedule_id,s.name,d.source,
              d.from_address,d.to_json,d.cc_json,d.bcc_json,d.subject,d.body_text,d.resume_id,r.name,r.filename,
              d.work_related,d.development_opportunity,d.ai_reason,d.ai_confidence,d.created_at,d.updated_at
            FROM email_drafts d JOIN gmail_connections g ON g.id=d.connection_id
            JOIN archives a ON a.id=g.archive_id LEFT JOIN messages m ON m.id=d.source_message_id
            LEFT JOIN ai_schedules s ON s.id=d.schedule_id LEFT JOIN resume_assets r ON r.id=d.resume_id
            WHERE a.owner_user_id=$1 ORDER BY d.updated_at DESC
            """;
        await using var command = database.CreateCommand(sql); command.Parameters.AddWithValue(owner);
        await using var reader = await command.ExecuteReaderAsync(token); var result = new List<DraftDto>();
        while (await reader.ReadAsync(token)) result.Add(ReadDraft(reader)); return result;
    }

    public async Task<DraftDto> CreateDraftAsync(JsonElement input, string owner, CancellationToken token)
    {
        var connectionId = Required(input, "connectionId");
        if (!await OwnsConnectionAsync(connectionId, owner, token)) throw new MailNotFoundException("Gmail connection not found");
        var id = Guid.NewGuid().ToString(); var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO email_drafts(id,connection_id,source_message_id,source,from_address,to_json,cc_json,bcc_json,
              subject,body_text,resume_id,created_at,updated_at)
            VALUES($1,$2,$3,'manual',$4,$5,$6,$7,$8,$9,$10,$11,$11)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id); command.Parameters.AddWithValue(connectionId);
        AddNullable(command, Source(input, "sourceMessageId")); AddNullable(command, Source(input, "fromAddress"));
        command.Parameters.AddWithValue(JsonSerializer.Serialize(Strings(input, "to"), JsonOptions));
        command.Parameters.AddWithValue(JsonSerializer.Serialize(Strings(input, "cc"), JsonOptions));
        command.Parameters.AddWithValue(JsonSerializer.Serialize(Strings(input, "bcc"), JsonOptions));
        command.Parameters.AddWithValue(Source(input, "subject") ?? ""); command.Parameters.AddWithValue(Source(input, "bodyText") ?? "");
        AddNullable(command, Source(input, "resumeId")); command.Parameters.AddWithValue(now);
        await command.ExecuteNonQueryAsync(token); return (await GetDraftAsync(id, owner, token))!;
    }

    public async Task<DraftDto> UpdateDraftAsync(string id, JsonElement input, string owner, CancellationToken token)
    {
        var current = await GetDraftAsync(id, owner, token) ?? throw new MailNotFoundException("Draft not found");
        var connectionId = Source(input, "connectionId") ?? current.ConnectionId;
        if (!await OwnsConnectionAsync(connectionId, owner, token)) throw new MailNotFoundException("Gmail connection not found");
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            UPDATE email_drafts SET connection_id=$2,from_address=$3,to_json=$4,cc_json=$5,bcc_json=$6,
              subject=$7,body_text=$8,resume_id=$9,updated_at=$10 WHERE id=$1
            """;
        await using var command = database.CreateCommand(sql); command.Parameters.AddWithValue(id); command.Parameters.AddWithValue(connectionId);
        AddNullable(command, input.TryGetProperty("fromAddress", out _) ? Source(input, "fromAddress") : current.FromAddress);
        command.Parameters.AddWithValue(JsonSerializer.Serialize(input.TryGetProperty("to", out _) ? Strings(input, "to") : current.To, JsonOptions));
        command.Parameters.AddWithValue(JsonSerializer.Serialize(input.TryGetProperty("cc", out _) ? Strings(input, "cc") : current.Cc, JsonOptions));
        command.Parameters.AddWithValue(JsonSerializer.Serialize(input.TryGetProperty("bcc", out _) ? Strings(input, "bcc") : current.Bcc, JsonOptions));
        command.Parameters.AddWithValue(Source(input, "subject") ?? current.Subject); command.Parameters.AddWithValue(Source(input, "bodyText") ?? current.BodyText);
        AddNullable(command, input.TryGetProperty("resumeId", out _) ? Source(input, "resumeId") : current.ResumeId); command.Parameters.AddWithValue(now);
        await command.ExecuteNonQueryAsync(token); return (await GetDraftAsync(id, owner, token))!;
    }

    public async Task DeleteDraftAsync(string id, string owner, CancellationToken token)
    {
        const string sql = "DELETE FROM email_drafts d USING gmail_connections g,archives a " +
            "WHERE d.id=$1 AND g.id=d.connection_id AND a.id=g.archive_id AND a.owner_user_id=$2";
        await using var command = database.CreateCommand(sql); command.Parameters.AddWithValue(id); command.Parameters.AddWithValue(owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("Draft not found");
    }

    public async Task<IReadOnlyList<ReplyStyleDto>> ListReplyStylesAsync(CancellationToken token)
    {
        await using var command = database.CreateCommand("SELECT id,name,tone,instructions,is_default<>0,created_at,updated_at FROM reply_styles ORDER BY is_default DESC,lower(name)");
        await using var reader = await command.ExecuteReaderAsync(token); var result = new List<ReplyStyleDto>();
        while (await reader.ReadAsync(token)) result.Add(new(reader.GetString(0),reader.GetString(1),reader.GetString(2),reader.GetString(3),reader.GetBoolean(4),reader.GetString(5),reader.GetString(6))); return result;
    }

    public async Task<ReplyStyleDto> CreateReplyStyleAsync(JsonElement input, CancellationToken token)
    {
        var id=Guid.NewGuid().ToString(); var now=DateTimeOffset.UtcNow.ToString("O"); var isDefault=Boolean(input,"isDefault")??false;
        await using var connection=await database.OpenConnectionAsync(token); await using var tx=await connection.BeginTransactionAsync(token);
        if(isDefault){await using var clear=new NpgsqlCommand("UPDATE reply_styles SET is_default=0",connection,tx);await clear.ExecuteNonQueryAsync(token);}
        const string sql="INSERT INTO reply_styles(id,name,tone,instructions,is_default,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)";
        await using var command=new NpgsqlCommand(sql,connection,tx);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(Required(input,"name"));command.Parameters.AddWithValue(Required(input,"tone"));command.Parameters.AddWithValue(Required(input,"instructions"));command.Parameters.AddWithValue(isDefault?1:0);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);await tx.CommitAsync(token);
        return (await FindReplyStyleAsync(id,token))!;
    }

    public async Task<ReplyStyleDto> UpdateReplyStyleAsync(string id,JsonElement input,CancellationToken token)
    {
        var current=await FindReplyStyleAsync(id,token)??throw new MailNotFoundException("Reply style not found"); var makeDefault=Boolean(input,"isDefault")??current.IsDefault;var now=DateTimeOffset.UtcNow.ToString("O");
        await using var connection=await database.OpenConnectionAsync(token);await using var tx=await connection.BeginTransactionAsync(token);
        if(makeDefault){await using var clear=new NpgsqlCommand("UPDATE reply_styles SET is_default=0 WHERE id<>$1",connection,tx);clear.Parameters.AddWithValue(id);await clear.ExecuteNonQueryAsync(token);}
        const string sql="UPDATE reply_styles SET name=$2,tone=$3,instructions=$4,is_default=$5,updated_at=$6 WHERE id=$1";await using var command=new NpgsqlCommand(sql,connection,tx);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(Source(input,"name")??current.Name);command.Parameters.AddWithValue(Source(input,"tone")??current.Tone);command.Parameters.AddWithValue(Source(input,"instructions")??current.Instructions);command.Parameters.AddWithValue(makeDefault?1:0);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);await tx.CommitAsync(token);return(await FindReplyStyleAsync(id,token))!;
    }

    public async Task DeleteReplyStyleAsync(string id,CancellationToken token)
    {
        var current=await FindReplyStyleAsync(id,token)??throw new MailNotFoundException("Reply style not found");if(current.IsDefault)throw new MailConflictException("Choose another default reply style before deleting this one");await using var command=database.CreateCommand("DELETE FROM reply_styles WHERE id=$1");command.Parameters.AddWithValue(id);await command.ExecuteNonQueryAsync(token);
    }

    public async Task<IReadOnlyList<ResumeDto>> ListResumesAsync(CancellationToken token)
    {
        await using var command=database.CreateCommand("SELECT id,name,filename,content_type,size_bytes,created_at,updated_at FROM resume_assets ORDER BY created_at DESC");await using var reader=await command.ExecuteReaderAsync(token);var result=new List<ResumeDto>();while(await reader.ReadAsync(token))result.Add(new(reader.GetString(0),reader.GetString(1),reader.GetString(2),reader.GetString(3),reader.GetInt64(4),reader.GetString(5),reader.GetString(6)));return result;
    }

    public async Task<ResumeDto> SaveResumeAsync(string name,string filename,string contentType,Stream body,CancellationToken token)
    {
        var directory=Path.Combine(active.DataDirectory,"resumes");Directory.CreateDirectory(directory);var id=Guid.NewGuid().ToString();var temporary=Path.Combine(directory,$"{id}.tmp");await using(var output=File.Create(temporary)){await body.CopyToAsync(output,token);}
        var info=new FileInfo(temporary);if(info.Length is <1 or >20_000_000){File.Delete(temporary);throw new ArgumentException("Resume must be between 1 byte and 20 MB");}
        var hash=Convert.ToHexString(await SHA256.HashDataAsync(File.OpenRead(temporary),token)).ToLowerInvariant();var relative=$"resumes/{hash}";var final=Path.Combine(active.DataDirectory,relative);if(!File.Exists(final))File.Move(temporary,final);else File.Delete(temporary);var now=DateTimeOffset.UtcNow.ToString("O");
        const string sql="INSERT INTO resume_assets(id,name,filename,content_type,sha256,relative_path,size_bytes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(name.Trim());command.Parameters.AddWithValue(Path.GetFileName(filename));command.Parameters.AddWithValue(contentType);command.Parameters.AddWithValue(hash);command.Parameters.AddWithValue(relative);command.Parameters.AddWithValue(info.Length);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);return new(id,name.Trim(),Path.GetFileName(filename),contentType,info.Length,now,now);
    }

    public async Task<ResumeContent?> GetResumeContentAsync(string id,CancellationToken token)
    {const string sql="SELECT filename,content_type,relative_path FROM resume_assets WHERE id=$1";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);await using var reader=await command.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))return null;var path=Path.GetFullPath(Path.Combine(active.DataDirectory,reader.GetString(2)));if(!path.StartsWith(Path.GetFullPath(active.DataDirectory)+Path.DirectorySeparatorChar,StringComparison.Ordinal)||!File.Exists(path))return null;return new(reader.GetString(0),reader.GetString(1),path);}
    public async Task DeleteResumeAsync(string id,CancellationToken token){await using var command=database.CreateCommand("DELETE FROM resume_assets WHERE id=$1");command.Parameters.AddWithValue(id);if(await command.ExecuteNonQueryAsync(token)==0)throw new MailNotFoundException("Resume not found");}

    private async Task<DraftDto?> GetDraftAsync(string id,string owner,CancellationToken token){var all=await ListDraftsAsync(owner,token);return all.FirstOrDefault(item=>item.Id==id);}
    private async Task<bool> OwnsConnectionAsync(string id,string owner,CancellationToken token){const string sql="SELECT EXISTS(SELECT 1 FROM gmail_connections g JOIN archives a ON a.id=g.archive_id WHERE g.id=$1 AND a.owner_user_id=$2)";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);return Convert.ToBoolean(await command.ExecuteScalarAsync(token));}
    private async Task<ReplyStyleDto?> FindReplyStyleAsync(string id,CancellationToken token){await using var command=database.CreateCommand("SELECT id,name,tone,instructions,is_default<>0,created_at,updated_at FROM reply_styles WHERE id=$1");command.Parameters.AddWithValue(id);await using var reader=await command.ExecuteReaderAsync(token);return await reader.ReadAsync(token)?new(reader.GetString(0),reader.GetString(1),reader.GetString(2),reader.GetString(3),reader.GetBoolean(4),reader.GetString(5),reader.GetString(6)):null;}
    private static DraftDto ReadDraft(NpgsqlDataReader r)=>new(r.GetString(0),r.GetString(1),r.GetString(2),r.IsDBNull(3)?null:r.GetString(3),r.IsDBNull(4)?null:r.GetString(4),r.IsDBNull(5)?null:r.GetString(5),r.IsDBNull(6)?null:r.GetString(6),r.GetString(7),r.IsDBNull(8)?null:r.GetString(8),Parse(r.GetString(9)),Parse(r.GetString(10)),Parse(r.GetString(11)),r.GetString(12),r.GetString(13),r.IsDBNull(14)?null:r.GetString(14),r.IsDBNull(15)?null:r.GetString(15),r.IsDBNull(16)?null:r.GetString(16),r.IsDBNull(17)?null:r.GetInt64(17)!=0,r.IsDBNull(18)?null:r.GetInt64(18)!=0,r.IsDBNull(19)?null:r.GetString(19),r.IsDBNull(20)?null:r.GetDouble(20),r.GetString(21),r.GetString(22));
    private static string[] Parse(string json){try{return JsonSerializer.Deserialize<string[]>(json,JsonOptions)??[];}catch{return[];}}
    private static string Required(JsonElement value,string name)=>Source(value,name) is {Length:>0} result?result:throw new ArgumentException($"{name} is required");
    private static string? Source(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.String?item.GetString():null;
    private static string[] Strings(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.Array?item.EnumerateArray().Where(x=>x.ValueKind==JsonValueKind.String).Select(x=>x.GetString()??"").ToArray():[];
    private static bool? Boolean(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind is JsonValueKind.True or JsonValueKind.False?item.GetBoolean():null;
    private static void AddNullable(NpgsqlCommand command,string? value)=>command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Text,Value=(object?)value??DBNull.Value});
}
