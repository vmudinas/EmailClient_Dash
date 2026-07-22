using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public static class SenderRuleEndpoints
{
    public static IEndpointRouteBuilder MapSenderRuleEndpoints(this IEndpointRouteBuilder app)
    {
        var rules = app.MapGroup("/api/admin/sender-filing").WithTags("Sender rules");

        rules.MapGet("", async (string? archiveId, HttpContext context, SenderRuleRepository repository, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(archiveId)) return Results.BadRequest(new { error = "Choose a valid archive" });
            var status = await repository.GetStatusAsync(archiveId, session.User.Id, token);
            return status is null ? Results.NotFound(new { error = "Archive not found" }) : Results.Ok(status);
        }).WithName("GetSenderFilingStatus").Produces<SenderFilingStatusDto>();

        rules.MapPost("/rules", async (SenderFilingRuleCreateRequest request, HttpContext context,
            SenderRuleRepository repository, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            try { return Results.Json(await repository.CreateAsync(request, session.User.Id, token), statusCode: StatusCodes.Status201Created); }
            catch (Exception error) { return Error(error); }
        }).WithName("CreateSenderFilingRule").Produces<SenderFilingRuleCreateResultDto>(StatusCodes.Status201Created);

        rules.MapPost("/organize", async (ArchiveSelectionRequest request, HttpContext context,
            SenderRuleRepository repository, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.OrganizeTopSendersAsync(request.ArchiveId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithName("OrganizeTopSenders").Produces<SenderFilingStatusDto>();

        rules.MapMethods("/rules/{ruleId}", ["PATCH"], async (string ruleId, FolderSelectionRequest request,
            HttpContext context, SenderRuleRepository repository, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await repository.UpdateFolderAsync(ruleId, request.FolderId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithName("UpdateSenderFilingRuleFolder").Produces<SenderFilingStatusDto>();

        rules.MapDelete("", async (string? archiveId, HttpContext context, SenderRuleRepository repository, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            if (string.IsNullOrWhiteSpace(archiveId)) return Results.BadRequest(new { error = "Choose a valid archive" });
            try { return Results.Ok(await repository.ClearAsync(archiveId, session.User.Id, token)); }
            catch (Exception error) { return Error(error); }
        }).WithName("DisableSenderFiling").Produces<SenderFilingStatusDto>();

        return app;
    }

    private static SessionRecord? Admin(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" } session ? session : null;

    private static IResult Error(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        MailConflictException => Results.Conflict(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
        PostgresException exception when exception.SqlState == PostgresErrorCodes.UniqueViolation =>
            Results.Conflict(new { error = "A folder or sender rule with those settings already exists" }),
        _ => throw error
    };
}
