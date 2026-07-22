using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class FollowUpEndpoints
{
    public static IEndpointRouteBuilder MapFollowUpEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/messages/{messageId}/follow-up", async (string messageId, MessageFollowUpCreateRequest request,
            HttpContext context, FollowUpRepository repository, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.CreateAsync(messageId, request, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Follow-ups").WithName("CreateFollowUp").Produces<MessageFollowUpDto>();

        app.MapGet("/api/follow-ups", async (string? status, HttpContext context, FollowUpRepository repository, CancellationToken token) =>
        {
            var session = Readable(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.ListAsync(status, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Follow-ups").WithName("ListFollowUps").Produces<IReadOnlyList<MessageFollowUpDto>>();

        app.MapMethods("/api/follow-ups/{followUpId}", ["PATCH"], async (string followUpId, MessageFollowUpPatchRequest request,
            HttpContext context, FollowUpRepository repository, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.UpdateAsync(followUpId, request, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Follow-ups").WithName("UpdateFollowUp").Produces<MessageFollowUpDto>();

        app.MapDelete("/api/follow-ups/{followUpId}", async (string followUpId, HttpContext context,
            FollowUpRepository repository, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try { await repository.DeleteAsync(followUpId, session.User.Id, token); return Results.NoContent(); }
            catch (Exception error) { return Error(error); }
        }).WithTags("Follow-ups").WithName("DeleteFollowUp").Produces(StatusCodes.Status204NoContent);
        return app;
    }

    private static SessionRecord? Readable(HttpContext context) => context.Items[AuthService.SessionItemKey] as SessionRecord;
    private static SessionRecord? Writable(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" or "user" } session ? session : null;
    private static IResult Error(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        _ => throw error
    };
}
