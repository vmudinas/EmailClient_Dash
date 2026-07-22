using System.Net;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class GmailEndpoints
{
    public static IEndpointRouteBuilder MapGmailEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/gmail/connections", async (HttpContext context,GmailService gmail,CancellationToken token)=>Results.Ok(await gmail.ListAsync(Session(context).User.Id,token))).WithName("ListGmailConnections").WithTags("Gmail");
        app.MapPost("/api/gmail/oauth/start", (JsonElement request,HttpContext context,GmailService gmail)=>
        {try{var publicUrl=Environment.GetEnvironmentVariable("EMAIL_CLIENT_PUBLIC_URL")?.TrimEnd('/');var redirect=$"{(string.IsNullOrWhiteSpace(publicUrl)?$"{context.Request.Scheme}://{context.Request.Host}":publicUrl)}/api/gmail/oauth/callback";return Results.Ok(gmail.StartAuthorization(request,Session(context).User.Id,redirect));}catch(Exception error){return Results.Problem(error.Message,statusCode:503);}}).WithName("StartGmailOAuth").WithTags("Gmail");
        app.MapGet("/api/gmail/oauth/callback",async(string? code,string? state,string? error,string? error_description,GmailService gmail,CancellationToken token)=>
        {if(!string.IsNullOrWhiteSpace(error))return Results.Content(Page("Gmail was not connected",error_description??error),"text/html",Encoding.UTF8,400);if(string.IsNullOrWhiteSpace(code)||string.IsNullOrWhiteSpace(state))return Results.Content(Page("Gmail was not connected","The authorization response was incomplete."),"text/html",Encoding.UTF8,400);try{var connection=await gmail.FinishAuthorizationAsync(state,code,token);return Results.Content(Page("Gmail connected",$"{connection.Email} is syncing into {connection.ArchiveName} / {connection.FolderPath}. You can return to Archive Mail."),"text/html");}catch(Exception exception){return Results.Content(Page("Gmail was not connected",exception.Message),"text/html",Encoding.UTF8,400);}}).WithName("FinishGmailOAuth").WithTags("Gmail");
        app.MapPost("/api/gmail/connections/{connectionId}/sync",async(string connectionId,JsonElement request,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.StartSyncAsync(connectionId,Session(context).User.Id,request.ValueKind==JsonValueKind.Object&&request.TryGetProperty("full",out var full)&&full.ValueKind==JsonValueKind.True,token));}catch(Exception error){return Failure(error);}}).WithName("SyncGmail").WithTags("Gmail");
        app.MapPost("/api/gmail/connections/{connectionId}/cancel",async(string connectionId,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.CancelAsync(connectionId,Session(context).User.Id,token));}catch(Exception error){return Failure(error);}}).WithName("CancelGmailSync").WithTags("Gmail");
        app.MapPost("/api/gmail/connections/{connectionId}/reconcile",async(string connectionId,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.StartSyncAsync(connectionId,Session(context).User.Id,false,token));}catch(Exception error){return Failure(error);}}).WithName("ReconcileGmail").WithTags("Gmail");
        app.MapPost("/api/gmail/connections/{connectionId}/reorganize",async(string connectionId,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.StartSyncAsync(connectionId,Session(context).User.Id,true,token));}catch(Exception error){return Failure(error);}}).WithName("ReorganizeGmail").WithTags("Gmail");
        app.MapPost("/api/gmail/connections/{connectionId}/send",async(string connectionId,JsonElement request,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.SendAsync(connectionId,Session(context).User.Id,request,token));}catch(Exception error){return Failure(error);}}).WithName("SendGmailMessage").WithTags("Gmail");
        app.MapGet("/api/gmail/connections/{connectionId}/send-as",async(string connectionId,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.SendAsAsync(connectionId,Session(context).User.Id,token));}catch(Exception error){return Failure(error);}}).WithName("ListGmailSendAs").WithTags("Gmail");
        app.MapDelete("/api/gmail/connections/{connectionId}",async(string connectionId,HttpContext context,GmailService gmail,CancellationToken token)=>{try{await gmail.DeleteAsync(connectionId,Session(context).User.Id,token);return Results.NoContent();}catch(Exception error){return Failure(error);}}).WithName("DeleteGmailConnection").WithTags("Gmail");
        return app;
    }

    private static SessionRecord Session(HttpContext context)=>(SessionRecord)context.Items[AuthService.SessionItemKey]!;
    private static IResult Failure(Exception error)=>error is KeyNotFoundException?Results.NotFound(new{error=error.Message}):error is ArgumentException?Results.BadRequest(new{error=error.Message}):Results.Conflict(new{error=error.Message});
    private static string Page(string title,string message){var encoder=HtmlEncoder.Default;return $"<!doctype html><html><head><meta charset=\"utf-8\"><title>{encoder.Encode(title)}</title></head><body><main><h1>{encoder.Encode(title)}</h1><p>{encoder.Encode(message)}</p><script>if(window.opener)window.opener.postMessage({{type:'archive-mail-gmail-oauth'}},window.location.origin);</script></main></body></html>";}
}
