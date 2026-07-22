using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class InboxTabEndpoints
{
    public static IEndpointRouteBuilder MapInboxTabEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/inbox-tabs", async (string? archiveId, HttpContext context, InboxTabRepository repository, CancellationToken token) =>
        {
            var session = context.Items[AuthService.SessionItemKey] as SessionRecord;
            if (session is null) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(archiveId)) return Results.BadRequest(new { error = "archiveId is required" });
            var settings = await repository.GetAsync(archiveId, session.User.Id, token);
            return settings is null ? Results.NotFound(new { error = "Archive not found" }) : Results.Ok(settings);
        }).WithTags("Inbox tabs").WithName("GetInboxTabs").Produces<InboxTabSettingsDto>();

        app.MapMethods("/api/admin/inbox-tabs/{archiveId}", ["PATCH"], async (string archiveId,
            InboxTabSettingsUpdateRequest request, HttpContext context, InboxTabRepository repository, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.UpdateAsync(archiveId, request, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Inbox tabs").WithName("UpdateInboxTabs").Produces<InboxTabSettingsDto>();

        app.MapPost("/api/admin/inbox-tabs/{archiveId}/reclassify", async (string archiveId, HttpContext context,
            InboxTabRepository repository, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.ReclassifyAsync(archiveId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Inbox tabs").WithName("ReclassifyInboxTabs").Produces<InboxTabReclassifyResultDto>();
        return app;
    }

    private static SessionRecord? Writable(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" or "user" } session ? session : null;
    private static IResult Error(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        _ => throw error
    };
}
