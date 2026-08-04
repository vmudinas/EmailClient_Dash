using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Productivity;
using Npgsql;

namespace ArchiveMail.Api.Ai;

public sealed class AiService(
    NpgsqlDataSource database,
    AppSettingsService settings,
    IHttpClientFactory clients,
    MailRepository mail,
    ProductivityRepository productivity,
    FollowUpRepository followUps,
    ILogger<AiService> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private sealed record FilingCandidate(string FolderId,string FolderPath,string Reason,double Confidence);
    private sealed record FilingProposal(string Id,string MessageId,string Subject,EmailAddressDto Sender,string CurrentFolderId,string CurrentFolderPath,string ProposedFolderId,string ProposedFolderPath,string Reason,double Confidence);
    private sealed record FilingContext(string MessageId,string CategoriesJson,string ArchiveId,string CurrentFolderId);
    private sealed record FilingFolder(string ArchiveId,string Id,string Path,string Name);

    public async Task<object> MessageStateAsync(string messageId,string owner,CancellationToken token)
    {
        await EnsureMessageOwner(messageId,owner,token); return new { job=await LatestJob(messageId,"analyze",token), analysis=await Analysis(messageId,token) };
    }

    public async Task<object> StartAnalysisAsync(string messageId,string owner,CancellationToken token)
    {
        await EnsureConfigured(token); await EnsureMessageOwner(messageId,owner,token);
        var existing=await Analysis(messageId,token);
        var job=await Enqueue(messageId,"analyze",null,null,null,token);return new {job,analysis=existing};
    }

    public async Task<object> StartDraftAsync(string messageId,JsonElement input,string owner,CancellationToken token)
    {await EnsureConfigured(token);await EnsureMessageOwner(messageId,owner,token);var connection=Required(input,"gmailConnectionId");await using var owns=database.CreateCommand("SELECT EXISTS(SELECT 1 FROM gmail_connections g JOIN archives a ON a.id=g.archive_id WHERE g.id=$1 AND a.owner_user_id=$2)");owns.Parameters.AddWithValue(connection);owns.Parameters.AddWithValue(owner);if(!Convert.ToBoolean(await owns.ExecuteScalarAsync(token)))throw new MailNotFoundException("Gmail connection not found");await using var existing=database.CreateCommand("SELECT id FROM email_drafts WHERE source_message_id=$1 AND connection_id=$2 ORDER BY created_at DESC LIMIT 1");existing.Parameters.AddWithValue(messageId);existing.Parameters.AddWithValue(connection);if(Convert.ToString(await existing.ExecuteScalarAsync(token))is{Length:>0} draftId)return new{job=(object?)null,draftId};var job=await Enqueue(messageId,"draft_reply",null,connection,String(input,"resumeId"),token);return new{job,draft=(object?)null};}
    public async Task<object> SuggestActionAsync(string messageId,JsonElement input,string owner,CancellationToken token)
    {await EnsureMessageOwner(messageId,owner,token);await using var command=database.CreateCommand("SELECT subject,body_text FROM messages WHERE id=$1");command.Parameters.AddWithValue(messageId);await using var r=await command.ExecuteReaderAsync(token);await r.ReadAsync(token);var subject=r.GetString(0);var body=r.GetString(1);var date=System.Text.RegularExpressions.Regex.Match(body,@"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b");var provider=settings.Current().AiValue.ActiveProvider;var model=Provider().Model;if(date.Success&&DateTime.TryParse(date.Value,out var parsed)){var day=DateOnly.FromDateTime(parsed).ToString("yyyy-MM-dd");return new{recommendedAction="calendar_event",reason="The message contains an explicit date.",confidence=.72,dateEvidence=new[]{date.Value},calendarEvent=new{title=subject,description=body[..Math.Min(body.Length,1000)],location="",allDay=true,startDate=day,endDate=day,startTime=(string?)null,endTime=(string?)null},todo=(object?)null,provider,model};}return new{recommendedAction="none",reason="No unambiguous future date was found.",confidence=.65,dateEvidence=System.Array.Empty<string>(),calendarEvent=(object?)null,todo=(object?)null,provider,model};}
    public async Task<object> SuggestFilingAsync(string[] ids,string owner,CancellationToken token)
    {
        var unique=ids.Distinct().Take(100).ToArray();
        if(unique.Length==0)throw new ArgumentException("Choose messages to file");
        const string sql="""
            SELECT f.id,f.path,COUNT(*)
            FROM messages selected
            JOIN archives a ON a.id=selected.archive_id
            JOIN messages similar ON similar.archive_id=selected.archive_id
                AND lower(similar.sender_address)=lower(selected.sender_address)
            JOIN folders f ON f.id=similar.folder_id
            WHERE selected.id=ANY($1) AND a.owner_user_id=$2 AND similar.id<>selected.id
                AND f.id<>selected.folder_id
                AND lower(f.name) NOT IN ('trash','spam','junk','deleted')
            GROUP BY f.id,f.path
            ORDER BY COUNT(*) DESC,f.path
            LIMIT 3
            """;
        var suggestions=new List<FilingCandidate>();
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(unique);command.Parameters.AddWithValue(owner);
        await using var r=await command.ExecuteReaderAsync(token);
        while(await r.ReadAsync(token))suggestions.Add(Candidate(r.GetString(0),r.GetString(1),r.GetInt64(2)));
        var provider=settings.Current().AiValue.ActiveProvider;var model=Provider().Model;
        if(suggestions.Count==0)return new{folderId=(string?)null,folderPath=(string?)null,reason="No previous filing pattern was found.",confidence=.3,messageCount=unique.Length,provider,model,suggestions};
        var best=suggestions[0];
        return new{folderId=best.FolderId,folderPath=best.FolderPath,reason=best.Reason,confidence=best.Confidence,messageCount=unique.Length,provider,model,suggestions};
    }

    public async Task<object?> GetJobAsync(string id,string owner,CancellationToken token)
    {
        const string sql="SELECT j.* FROM ai_jobs j JOIN messages m ON m.id=j.message_id JOIN archives a ON a.id=m.archive_id WHERE j.id=$1 AND a.owner_user_id=$2";
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);return await reader.ReadAsync(token)?Job(reader):null;
    }

    public async Task<object?> CancelAsync(string id,string owner,CancellationToken token)
    {
        const string sql="UPDATE ai_jobs j SET status='cancelled',updated_at=$3,completed_at=$3 FROM messages m,archives a WHERE j.id=$1 AND m.id=j.message_id AND a.id=m.archive_id AND a.owner_user_id=$2 AND j.status IN ('queued','running')";
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);return await GetJobAsync(id,owner,token);
    }

    public async Task<object> ReviewQueueAsync(string owner,CancellationToken token)
    {
        const string sql="SELECT m.id FROM ai_message_analysis x JOIN messages m ON m.id=x.message_id JOIN archives a ON a.id=m.archive_id LEFT JOIN ai_analysis_reviews r ON r.message_id=m.id WHERE a.owner_user_id=$1 AND r.message_id IS NULL ORDER BY x.updated_at DESC LIMIT 100";
        var analyses=new List<object>();await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);var ids=new List<string>();while(await reader.ReadAsync(token))ids.Add(reader.GetString(0));
        await reader.CloseAsync();
        var summaryTask=mail.GetMessageSummariesAsync(ids,owner,token);
        var analysisTask=AnalysesAsync(ids.ToArray(),token);
        var filingTask=SafeFilingSuggestionsByMessageAsync(ids.ToArray(),owner,token);
        var draftTask=productivity.ListDraftsAsync(owner,token);
        var followUpTask=followUps.ListAsync("pending",owner,token);
        await Task.WhenAll(summaryTask,analysisTask,filingTask,draftTask,followUpTask);
        var summaries=(await summaryTask).ToDictionary(message=>message.Id);
        var analysisByMessage=await analysisTask;
        var filingSuggestions=await filingTask;
        foreach(var id in ids)
        {
            if(summaries.TryGetValue(id,out var message)&&analysisByMessage.TryGetValue(id,out var analysis))
                analyses.Add(new{message,analysis,filingSuggestions=filingSuggestions.GetValueOrDefault(id)??new List<FilingCandidate>()});
        }
        var archiveIds=summaries.Values.Select(message=>message.ArchiveId).Distinct().ToArray();
        var folderLists=await Task.WhenAll(archiveIds.Select(archiveId=>mail.ListFoldersAsync(archiveId,owner,token)));
        var folders=folderLists.SelectMany(list=>list).ToArray();
        var drafts=await draftTask;
        var pendingFollowUps=await followUpTask;
        return new{drafts,analyses,followUps=pendingFollowUps,folders,totalItems=drafts.Count+analyses.Count+pendingFollowUps.Count};
    }

    public async Task<object> FilingProposalsAsync(string[] ids,string owner,CancellationToken token)
    {
        var unique=ids.Where(id=>!string.IsNullOrWhiteSpace(id)).Distinct().Take(100).ToArray();
        if(unique.Length==0)throw new ArgumentException("Choose messages to recategorize");
        var summaryTask=mail.GetMessageSummariesAsync(unique,owner,token);
        var suggestionTask=FilingSuggestionsByMessageAsync(unique,owner,token);
        await Task.WhenAll(summaryTask,suggestionTask);
        var suggestions=await suggestionTask;
        var proposals=new List<FilingProposal>();
        foreach(var message in await summaryTask)
        {
            var candidate=suggestions.GetValueOrDefault(message.Id)?.FirstOrDefault();
            if(candidate is null)continue;
            proposals.Add(new($"{message.Id}:{candidate.FolderId}",message.Id,message.Subject,message.Sender,message.FolderId,message.FolderPath,candidate.FolderId,candidate.FolderPath,candidate.Reason,candidate.Confidence));
        }
        var ordered=proposals.OrderByDescending(proposal=>proposal.Confidence).ToArray();
        return new{proposals=ordered,considered=unique.Length,skipped=unique.Length-ordered.Length,generatedAt=DateTimeOffset.UtcNow.ToString("O")};
    }

    private async Task<Dictionary<string,List<FilingCandidate>>> FilingSuggestionsByMessageAsync(string[] ids,string owner,CancellationToken token)
    {
        var result=new Dictionary<string,List<FilingCandidate>>();
        if(ids.Length==0)return result;
        const string sql="""
            WITH ranked AS (
                SELECT selected.id AS message_id,f.id AS folder_id,f.path,COUNT(*) AS matches,
                    ROW_NUMBER() OVER (PARTITION BY selected.id ORDER BY COUNT(*) DESC,f.path) AS rank
                FROM messages selected
                JOIN archives a ON a.id=selected.archive_id
                JOIN messages similar ON similar.archive_id=selected.archive_id
                    AND lower(similar.sender_address)=lower(selected.sender_address)
                JOIN folders f ON f.id=similar.folder_id
                WHERE selected.id=ANY($1) AND a.owner_user_id=$2 AND similar.id<>selected.id
                    AND f.id<>selected.folder_id
                    AND lower(f.name) NOT IN ('trash','spam','junk','deleted')
                GROUP BY selected.id,f.id,f.path
            )
            SELECT message_id,folder_id,path,matches FROM ranked WHERE rank<=3 ORDER BY message_id,rank
            """;
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(ids);command.Parameters.AddWithValue(owner);
        await using var reader=await command.ExecuteReaderAsync(token);
        while(await reader.ReadAsync(token))
        {
            var messageId=reader.GetString(0);
            if(!result.TryGetValue(messageId,out var suggestions)){suggestions=new List<FilingCandidate>();result[messageId]=suggestions;}
            suggestions.Add(Candidate(reader.GetString(1),reader.GetString(2),reader.GetInt64(3)));
        }
        await reader.CloseAsync();
        const string contextSql="""
            SELECT x.message_id,x.categories_json,m.archive_id,m.folder_id
            FROM ai_message_analysis x
            JOIN messages m ON m.id=x.message_id
            JOIN archives a ON a.id=m.archive_id
            WHERE x.message_id=ANY($1) AND a.owner_user_id=$2
            """;
        var contexts=new List<FilingContext>();
        await using var contextCommand=database.CreateCommand(contextSql);contextCommand.Parameters.AddWithValue(ids);contextCommand.Parameters.AddWithValue(owner);
        await using var contextReader=await contextCommand.ExecuteReaderAsync(token);
        while(await contextReader.ReadAsync(token))
            contexts.Add(new(contextReader.GetString(0),contextReader.GetString(1),contextReader.GetString(2),contextReader.GetString(3)));
        await contextReader.CloseAsync();
        var archiveIds=contexts.Select(context=>context.ArchiveId).Distinct().ToArray();
        if(archiveIds.Length==0)return result;
        const string folderSql="""
            SELECT f.archive_id,f.id,f.path,f.name
            FROM folders f
            JOIN archives a ON a.id=f.archive_id
            WHERE f.archive_id=ANY($1) AND a.owner_user_id=$2
                AND lower(f.name) NOT IN ('trash','spam','junk','deleted')
            ORDER BY f.archive_id,f.path
            """;
        var folders=new List<FilingFolder>();
        await using var folderCommand=database.CreateCommand(folderSql);folderCommand.Parameters.AddWithValue(archiveIds);folderCommand.Parameters.AddWithValue(owner);
        await using var folderReader=await folderCommand.ExecuteReaderAsync(token);
        while(await folderReader.ReadAsync(token))
            folders.Add(new(folderReader.GetString(0),folderReader.GetString(1),folderReader.GetString(2),folderReader.GetString(3)));
        var foldersByArchive=folders.ToLookup(folder=>folder.ArchiveId);
        foreach(var context in contexts)
        {
            var categories=ParseArray(context.CategoriesJson);
            if(categories.Length==0)continue;
            if(!result.TryGetValue(context.MessageId,out var suggestions)){suggestions=new List<FilingCandidate>();result[context.MessageId]=suggestions;}
            foreach(var folder in foldersByArchive[context.ArchiveId])
            {
                if(suggestions.Count>=3)break;
                if(folder.Id==context.CurrentFolderId||suggestions.Any(candidate=>candidate.FolderId==folder.Id))continue;
                if(categories.Any(category=>CategoryMatchesFolder(category,folder.Name,folder.Path)))
                    suggestions.Add(new(folder.Id,folder.Path,"AI category matches this existing folder.",.68));
            }
        }
        return result;
    }

    private async Task<Dictionary<string,List<FilingCandidate>>> SafeFilingSuggestionsByMessageAsync(string[] ids,string owner,CancellationToken token)
    {
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        try{return await FilingSuggestionsByMessageAsync(ids,owner,timeout.Token);}
        catch(OperationCanceledException)when(token.IsCancellationRequested){throw;}
        catch(Exception error)
        {
            logger.LogWarning(error,"Review queue folder suggestions failed; returning the queue without suggestions");
            return new Dictionary<string,List<FilingCandidate>>();
        }
    }

    internal static bool CategoryMatchesFolder(string category,string folderName,string folderPath)=>
        category.Equals(folderName,StringComparison.OrdinalIgnoreCase)||category.Equals(folderPath,StringComparison.OrdinalIgnoreCase);

    private async Task<Dictionary<string,object>> AnalysesAsync(string[] ids,CancellationToken token)
    {
        var result=new Dictionary<string,object>();
        if(ids.Length==0)return result;
        const string sql="SELECT id,message_id,summary,categories_json,priority,action_required<>0,action_summary,spam_probability,phishing_probability,draft_recommended<>0,confidence,signals_json,model,prompt_version,content_hash,context_hash,thread_message_count,created_at,updated_at FROM ai_message_analysis WHERE message_id=ANY($1)";
        await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(ids);
        await using var reader=await command.ExecuteReaderAsync(token);
        while(await reader.ReadAsync(token))result[reader.GetString(1)]=AnalysisObject(reader);
        return result;
    }

    private static FilingCandidate Candidate(string folderId,string folderPath,long matches)=>new(
        folderId,folderPath,"Previous messages from this sender were filed here.",Math.Min(.95,.55+matches/100d));

    public async Task<object> ReviewAsync(string messageId,string owner,CancellationToken token)
    {await EnsureMessageOwner(messageId,owner,token);if(await Analysis(messageId,token) is null)throw new MailNotFoundException("Message analysis not found");var now=DateTimeOffset.UtcNow.ToString("O");await using var command=database.CreateCommand("INSERT INTO ai_analysis_reviews(message_id,reviewed_at) VALUES($1,$2) ON CONFLICT(message_id) DO UPDATE SET reviewed_at=EXCLUDED.reviewed_at");command.Parameters.AddWithValue(messageId);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);return new{messageId,reviewedAt=now};}
    public async Task<object> ReviewAllAsync(string owner,CancellationToken token)
    {var now=DateTimeOffset.UtcNow.ToString("O");const string sql="INSERT INTO ai_analysis_reviews(message_id,reviewed_at) SELECT x.message_id,$2 FROM ai_message_analysis x JOIN messages m ON m.id=x.message_id JOIN archives a ON a.id=m.archive_id WHERE a.owner_user_id=$1 ON CONFLICT(message_id) DO UPDATE SET reviewed_at=EXCLUDED.reviewed_at";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(owner);command.Parameters.AddWithValue(now);var count=await command.ExecuteNonQueryAsync(token);return new{reviewedCount=count,reviewedAt=now};}

    public async Task<IReadOnlyList<object>> ListSchedulesAsync(string owner,CancellationToken token)
    {const string sql="SELECT s.id,s.name,s.task,s.folder_id,f.path,f.archive_id,a.name,s.message_id,m.subject,s.gmail_connection_id,g.email,s.resume_id,r.name,s.mode,s.interval_minutes,s.enabled<>0,s.last_run_at,s.last_run_summary,s.provider,s.model,s.skills_json,s.prompt,s.created_at,s.updated_at FROM ai_schedules s JOIN folders f ON f.id=s.folder_id JOIN archives a ON a.id=f.archive_id LEFT JOIN messages m ON m.id=s.message_id LEFT JOIN gmail_connections g ON g.id=s.gmail_connection_id LEFT JOIN resume_assets r ON r.id=s.resume_id WHERE a.owner_user_id=$1 ORDER BY s.created_at DESC";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(owner);await using var reader=await command.ExecuteReaderAsync(token);var list=new List<object>();while(await reader.ReadAsync(token))list.Add(Schedule(reader));return list;}
    public async Task<object> CreateScheduleAsync(JsonElement input,string owner,CancellationToken token)
    {var folder=Required(input,"folderId");await EnsureFolderOwner(folder,owner,token);var id=Guid.NewGuid().ToString();var now=DateTimeOffset.UtcNow.ToString("O");const string sql="INSERT INTO ai_schedules(id,name,folder_id,mode,interval_minutes,enabled,provider,model,skills_json,prompt,task,message_id,gmail_connection_id,resume_id,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(Required(input,"name"));command.Parameters.AddWithValue(folder);command.Parameters.AddWithValue(String(input,"mode")??"all");command.Parameters.AddWithValue(Integer(input,"intervalMinutes")??60);command.Parameters.AddWithValue(Boolean(input,"enabled")??true?1:0);command.Parameters.AddWithValue(String(input,"provider")??settings.Current().AiValue.ActiveProvider);command.Parameters.AddWithValue(String(input,"model")??Provider().Model);command.Parameters.AddWithValue(input.TryGetProperty("skills",out var skills)?skills.GetRawText():"[]");command.Parameters.AddWithValue(String(input,"prompt")??"");command.Parameters.AddWithValue(String(input,"task")??"analyze");AddNullable(command,String(input,"messageId"));AddNullable(command,String(input,"gmailConnectionId"));AddNullable(command,String(input,"resumeId"));command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);return (await ListSchedulesAsync(owner,token)).Single(item=>Id(item)==id);}
    public async Task<object?> UpdateScheduleAsync(string id,JsonElement input,string owner,CancellationToken token)
    {var schedules=await ListSchedulesAsync(owner,token);if(!schedules.Any(item=>Id(item)==id))return null;if(String(input,"folderId") is{} folder)await EnsureFolderOwner(folder,owner,token);var values=new Dictionary<string,object?>{{"name",String(input,"name")},{"folder_id",String(input,"folderId")},{"mode",String(input,"mode")},{"interval_minutes",Integer(input,"intervalMinutes")},{"enabled",Boolean(input,"enabled") is{} b?b?1:0:null},{"provider",String(input,"provider")},{"model",String(input,"model")},{"prompt",String(input,"prompt")},{"task",String(input,"task")},{"message_id",NullableProperty(input,"messageId")},{"gmail_connection_id",NullableProperty(input,"gmailConnectionId")},{"resume_id",NullableProperty(input,"resumeId")},{"skills_json",input.TryGetProperty("skills",out var skills)?skills.GetRawText():null}};var set=values.Where(pair=>pair.Value is not null||input.TryGetProperty(ToCamel(pair.Key),out _)).ToArray();if(set.Length==0)throw new ArgumentException("At least one schedule setting is required");var sql="UPDATE ai_schedules SET "+string.Join(',',set.Select((pair,index)=>$"{pair.Key}=${index+2}"))+",updated_at=$1 WHERE id=$"+(set.Length+2);await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));foreach(var pair in set)command.Parameters.AddWithValue(pair.Value??DBNull.Value);command.Parameters.AddWithValue(id);await command.ExecuteNonQueryAsync(token);return (await ListSchedulesAsync(owner,token)).Single(item=>Id(item)==id);}
    public async Task DeleteScheduleAsync(string id,string owner,CancellationToken token){await using var command=database.CreateCommand("DELETE FROM ai_schedules s USING folders f,archives a WHERE s.id=$1 AND f.id=s.folder_id AND a.id=f.archive_id AND a.owner_user_id=$2");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);await command.ExecuteNonQueryAsync(token);}
    public async Task<object?> RunScheduleAsync(string id,string owner,CancellationToken token){var schedule=(await ListSchedulesAsync(owner,token)).FirstOrDefault(item=>Id(item)==id);if(schedule is null)return null;await QueueSchedule(id,token);return (await ListSchedulesAsync(owner,token)).First(item=>Id(item)==id);}

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {while(!stoppingToken.IsCancellationRequested){try{await QueueDueSchedules(stoppingToken);var id=await Claim(stoppingToken);if(id is null)await Task.Delay(1000,stoppingToken);else await Process(id,stoppingToken);}catch(OperationCanceledException)when(stoppingToken.IsCancellationRequested){break;}catch(Exception error){logger.LogError(error,"AI worker iteration failed");await Task.Delay(2000,stoppingToken);}}}

    private async Task Process(string id,CancellationToken token)
    {
        try
        {
            const string sql="SELECT j.message_id,j.model,j.provider,j.task,j.gmail_connection_id,j.resume_id,j.schedule_id,m.subject,m.sender_address,m.recipients_text,m.body_text FROM ai_jobs j JOIN messages m ON m.id=j.message_id WHERE j.id=$1";
            await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);await using var reader=await command.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))return;
            var messageId=reader.GetString(0);var model=reader.GetString(1);var provider=reader.GetString(2);var task=reader.GetString(3);var connection=reader.IsDBNull(4)?null:reader.GetString(4);var resume=reader.IsDBNull(5)?null:reader.GetString(5);var schedule=reader.IsDBNull(6)?null:reader.GetString(6);var subject=reader.GetString(7);var sender=reader.GetString(8);var content=$"Subject: {subject}\nFrom: {sender}\nTo: {reader.GetString(9)}\n\n{reader.GetString(10)}";await reader.CloseAsync();var now=DateTimeOffset.UtcNow.ToString("O");
            if(task=="draft_reply")
            {
                if(connection is null)throw new InvalidOperationException("A Gmail sending account is required");var reply=await CallReply(provider,model,content,token);var draftId=Guid.NewGuid().ToString();// AI replies had no From address at all, so they fell through to the connected account's own
                // address. A reply generated against a resume is about engineering work and goes out from
                // the development address; every other generated reply comes from the automated one.
                var from=SendingIdentity.DefaultFor(resume is{Length:>0});
                const string insert="INSERT INTO email_drafts(id,connection_id,source_message_id,schedule_id,source,from_address,to_json,cc_json,bcc_json,subject,body_text,resume_id,work_related,development_opportunity,ai_reason,ai_confidence,created_at,updated_at) VALUES($1,$2,$3,$4,'ai',$5,$6,'[]','[]',$7,$8,$9,1,0,$10,$11,$12,$12) ON CONFLICT(schedule_id,source_message_id) WHERE schedule_id IS NOT NULL AND source_message_id IS NOT NULL DO NOTHING";await using var draft=database.CreateCommand(insert);draft.Parameters.AddWithValue(draftId);draft.Parameters.AddWithValue(connection);draft.Parameters.AddWithValue(messageId);AddNullable(draft,schedule);draft.Parameters.AddWithValue(from);draft.Parameters.AddWithValue(JsonSerializer.Serialize(new[]{sender}));draft.Parameters.AddWithValue(subject.StartsWith("Re:",StringComparison.OrdinalIgnoreCase)?subject:$"Re: {subject}");draft.Parameters.AddWithValue(reply);AddNullable(draft,resume);draft.Parameters.AddWithValue("AI-generated reply for review");draft.Parameters.AddWithValue(.75);draft.Parameters.AddWithValue(now);await draft.ExecuteNonQueryAsync(token);await Finish(id,"completed",null,token);return;
            }
            var result=await Call(provider,model,content,token);const string save="INSERT INTO ai_message_analysis(id,message_id,summary,categories_json,priority,action_required,action_summary,spam_probability,phishing_probability,draft_recommended,confidence,signals_json,model,prompt_version,content_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'csharp-v1',$14,$15,$15) ON CONFLICT(message_id) DO UPDATE SET summary=EXCLUDED.summary,categories_json=EXCLUDED.categories_json,priority=EXCLUDED.priority,action_required=EXCLUDED.action_required,action_summary=EXCLUDED.action_summary,spam_probability=EXCLUDED.spam_probability,phishing_probability=EXCLUDED.phishing_probability,draft_recommended=EXCLUDED.draft_recommended,confidence=EXCLUDED.confidence,signals_json=EXCLUDED.signals_json,model=EXCLUDED.model,content_hash=EXCLUDED.content_hash,updated_at=EXCLUDED.updated_at";await using var saveCommand=database.CreateCommand(save);saveCommand.Parameters.AddWithValue(Guid.NewGuid().ToString());saveCommand.Parameters.AddWithValue(messageId);saveCommand.Parameters.AddWithValue(Text(result,"summary")??"No summary returned");saveCommand.Parameters.AddWithValue(JsonArray(result,"categories"));saveCommand.Parameters.AddWithValue(NormalizePriority(Text(result,"priority")));saveCommand.Parameters.AddWithValue(Bool(result,"actionRequired")?1:0);AddNullable(saveCommand,Text(result,"actionSummary"));saveCommand.Parameters.AddWithValue(Number(result,"spamProbability"));saveCommand.Parameters.AddWithValue(Number(result,"phishingProbability"));saveCommand.Parameters.AddWithValue(Bool(result,"draftRecommended")?1:0);saveCommand.Parameters.AddWithValue(Number(result,"confidence"));saveCommand.Parameters.AddWithValue(JsonArray(result,"signals"));saveCommand.Parameters.AddWithValue(model);saveCommand.Parameters.AddWithValue(Hash(content));saveCommand.Parameters.AddWithValue(now);await saveCommand.ExecuteNonQueryAsync(token);await Finish(id,"completed",null,token);
        }
        catch(Exception error){logger.LogWarning(error,"AI job {JobId} failed",id);await Finish(id,"failed",error.Message,token);}
    }

    private async Task<JsonElement> Call(string provider,string model,string content,CancellationToken token)
    {var config=Provider(provider);return await AiProviderClient.AnalyzeAsync(clients.CreateClient("ai"),provider,model,config.ApiKey,content,token);}
    private async Task<string> CallReply(string provider,string model,string content,CancellationToken token)
    {var config=Provider(provider);return await AiProviderClient.DraftReplyAsync(clients.CreateClient("ai"),provider,model,config.ApiKey,content,token);}

    internal const string EnqueueSql="INSERT INTO ai_jobs(id,message_id,task,schedule_id,gmail_connection_id,resume_id,status,provider,model,skills_json,prompt,prompt_version,content_hash,attempts,max_attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'queued',$7,$8,'[]','','csharp-v1','pending',0,2,$9,$9) ON CONFLICT DO NOTHING";
    private async Task<object> Enqueue(string messageId,string task,string? scheduleId,string? connectionId,string? resumeId,CancellationToken token){var config=settings.Current().AiValue;var provider=config.ActiveProvider;var model=Provider(provider).Model;var id=Guid.NewGuid().ToString();var now=DateTimeOffset.UtcNow.ToString("O");await using var command=database.CreateCommand(EnqueueSql);command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(messageId);command.Parameters.AddWithValue(task);AddNullable(command,scheduleId);AddNullable(command,connectionId);AddNullable(command,resumeId);command.Parameters.AddWithValue(provider);command.Parameters.AddWithValue(model);command.Parameters.AddWithValue(now);await command.ExecuteNonQueryAsync(token);return await LatestJob(messageId,task,token)??throw new InvalidOperationException("AI job could not be queued");}
    private async Task<string?> Claim(CancellationToken token){const string sql="UPDATE ai_jobs SET status='running',attempts=attempts+1,started_at=$1,updated_at=$1 WHERE id=(SELECT id FROM ai_jobs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));return Convert.ToString(await command.ExecuteScalarAsync(token));}
    private async Task Finish(string id,string status,string? error,CancellationToken token){await using var command=database.CreateCommand("UPDATE ai_jobs SET status=$2,error=$3,completed_at=$4,updated_at=$4 WHERE id=$1");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(status);AddNullable(command,error);command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await command.ExecuteNonQueryAsync(token);}
    private async Task QueueDueSchedules(CancellationToken token){const string sql="SELECT id FROM ai_schedules WHERE enabled<>0 AND (last_run_at IS NULL OR last_run_at::timestamptz + interval_minutes*interval '1 minute' <= now())";await using var command=database.CreateCommand(sql);await using var reader=await command.ExecuteReaderAsync(token);var ids=new List<string>();while(await reader.ReadAsync(token))ids.Add(reader.GetString(0));foreach(var id in ids)await QueueSchedule(id,token);}
    private async Task QueueSchedule(string id,CancellationToken token){const string sql="SELECT s.folder_id,s.mode,s.task,s.gmail_connection_id,s.resume_id FROM ai_schedules s WHERE s.id=$1";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);await using var reader=await command.ExecuteReaderAsync(token);if(!await reader.ReadAsync(token))return;var folder=reader.GetString(0);var mode=reader.GetString(1);var task=reader.GetString(2);var connection=reader.IsDBNull(3)?null:reader.GetString(3);var resume=reader.IsDBNull(4)?null:reader.GetString(4);await reader.CloseAsync();var list=database.CreateCommand("SELECT m.id FROM messages m LEFT JOIN message_state st ON st.message_id=m.id WHERE m.folder_id=$1 AND ($2='all' OR COALESCE(st.is_read,0)=0)");await using(list){list.Parameters.AddWithValue(folder);list.Parameters.AddWithValue(mode);await using var messages=await list.ExecuteReaderAsync(token);var ids=new List<string>();while(await messages.ReadAsync(token))ids.Add(messages.GetString(0));foreach(var message in ids)await Enqueue(message,task,id,connection,resume,token);}await using var update=database.CreateCommand("UPDATE ai_schedules SET last_run_at=$2,last_run_summary=$3,updated_at=$2 WHERE id=$1");update.Parameters.AddWithValue(id);update.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));update.Parameters.AddWithValue("Jobs queued by C# scheduler");await update.ExecuteNonQueryAsync(token);}

    private async Task EnsureConfigured(CancellationToken token){await Task.CompletedTask;var ai=settings.Current().AiValue;if(!ai.Enabled||string.IsNullOrWhiteSpace(Provider().ApiKey))throw new InvalidOperationException("Configure and enable an AI provider in Settings");}
    private AiProviderRuntimeSettings Provider(string? provider=null){var ai=settings.Current().AiValue;return (provider??ai.ActiveProvider)=="deepseek"?ai.DeepSeek??new():ai.OpenAi??new();}
    private async Task EnsureMessageOwner(string id,string owner,CancellationToken token){await using var command=database.CreateCommand("SELECT EXISTS(SELECT 1 FROM messages m JOIN archives a ON a.id=m.archive_id WHERE m.id=$1 AND a.owner_user_id=$2)");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);if(!Convert.ToBoolean(await command.ExecuteScalarAsync(token)))throw new MailNotFoundException("Message not found");}
    private async Task EnsureFolderOwner(string id,string owner,CancellationToken token){await using var command=database.CreateCommand("SELECT EXISTS(SELECT 1 FROM folders f JOIN archives a ON a.id=f.archive_id WHERE f.id=$1 AND a.owner_user_id=$2)");command.Parameters.AddWithValue(id);command.Parameters.AddWithValue(owner);if(!Convert.ToBoolean(await command.ExecuteScalarAsync(token)))throw new MailNotFoundException("Mailbox not found");}
    private async Task<object?> LatestJob(string messageId,string task,CancellationToken token){await using var command=database.CreateCommand("SELECT * FROM ai_jobs WHERE message_id=$1 AND task=$2 ORDER BY created_at DESC LIMIT 1");command.Parameters.AddWithValue(messageId);command.Parameters.AddWithValue(task);await using var reader=await command.ExecuteReaderAsync(token);return await reader.ReadAsync(token)?Job(reader):null;}
    private async Task<object?> Analysis(string id,CancellationToken token){const string sql="SELECT id,message_id,summary,categories_json,priority,action_required<>0,action_summary,spam_probability,phishing_probability,draft_recommended<>0,confidence,signals_json,model,prompt_version,content_hash,context_hash,thread_message_count,created_at,updated_at FROM ai_message_analysis WHERE message_id=$1";await using var command=database.CreateCommand(sql);command.Parameters.AddWithValue(id);await using var r=await command.ExecuteReaderAsync(token);return await r.ReadAsync(token)?AnalysisObject(r):null;}
    private static object AnalysisObject(NpgsqlDataReader r)=>new{id=r.GetString(0),messageId=r.GetString(1),summary=r.GetString(2),categories=ParseArray(r.GetString(3)),priority=r.GetString(4),actionRequired=r.GetBoolean(5),actionSummary=r.IsDBNull(6)?null:r.GetString(6),spamProbability=r.GetDouble(7),phishingProbability=r.GetDouble(8),draftRecommended=r.GetBoolean(9),confidence=r.GetDouble(10),signals=ParseArray(r.GetString(11)),model=r.GetString(12),promptVersion=r.GetString(13),contentHash=r.GetString(14),contextHash=r.GetString(15),threadMessageCount=r.GetInt64(16),createdAt=r.GetString(17),updatedAt=r.GetString(18)};
    private static object Job(NpgsqlDataReader r)=>new{id=r["id"],messageId=r["message_id"],task=r["task"],scheduleId=r["schedule_id"] is DBNull?null:r["schedule_id"],scheduleRunId=(string?)null,gmailConnectionId=r["gmail_connection_id"] is DBNull?null:r["gmail_connection_id"],resumeId=r["resume_id"] is DBNull?null:r["resume_id"],status=r["status"],provider=r["provider"],model=r["model"],skills=ParseArray((string)r["skills_json"]),prompt=r["prompt"],promptVersion=r["prompt_version"],contentHash=r["content_hash"],attempts=r["attempts"],maxAttempts=r["max_attempts"],error=r["error"] is DBNull?null:r["error"],createdAt=r["created_at"],updatedAt=r["updated_at"],startedAt=r["started_at"] is DBNull?null:r["started_at"],completedAt=r["completed_at"] is DBNull?null:r["completed_at"]};
    private static object Schedule(NpgsqlDataReader r)=>new{id=r.GetString(0),name=r.GetString(1),task=r.GetString(2),folderId=r.GetString(3),folderPath=r.GetString(4),archiveId=r.GetString(5),archiveName=r.GetString(6),messageId=r.IsDBNull(7)?null:r.GetString(7),messageSubject=r.IsDBNull(8)?null:r.GetString(8),gmailConnectionId=r.IsDBNull(9)?null:r.GetString(9),gmailConnectionEmail=r.IsDBNull(10)?null:r.GetString(10),resumeId=r.IsDBNull(11)?null:r.GetString(11),resumeName=r.IsDBNull(12)?null:r.GetString(12),mode=r.GetString(13),intervalMinutes=r.GetInt64(14),enabled=r.GetBoolean(15),lastRunAt=r.IsDBNull(16)?null:r.GetString(16),lastRunSummary=r.IsDBNull(17)?null:r.GetString(17),provider=r.GetString(18),model=r.GetString(19),skills=ParseArray(r.GetString(20)),prompt=r.GetString(21),progress=(object?)null,createdAt=r.GetString(22),updatedAt=r.GetString(23)};
    private static string Id(object value)=>value.GetType().GetProperty("id")?.GetValue(value)?.ToString()??"";
    internal static string[] ParseArray(string value){try{return JsonSerializer.Deserialize<string[]>(value,JsonOptions)??[];}catch{return[];}}
    private static string Required(JsonElement input,string name)=>String(input,name)??throw new ArgumentException($"{name} is required");
    private static string? String(JsonElement input,string name)=>input.ValueKind==JsonValueKind.Object&&input.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString()?.Trim():null;
    private static object? NullableProperty(JsonElement input,string name)=>input.TryGetProperty(name,out var value)?value.ValueKind==JsonValueKind.Null?null:value.GetString():null;
    private static int? Integer(JsonElement input,string name)=>input.TryGetProperty(name,out var value)&&value.TryGetInt32(out var result)?result:null;
    private static bool? Boolean(JsonElement input,string name)=>input.TryGetProperty(name,out var value)&&value.ValueKind is JsonValueKind.True or JsonValueKind.False?value.GetBoolean():null;
    private static string ToCamel(string value){var parts=value.Split('_');return parts[0]+string.Concat(parts.Skip(1).Select(part=>char.ToUpperInvariant(part[0])+part[1..]));}
    private static string? Text(JsonElement value,string name)=>value.TryGetProperty(name,out var result)&&result.ValueKind==JsonValueKind.String?result.GetString():null;
    private static bool Bool(JsonElement value,string name)=>value.TryGetProperty(name,out var result)&&result.ValueKind==JsonValueKind.True;
    private static double Number(JsonElement value,string name)=>value.TryGetProperty(name,out var result)&&result.TryGetDouble(out var number)?Math.Clamp(number,0,1):0;
    private static string JsonArray(JsonElement value,string name)=>value.TryGetProperty(name,out var result)&&result.ValueKind==JsonValueKind.Array?result.GetRawText():"[]";
    private static string NormalizePriority(string? value)=>value is "low" or "high" or "urgent"?value:"normal";
    private static string Hash(string value)=>Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static void AddNullable(NpgsqlCommand command,object? value)=>command.Parameters.AddWithValue(value??DBNull.Value);
}
