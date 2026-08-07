using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;
using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Gmail;
using Microsoft.Extensions.Options;
using Npgsql;

namespace ArchiveMail.Api.Endpoints;

public static class MailEndpoints
{
    public static IEndpointRouteBuilder MapMailEndpoints(this IEndpointRouteBuilder app)
    {
        var api = app.MapGroup("/api").WithTags("Mail");

        api.MapGet("/archives", async (HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            return session is null ? Results.Forbid() : Results.Ok(await mail.ListArchivesAsync(session.User.Id, token));
        }).WithName("ListArchives").Produces<IReadOnlyList<ArchiveDto>>();

        api.MapMethods("/archives/{archiveId}", ["PATCH"], async (
            string archiveId, NamePatch request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.RenameArchiveAsync(archiveId, session.User.Id, request.Name, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("RenameArchive").Produces<ArchiveDto>();

        api.MapDelete("/archives/{archiveId}", async (
            string archiveId, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { await mail.DeleteArchiveAsync(archiveId, session.User.Id, token); return Results.NoContent(); }
            catch (Exception error) { return MailError(error); }
        }).WithName("DeleteArchive").Produces(StatusCodes.Status204NoContent);

        // Returns the job that tracks the merge, not the merged archive. Moving hundreds of
        // thousands of messages cannot finish inside a request, and when it used to try, the
        // proxy timed out, the client disconnect cancelled the token, and the whole transaction
        // rolled back - so the merge reported failure and silently changed nothing.
        api.MapPost("/archives/{archiveId}/combine", async (string archiveId, CombineArchiveRequest request,
            HttpContext context, ArchiveCombineService combines, CancellationToken token) =>
        {
            var session = MailSession(context, true); if (session is null) return Results.Forbid();
            try
            {
                return Results.Accepted(
                    "/api/import-jobs",
                    await combines.EnqueueArchiveCombineAsync(archiveId, request.TargetArchiveId, session.User.Id, token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("CombineArchives").Produces<ImportJobDto>(StatusCodes.Status202Accepted);

        api.MapGet("/archives/{archiveId}/folders", async (
            string archiveId, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            return session is null ? Results.Forbid() : Results.Ok(await mail.ListFoldersAsync(archiveId, session.User.Id, token));
        }).WithName("ListFolders").Produces<IReadOnlyList<FolderDto>>();

        api.MapPost("/archives/{archiveId}/folders", async (
            string archiveId, CreateFolderRequest request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Created($"/api/archives/{archiveId}/folders", await mail.CreateFolderAsync(archiveId, session.User.Id, request.Name, request.ParentId, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("CreateFolder").Produces<FolderDto>(StatusCodes.Status201Created);

        api.MapMethods("/folders/{folderId}", ["PATCH"], async (
            string folderId, NamePatch request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.RenameFolderAsync(folderId, session.User.Id, request.Name, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("RenameFolder").Produces<FolderDto>();

        api.MapDelete("/folders/{folderId}", async (
            string folderId, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { await mail.DeleteFolderAsync(folderId, session.User.Id, token); return Results.NoContent(); }
            catch (Exception error) { return MailError(error); }
        }).WithName("DeleteFolder").Produces(StatusCodes.Status204NoContent);

        // Same shape as the archive merge above, and for the same reason: a mailbox holding a
        // large chunk of a 600k archive is just as far past what a request can carry.
        api.MapPost("/folders/{folderId}/combine", async (string folderId, CombineFolderRequest request,
            HttpContext context, ArchiveCombineService combines, CancellationToken token) =>
        {
            var session = MailSession(context, true); if (session is null) return Results.Forbid();
            try
            {
                return Results.Accepted(
                    "/api/import-jobs",
                    await combines.EnqueueFolderCombineAsync(folderId, request.TargetFolderId, session.User.Id, token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("CombineFolders").Produces<ImportJobDto>(StatusCodes.Status202Accepted);

        api.MapPost("/folders/{folderId}/move", async (string folderId, MoveFolderRequest request,
            HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, true); if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.MoveFolderAsync(folderId, request.TargetParentId, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("MoveFolder");

        api.MapGet("/messages", async (HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.ListMessagesAsync(Filters(context.Request.Query), session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("ListMessages").Produces<CursorPageDto<MessageSummaryDto>>();

        api.MapGet("/messages/category-counts", async (HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.CountCategoriesAsync(Filters(context.Request.Query), session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("InboxCategoryCounts").Produces<InboxCategoryCountsDto>();

        api.MapGet("/search", async (HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            try
            {
                return Results.Ok(await mail.SearchAsync(
                    context.Request.Query["q"].ToString(),
                    context.Request.Query["sort"].ToString(),
                    Filters(context.Request.Query),
                    session.User.Id,
                    token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("SearchMessages").Produces<CursorPageDto<SearchHitDto>>();

        api.MapGet("/messages/{messageId}", async (
            string messageId, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            var message = await mail.GetMessageAsync(messageId, session.User.Id, token);
            return message is null ? Results.NotFound(new { error = "Message not found" }) : Results.Ok(message);
        }).WithName("GetMessage").Produces<MessageDetailDto>().Produces(StatusCodes.Status404NotFound);

        api.MapGet("/messages/{messageId}/thread", async (
            string messageId, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.GetThreadAsync(messageId, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("GetMessageThread").Produces<MessageThreadDto>();

        api.MapGet("/attachments/{attachmentId}/content", async (
            string attachmentId,
            HttpContext context,
            MailRepository mail,
            IOptions<ImportOptions> options,
            CancellationToken token) =>
        {
            var session = MailSession(context);
            if (session is null) return Results.Forbid();
            var attachment = await mail.GetAttachmentContentAsync(attachmentId, session.User.Id, token);
            if (attachment is null) return Results.NotFound(new { error = "Attachment not found" });
            var root = Path.GetFullPath(Path.Combine(options.Value.DataDirectory, "blobs"));
            var path = Path.GetFullPath(Path.Combine(root, attachment.RelativePath.Replace('/', Path.DirectorySeparatorChar)));
            if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(path))
                return Results.NotFound(new { error = "Attachment content not found" });
            context.Response.Headers.CacheControl = "private, no-store";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers.ContentDisposition = $"inline; filename*=UTF-8''{Uri.EscapeDataString(SafeFilename(attachment.Filename))}";
            return Results.File(path, SafeContentType(attachment.ContentType, attachment.Filename), enableRangeProcessing: true);
        }).WithName("GetAttachmentContent").Produces(StatusCodes.Status200OK).Produces(StatusCodes.Status404NotFound);

        api.MapMethods("/messages/{messageId}/state", ["PATCH"], async (
            string messageId, MessageStatePatch request, HttpContext context, MailRepository mail,
            GmailService gmail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try
            {
                var actions = GmailStateActions(request);
                var mutation = await gmail.ApplyMailboxActionsAsync([messageId], session.User.Id, actions, token);
                EnsureGmailMutationSucceeded(mutation);
                return Results.Ok(await mail.UpdateStateAsync(messageId, session.User.Id, request, token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("UpdateMessageState").Produces<LocalMessageStateDto>();

        api.MapPost("/messages/{messageId}/move", async (
            string messageId, MoveMessageRequest request, HttpContext context, MailRepository mail,
            GmailService gmail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try
            {
                var mutation = await gmail.ApplyFolderMoveAsync(
                    [messageId], request.FolderId, session.User.Id, token);
                EnsureGmailMutationSucceeded(mutation);
                await mail.MoveMessageAsync(messageId, request.FolderId, session.User.Id, token);
                return Results.Ok(await mail.GetMessageAsync(messageId, session.User.Id, token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("MoveMessage").Produces<MessageDetailDto>();

        api.MapPost("/messages/bulk-read", async (
            BulkReadRequest request, HttpContext context, MailRepository mail, GmailService gmail,
            CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try
            {
                var mutation = await gmail.ApplyMailboxActionsAsync(
                    request.MessageIds, session.User.Id, [GmailMailboxAction.Read], token);
                var eligible = mutation.EligibleLocalMessageIds(request.MessageIds);
                if (eligible.Length == 0)
                {
                    EnsureGmailMutationSucceeded(mutation);
                    return Results.Ok(new BulkReadResult(0, 0, 0));
                }
                var local = await mail.BulkReadAsync(eligible, session.User.Id, token);
                return Results.Ok(local with { Failed = local.Failed + mutation.FailedMessageIds.Length });
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("BulkMarkRead").Produces<BulkReadResult>();

        api.MapPost("/messages/bulk-move-to-folder", async (
            BulkMoveFolderRequest request, HttpContext context, MailRepository mail, GmailService gmail,
            CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try
            {
                var mutation = await gmail.ApplyFolderMoveAsync(
                    request.MessageIds, request.FolderId, session.User.Id, token);
                var eligible = mutation.EligibleLocalMessageIds(request.MessageIds);
                if (eligible.Length == 0)
                {
                    EnsureGmailMutationSucceeded(mutation);
                    throw new ArgumentException("Choose one or more messages");
                }
                var local = await mail.BulkMoveToFolderAsync(
                    eligible, request.FolderId, session.User.Id, token);
                return Results.Ok(local with { Failed = local.Failed + mutation.FailedMessageIds.Length });
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("BulkMoveToFolder").Produces<BulkFolderMoveResult>();

        api.MapPost("/messages/bulk-move", async (
            BulkMoveRequest request, HttpContext context, MailRepository mail,
            SenderRuleRepository senderRules, GmailService gmail, CancellationToken token) =>
        {
            var session = MailSession(context, true);
            if (session is null) return Results.Forbid();
            if (request.Destination is not ("trash" or "archived" or "spam"))
                return Results.BadRequest(new { error = "Choose a valid destination" });
            var ids = request.MessageIds.Where(id => !string.IsNullOrWhiteSpace(id))
                .Distinct(StringComparer.Ordinal).Take(500).ToArray();
            if (ids.Length == 0) return Results.BadRequest(new { error = "Choose one or more messages" });
            try
            {
                long moved = 0, already = 0, rules = 0;
                var paths = new HashSet<string>();
                var destinationIds = new HashSet<string>();
                var details = (await Task.WhenAll(ids.Select(id => mail.GetMessageAsync(id, session.User.Id, token))))
                    .Where(value => value is not null).Cast<MessageDetailDto>();
                foreach (var group in details.GroupBy(value => value.ArchiveId))
                {
                    var destination = await EnsureNamedFolder(
                        mail, group.Key, session.User.Id,
                        request.Destination == "archived" ? "Archived" : request.Destination == "trash" ? "Trash" : "Spam",
                        token);
                    paths.Add(destination.Path);
                    destinationIds.Add(destination.Id);
                    if (request.Destination == "spam")
                    {
                        foreach (var senderGroup in group.GroupBy(value => value.Sender.Address, StringComparer.OrdinalIgnoreCase))
                        {
                            var selectedSenderIds = senderGroup.Select(value => value.Id).ToArray();
                            var mutation = await gmail.ApplySenderSpamAsync(selectedSenderIds, session.User.Id, token);
                            if (mutation.FailedMessageIds.Length > 0)
                            {
                                var fallback = await MoveMessagesInBatches(
                                    mail,
                                    mutation.SyncedMessageIds.Concat(mutation.EligibleLocalMessageIds(selectedSenderIds)),
                                    destination.Id, session.User.Id, token);
                                moved += fallback.Moved;
                                already += fallback.AlreadyThere;
                                continue;
                            }
                            var message = senderGroup.First();
                            try
                            {
                                var result = await senderRules.CreateAsync(new(
                                    message.ArchiveId, "archive", "from", message.Sender.Address,
                                    "inbox", null, destination.Id, null, true), session.User.Id, token);
                                moved += result.MovedMessages;
                                rules += result.CreatedRules;
                            }
                            catch
                            {
                                // Google may already have accepted this idempotent mutation. Keep
                                // every remotely changed message consistent locally even if sender
                                // rule creation itself loses a database race.
                                var fallback = await MoveMessagesInBatches(
                                    mail,
                                    mutation.SyncedMessageIds.Concat(mutation.EligibleLocalMessageIds(selectedSenderIds)),
                                    destination.Id, session.User.Id, token);
                                moved += fallback.Moved;
                                already += fallback.AlreadyThere;
                            }
                        }
                    }
                    else
                    {
                        var selectedIds = group.Select(value => value.Id).ToArray();
                        var action = GmailBulkMoveAction(request.Destination);
                        var mutation = action is not null
                            ? await gmail.ApplyMailboxActionsAsync(
                                selectedIds, session.User.Id, [action.Value], token)
                            : new GmailMailboxMutationResult([], [], []);
                        var eligible = mutation.EligibleLocalMessageIds(selectedIds);
                        if (eligible.Length == 0) continue;
                        var result = await mail.BulkMoveToFolderAsync(
                            eligible, destination.Id, session.User.Id, token);
                        moved += result.Moved;
                        already += result.AlreadyThere;
                    }
                }
                var processed = (await mail.GetMessageSummariesAsync(ids, session.User.Id, token))
                    .Where(message => destinationIds.Contains(message.FolderId)).Select(message => message.Id).ToArray();
                var failed = ids.Length - processed.Length;
                return Results.Ok(new BulkMoveResult(
                    request.Destination, paths.ToArray(), moved, already, failed, rules, processed));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("BulkMoveMessages");

        api.MapPost("/messages/{messageId}/sender-folder",async(string messageId,MoveMessageRequest request,HttpContext context,MailRepository mail,SenderRuleRepository rules,CancellationToken token)=>
        {var session=MailSession(context,true);if(session is null)return Results.Forbid();var message=await mail.GetMessageAsync(messageId,session.User.Id,token);if(message is null)return Results.NotFound(new{error="Message not found"});try{var result=await rules.CreateAsync(new(message.ArchiveId,"archive","from",message.Sender.Address,"all",null,request.FolderId,null,true),session.User.Id,token);var folder=(await mail.ListFoldersAsync(message.ArchiveId,session.User.Id,token)).Single(value=>value.Id==request.FolderId);return Results.Ok(new SenderFolderRuleResult(message.Sender.Address,folder.Id,folder.Path,result.MovedMessages,(await mail.GetMessageAsync(messageId,session.User.Id,token))!));}catch(Exception error){return MailError(error);}}).WithName("MoveSenderMessages");

        api.MapPost("/messages/{messageId}/spam-sender", async (
            string messageId, HttpContext context, MailRepository mail, SenderRuleRepository rules,
            GmailService gmail, CancellationToken token) =>
        {
            var session = MailSession(context, true);
            if (session is null) return Results.Forbid();
            var message = await mail.GetMessageAsync(messageId, session.User.Id, token);
            if (message is null) return Results.NotFound(new { error = "Message not found" });
            try
            {
                var folder = await EnsureNamedFolder(mail, message.ArchiveId, session.User.Id, "Spam", token);
                var mutation = await gmail.ApplySenderSpamAsync([messageId], session.User.Id, token);
                if (mutation.FailedMessageIds.Length > 0)
                {
                    await MoveMessagesInBatches(
                        mail,
                        mutation.SyncedMessageIds.Concat(mutation.EligibleLocalMessageIds([messageId])),
                        folder.Id, session.User.Id, token);
                    EnsureGmailMutationSucceeded(mutation);
                }
                try
                {
                    var result = await rules.CreateAsync(new(
                        message.ArchiveId, "archive", "from", message.Sender.Address,
                        "inbox", null, folder.Id, null, true), session.User.Id, token);
                    return Results.Ok(new SenderSpamRuleResult(
                        message.Sender.Address, folder.Id, folder.Path, result.MovedMessages,
                        (await mail.GetMessageAsync(messageId, session.User.Id, token))!));
                }
                catch
                {
                    await MoveMessagesInBatches(
                        mail,
                        mutation.SyncedMessageIds.Concat(mutation.EligibleLocalMessageIds([messageId])),
                        folder.Id, session.User.Id, token);
                    throw;
                }
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("MarkSenderSpam");

        return app;
    }

    private static SessionRecord? MailSession(HttpContext context, bool write = false)
    {
        if (context.Items[AuthService.SessionItemKey] is not SessionRecord session) return null;
        return session.Role switch
        {
            "admin" => session,
            "user" => session,
            _ => null
        };
    }

    internal static GmailMailboxAction[] GmailStateActions(MessageStatePatch request)
    {
        var actions = new List<GmailMailboxAction>(2);
        if (request.IsRead is not null)
            actions.Add(request.IsRead.Value ? GmailMailboxAction.Read : GmailMailboxAction.Unread);
        if (request.IsStarred is not null)
            actions.Add(request.IsStarred.Value ? GmailMailboxAction.Star : GmailMailboxAction.Unstar);
        return actions.ToArray();
    }

    internal static GmailMailboxAction? GmailBulkMoveAction(string destination) => destination switch
    {
        "archived" => GmailMailboxAction.Archive,
        "trash" => GmailMailboxAction.Trash,
        "spam" => GmailMailboxAction.Spam,
        _ => null
    };

    private static MessageFilters Filters(IQueryCollection query) => new(
        Text(query, "archiveId"), Text(query, "folderId"), Boolean(query, "isRead"),
        Boolean(query, "starred"), Text(query, "inboxCategory"), Text(query, "from"), Text(query, "to"),
        Text(query, "after"), Text(query, "before"), Boolean(query, "hasAttachment"),
        Text(query, "cursor"), Integer(query, "limit"), Boolean(query, "focus"), Boolean(query, "inboxOnly"));

    private static string? Text(IQueryCollection query, string key)
    {
        var value = query[key].ToString().Trim();
        return value.Length == 0 ? null : value;
    }

    private static bool? Boolean(IQueryCollection query, string key) => Text(query, key)?.ToLowerInvariant() switch
    {
        "true" or "1" => true,
        "false" or "0" => false,
        _ => null
    };

    private static int? Integer(IQueryCollection query, string key) =>
        int.TryParse(Text(query, key), out var value) ? value : null;

    internal const string DatabaseBusyMessage =
        "The mail database is busy or briefly unreachable. A running import or combine is the usual cause; this clears on its own.";

    internal static IResult MailError(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        MailConflictException => Results.Conflict(new { error = error.Message }),
        GmailMailboxActionException => Results.Json(
            new { error = error.Message }, statusCode: StatusCodes.Status502BadGateway),
        ArgumentException => Results.BadRequest(new { error = error.Message }),

        // A combine keeps the database saturated for as long as it runs, and restarting the API
        // under one leaves a window where connections are refused outright. Both reached the
        // browser as a bare 500 with no body, which reads as a broken application rather than
        // something that resolves itself. PostgresException stays out of this on purpose: there
        // the server understood the statement and rejected it, which is a bug, and it stays loud.
        TimeoutException => Results.Json(
            new { error = DatabaseBusyMessage }, statusCode: StatusCodes.Status503ServiceUnavailable),
        NpgsqlException and not PostgresException => Results.Json(
            new { error = DatabaseBusyMessage }, statusCode: StatusCodes.Status503ServiceUnavailable),
        _ => throw error
    };

    private static string SafeFilename(string value)
    {
        var name = Path.GetFileName(value);
        var cleaned = new string(name.Select(character => char.IsControl(character) ? '_' : character).ToArray());
        return cleaned.Length == 0 ? "attachment" : cleaned[..Math.Min(240, cleaned.Length)];
    }

    private static async Task<FolderDto> EnsureNamedFolder(MailRepository mail,string archive,string owner,string name,CancellationToken token)
    {var existing=(await mail.ListFoldersAsync(archive,owner,token)).FirstOrDefault(value=>value.ParentId is null&&value.Name.Equals(name,StringComparison.OrdinalIgnoreCase));return existing??await mail.CreateFolderAsync(archive,owner,name,null,token);}

    private static void EnsureGmailMutationSucceeded(GmailMailboxMutationResult mutation)
    {
        if (mutation.FailedMessageIds.Length == 0) return;
        throw new GmailMailboxActionException(
            mutation.Warnings.FirstOrDefault()
            ?? "Gmail did not accept the mailbox change. Try again or reconnect the account.");
    }

    private static async Task<(long Moved, long AlreadyThere)> MoveMessagesInBatches(
        MailRepository mail, IEnumerable<string> messageIds, string folderId, string owner,
        CancellationToken token)
    {
        long moved = 0, already = 0;
        var ids = messageIds.Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal).Take(5_000).ToArray();
        foreach (var batch in ids.Chunk(500))
        {
            var result = await mail.BulkMoveToFolderAsync(batch, folderId, owner, token);
            moved += result.Moved;
            already += result.AlreadyThere;
        }
        return (moved, already);
    }

    private static string SafeContentType(string declared, string filename)
    {
        var mediaType = declared.Split(';', 2)[0].Trim().ToLowerInvariant();
        if (mediaType.Length > 0 && mediaType is not ("application/octet-stream" or "binary/octet-stream")) return declared;
        return Path.GetExtension(filename).ToLowerInvariant() switch
        {
            ".bmp" => "image/bmp",
            ".gif" => "image/gif",
            ".jpeg" or ".jpg" => "image/jpeg",
            ".png" => "image/png",
            ".webp" => "image/webp",
            ".pdf" => "application/pdf",
            ".csv" => "text/csv; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".md" => "text/markdown; charset=utf-8",
            ".txt" or ".text" or ".log" => "text/plain; charset=utf-8",
            ".xml" => "application/xml; charset=utf-8",
            _ => "application/octet-stream"
        };
    }
}
