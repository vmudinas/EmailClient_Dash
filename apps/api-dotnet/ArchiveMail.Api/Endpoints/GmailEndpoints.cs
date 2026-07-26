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
        {try{var redirect=GoogleOAuthRedirect.Resolve(Environment.GetEnvironmentVariable("EMAIL_CLIENT_PUBLIC_URL"),context.Request.Scheme,context.Request.Host);return Results.Ok(gmail.StartAuthorization(request,Session(context).User.Id,redirect));}catch(Exception error){return Results.Json(new{error=error.Message},statusCode:503);}}).WithName("StartGmailOAuth").WithTags("Gmail");
        app.MapGet("/api/gmail/oauth/callback",async(string? code,string? state,string? error,string? error_description,GmailService gmail,CancellationToken token)=>
        {
            if(!string.IsNullOrWhiteSpace(error))return Results.Content(Page("Gmail was not connected",error_description??error,false),"text/html",Encoding.UTF8,400);
            if(string.IsNullOrWhiteSpace(code)||string.IsNullOrWhiteSpace(state))return Results.Content(Page("Gmail was not connected","The authorization response was incomplete.",false),"text/html",Encoding.UTF8,400);
            try
            {
                var connection=await gmail.FinishAuthorizationAsync(state,code,token);
                return Results.Content(Page("Gmail connected",$"{connection.Email} is syncing into {connection.ArchiveName} / {connection.FolderPath}.",true),"text/html");
            }
            catch(Exception exception)
            {
                return Results.Content(Page("Gmail was not connected",exception.Message,false),"text/html",Encoding.UTF8,400);
            }
        }).WithName("FinishGmailOAuth").WithTags("Gmail");
        // Moving a connection is not a reauthorization: the Google grant stays exactly as it is and
        // only the archive and mailbox future syncs land in change. Reauthorizing deliberately
        // cannot do this - it pins the connection's existing destination - so this is the route.
        app.MapMethods("/api/gmail/connections/{connectionId}/destination",["PATCH"],async(string connectionId,JsonElement request,HttpContext context,GmailService gmail,CancellationToken token)=>{try{return Results.Ok(await gmail.MoveAsync(connectionId,Session(context).User.Id,request,token));}catch(Exception error){return Failure(error);}}).WithName("MoveGmailConnection").WithTags("Gmail");
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
    internal static string Page(string title,string message,bool success)
    {
        var encoder=HtmlEncoder.Default;
        var payload=JsonSerializer.Serialize(new{type="archive-mail-gmail-oauth",success,message});
        return $"<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{encoder.Encode(title)}</title></head><body><main><h1>{encoder.Encode(title)}</h1><p>{encoder.Encode(message)}</p><p>{(success?"This window will close automatically.":"Return to Archive Mail and try again after correcting the error.")}</p><script>(()=>{{const result={payload};try{{localStorage.setItem('archive-mail-gmail-oauth-result',JSON.stringify({{...result,completedAt:Date.now()}}));}}catch{{}}if(window.opener)window.opener.postMessage(result,window.location.origin);if(result.success)setTimeout(()=>window.close(),500);}})();</script></main></body></html>";
    }
}

internal static class GoogleOAuthRedirect
{
    internal static string Resolve(string? configuredPublicUrl,string requestScheme,HostString requestHost)
    {
        var origin=string.IsNullOrWhiteSpace(configuredPublicUrl)?$"{requestScheme}://{requestHost}":configuredPublicUrl.Trim().TrimEnd('/');
        if(!Uri.TryCreate(origin,UriKind.Absolute,out var uri)||!string.IsNullOrEmpty(uri.UserInfo)||!string.IsNullOrEmpty(uri.Query)||!string.IsNullOrEmpty(uri.Fragment)||uri.AbsolutePath!="/")
            throw new InvalidOperationException("EMAIL_CLIENT_PUBLIC_URL must be one HTTPS origin without a path, query, credentials, or fragment");
        var loopback=uri.IsLoopback&&(uri.Scheme==Uri.UriSchemeHttp||uri.Scheme==Uri.UriSchemeHttps);
        var rawIp=System.Net.IPAddress.TryParse(uri.Host,out _);
        if(!loopback&&(uri.Scheme!=Uri.UriSchemeHttps||rawIp||uri.Host.EndsWith(".local",StringComparison.OrdinalIgnoreCase)||!uri.Host.Contains('.')))
            throw new InvalidOperationException($"Google rejected the insecure OAuth callback {origin}/api/gmail/oauth/callback. Set EMAIL_CLIENT_PUBLIC_URL to an HTTPS domain you own, create a Google Web application OAuth client, and register that exact /api/gmail/oauth/callback URL in Google Cloud.");
        return $"{uri.Scheme}://{uri.Authority}/api/gmail/oauth/callback";
    }
}
