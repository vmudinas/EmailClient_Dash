using System.Text.Json;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Productivity;
using ArchiveMail.Api.Security;
using ArchiveMail.Api.Gmail;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public static class ProductivityEndpoints
{
    public static IEndpointRouteBuilder MapProductivityEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/drafts", async (HttpContext context, ProductivityRepository repository, CancellationToken token) =>
            Results.Ok(await repository.ListDraftsAsync(Session(context).User.Id, token)))
            .WithName("ListDrafts").WithTags("Drafts");
        app.MapPost("/api/drafts", async (JsonElement request, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { try { return Results.Json(await repository.CreateDraftAsync(request, Session(context).User.Id, token), statusCode: 201); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("CreateDraft").WithTags("Drafts");
        app.MapMethods("/api/drafts/{draftId}", ["PATCH"], async (string draftId, JsonElement request, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { try { return Results.Ok(await repository.UpdateDraftAsync(draftId, request, Session(context).User.Id, token)); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("UpdateDraft").WithTags("Drafts");
        app.MapDelete("/api/drafts/{draftId}", async (string draftId, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { try { await repository.DeleteDraftAsync(draftId, Session(context).User.Id, token); return Results.NoContent(); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("DeleteDraft").WithTags("Drafts");
        app.MapPost("/api/drafts/{draftId}/send",async(string draftId,HttpContext context,ProductivityRepository repository,GmailService gmail,CancellationToken token)=>
        {try{var owner=Session(context).User.Id;var draft=(await repository.ListDraftsAsync(owner,token)).FirstOrDefault(value=>value.Id==draftId);if(draft is null)return Results.NotFound(new{error="Draft not found"});var input=JsonSerializer.SerializeToElement(new{fromAddress=draft.FromAddress,to=draft.To,cc=draft.Cc,bcc=draft.Bcc,subject=draft.Subject,bodyText=draft.BodyText,resumeId=draft.ResumeId,sourceMessageId=draft.SourceMessageId});var sent=await gmail.SendAsync(draft.ConnectionId,owner,input,token);await repository.DeleteDraftAsync(draftId,owner,token);return Results.Ok(sent);}catch(Exception error){return ProductivityError(error);}}).WithName("SendDraft").WithTags("Drafts");

        app.MapGet("/api/reply-styles", async (ProductivityRepository repository, CancellationToken token) => Results.Ok(await repository.ListReplyStylesAsync(token)))
            .WithName("ListReplyStyles").WithTags("Reply styles");
        app.MapPost("/api/admin/reply-styles", async (JsonElement request, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { if (!Admin(context)) return Results.Forbid(); try { return Results.Json(await repository.CreateReplyStyleAsync(request, token), statusCode: 201); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("CreateReplyStyle").WithTags("Reply styles");
        app.MapMethods("/api/admin/reply-styles/{styleId}", ["PATCH"], async (string styleId, JsonElement request, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { if (!Admin(context)) return Results.Forbid(); try { return Results.Ok(await repository.UpdateReplyStyleAsync(styleId, request, token)); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("UpdateReplyStyle").WithTags("Reply styles");
        app.MapDelete("/api/admin/reply-styles/{styleId}", async (string styleId, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { if (!Admin(context)) return Results.Forbid(); try { await repository.DeleteReplyStyleAsync(styleId, token); return Results.NoContent(); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("DeleteReplyStyle").WithTags("Reply styles");

        app.MapGet("/api/resumes", async (ProductivityRepository repository, CancellationToken token) => Results.Ok(await repository.ListResumesAsync(token)))
            .WithName("ListResumes").WithTags("Resumes");
        app.MapGet("/api/admin/resumes", async (HttpContext context, ProductivityRepository repository, CancellationToken token) =>
            Admin(context) ? Results.Ok(await repository.ListResumesAsync(token)) : Results.Forbid())
            .WithName("AdminListResumes").WithTags("Resumes");
        app.MapPost("/api/admin/resumes", async (string? filename, string? name, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        {
            if (!Admin(context)) return Results.Forbid();
            try { return Results.Json(await repository.SaveResumeAsync(name ?? Path.GetFileNameWithoutExtension(filename) ?? "Resume", filename ?? "resume.pdf", context.Request.ContentType ?? "application/octet-stream", context.Request.Body, token), statusCode: 201); }
            catch (Exception error) { return ProductivityError(error); }
        }).DisableAntiforgery().WithName("UploadResume").WithTags("Resumes");
        app.MapGet("/api/admin/resumes/{resumeId}/download", async (string resumeId, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        {
            if (!Admin(context)) return Results.Forbid(); var item = await repository.GetResumeContentAsync(resumeId, token);
            return item is null ? Results.NotFound(new { error = "Resume not found" }) : Results.File(item.FullPath, item.ContentType, item.Filename, enableRangeProcessing: true);
        }).WithName("DownloadResume").WithTags("Resumes");
        app.MapDelete("/api/admin/resumes/{resumeId}", async (string resumeId, HttpContext context, ProductivityRepository repository, CancellationToken token) =>
        { if (!Admin(context)) return Results.Forbid(); try { await repository.DeleteResumeAsync(resumeId, token); return Results.NoContent(); } catch (Exception error) { return ProductivityError(error); } })
            .WithName("DeleteResume").WithTags("Resumes");
        return app;
    }

    private static SessionRecord Session(HttpContext context) => (SessionRecord)context.Items[AuthService.SessionItemKey]!;
    private static bool Admin(HttpContext context) => context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" };
    internal static IResult ProductivityError(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        MailConflictException => Results.Conflict(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        InvalidOperationException => Results.Json(new { error = error.Message }, statusCode: StatusCodes.Status503ServiceUnavailable),
        TimeoutException => Results.Json(new { error = MailEndpoints.DatabaseBusyMessage }, statusCode: StatusCodes.Status503ServiceUnavailable),
        NpgsqlException and not PostgresException => Results.Json(new { error = MailEndpoints.DatabaseBusyMessage }, statusCode: StatusCodes.Status503ServiceUnavailable),
        PostgresException exception when exception.SqlState == PostgresErrorCodes.UniqueViolation => Results.Conflict(new { error = "That name already exists" }),
        _ => throw error
    };
}
