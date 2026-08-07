using System.Text.Json;
using Npgsql;

namespace ArchiveMail.Api.Gmail;

internal enum GmailMailboxAction
{
    Read,
    Unread,
    Star,
    Unstar,
    Archive,
    Trash,
    Spam
}

internal sealed record GmailMailboxMutationResult(
    string[] SyncedMessageIds,
    string[] FailedMessageIds,
    string[] Warnings)
{
    internal string[] EligibleLocalMessageIds(IEnumerable<string> requestedIds)
    {
        var failed = FailedMessageIds.ToHashSet(StringComparer.Ordinal);
        return requestedIds
            .Where(id => !string.IsNullOrWhiteSpace(id) && !failed.Contains(id))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }
}

internal sealed record GmailMailboxMessage(
    string MessageId,
    string SourceKey,
    string ArchiveId,
    string? ConnectionId,
    string? ConnectionEmail);

public sealed class GmailMailboxActionException(string message) : Exception(message);

public sealed partial class GmailService
{
    private const int MaxMailboxMutationMessages = 5_000;
    private const int GmailBatchModifyLimit = 1_000;

    // The owner predicate is deliberately in the same query that resolves the provider id. A
    // caller cannot use a guessed local message id to make a connected account mutate someone
    // else's Gmail message. Matching both archive and the account-qualified source key avoids
    // accidentally choosing another Gmail connection that happens to share an archive.
    internal const string MailboxMessageLookupSql = """
      SELECT m.id,m.source_key,m.archive_id,provider.id,provider.email
      FROM messages m
      JOIN archives a ON a.id=m.archive_id
      LEFT JOIN LATERAL (
        SELECT g.id,g.email
        FROM gmail_connections g
        WHERE g.archive_id=m.archive_id
          AND starts_with(m.source_key,'gmail:' || lower(g.email) || ':')
        ORDER BY g.updated_at DESC,g.id
        LIMIT 1
      ) provider ON TRUE
      WHERE m.id=ANY($1) AND a.owner_user_id=$2
      """;

    // Sender-spam is intentionally bounded. The UI promises to move current Inbox matches from
    // the sender, so the provider mutation expands the same owner-scoped Inbox set before the
    // local filing rule runs. A very large sender sweep is refused before any Google request.
    internal const string SenderSpamExpansionSql = """
      WITH selected AS (
        SELECT DISTINCT m.archive_id,lower(trim(m.sender_address)) AS sender_address
        FROM messages m JOIN archives a ON a.id=m.archive_id
        WHERE m.id=ANY($1) AND a.owner_user_id=$2 AND trim(m.sender_address)<>''
      )
      SELECT DISTINCT candidate.id
      FROM selected
      JOIN messages candidate ON candidate.archive_id=selected.archive_id
        AND lower(trim(candidate.sender_address))=selected.sender_address
      JOIN folders folder ON folder.id=candidate.folder_id
      WHERE lower(trim(folder.name))='inbox' OR candidate.id=ANY($1)
      ORDER BY candidate.id
      LIMIT $3
      """;

    internal async Task<GmailMailboxMutationResult> ApplyMailboxActionsAsync(
        IEnumerable<string> messageIds,
        string owner,
        IReadOnlyCollection<GmailMailboxAction> actions,
        CancellationToken token)
    {
        var ids=messageIds.Where(id=>!string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal).Take(MaxMailboxMutationMessages+1).ToArray();
        if(ids.Length==0||actions.Count==0)return new([],[],[]);
        var mailboxActionsEnabled=settings.Current().GmailValue.SyncMailboxActions;
        if(!mailboxActionsEnabled)return new([],[],[]);
        if(ids.Length>MaxMailboxMutationMessages)
            throw new GmailMailboxActionException(
                $"A Gmail mailbox action can update at most {MaxMailboxMutationMessages:N0} messages at once.");

        var messages=await ResolveMailboxMessagesAsync(ids,owner,token);
        var failed=new HashSet<string>(StringComparer.Ordinal);
        var synced=new HashSet<string>(StringComparer.Ordinal);
        var warnings=new List<string>();

        foreach(var orphan in messages.Where(message=>
                    message.SourceKey.StartsWith("gmail:",StringComparison.OrdinalIgnoreCase)
                    &&string.IsNullOrWhiteSpace(message.ConnectionId)))
        {
            failed.Add(orphan.MessageId);
        }
        if(failed.Count>0)
            warnings.Add("Some Gmail messages are no longer linked to a connected account. Reconnect that account and try again.");

        foreach(var group in messages.Where(message=>!string.IsNullOrWhiteSpace(message.ConnectionId))
                    .GroupBy(message=>message.ConnectionId!,StringComparer.Ordinal))
        {
            var connection=await GetAsync(group.Key,owner,token);
            var groupMessages=group.ToArray();
            if(connection is null)
            {
                foreach(var message in groupMessages)failed.Add(message.MessageId);
                warnings.Add("A Gmail connection changed while the mailbox action was running. Try again.");
                continue;
            }
            if(!ShouldSyncMailboxActions(mailboxActionsEnabled,connection.Public.CanModifyMailbox))
            {
                foreach(var message in groupMessages)failed.Add(message.MessageId);
                warnings.Add($"Reconnect {connection.Public.Email} to grant Gmail mailbox permission, then try again.");
                continue;
            }

            try
            {
                var accessToken=await AccessTokenAsync(connection,token);
                foreach(var batch in groupMessages.Chunk(GmailBatchModifyLimit))
                {
                    var externalIds=batch.Select(message=>ExternalMessageId(message,connection.Public.Email)).ToArray();
                    var payload=BuildBatchModifyPayload(externalIds,actions);
                    await GoogleJsonAsync(
                        $"{GmailApi}/users/me/messages/batchModify",accessToken,HttpMethod.Post,payload,token);
                    foreach(var message in batch)synced.Add(message.MessageId);
                }
            }
            catch(OperationCanceledException) when(token.IsCancellationRequested)
            {
                throw;
            }
            catch(Exception error)
            {
                foreach(var message in groupMessages.Where(message=>!synced.Contains(message.MessageId)))
                    failed.Add(message.MessageId);
                var warning=$"Gmail did not accept the mailbox change for {connection.Public.Email}. Try again; if it continues, reconnect the account.";
                warnings.Add(warning);
                logger.LogWarning(error,"Gmail mailbox action failed for connection {ConnectionId}",connection.Public.Id);
                try
                {
                    await observations.RecordServerDiagnosticAsync(
                        owner,"gmail_mailbox_action",warning,error,null,connection.Public.ArchiveId,
                        connection.Public.Email,new
                        {
                            connectionId=connection.Public.Id,
                            actions=actions.Select(value=>value.ToString().ToLowerInvariant()).ToArray(),
                            messageCount=groupMessages.Length
                        },CancellationToken.None);
                }
                catch(Exception diagnosticError)
                {
                    logger.LogWarning(diagnosticError,
                        "Failed to record Gmail mailbox action diagnostic for {ConnectionId}",connection.Public.Id);
                }
            }
        }

        return new(synced.ToArray(),failed.ToArray(),warnings.Distinct(StringComparer.Ordinal).ToArray());
    }

    internal async Task<GmailMailboxMutationResult> ApplyFolderMoveAsync(
        IEnumerable<string> messageIds,string folderId,string owner,CancellationToken token)
    {
        var action=await DestinationActionAsync(folderId,owner,token);
        return action is null
            ? new([],[],[])
            : await ApplyMailboxActionsAsync(messageIds,owner,[action.Value],token);
    }

    internal async Task<GmailMailboxMutationResult> ApplySenderSpamAsync(
        IEnumerable<string> selectedMessageIds,string owner,CancellationToken token)
    {
        var selected=selectedMessageIds.Where(id=>!string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.Ordinal).Take(501).ToArray();
        if(selected.Length==0||!settings.Current().GmailValue.SyncMailboxActions)
            return new([],[],[]);
        await using var command=database.CreateCommand(SenderSpamExpansionSql);
        command.Parameters.AddWithValue(selected);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(MaxMailboxMutationMessages+1);
        var expanded=new List<string>();
        await using(var reader=await command.ExecuteReaderAsync(token))
            while(await reader.ReadAsync(token))expanded.Add(reader.GetString(0));
        if(expanded.Count>MaxMailboxMutationMessages)
            throw new GmailMailboxActionException(
                $"This sender has more than {MaxMailboxMutationMessages:N0} Inbox messages. Mark a smaller selection as Spam from Gmail, then sync again.");
        return await ApplyMailboxActionsAsync(expanded,owner,[GmailMailboxAction.Spam],token);
    }

    internal static JsonElement BuildBatchModifyPayload(
        IReadOnlyCollection<string> externalMessageIds,
        IReadOnlyCollection<GmailMailboxAction> actions)
    {
        var add=new HashSet<string>(StringComparer.Ordinal);
        var remove=new HashSet<string>(StringComparer.Ordinal);
        foreach(var action in actions)
        {
            switch(action)
            {
                case GmailMailboxAction.Read: remove.Add("UNREAD"); break;
                case GmailMailboxAction.Unread: add.Add("UNREAD"); break;
                case GmailMailboxAction.Star: add.Add("STARRED"); break;
                case GmailMailboxAction.Unstar: remove.Add("STARRED"); break;
                case GmailMailboxAction.Archive: remove.Add("INBOX"); break;
                case GmailMailboxAction.Trash:
                    add.Add("TRASH");
                    remove.Add("INBOX");
                    break;
                case GmailMailboxAction.Spam:
                    add.Add("SPAM");
                    remove.Add("INBOX");
                    break;
            }
        }
        // A contradictory state patch should resolve to its positive label operation. Current API
        // callers never create one, but this keeps the payload deterministic if a future caller does.
        remove.ExceptWith(add);
        return JsonSerializer.SerializeToElement(new
        {
            ids=externalMessageIds,
            addLabelIds=add.Order(StringComparer.Ordinal).ToArray(),
            removeLabelIds=remove.Order(StringComparer.Ordinal).ToArray()
        });
    }

    internal static GmailMailboxAction? DestinationAction(string folderName) =>
        folderName.Trim().ToLowerInvariant() switch
        {
            "archive" or "archived" => GmailMailboxAction.Archive,
            "trash" or "deleted" or "deleted items" => GmailMailboxAction.Trash,
            "spam" or "junk" => GmailMailboxAction.Spam,
            _ => null
        };

    internal static bool ShouldSyncMailboxActions(bool configured,bool canModifyMailbox) =>
        configured&&canModifyMailbox;

    private async Task<IReadOnlyList<GmailMailboxMessage>> ResolveMailboxMessagesAsync(
        string[] ids,string owner,CancellationToken token)
    {
        await using var command=database.CreateCommand(MailboxMessageLookupSql);
        command.Parameters.AddWithValue(ids);
        command.Parameters.AddWithValue(owner);
        var messages=new List<GmailMailboxMessage>();
        await using var reader=await command.ExecuteReaderAsync(token);
        while(await reader.ReadAsync(token))messages.Add(new(
            reader.GetString(0),reader.GetString(1),reader.GetString(2),
            reader.IsDBNull(3)?null:reader.GetString(3),reader.IsDBNull(4)?null:reader.GetString(4)));
        return messages;
    }

    private async Task<GmailMailboxAction?> DestinationActionAsync(
        string folderId,string owner,CancellationToken token)
    {
        const string sql="""
          SELECT f.name FROM folders f JOIN archives a ON a.id=f.archive_id
          WHERE f.id=$1 AND a.owner_user_id=$2
          """;
        await using var command=database.CreateCommand(sql);
        command.Parameters.AddWithValue(folderId);
        command.Parameters.AddWithValue(owner);
        var name=Convert.ToString(await command.ExecuteScalarAsync(token));
        return string.IsNullOrWhiteSpace(name)?null:DestinationAction(name);
    }

    private static string ExternalMessageId(GmailMailboxMessage message,string connectionEmail)
    {
        var prefix=$"gmail:{connectionEmail.ToLowerInvariant()}:";
        if(!message.SourceKey.StartsWith(prefix,StringComparison.Ordinal)||message.SourceKey.Length==prefix.Length)
            throw new InvalidOperationException("The local Gmail message reference is invalid");
        return message.SourceKey[prefix.Length..];
    }
}
