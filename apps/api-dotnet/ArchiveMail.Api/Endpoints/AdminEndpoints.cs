using System.Text.Json;
using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public static class AdminEndpoints
{
    public static IEndpointRouteBuilder MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
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
