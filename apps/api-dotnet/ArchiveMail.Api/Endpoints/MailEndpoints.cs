using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;
using ArchiveMail.Api.Imports;
using Microsoft.Extensions.Options;

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

        api.MapPost("/archives/{archiveId}/combine", async (string archiveId, CombineArchiveRequest request,
            HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, true); if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.CombineArchivesAsync(archiveId, request.TargetArchiveId, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("CombineArchives");

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

        api.MapPost("/folders/{folderId}/combine", async (string folderId, CombineFolderRequest request,
            HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, true); if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.CombineFoldersAsync(folderId, request.TargetFolderId, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("CombineFolders");

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
            string messageId, MessageStatePatch request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.UpdateStateAsync(messageId, session.User.Id, request, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("UpdateMessageState").Produces<LocalMessageStateDto>();

        api.MapPost("/messages/{messageId}/move", async (
            string messageId, MoveMessageRequest request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try
            {
                await mail.MoveMessageAsync(messageId, request.FolderId, session.User.Id, token);
                return Results.Ok(await mail.GetMessageAsync(messageId, session.User.Id, token));
            }
            catch (Exception error) { return MailError(error); }
        }).WithName("MoveMessage").Produces<MessageDetailDto>();

        api.MapPost("/messages/bulk-read", async (
            BulkReadRequest request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.BulkReadAsync(request.MessageIds, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("BulkMarkRead").Produces<BulkReadResult>();

        api.MapPost("/messages/bulk-move-to-folder", async (
            BulkMoveFolderRequest request, HttpContext context, MailRepository mail, CancellationToken token) =>
        {
            var session = MailSession(context, write: true);
            if (session is null) return Results.Forbid();
            try { return Results.Ok(await mail.BulkMoveToFolderAsync(request.MessageIds, request.FolderId, session.User.Id, token)); }
            catch (Exception error) { return MailError(error); }
        }).WithName("BulkMoveToFolder").Produces<BulkFolderMoveResult>();

        api.MapPost("/messages/bulk-move", async (BulkMoveRequest request,HttpContext context,MailRepository mail,SenderRuleRepository senderRules,CancellationToken token)=>
        {
            var session=MailSession(context,true);if(session is null)return Results.Forbid();
            if(request.Destination is not("trash" or "archived" or "spam"))return Results.BadRequest(new{error="Choose a valid destination"});
            var ids=request.MessageIds.Where(id=>!string.IsNullOrWhiteSpace(id)).Distinct().Take(500).ToArray();if(ids.Length==0)return Results.BadRequest(new{error="Choose one or more messages"});
            long moved=0,already=0,failed=0,rules=0;var paths=new HashSet<string>();
            foreach(var group in (await Task.WhenAll(ids.Select(id=>mail.GetMessageAsync(id,session.User.Id,token)))).Where(value=>value is not null).Cast<MessageDetailDto>().GroupBy(value=>value.ArchiveId))
            {
                var destination=await EnsureNamedFolder(mail,group.Key,session.User.Id,request.Destination=="archived"?"Archived":request.Destination=="trash"?"Trash":"Spam",token);paths.Add(destination.Path);
                if(request.Destination=="spam")foreach(var message in group.GroupBy(value=>value.Sender.Address,StringComparer.OrdinalIgnoreCase).Select(value=>value.First()))
                {try{var result=await senderRules.CreateAsync(new(message.ArchiveId,"archive","from",message.Sender.Address,"all",null,destination.Id,null,true),session.User.Id,token);moved+=result.MovedMessages;rules+=result.CreatedRules;}catch{failed++;}}
                else{var result=await mail.BulkMoveToFolderAsync(group.Select(value=>value.Id).ToArray(),destination.Id,session.User.Id,token);moved+=result.Moved;already+=result.AlreadyThere;failed+=result.Failed;}
            }
            failed+=ids.Length-(moved+already+failed)>0?ids.Length-(moved+already+failed):0;return Results.Ok(new BulkMoveResult(request.Destination,paths.ToArray(),moved,already,failed,rules));
        }).WithName("BulkMoveMessages");

        api.MapPost("/messages/{messageId}/sender-folder",async(string messageId,MoveMessageRequest request,HttpContext context,MailRepository mail,SenderRuleRepository rules,CancellationToken token)=>
        {var session=MailSession(context,true);if(session is null)return Results.Forbid();var message=await mail.GetMessageAsync(messageId,session.User.Id,token);if(message is null)return Results.NotFound(new{error="Message not found"});try{var result=await rules.CreateAsync(new(message.ArchiveId,"archive","from",message.Sender.Address,"all",null,request.FolderId,null,true),session.User.Id,token);var folder=(await mail.ListFoldersAsync(message.ArchiveId,session.User.Id,token)).Single(value=>value.Id==request.FolderId);return Results.Ok(new SenderFolderRuleResult(message.Sender.Address,folder.Id,folder.Path,result.MovedMessages,(await mail.GetMessageAsync(messageId,session.User.Id,token))!));}catch(Exception error){return MailError(error);}}).WithName("MoveSenderMessages");

        api.MapPost("/messages/{messageId}/spam-sender",async(string messageId,HttpContext context,MailRepository mail,SenderRuleRepository rules,CancellationToken token)=>
        {var session=MailSession(context,true);if(session is null)return Results.Forbid();var message=await mail.GetMessageAsync(messageId,session.User.Id,token);if(message is null)return Results.NotFound(new{error="Message not found"});try{var folder=await EnsureNamedFolder(mail,message.ArchiveId,session.User.Id,"Spam",token);var result=await rules.CreateAsync(new(message.ArchiveId,"archive","from",message.Sender.Address,"all",null,folder.Id,null,true),session.User.Id,token);return Results.Ok(new SenderSpamRuleResult(message.Sender.Address,folder.Id,folder.Path,result.MovedMessages,(await mail.GetMessageAsync(messageId,session.User.Id,token))!));}catch(Exception error){return MailError(error);}}).WithName("MarkSenderSpam");

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

    private static MessageFilters Filters(IQueryCollection query) => new(
        Text(query, "archiveId"), Text(query, "folderId"), Boolean(query, "isRead"),
        Boolean(query, "starred"), Text(query, "inboxCategory"), Text(query, "from"), Text(query, "to"),
        Text(query, "after"), Text(query, "before"), Boolean(query, "hasAttachment"),
        Text(query, "cursor"), Integer(query, "limit"));

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

    private static IResult MailError(Exception error) => error switch
    {
        MailNotFoundException => Results.NotFound(new { error = error.Message }),
        MailConflictException => Results.Conflict(new { error = error.Message }),
        ArgumentException => Results.BadRequest(new { error = error.Message }),
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
