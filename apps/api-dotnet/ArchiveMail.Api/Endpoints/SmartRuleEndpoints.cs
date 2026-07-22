using System.Text.Json;
using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class SmartRuleEndpoints
{
    public static IEndpointRouteBuilder MapSmartRuleEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/smart-mail-rules",async(string? archiveId,HttpContext context,SmartRuleService rules,CancellationToken token)=>Results.Ok(await rules.ListAsync(archiveId,Session(context).User.Id,token))).WithTags("Smart mail rules");
        app.MapPost("/api/admin/smart-mail-rules/suggest",(JsonElement input,SmartRuleService rules)=>{try{return Results.Ok(rules.Suggest(input));}catch(Exception error){return Error(error);}}).WithTags("Smart mail rules");
        app.MapPost("/api/admin/smart-mail-rules",async(JsonElement input,HttpContext context,SmartRuleService rules,CancellationToken token)=>{try{return Results.Ok(await rules.CreateAsync(input,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("Smart mail rules");
        app.MapPatch("/api/admin/smart-mail-rules/{ruleId}",async(string ruleId,JsonElement input,HttpContext context,SmartRuleService rules,CancellationToken token)=>{try{return await rules.UpdateAsync(ruleId,input,Session(context).User.Id,token)is{} value?Results.Ok(value):Results.NotFound(new{error="Mail rule not found"});}catch(Exception error){return Error(error);}}).WithTags("Smart mail rules");
        app.MapDelete("/api/admin/smart-mail-rules/{ruleId}",async(string ruleId,HttpContext context,SmartRuleService rules,CancellationToken token)=>{try{await rules.DeleteAsync(ruleId,Session(context).User.Id,token);return Results.NoContent();}catch(Exception error){return Error(error);}}).WithTags("Smart mail rules");
        app.MapPost("/api/admin/smart-mail-rules/{ruleId}/run",async(string ruleId,JsonElement input,HttpContext context,SmartRuleService rules,CancellationToken token)=>{var owner=Session(context).User.Id;var rule=(await rules.ListAsync(null,owner,token)).FirstOrDefault(value=>value.GetType().GetProperty("id")?.GetValue(value)?.ToString()==ruleId);if(rule is null)return Results.NotFound(new{error="Mail rule not found"});var archive=rule.GetType().GetProperty("archiveId")!.GetValue(rule)!.ToString()!;var scope=input.TryGetProperty("scope",out var value)?value.GetString()??"inbox":"inbox";return Results.Accepted(value:await rules.EnqueueAsync(archive,[ruleId],scope,owner,token));}).WithTags("Smart mail rules");
        app.MapPost("/api/admin/smart-mail-rules/run",async(JsonElement input,HttpContext context,SmartRuleService rules,CancellationToken token)=>{try{return Results.Accepted(value:await rules.EnqueueAsync(Required(input,"archiveId"),Strings(input,"ruleIds"),String(input,"scope")??"inbox",Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("Smart mail rules");
        app.MapGet("/api/admin/mailbox-tasks/{taskId}",async(string taskId,HttpContext context,SmartRuleService rules,CancellationToken token)=>await rules.TaskAsync(taskId,Session(context).User.Id,token)is{} task?Results.Ok(task):Results.NotFound(new{error="Mailbox task not found"})).WithTags("Smart mail rules");
        app.MapPost("/api/admin/mailbox-tasks/{taskId}/cancel",async(string taskId,HttpContext context,SmartRuleService rules,CancellationToken token)=>await rules.CancelAsync(taskId,Session(context).User.Id,token)is{} task?Results.Ok(task):Results.NotFound(new{error="Mailbox task not found"})).WithTags("Smart mail rules");
        return app;
    }
    private static SessionRecord Session(HttpContext context)=>(SessionRecord)context.Items[AuthService.SessionItemKey]!;
    private static IResult Error(Exception error)=>error switch{MailNotFoundException=>Results.NotFound(new{error=error.Message}),ArgumentException=>Results.BadRequest(new{error=error.Message}),_=>throw error};
    private static string? String(JsonElement input,string name)=>input.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString():null;
    private static string Required(JsonElement input,string name)=>String(input,name)??throw new ArgumentException($"{name} is required");
    private static string[] Strings(JsonElement input,string name)=>input.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.Array?value.EnumerateArray().Select(item=>item.GetString()??"").Where(item=>item.Length>0).ToArray():[];
}
