using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Security;
using Microsoft.Extensions.Options;

namespace ArchiveMail.Api.Endpoints;

public static class ImportEndpoints
{
    public static IEndpointRouteBuilder MapImportEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api").WithTags("Imports");

        group.MapGet("/import-jobs", async (HttpContext context, ImportJobRepository jobs, CancellationToken cancellationToken) =>
            Results.Ok(await jobs.ListAsync(Session(context).User.Id, cancellationToken)))
            .WithName("ListImportJobs")
            .Produces<IReadOnlyList<ImportJobDto>>();

        group.MapGet("/import-jobs-runtime", async (
            ImportJobRepository jobs,
            ImportCoordinator coordinator,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var counts = await jobs.CountsAsync(Session(context).User.Id, cancellationToken);
            return Results.Ok(new ImportRuntimeDto(
                coordinator.ActiveCount,
                counts.Queued,
                1,
                coordinator.BatchSize,
                0,
                0,
                false,
                coordinator.ParserConcurrency,
                coordinator.WorkerId));
        }).WithName("GetImportRuntime").Produces<ImportRuntimeDto>();

        group.MapGet("/import-jobs/{jobId}", async (
            string jobId,
            ImportJobRepository jobs,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var job = await jobs.GetAsync(jobId, Session(context).User.Id, cancellationToken);
            return job is null ? Results.NotFound(new { error = "Import job not found" }) : Results.Ok(job.Public);
        }).WithName("GetImportJob").Produces<ImportJobDto>().Produces(StatusCodes.Status404NotFound);

        group.MapPost("/import-jobs/{jobId}/cancel", async (
            string jobId,
            ImportJobRepository jobs,
            ImportCoordinator coordinator,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var job = await jobs.SetCancelledAsync(jobId, Session(context).User.Id, cancellationToken);
            if (job is null) return Results.NotFound(new { error = "Import job not found" });
            coordinator.Cancel(jobId);
            return Results.Ok(job);
        }).WithName("CancelImportJob").Produces<ImportJobDto>().Produces(StatusCodes.Status404NotFound);

        group.MapPost("/import-jobs/{jobId}/resume", async (
            string jobId,
            ImportJobRepository jobs,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var job = await jobs.SetQueuedAsync(jobId, Session(context).User.Id, cancellationToken);
                return job is null
                    ? Results.NotFound(new { error = "Import job not found" })
                    : Results.Ok(job);
            }
            catch (Exception exception) when (exception is InvalidOperationException or IOException)
            {
                return Results.Conflict(new { error = exception.Message });
            }
        }).WithName("ResumeImportJob").Produces<ImportJobDto>().Produces(StatusCodes.Status409Conflict);

        group.MapDelete("/import-jobs/{jobId}", async (
            string jobId,
            ImportJobRepository jobs,
            ImportCoordinator coordinator,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            if (coordinator.ActiveCount > 0)
            {
                var job = await jobs.GetAsync(jobId, Session(context).User.Id, cancellationToken);
                if (job?.Public.Status == "running")
                    return Results.Conflict(new { error = "Stop the import before clearing it" });
            }
            return await jobs.ClearAsync(jobId, Session(context).User.Id, cancellationToken)
                ? Results.NoContent()
                : Results.NotFound(new { error = "Import job not found or still active" });
        }).WithName("ClearImportJob").Produces(StatusCodes.Status204NoContent).Produces(StatusCodes.Status409Conflict);

        group.MapPost("/admin/import", async (
            StartImportRequest request,
            ImportJobRepository jobs,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            if (string.IsNullOrWhiteSpace(request.SourcePath))
                return Results.BadRequest(new { error = "sourcePath is required" });
            try
            {
                return Results.Ok(await jobs.CreateAsync(request.SourcePath, request.Options?.OcrEnabled ?? false,
                    null, false, Session(context).User.Id, null, cancellationToken));
            }
            catch (Exception exception) when (exception is IOException or NotSupportedException)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("StartServerImport").Produces<ImportJobDto>().Produces(StatusCodes.Status400BadRequest);

        group.MapPost("/uploads", async (
            CreateUploadRequest request,
            UploadService uploads,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await uploads.CreateOrResumeAsync(request, Session(context).User.Id, cancellationToken));
            }
            catch (InvalidOperationException exception)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("CreateOrResumeUpload").Produces<UploadSessionDto>().Produces(StatusCodes.Status400BadRequest);

        group.MapGet("/uploads", async (HttpContext context, UploadService uploads, CancellationToken cancellationToken) =>
            Results.Ok(await uploads.ListAsync(Session(context).User.Id, cancellationToken)))
            .WithName("ListUploads").Produces<IReadOnlyList<UploadSessionDto>>();

        group.MapGet("/uploads/{uploadId}", async (
            string uploadId,
            UploadService uploads,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            var upload = await uploads.GetAsync(uploadId, Session(context).User.Id, cancellationToken);
            return upload is null
                ? Results.NotFound(new { error = "Upload session not found" })
                : Results.Ok(upload.Public);
        }).WithName("GetUpload").Produces<UploadSessionDto>().Produces(StatusCodes.Status404NotFound);

        group.MapPut("/uploads/{uploadId}/chunk", async (
            string uploadId,
            HttpRequest request,
            UploadService uploads,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            if (!long.TryParse(request.Headers["X-Upload-Offset"], out var offset) || offset < 0)
                return Results.BadRequest(new { error = "Upload offset is invalid" });
            try
            {
                return Results.Ok(await uploads.AppendAsync(uploadId, offset, request.Body, Session(context).User.Id, cancellationToken));
            }
            catch (KeyNotFoundException exception)
            {
                return Results.NotFound(new { error = exception.Message });
            }
            catch (UploadOffsetException exception)
            {
                return Results.Conflict(new { error = exception.Message });
            }
            catch (InvalidOperationException exception)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("AppendUploadChunk").Accepts<byte[]>("application/octet-stream")
            .Produces<UploadSessionDto>().Produces(StatusCodes.Status409Conflict);

        group.MapPost("/uploads/{uploadId}/complete", async (
            string uploadId,
            UploadService uploads,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await uploads.CompleteAsync(uploadId, Session(context).User.Id, cancellationToken));
            }
            catch (KeyNotFoundException exception)
            {
                return Results.NotFound(new { error = exception.Message });
            }
            catch (UploadOffsetException exception)
            {
                return Results.Conflict(new { error = exception.Message });
            }
            catch (InvalidOperationException exception)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("CompleteUpload").Produces<UploadSessionDto>();

        group.MapDelete("/uploads/{uploadId}", async (
            string uploadId,
            UploadService uploads,
            HttpContext context,
            CancellationToken cancellationToken) =>
        {
            try
            {
                return Results.Ok(await uploads.CancelAsync(uploadId, Session(context).User.Id, cancellationToken));
            }
            catch (KeyNotFoundException exception)
            {
                return Results.NotFound(new { error = exception.Message });
            }
            catch (InvalidOperationException exception)
            {
                return Results.Conflict(new { error = exception.Message });
            }
        }).WithName("CancelUpload").Produces<UploadSessionDto>();

        return app;
    }

    private static SessionRecord Session(HttpContext context) =>
        (SessionRecord)context.Items[AuthService.SessionItemKey]!;
}

public sealed record StartImportRequest(string SourcePath, StartImportOptions? Options);
public sealed record StartImportOptions(bool OcrEnabled = false, string? ReplaceArchiveId = null);
