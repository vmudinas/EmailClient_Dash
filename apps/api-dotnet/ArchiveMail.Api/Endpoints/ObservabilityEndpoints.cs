using System.Text.Json;
using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Endpoints;

public static class ObservabilityEndpoints
{
    public static IEndpointRouteBuilder MapObservabilityEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/diagnostics", async (string? level, string? category, string? jobId, int? limit,
            HttpContext context, ObservabilityRepository observations, ImportJobRepository jobs,
            UploadService uploads, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            var events = await observations.ListDiagnosticsAsync(session.User.Id, level, category, jobId, limit, token);
            return Results.Ok(new
            {
                events,
                importJobs = await jobs.ListAsync(session.User.Id, token),
                uploads = await uploads.ListAsync(session.User.Id, token),
                gmailConnections = Array.Empty<object>(),
                aiJobs = Array.Empty<object>()
            });
        }).WithTags("Diagnostics").WithName("GetDiagnostics");

        app.MapPost("/api/diagnostics/client", async (ClientDiagnosticRequest request, HttpContext context,
            ObservabilityRepository observations, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            try
            {
                return Results.Ok(await observations.RecordDiagnosticAsync(session.User.Id, request,
                context.Request.Headers.UserAgent.ToString(), token));
            }
            catch (ArgumentException error) { return Results.BadRequest(new { error = error.Message }); }
        }).WithTags("Diagnostics").WithName("RecordClientDiagnostic").Produces<DiagnosticEventDto>();

        app.MapDelete("/api/diagnostics", async (HttpContext context, ObservabilityRepository observations, CancellationToken token) =>
        {
            var session = Writable(context);
            if (session is null) return Results.Forbid();
            await observations.ClearDiagnosticsAsync(session.User.Id, token);
            return Results.NoContent();
        }).WithTags("Diagnostics").WithName("ClearDiagnostics").Produces(StatusCodes.Status204NoContent);

        app.MapGet("/api/diagnostics/export", async (HttpContext context, ObservabilityRepository observations,
            ImportJobRepository jobs, UploadService uploads, CancellationToken token) =>
        {
            var session = Admin(context);
            if (session is null) return Results.Forbid();
            var exportedAt = DateTimeOffset.UtcNow.ToString("O");
            var payload = new
            {
                exportedAt,
                database = "configured database (credentials redacted)",
                events = await observations.ListDiagnosticsAsync(session.User.Id, null, null, null, 1_000, token),
                importJobs = await jobs.ListAsync(session.User.Id, token),
                uploads = await uploads.ListAsync(session.User.Id, token),
                gmailConnections = Array.Empty<object>(),
                aiJobs = Array.Empty<object>()
            };
            return Results.File(JsonSerializer.SerializeToUtf8Bytes(payload, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }),
                "application/json", $"email-client-diagnostics-{DateTime.UtcNow:yyyy-MM-dd}.json");
        }).WithTags("Diagnostics").WithName("ExportDiagnostics");

        app.MapGet("/api/admin/audit", async (string? username, string? action, string? ipAddress,
            string? success, string? cursor, int? limit, HttpContext context, ObservabilityRepository observations, CancellationToken token) =>
        {
            if (Admin(context) is null) return Results.Forbid();
            bool? parsedSuccess = success?.Trim().ToLowerInvariant() switch
            {
                "true" or "1" => true,
                "false" or "0" => false,
                _ => null
            };
            return Results.Ok(await observations.ListAuditAsync(username, action, ipAddress, parsedSuccess, cursor, limit, token));
        }).WithTags("Audit").WithName("GetAudit").Produces<AuditPageDto>();

        app.MapGet("/api/admin/audit/export", async (HttpContext context, ObservabilityRepository observations, CancellationToken token) =>
        {
            if (Admin(context) is null) return Results.Forbid();
            var exportedAt = DateTimeOffset.UtcNow.ToString("O");
            var events = await observations.ListAuditAsync(null, null, null, null, null, 500, token);
            return Results.File(JsonSerializer.SerializeToUtf8Bytes(new { exportedAt, events = events.Items },
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }),
                "application/json", $"archive-mail-audit-{DateTime.UtcNow:yyyy-MM-dd}.json");
        }).WithTags("Audit").WithName("ExportAudit");
        return app;
    }

    private static SessionRecord? Writable(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" or "user" } session ? session : null;
    private static SessionRecord? Admin(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" } session ? session : null;
}
