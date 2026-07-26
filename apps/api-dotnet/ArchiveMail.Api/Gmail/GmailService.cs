using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Globalization;
using System.Text.Json;
using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Infrastructure;
using MimeKit;
using Npgsql;
using NpgsqlTypes;

namespace ArchiveMail.Api.Gmail;

public sealed record GmailConnectionDto(
    string Id,string Email,string ArchiveId,string ArchiveName,string FolderId,string FolderPath,string Query,bool OcrEnabled,
    bool CanSend,bool CanModifyMailbox,bool CanManageCalendar,string Status,long ProcessedItems,long? TotalItems,long ImportedItems,
    string? LastSyncedAt,string? LastError,string CreatedAt,string UpdatedAt);

internal sealed record PendingGmailAuthorization(
    JsonElement Request,string OwnerUserId,string Verifier,string RedirectUri,DateTimeOffset ExpiresAt,bool ModifyRequested);
internal sealed record GmailConnectionRecord(GmailConnectionDto Public,string RefreshToken,string? AccessToken,string? AccessTokenExpiresAt);

public sealed class GmailService(
    NpgsqlDataSource database,
    AppSettingsService settings,
    ObservabilityRepository observations,
    ImportBatchWriter writer,
    ImportJobRepository jobs,
    ActiveDatabaseConfiguration active,
    IHttpClientFactory clients,
    ILogger<GmailService> logger)
{
    private const string GmailApi="https://gmail.googleapis.com/gmail/v1";
    internal const string ConnectionUpsertSql = """
      INSERT INTO gmail_connections(
        id,email,archive_id,folder_id,query,ocr_enabled,refresh_token,access_token,access_token_expires_at,
        status,processed_items,total_items,imported_items,can_send,can_modify_mailbox,can_manage_calendar,created_at,updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'connected',0,NULL,0,$10,$11,$12,$13,$13)
      ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,query=EXCLUDED.query,ocr_enabled=EXCLUDED.ocr_enabled,
        refresh_token=EXCLUDED.refresh_token,access_token=EXCLUDED.access_token,access_token_expires_at=EXCLUDED.access_token_expires_at,
        status='connected',can_send=EXCLUDED.can_send,can_modify_mailbox=EXCLUDED.can_modify_mailbox,
        can_manage_calendar=EXCLUDED.can_manage_calendar,last_error=NULL,updated_at=EXCLUDED.updated_at
      """;
    /// <summary>
    /// Reauthorization reads the destination back out of the row rather than trusting the request,
    /// so finishing an authorization can never redirect an account's mail somewhere else. Changing
    /// where a connection files its mail goes through <see cref="MoveAsync"/> instead.
    /// </summary>
    internal const string ExistingConnectionSql = """
      SELECT g.email,g.archive_id,g.folder_id
      FROM gmail_connections g JOIN archives a ON a.id=g.archive_id
      WHERE g.id=$1 AND a.owner_user_id=$2 FOR UPDATE
      """;
    private readonly ConcurrentDictionary<string,PendingGmailAuthorization> _pending=new();
    private readonly ConcurrentDictionary<string,CancellationTokenSource> _runs=new();

    public async Task<IReadOnlyList<GmailConnectionDto>> ListAsync(string owner,CancellationToken token)
    {
        const string sql="""
          SELECT g.id,g.email,g.archive_id,a.name,g.folder_id,f.path,g.query,g.ocr_enabled<>0,g.can_send<>0,
            g.can_modify_mailbox<>0,g.can_manage_calendar<>0,g.status,g.processed_items,g.total_items,g.imported_items,
            g.last_synced_at,g.last_error,g.created_at,g.updated_at
          FROM gmail_connections g JOIN archives a ON a.id=g.archive_id JOIN folders f ON f.id=g.folder_id
          WHERE a.owner_user_id=$1 ORDER BY g.updated_at DESC
          """;
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);var result=new List<GmailConnectionDto>();while(await reader.ReadAsync(token))result.Add(ReadPublic(reader));return result;
    }

    internal async Task<IReadOnlyList<ScheduledGmailConnection>> InternalScheduleListAsync(CancellationToken token)
    {
        const string sql = "SELECT g.id,a.owner_user_id,g.status FROM gmail_connections g JOIN archives a ON a.id=g.archive_id WHERE a.owner_user_id IS NOT NULL";
        await using var command = database.CreateCommand(sql);
        await using var reader = await command.ExecuteReaderAsync(token);
        var result = new List<ScheduledGmailConnection>();
        while (await reader.ReadAsync(token)) result.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2)));
        return result;
    }

    public object StartAuthorization(JsonElement request,string owner,string redirectUri)
    {
        var configured=settings.Current().GmailValue;if(string.IsNullOrWhiteSpace(configured.ClientId))throw new InvalidOperationException("Gmail is not configured. Open Admin settings, choose Gmail, and load a Google OAuth JSON file");
        var state=Base64Url(RandomNumberGenerator.GetBytes(32));var verifier=Base64Url(RandomNumberGenerator.GetBytes(64));var challenge=Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));var expires=DateTimeOffset.UtcNow.AddMinutes(10);var modify=configured.SyncMailboxActions;
        _pending[state]=new(request.Clone(),owner,verifier,redirectUri,expires,modify);
        var scopes=new[]{modify?"https://www.googleapis.com/auth/gmail.modify":"https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.settings.basic","https://www.googleapis.com/auth/calendar.events","https://www.googleapis.com/auth/calendar.calendarlist.readonly"};
        var query=new Dictionary<string,string?>{{"client_id",configured.ClientId},{"redirect_uri",redirectUri},{"response_type","code"},{"scope",string.Join(' ',scopes)},{"access_type","offline"},{"prompt","select_account consent"},{"state",state},{"code_challenge",challenge},{"code_challenge_method","S256"}};
        return new{authorizationUrl=Microsoft.AspNetCore.WebUtilities.QueryHelpers.AddQueryString("https://accounts.google.com/o/oauth2/v2/auth",query),expiresAt=expires.ToString("O")};
    }

    public async Task<GmailConnectionDto> FinishAuthorizationAsync(string state,string code,CancellationToken token)
    {
        if(!_pending.TryRemove(state,out var pending)||pending.ExpiresAt<=DateTimeOffset.UtcNow)throw new ArgumentException("This Gmail authorization request expired; connect again");var configured=settings.Current().GmailValue;
        var tokenFields=new Dictionary<string,string>{{"client_id",configured.ClientId},{"code",code},{"code_verifier",pending.Verifier},{"grant_type","authorization_code"},{"redirect_uri",pending.RedirectUri}};if(!string.IsNullOrWhiteSpace(configured.ClientSecret))tokenFields["client_secret"]=configured.ClientSecret;using var form=new FormUrlEncodedContent(tokenFields);
        using var response=await clients.CreateClient("gmail").PostAsync("https://oauth2.googleapis.com/token",form,token);var tokenBody=await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken:token);if(!response.IsSuccessStatusCode)throw new InvalidOperationException("Google rejected the authorization code");
        var accessToken=tokenBody.GetProperty("access_token").GetString()??throw new InvalidOperationException("Google did not return an access token");var refreshToken=tokenBody.TryGetProperty("refresh_token",out var refresh)?refresh.GetString():null;if(string.IsNullOrWhiteSpace(refreshToken))throw new InvalidOperationException("Google did not return a refresh token; remove the previous app grant and connect again");var expires=Seconds(tokenBody,"expires_in",3600);var granted=tokenBody.TryGetProperty("scope",out var scope)?scope.GetString()??"":"";
        var profile=await GoogleJsonAsync($"{GmailApi}/users/me/profile",accessToken,HttpMethod.Get,null,token);var email=profile.GetProperty("emailAddress").GetString()??throw new InvalidOperationException("Google did not return the Gmail address");
        var requestedConnectionId=Text(pending.Request,"connectionId");var archiveId=Text(pending.Request,"archiveId");var folderId=Text(pending.Request,"folderId");var archiveName=Text(pending.Request,"archiveName")??"Gmail";var folderName=Text(pending.Request,"folderName")??"Gmail";var now=DateTimeOffset.UtcNow.ToString("O");
        await using var connection=await database.OpenConnectionAsync(token);await using var tx=await connection.BeginTransactionAsync(token);
        string? id=null;
        if(!string.IsNullOrWhiteSpace(requestedConnectionId))
        {
            await using var existing=new NpgsqlCommand(ExistingConnectionSql,connection,tx);existing.Parameters.AddWithValue(requestedConnectionId);existing.Parameters.AddWithValue(pending.OwnerUserId);
            await using var reader=await existing.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))throw new InvalidOperationException("Gmail connection not found");
            if(!string.Equals(reader.GetString(0),email,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Choose the same Google account when reauthorizing this connection");
            id=requestedConnectionId;archiveId=reader.GetString(1);folderId=reader.GetString(2);await reader.CloseAsync();
        }
        if(string.IsNullOrWhiteSpace(archiveId)){archiveId=Guid.NewGuid().ToString();const string archiveSql="INSERT INTO archives(id,name,source_type,fingerprint,status,owner_user_id,created_at) VALUES($1,$2,'gmail',$3,'ready',$4,$5)";await using var archive=new NpgsqlCommand(archiveSql,connection,tx);archive.Parameters.AddWithValue(archiveId);archive.Parameters.AddWithValue(archiveName);archive.Parameters.AddWithValue($"gmail:{email.ToLowerInvariant()}");archive.Parameters.AddWithValue(pending.OwnerUserId);archive.Parameters.AddWithValue(now);await archive.ExecuteNonQueryAsync(token);}else if(!await OwnsArchiveAsync(connection,tx,archiveId,pending.OwnerUserId,token))throw new InvalidOperationException("Destination archive not found");
        if(string.IsNullOrWhiteSpace(folderId)){folderId=Guid.NewGuid().ToString();const string folderSql="INSERT INTO folders(id,archive_id,name,path) VALUES($1,$2,$3,$3) ON CONFLICT(archive_id,path) DO UPDATE SET name=EXCLUDED.name RETURNING id";await using var folder=new NpgsqlCommand(folderSql,connection,tx);folder.Parameters.AddWithValue(folderId);folder.Parameters.AddWithValue(archiveId);folder.Parameters.AddWithValue(folderName);folderId=Convert.ToString(await folder.ExecuteScalarAsync(token))!;}
        if(id is null)
        {
            const string matchingSql="""
              SELECT g.id FROM gmail_connections g JOIN archives a ON a.id=g.archive_id
              WHERE lower(g.email)=lower($1) AND g.archive_id=$2 AND g.folder_id=$3 AND a.owner_user_id=$4
              ORDER BY g.updated_at DESC LIMIT 1 FOR UPDATE
              """;
            await using var matching=new NpgsqlCommand(matchingSql,connection,tx);matching.Parameters.AddWithValue(email);matching.Parameters.AddWithValue(archiveId);matching.Parameters.AddWithValue(folderId);matching.Parameters.AddWithValue(pending.OwnerUserId);id=await matching.ExecuteScalarAsync(token) as string;
        }
        id??=Guid.NewGuid().ToString();
        await using var insert=new NpgsqlCommand(ConnectionUpsertSql,connection,tx);insert.Parameters.AddWithValue(id);insert.Parameters.AddWithValue(email);insert.Parameters.AddWithValue(archiveId);insert.Parameters.AddWithValue(folderId);insert.Parameters.AddWithValue(Text(pending.Request,"query")??"newer_than:30d");insert.Parameters.AddWithValue(Bool(pending.Request,"ocrEnabled")?1:0);insert.Parameters.AddWithValue(refreshToken);insert.Parameters.AddWithValue(accessToken);insert.Parameters.AddWithValue(DateTimeOffset.UtcNow.AddSeconds(expires).ToString("O"));insert.Parameters.AddWithValue(granted.Contains("gmail.send",StringComparison.Ordinal)?1:0);insert.Parameters.AddWithValue(pending.ModifyRequested&&granted.Contains("gmail.modify",StringComparison.Ordinal)?1:0);insert.Parameters.AddWithValue(granted.Contains("calendar.events",StringComparison.Ordinal)&&granted.Contains("calendar.calendarlist",StringComparison.Ordinal)?1:0);insert.Parameters.AddWithValue(now);await insert.ExecuteNonQueryAsync(token);await tx.CommitAsync(token);
        var result=(await GetAsync(id,pending.OwnerUserId,token))!.Public;StartSync(id,pending.OwnerUserId,false);return result;
    }

    /// <summary>Archive and mailbox move together: a folder only ever belongs to one archive.</summary>
    internal const string MoveDestinationSql =
        "UPDATE gmail_connections SET archive_id=$2,folder_id=$3,updated_at=$4 WHERE id=$1";

    /// <summary>
    /// Re-points a connection at another archive or mailbox. The Google grant is untouched: a
    /// refresh token belongs to the Google account, not to whichever archive it happens to fill,
    /// so there is nothing to reauthorize. Reauthorizing could not do this anyway - it pins the
    /// connection's existing archive and folder on purpose, so that finishing an authorization
    /// cannot quietly redirect an account's mail somewhere else.
    ///
    /// Only the destination of future syncs moves. Messages already downloaded stay in the archive
    /// they were downloaded into, which also means the next sync picks up from last_synced_at
    /// rather than backfilling the new destination.
    /// </summary>
    public async Task<GmailConnectionDto> MoveAsync(string id,string owner,JsonElement request,CancellationToken token)
    {
        var archiveId=Text(request,"archiveId");if(string.IsNullOrWhiteSpace(archiveId))throw new ArgumentException("Choose a destination archive");
        var folderId=Text(request,"folderId");var folderName=Text(request,"folderName");
        if(folderName?.Length>120)throw new ArgumentException("Mailbox names are limited to 120 characters");
        var current=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");
        await using var connection=await database.OpenConnectionAsync(token);await using var tx=await connection.BeginTransactionAsync(token);
        // A sync in flight is writing into the archive this is about to move away from, and it holds
        // the old destination for the rest of its run. _runs only knows about this process, so the
        // locked row's status is what settles it when more than one instance is serving the API.
        if(_runs.ContainsKey(id))throw new InvalidOperationException("Stop this account's Gmail sync before moving it");
        await using(var locked=new NpgsqlCommand("SELECT g.status FROM gmail_connections g JOIN archives a ON a.id=g.archive_id WHERE g.id=$1 AND a.owner_user_id=$2 FOR UPDATE",connection,tx))
        {
            locked.Parameters.AddWithValue(id);locked.Parameters.AddWithValue(owner);
            var status=await locked.ExecuteScalarAsync(token) as string??throw new KeyNotFoundException("Gmail connection not found");
            if(status=="syncing")throw new InvalidOperationException("Stop this account's Gmail sync before moving it");
        }
        if(!await OwnsArchiveAsync(connection,tx,archiveId,owner,token))throw new KeyNotFoundException("Destination archive not found");
        if(!string.IsNullOrWhiteSpace(folderId))
        {
            await using var target=new NpgsqlCommand("SELECT 1 FROM folders WHERE id=$1 AND archive_id=$2",connection,tx);
            target.Parameters.AddWithValue(folderId);target.Parameters.AddWithValue(archiveId);
            if(await target.ExecuteScalarAsync(token) is null)throw new KeyNotFoundException("That mailbox is not in the destination archive");
        }
        else
        {
            var name=string.IsNullOrWhiteSpace(folderName)?current.Public.FolderPath.Split('/')[^1]:folderName;
            await using var folder=new NpgsqlCommand("INSERT INTO folders(id,archive_id,name,path) VALUES($1,$2,$3,$3) ON CONFLICT(archive_id,path) DO UPDATE SET name=EXCLUDED.name RETURNING id",connection,tx);
            folder.Parameters.AddWithValue(Guid.NewGuid().ToString());folder.Parameters.AddWithValue(archiveId);folder.Parameters.AddWithValue(name);
            folderId=Convert.ToString(await folder.ExecuteScalarAsync(token))!;
        }
        await using(var move=new NpgsqlCommand(MoveDestinationSql,connection,tx))
        {move.Parameters.AddWithValue(id);move.Parameters.AddWithValue(archiveId);move.Parameters.AddWithValue(folderId);move.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await move.ExecuteNonQueryAsync(token);}
        await tx.CommitAsync(token);
        return(await GetAsync(id,owner,token))!.Public;
    }

    public async Task<GmailConnectionDto> StartSyncAsync(string id,string owner,bool full,CancellationToken token)
    {var record=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");if(_runs.ContainsKey(id))return record.Public;await UpdateSyncAsync(id,"syncing",0,null,0,null,token,full?"":null);StartSync(id,owner,full);return(await GetAsync(id,owner,token))!.Public;}
    public async Task<GmailConnectionDto> CancelAsync(string id,string owner,CancellationToken token){var record=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");if(_runs.TryGetValue(id,out var cancellation))cancellation.Cancel();await UpdateSyncAsync(id,"connected",record.Public.ProcessedItems,record.Public.TotalItems,record.Public.ImportedItems,null,token);return(await GetAsync(id,owner,token))!.Public;}
    public async Task DeleteAsync(string id,string owner,CancellationToken token){var record=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");if(_runs.TryGetValue(id,out var cancellation))cancellation.Cancel();await using var command=database.CreateCommand("DELETE FROM gmail_connections g USING archives a WHERE g.id=$1 AND a.id=g.archive_id AND a.owner_user_id=$2");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);await command.ExecuteNonQueryAsync(token);try{using var form=new FormUrlEncodedContent(new Dictionary<string,string>{{"token",record.RefreshToken}});await clients.CreateClient("gmail").PostAsync("https://oauth2.googleapis.com/revoke",form,token);}catch(HttpRequestException){}}

    public async Task<object> SendAsync(string id,string owner,JsonElement input,CancellationToken token)
    {
        var connection=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");if(!connection.Public.CanSend)throw new InvalidOperationException("Reconnect this account to grant Gmail send permission");var accessToken=await AccessTokenAsync(connection,token);var message=new MimeMessage();message.From.Add(MailboxAddress.Parse(Text(input,"fromAddress")??connection.Public.Email));foreach(var value in Strings(input,"to"))message.To.Add(MailboxAddress.Parse(value));foreach(var value in Strings(input,"cc"))message.Cc.Add(MailboxAddress.Parse(value));foreach(var value in Strings(input,"bcc"))message.Bcc.Add(MailboxAddress.Parse(value));message.Subject=Text(input,"subject")??"";message.Body=new TextPart("plain"){Text=Text(input,"bodyText")??""};await using var stream=new MemoryStream();await message.WriteToAsync(stream,token);var payload=JsonSerializer.SerializeToElement(new{raw=Base64Url(stream.ToArray())});var sent=await GoogleJsonAsync($"{GmailApi}/users/me/messages/send",accessToken,HttpMethod.Post,payload,token);return new{id=sent.GetProperty("id").GetString(),threadId=sent.TryGetProperty("threadId",out var thread)?thread.GetString():null,localCopyImported=false};
    }

    public async Task<IReadOnlyList<object>> SendAsAsync(string id,string owner,CancellationToken token){var connection=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");var accessToken=await AccessTokenAsync(connection,token);var json=await GoogleJsonAsync($"{GmailApi}/users/me/settings/sendAs",accessToken,HttpMethod.Get,null,token);if(!json.TryGetProperty("sendAs",out var values)||values.ValueKind!=JsonValueKind.Array)return[];return values.EnumerateArray().Where(item=>item.TryGetProperty("sendAsEmail",out _)).Select(item=>(object)new{email=item.GetProperty("sendAsEmail").GetString(),displayName=item.TryGetProperty("displayName",out var display)?display.GetString()??"":"",isPrimary=item.TryGetProperty("isPrimary",out var primary)&&primary.GetBoolean(),isDefault=item.TryGetProperty("isDefault",out var fallback)&&fallback.GetBoolean()}).ToArray();}

    public async Task<JsonElement> GoogleRequestAsync(string id,string owner,string url,HttpMethod method,JsonElement? body,CancellationToken token)
    {var connection=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");if(!connection.Public.CanManageCalendar)throw new InvalidOperationException("Reconnect this account to grant Google Calendar permission");return await GoogleJsonAsync(url,await AccessTokenAsync(connection,token),method,body,token);}

    private void StartSync(string id,string owner,bool full){var cancellation=new CancellationTokenSource();if(!_runs.TryAdd(id,cancellation)){cancellation.Dispose();return;}_=Task.Run(async()=>{try{await RunSyncAsync(id,owner,full,cancellation.Token);}catch(OperationCanceledException) when(cancellation.IsCancellationRequested){await FinishSyncAsync(id,"connected",null,CancellationToken.None);}catch(Exception error){logger.LogError(error,"Gmail sync {ConnectionId} failed",id);await FinishSyncAsync(id,"error",error.Message,CancellationToken.None);}finally{_runs.TryRemove(id,out _);cancellation.Dispose();}});}

    private async Task RunSyncAsync(string id,string owner,bool full,CancellationToken token)
    {
        string? jobId=null;
        GmailConnectionRecord? connection=null;
        try
        {
            connection=await GetAsync(id,owner,token)??throw new KeyNotFoundException("Gmail connection not found");var accessToken=await AccessTokenAsync(connection,token);var query=full?"":connection.Public.Query;if(!full&&connection.Public.LastSyncedAt is not null&&DateTimeOffset.TryParse(connection.Public.LastSyncedAt,out var last))query=$"{query} after:{last.ToUnixTimeSeconds()}".Trim();var ids=await ListMessageIdsAsync(accessToken,query,token);await UpdateSyncAsync(id,"syncing",0,ids.Count,0,null,token,full?"":null);
            var staging=Path.Combine(active.DataDirectory,"gmail-staging",id,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(staging);jobId=Guid.NewGuid().ToString();var now=DateTimeOffset.UtcNow.ToString("O");await CreateSyncJobAsync(jobId,connection.Public,staging,ids.Count,now,token);var job=new ImportJobRecord(new(jobId,connection.Public.ArchiveId,connection.Public.Email,"gmail","running","indexing",0,ids.Count,0,0,0,connection.Public.OcrEnabled,true,"Syncing Gmail",now,now),staging,true,JsonDocument.Parse("{}"),staging,"gmail",1);long processed=0,imported=0;
            for(var offset=0;offset<ids.Count;offset+=100){token.ThrowIfCancellationRequested();var parsed=new List<ParsedMessage>();var readStates=new Dictionary<string,bool>();foreach(var messageId in ids.Skip(offset).Take(100)){var sourceKey=$"gmail:{connection.Public.Email.ToLowerInvariant()}:{messageId}";if(await MessageExistsAsync(connection.Public.ArchiveId,sourceKey,token)){processed++;continue;}var raw=await GoogleJsonAsync($"{GmailApi}/users/me/messages/{Uri.EscapeDataString(messageId)}?format=raw",await AccessTokenAsync(await GetAsync(id,owner,token)??connection,token),HttpMethod.Get,null,token);if(!raw.TryGetProperty("raw",out var encoded))continue;var file=Path.Combine(staging,$"{messageId}.eml");await File.WriteAllBytesAsync(file,Base64UrlDecode(encoded.GetString()??""),token);var item=await EmlParser.ParseAsync(connection.Public.ArchiveId,staging,file,token);var labels=raw.TryGetProperty("labelIds",out var labelArray)&&labelArray.ValueKind==JsonValueKind.Array?labelArray.EnumerateArray().Select(value=>value.GetString()??"").ToHashSet():[];var folder=ResolveFolder(connection.Public.FolderPath,labels);var category=labels.Contains("CATEGORY_PROMOTIONS")?"promotions":labels.Contains("CATEGORY_SOCIAL")?"social":labels.Contains("CATEGORY_UPDATES")?"updates":item.InboxCategory;parsed.Add(item with{SourceKey=sourceKey,FolderPath=folder,InboxCategory=category,SourceFile=Path.GetFileName(file)});readStates[sourceKey]=!labels.Contains("UNREAD");processed++;}
                if(parsed.Count>0){imported+=parsed.Count;var checkpoint=new ImportCheckpoint(2,"indexing",parsed[^1].SourceFile,processed,ids.Count,$"gmail:{id}");await writer.CommitAsync(job,parsed,checkpoint,TimeSpan.FromMinutes(5),token);await ApplyReadStatesAsync(connection.Public.ArchiveId,readStates,token);}await UpdateSyncAsync(id,"syncing",processed,ids.Count,imported,null,token);}
            await jobs.MarkCompletedAsync(jobId,token);await UpdateSyncAsync(id,"connected",processed,ids.Count,imported,null,token,lastSyncedAt:DateTimeOffset.UtcNow.ToString("O"));
        }
        catch(Exception error)
        {
            if(jobId is not null)
            {
                try{await jobs.MarkNonResumableFailedAsync(jobId,error.Message,CancellationToken.None);}
                catch(Exception cleanupError){logger.LogWarning(cleanupError,"Failed to close Gmail import job {JobId}",jobId);}
            }
            if(error is not OperationCanceledException||!token.IsCancellationRequested)
            {
                try
                {
                    await observations.RecordServerDiagnosticAsync(
                        owner,"gmail",$"Gmail sync failed: {error.Message}",error,jobId,
                        connection?.Public.ArchiveId,connection?.Public.Email,
                        new{connectionId=id,full,cancellationRequested=token.IsCancellationRequested},
                        CancellationToken.None);
                }
                catch(Exception diagnosticError)
                {
                    logger.LogWarning(diagnosticError,"Failed to persist Gmail sync diagnostic for {ConnectionId}",id);
                }
            }
            throw;
        }
    }

    private async Task CreateSyncJobAsync(string jobId,GmailConnectionDto connection,string staging,long total,string now,CancellationToken token){const string sql="""INSERT INTO import_jobs(id,archive_id,source_path,source_name,source_type,status,phase,processed_items,total_items,processed_bytes,total_bytes,error_count,ocr_enabled,can_resume,temporary_source,checkpoint_json,checkpoint_version,staging_path,parser_name,created_at,updated_at) VALUES($1,$2,$3,$4,'gmail','running','indexing',0,$5,0,0,0,$6,1,1,'{}',2,$3,'gmail-api',$7,$7)""";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(jobId);command.Parameters.AddWithValue(connection.ArchiveId);command.Parameters.AddWithValue(staging);command.Parameters.AddWithValue(connection.Email);command.Parameters.AddWithValue(total);command.Parameters.AddWithValue(connection.OcrEnabled?1:0);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);}
    private async Task<IReadOnlyList<string>> ListMessageIdsAsync(string accessToken,string query,CancellationToken token){var result=new List<string>();string? page=null;do{var url=$"{GmailApi}/users/me/messages?maxResults=500"+(query.Length>0?$"&q={Uri.EscapeDataString(query)}":"")+(page is null?"":$"&pageToken={Uri.EscapeDataString(page)}");var json=await GoogleJsonAsync(url,accessToken,HttpMethod.Get,null,token);if(json.TryGetProperty("messages",out var messages)&&messages.ValueKind==JsonValueKind.Array)result.AddRange(messages.EnumerateArray().Select(item=>item.GetProperty("id").GetString()).Where(value=>value is not null)!);page=json.TryGetProperty("nextPageToken",out var next)?next.GetString():null;}while(page is not null);return result;}
    private async Task<GmailConnectionRecord?> GetAsync(string id,string owner,CancellationToken token){const string sql="""SELECT g.id,g.email,g.archive_id,a.name,g.folder_id,f.path,g.query,g.ocr_enabled<>0,g.can_send<>0,g.can_modify_mailbox<>0,g.can_manage_calendar<>0,g.status,g.processed_items,g.total_items,g.imported_items,g.last_synced_at,g.last_error,g.created_at,g.updated_at,g.refresh_token,g.access_token,g.access_token_expires_at FROM gmail_connections g JOIN archives a ON a.id=g.archive_id JOIN folders f ON f.id=g.folder_id WHERE g.id=$1 AND a.owner_user_id=$2""";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))return null;var value=ReadPublic(reader);return new(value,reader.GetString(19),reader.IsDBNull(20)?null:reader.GetString(20),reader.IsDBNull(21)?null:reader.GetString(21));}
    private async Task<string> AccessTokenAsync(GmailConnectionRecord record,CancellationToken token){if(record.AccessToken is not null&&DateTimeOffset.TryParse(record.AccessTokenExpiresAt,out var expires)&&expires>DateTimeOffset.UtcNow.AddMinutes(1))return record.AccessToken;var configured=settings.Current().GmailValue;if(string.IsNullOrWhiteSpace(configured.ClientId))throw new InvalidOperationException("Gmail OAuth configuration is missing; restore it in Admin settings and reauthorize the account");var tokenFields=new Dictionary<string,string>{{"client_id",configured.ClientId},{"refresh_token",record.RefreshToken},{"grant_type","refresh_token"}};if(!string.IsNullOrWhiteSpace(configured.ClientSecret))tokenFields["client_secret"]=configured.ClientSecret;using var form=new FormUrlEncodedContent(tokenFields);using var response=await clients.CreateClient("gmail").PostAsync("https://oauth2.googleapis.com/token",form,token);var body=await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken:token);if(!response.IsSuccessStatusCode){var reason=Text(body,"error_description")??Text(body,"error")??$"HTTP {(int)response.StatusCode}";throw new InvalidOperationException($"Google access token refresh failed: {reason}");}var access=body.GetProperty("access_token").GetString()!;var expiresAt=DateTimeOffset.UtcNow.AddSeconds(Seconds(body,"expires_in",3600)).ToString("O");await using var command=database.CreateCommand("UPDATE gmail_connections SET access_token=$2,access_token_expires_at=$3,updated_at=$4 WHERE id=$1");command.Parameters.AddWithValue(record.Public.Id);command.Parameters.AddWithValue(access);command.Parameters.AddWithValue(expiresAt);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);return access;}
    private async Task<JsonElement> GoogleJsonAsync(string url,string accessToken,HttpMethod method,JsonElement? body,CancellationToken token)
    {
        var maxAttempts=method==HttpMethod.Get?3:1;
        for(var attempt=1;attempt<=maxAttempts;attempt++)
        {
            try
            {
                using var request=new HttpRequestMessage(method,url);
                request.Headers.Authorization=new AuthenticationHeaderValue("Bearer",accessToken);
                if(body is not null)request.Content=JsonContent.Create(body.Value);
                using var response=await clients.CreateClient("gmail").SendAsync(request,token);
                var text=await response.Content.ReadAsStringAsync(token);
                if(response.IsSuccessStatusCode)return string.IsNullOrWhiteSpace(text)?JsonSerializer.SerializeToElement(new{}):JsonDocument.Parse(text).RootElement.Clone();
                if(attempt<maxAttempts&&TransientGoogleStatus(response.StatusCode)){await RetryDelayAsync(attempt,token);continue;}
                throw new InvalidOperationException($"Google API returned {(int)response.StatusCode}: {text[..Math.Min(300,text.Length)]}");
            }
            catch(TaskCanceledException error) when(!token.IsCancellationRequested)
            {
                if(attempt>=maxAttempts)throw new TimeoutException($"Google API request timed out after {maxAttempts} attempts",error);
                await RetryDelayAsync(attempt,token);
            }
            catch(HttpRequestException) when(attempt<maxAttempts)
            {
                await RetryDelayAsync(attempt,token);
            }
        }
        throw new InvalidOperationException("Google API request failed");
    }
    internal static bool TransientGoogleStatus(HttpStatusCode status)=>(int)status is 429 or 500 or 502 or 503 or 504;
    private static Task RetryDelayAsync(int attempt,CancellationToken token)=>Task.Delay(TimeSpan.FromSeconds(1<<Math.Min(attempt-1,3)),token);
    private async Task UpdateSyncAsync(string id,string status,long processed,long? total,long imported,string? error,CancellationToken token,string? query=null,string? lastSyncedAt=null){const string sql="UPDATE gmail_connections SET status=$2,processed_items=$3,total_items=$4,imported_items=$5,last_error=$6,query=COALESCE($7,query),last_synced_at=COALESCE($8,last_synced_at),updated_at=$9 WHERE id=$1";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(status);command.Parameters.AddWithValue(processed);command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Bigint,Value=(object?)total??DBNull.Value});command.Parameters.AddWithValue(imported);command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Text,Value=(object?)error??DBNull.Value});command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Text,Value=(object?)query??DBNull.Value});command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Text,Value=(object?)lastSyncedAt??DBNull.Value});command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);}
    private async Task FinishSyncAsync(string id,string status,string? error,CancellationToken token){const string sql="UPDATE gmail_connections SET status=$2,last_error=$3,updated_at=$4 WHERE id=$1";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(status);command.Parameters.Add(new NpgsqlParameter{NpgsqlDbType=NpgsqlDbType.Text,Value=(object?)error??DBNull.Value});command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);}
    private async Task<bool> MessageExistsAsync(string archive,string key,CancellationToken token){await using var command=database.CreateCommand("SELECT EXISTS(SELECT 1 FROM messages WHERE archive_id=$1 AND source_key=$2)");command.Parameters.AddWithValue(archive);command.Parameters.AddWithValue(key);return Convert.ToBoolean(await command.ExecuteScalarAsync(token));}
    private async Task ApplyReadStatesAsync(string archive,IReadOnlyDictionary<string,bool> states,CancellationToken token){foreach(var pair in states){await using var command=database.CreateCommand("UPDATE message_state s SET is_read=$3,updated_at=$4 FROM messages m WHERE m.id=s.message_id AND m.archive_id=$1 AND m.source_key=$2");command.Parameters.AddWithValue(archive);command.Parameters.AddWithValue(pair.Key);command.Parameters.AddWithValue(pair.Value?1:0);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);}}
    private static async Task<bool> OwnsArchiveAsync(NpgsqlConnection connection,NpgsqlTransaction tx,string archive,string owner,CancellationToken token){await using var command=new NpgsqlCommand("SELECT EXISTS(SELECT 1 FROM archives WHERE id=$1 AND owner_user_id=$2)",connection,tx);command.Parameters.AddWithValue(archive);command.Parameters.AddWithValue(owner);return Convert.ToBoolean(await command.ExecuteScalarAsync(token));}
    private static GmailConnectionDto ReadPublic(NpgsqlDataReader r)=>new(r.GetString(0),r.GetString(1),r.GetString(2),r.GetString(3),r.GetString(4),r.GetString(5),r.GetString(6),r.GetBoolean(7),r.GetBoolean(8),r.GetBoolean(9),r.GetBoolean(10),r.GetString(11),r.GetInt64(12),r.IsDBNull(13)?null:r.GetInt64(13),r.GetInt64(14),r.IsDBNull(15)?null:r.GetString(15),r.IsDBNull(16)?null:r.GetString(16),r.GetString(17),r.GetString(18));
    private static string ResolveFolder(string root,IReadOnlySet<string> labels)=>labels.Contains("TRASH")?$"{root}/Trash":labels.Contains("SPAM")?$"{root}/Spam":labels.Contains("SENT")?$"{root}/Sent":labels.Contains("DRAFT")?$"{root}/Drafts":labels.Contains("INBOX")?$"{root}/Inbox":$"{root}/Archived";
    // OAuth token endpoints are inconsistent about expires_in: the spec says a number, but
    // Google and proxies in front of it sometimes return it quoted. GetInt32() throws on the
    // string form ("requires an element of type 'Number'"), and because AccessTokenAsync runs
    // on every Gmail operation that surfaced as a tight loop of unhandled exceptions.
    // A non-positive lifetime is treated as absent too: it would expire the token instantly
    // and refresh on every single call, which is the same runaway loop by another route.
    internal static int Seconds(JsonElement value,string name,int fallback)
    {
        if(value.ValueKind!=JsonValueKind.Object||!value.TryGetProperty(name,out var item))return fallback;
        var parsed=item.ValueKind switch
        {
            JsonValueKind.Number when item.TryGetInt32(out var number)=>number,
            JsonValueKind.String when int.TryParse(item.GetString(),NumberStyles.Integer,CultureInfo.InvariantCulture,out var text)=>text,
            _=>0
        };
        return parsed>0?parsed:fallback;
    }
    private static string? Text(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.String?item.GetString()?.Trim():null;
    private static bool Bool(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.True;
    private static string[] Strings(JsonElement value,string name)=>value.ValueKind==JsonValueKind.Object&&value.TryGetProperty(name,out var item)&&item.ValueKind==JsonValueKind.Array?item.EnumerateArray().Where(entry=>entry.ValueKind==JsonValueKind.String).Select(entry=>entry.GetString()??"").ToArray():[];
    private static string Base64Url(byte[] value)=>Convert.ToBase64String(value).TrimEnd('=').Replace('+','-').Replace('/','_');
    private static byte[] Base64UrlDecode(string value){var normalized=value.Replace('-','+').Replace('_','/');normalized+=new string('=',(4-normalized.Length%4)%4);return Convert.FromBase64String(normalized);}
}

public sealed class GmailScheduledSyncService(GmailService gmail,AppSettingsService settings,ILogger<GmailScheduledSyncService> logger):BackgroundService
{
    // Reading the interval and awaiting the delay sit inside the guard with everything else: they
    // decrypt saved settings and observe the shutdown token, and an exception from either escaping
    // ExecuteAsync faults this service. Every other worker here already guards its whole loop.
    protected override async Task ExecuteAsync(CancellationToken stoppingToken){while(!stoppingToken.IsCancellationRequested){try{var minutes=Math.Clamp(settings.Current().GmailValue.SyncIntervalMinutes,1,1440);await Task.Delay(TimeSpan.FromMinutes(minutes),stoppingToken);foreach(var connection in await gmail.ListAsyncForSchedule(stoppingToken))if(connection.Status!="syncing")await gmail.StartSyncAsync(connection.Id,connection.OwnerUserId,false,stoppingToken);}catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){break;}catch(Exception error){logger.LogError(error,"Scheduled Gmail synchronization failed");await Task.Delay(TimeSpan.FromMinutes(1),CancellationToken.None);}}}
}

public sealed record ScheduledGmailConnection(string Id,string OwnerUserId,string Status);
public static class GmailScheduleExtensions
{
    public static async Task<IReadOnlyList<ScheduledGmailConnection>> ListAsyncForSchedule(this GmailService service,CancellationToken token)=>await service.InternalScheduleListAsync(token);
}
