using System.Text.Json;
using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public static class AiEndpoints
{
    public static IEndpointRouteBuilder MapAiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/messages/{messageId}/ai",async(string messageId,HttpContext context,AiService ai,CancellationToken token)=>
        {try{return Results.Ok(await ai.MessageStateAsync(messageId,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapPost("/api/messages/{messageId}/ai/analyze",async(string messageId,HttpContext context,AiService ai,CancellationToken token)=>
        {try{return Results.Accepted(value:await ai.StartAnalysisAsync(messageId,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapPost("/api/messages/{messageId}/ai/action-suggestion",async(string messageId,JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>{try{return Results.Ok(await ai.SuggestActionAsync(messageId,input,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapPost("/api/messages/ai/filing-suggestion",async(JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>{try{var ids=input.TryGetProperty("messageIds",out var values)?values.EnumerateArray().Select(value=>value.GetString()??"").ToArray():[];return Results.Ok(await ai.SuggestFilingAsync(ids,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapPost("/api/messages/{messageId}/ai/draft-reply",async(string messageId,JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>{try{return Results.Accepted(value:await ai.StartDraftAsync(messageId,input,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapGet("/api/ai/jobs/{jobId}",async(string jobId,HttpContext context,AiService ai,CancellationToken token)=>
            await ai.GetJobAsync(jobId,Session(context).User.Id,token) is{} job?Results.Ok(job):Results.NotFound(new{error="AI job not found"})).WithTags("AI");
        app.MapPost("/api/ai/jobs/{jobId}/cancel",async(string jobId,HttpContext context,AiService ai,CancellationToken token)=>
            await ai.CancelAsync(jobId,Session(context).User.Id,token) is{} job?Results.Ok(job):Results.NotFound(new{error="AI job not found"})).WithTags("AI");
        app.MapGet("/api/ai/review-queue",async(HttpContext context,AiService ai,CancellationToken token)=>Results.Ok(await ai.ReviewQueueAsync(Session(context).User.Id,token))).WithTags("AI");
        app.MapPost("/api/ai/review-queue/filing-proposals",async(JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>
        {try{var ids=input.TryGetProperty("messageIds",out var values)?values.EnumerateArray().Select(value=>value.GetString()??"").ToArray():[];var contentOnly=input.TryGetProperty("contentOnly",out var content)&&content.ValueKind==JsonValueKind.True;return Results.Ok(await ai.FilingProposalsAsync(ids,contentOnly,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapPost("/api/ai/review-queue/review-all",async(HttpContext context,AiService ai,CancellationToken token)=>Results.Ok(await ai.ReviewAllAsync(Session(context).User.Id,token))).WithTags("AI");
        app.MapPost("/api/messages/{messageId}/ai/review",async(string messageId,HttpContext context,AiService ai,CancellationToken token)=>
        {try{return Results.Ok(await ai.ReviewAsync(messageId,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");

        app.MapPost("/api/ai/ask",async(JsonElement input,HttpContext context,AskService ask,CancellationToken token)=>
        {try{return Results.Ok(await ask.AskAsync(input,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI");
        app.MapGet("/api/ai/ask/history",async(HttpContext context,AskService ask,CancellationToken token)=>Results.Ok(await ask.HistoryAsync(Session(context).User.Id,token))).WithTags("AI");

        app.MapGet("/api/ai/duplicates",async(string? status,HttpContext context,DeduplicationService duplicates,CancellationToken token)=>Results.Ok(await duplicates.ListGroupsAsync(status,Session(context).User.Id,token))).WithTags("AI duplicates");
        app.MapGet("/api/ai/duplicates/{groupId}",async(string groupId,HttpContext context,DeduplicationService duplicates,CancellationToken token)=>
            await duplicates.GetGroupAsync(groupId,Session(context).User.Id,token) is{} group?Results.Ok(group):Results.NotFound(new{error="Duplicate group not found"})).WithTags("AI duplicates");
        app.MapPatch("/api/ai/duplicates/{groupId}",async(string groupId,JsonElement input,HttpContext context,DeduplicationService duplicates,CancellationToken token)=>
        {try{return await duplicates.UpdateGroupAsync(groupId,input,Session(context).User.Id,token) is{} group?Results.Ok(group):Results.NotFound(new{error="Duplicate group not found"});}catch(Exception error){return Error(error);}}).WithTags("AI duplicates");
        // Enqueue only - the scan itself runs in DuplicateScanCoordinator. Running it inline here
        // is what produced the 504s, so this endpoint must never do more than write one row.
        app.MapPost("/api/ai/duplicates/scan",async(HttpContext context,DeduplicationService duplicates,CancellationToken token)=>
        {try{return Results.Accepted(value:await duplicates.EnqueueScanAsync(Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI duplicates");
        app.MapGet("/api/ai/duplicates/scan",async(HttpContext context,DeduplicationService duplicates,CancellationToken token)=>
        {try{return Results.Ok(await duplicates.LatestScanAsync(Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI duplicates");
        app.MapPost("/api/ai/duplicates/scan/cancel",async(HttpContext context,DeduplicationService duplicates,CancellationToken token)=>
            await duplicates.CancelScanAsync(Session(context).User.Id,token) is{} scan?Results.Ok(scan):Results.NotFound(new{error="No duplicate scan is running"})).WithTags("AI duplicates");

        app.MapGet("/api/admin/ai-schedules",async(HttpContext context,AiService ai,CancellationToken token)=>Admin(context)?Results.Ok(await ai.ListSchedulesAsync(Session(context).User.Id,token)):Results.Forbid()).WithTags("AI schedules");
        app.MapPost("/api/admin/ai-schedules",async(JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>
        {if(!Admin(context))return Results.Forbid();try{return Results.Ok(await ai.CreateScheduleAsync(input,Session(context).User.Id,token));}catch(Exception error){return Error(error);}}).WithTags("AI schedules");
        app.MapPatch("/api/admin/ai-schedules/{scheduleId}",async(string scheduleId,JsonElement input,HttpContext context,AiService ai,CancellationToken token)=>
        {if(!Admin(context))return Results.Forbid();try{return await ai.UpdateScheduleAsync(scheduleId,input,Session(context).User.Id,token) is{} value?Results.Ok(value):Results.NotFound(new{error="AI schedule not found"});}catch(Exception error){return Error(error);}}).WithTags("AI schedules");
        app.MapDelete("/api/admin/ai-schedules/{scheduleId}",async(string scheduleId,HttpContext context,AiService ai,CancellationToken token)=>
        {if(!Admin(context))return Results.Forbid();await ai.DeleteScheduleAsync(scheduleId,Session(context).User.Id,token);return Results.NoContent();}).WithTags("AI schedules");
        app.MapPost("/api/admin/ai-schedules/{scheduleId}/run",async(string scheduleId,HttpContext context,AiService ai,CancellationToken token)=>
        {if(!Admin(context))return Results.Forbid();return await ai.RunScheduleAsync(scheduleId,Session(context).User.Id,token) is{} value?Results.Ok(value):Results.NotFound(new{error="AI schedule not found"});}).WithTags("AI schedules");
        return app;
    }
    private static SessionRecord Session(HttpContext context)=>(SessionRecord)context.Items[AuthService.SessionItemKey]!;
    private static bool Admin(HttpContext context)=>Session(context).Role=="admin";
    private static IResult Error(Exception error)=>error switch{MailNotFoundException=>Results.NotFound(new{error=error.Message}),ArgumentException=>Results.BadRequest(new{error=error.Message}),InvalidOperationException=>Results.Json(new{error=error.Message},statusCode:503),TimeoutException=>Results.Json(new{error=MailEndpoints.DatabaseBusyMessage},statusCode:503),NpgsqlException and not PostgresException=>Results.Json(new{error=MailEndpoints.DatabaseBusyMessage},statusCode:503),_=>throw error};
}
