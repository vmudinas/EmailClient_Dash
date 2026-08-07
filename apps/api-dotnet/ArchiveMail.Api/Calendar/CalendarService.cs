using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Infrastructure;
using Microsoft.AspNetCore.DataProtection;
using Npgsql;

namespace ArchiveMail.Api.Calendar;

public sealed class CalendarService(NpgsqlDataSource database,GmailService gmail,IHttpClientFactory clients,ActiveDatabaseConfiguration active)
{
    private const string GoogleApi="https://www.googleapis.com/calendar/v3";
    internal const string AccountsSql="SELECT id,provider,label,username,server_url,status,last_error,created_at,updated_at FROM calendar_accounts WHERE owner_user_id=$1 ORDER BY created_at DESC";
    internal const string InsertAppleAccountSql="INSERT INTO calendar_accounts(id,owner_user_id,provider,label,username,server_url,secret,status,created_at,updated_at) VALUES($1,$2,'apple',$3,$4,$5,$6,'connected',$7,$7)";
    internal const string ReconnectAppleAccountSql="UPDATE calendar_accounts SET label=$3,username=$4,server_url=$5,secret=$6,status='connected',last_error=NULL,updated_at=$7 WHERE id=$1 AND owner_user_id=$2 AND provider='apple'";
    internal const string DeleteAppleAccountSql="DELETE FROM calendar_accounts WHERE id=$1 AND owner_user_id=$2 AND provider='apple'";
    internal const string AppleRecordsSql="SELECT id,label,username,server_url,secret FROM calendar_accounts WHERE provider='apple' AND owner_user_id=$1";
    internal const string AppleRecordSql="SELECT id,label,username,server_url,secret FROM calendar_accounts WHERE id=$1 AND provider='apple' AND owner_user_id=$2";
    internal const string UpdateAppleCalendarUrlSql="UPDATE calendar_accounts SET server_url=$3,status='connected',last_error=NULL,updated_at=$4 WHERE id=$1 AND owner_user_id=$2 AND provider='apple'";
    internal const string MarkAppleErrorSql="UPDATE calendar_accounts SET status='error',last_error=$3,updated_at=$4 WHERE id=$1 AND owner_user_id=$2 AND provider='apple'";
    private readonly IDataProtector protector=DataProtectionProvider.Create(new DirectoryInfo(Path.Combine(active.DataDirectory,"data-protection-keys")),options=>options.SetApplicationName("ArchiveMail.AppSettings.v1")).CreateProtector("calendar-secrets");
    public async Task<IReadOnlyList<object>> AccountsAsync(string owner,CancellationToken token)
    {
        await using var command=database.CreateCommand(AccountsSql);
        command.Parameters.AddWithValue(owner);
        await using var r=await command.ExecuteReaderAsync(token);
        var list=new List<object>();
        while(await r.ReadAsync(token))list.Add(new{id=r.GetString(0),provider=r.GetString(1),label=r.GetString(2),username=r.GetString(3),serverUrl=r.GetString(4),status=r.GetString(5),lastError=r.IsDBNull(6)?null:r.GetString(6),createdAt=r.GetString(7),updatedAt=r.GetString(8)});
        return list;
    }

    public async Task<object> AddAppleAsync(JsonElement input,string owner,CancellationToken token)
    {
        var server=Required(input,"serverUrl").TrimEnd('/');
        var username=Required(input,"username");
        var password=Required(input,"appSpecificPassword");
        var calendarUrl=await DiscoverAppleCalendarAsync(server,username,password,token);
        var id=Guid.NewGuid().ToString();
        var now=DateTimeOffset.UtcNow.ToString("O");
        await using var command=database.CreateCommand(InsertAppleAccountSql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(Required(input,"label"));
        command.Parameters.AddWithValue(username);
        command.Parameters.AddWithValue(calendarUrl);
        command.Parameters.AddWithValue(protector.Protect(password));
        command.Parameters.AddWithValue(now);
        await command.ExecuteNonQueryAsync(token);
        return(await AccountsAsync(owner,token)).Single(item=>Property(item,"id")==id);
    }

    public async Task<object> ReconnectAppleAsync(string id,JsonElement input,string owner,CancellationToken token)
    {
        // Check ownership before making a network request. A guessed account id must not be usable
        // to trigger provider calls or probe whether another user's account exists.
        if(await AppleRecordAsync(id,owner,token) is null)throw new KeyNotFoundException("Apple Calendar account not found");
        var server=(String(input,"serverUrl")??"https://caldav.icloud.com").TrimEnd('/');
        var username=Required(input,"username");
        var password=Required(input,"appSpecificPassword");
        var calendarUrl=await DiscoverAppleCalendarAsync(server,username,password,token);
        await using var command=database.CreateCommand(ReconnectAppleAccountSql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(Required(input,"label"));
        command.Parameters.AddWithValue(username);
        command.Parameters.AddWithValue(calendarUrl);
        command.Parameters.AddWithValue(protector.Protect(password));
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        if(await command.ExecuteNonQueryAsync(token)!=1)throw new KeyNotFoundException("Apple Calendar account not found");
        return(await AccountsAsync(owner,token)).Single(item=>Property(item,"id")==id);
    }

    public async Task DeleteAccountAsync(string id,string owner,CancellationToken token)
    {
        await using var command=database.CreateCommand(DeleteAppleAccountSql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        await command.ExecuteNonQueryAsync(token);
    }

    public async Task<IReadOnlyList<object>> SourcesAsync(string owner,CancellationToken token)
    {
        var list=new List<object>();
        foreach(var connection in await gmail.ListAsync(owner,token))
        {
            if(!connection.CanManageCalendar)continue;
            try
            {
                var baseUrl=$"{GoogleApi}/users/me/calendarList?minAccessRole=reader";
                string? pageToken=null;
                var seenPageTokens=new HashSet<string>(StringComparer.Ordinal);
                do
                {
                    var json=await gmail.GoogleRequestAsync(connection.Id,owner,GooglePageUrl(baseUrl,pageToken),HttpMethod.Get,null,token);
                    if(json.TryGetProperty("items",out var items)&&items.ValueKind==JsonValueKind.Array)
                        foreach(var item in items.EnumerateArray())
                        {
                            var external=item.GetProperty("id").GetString()!;
                            list.Add(new{id=$"google:{connection.Id}:{Base64(external)}",provider="google",accountId=connection.Id,accountLabel=connection.Email,externalId=external,name=Text(item,"summary")??external,color=Text(item,"backgroundColor")??"#4285f4",readOnly=Text(item,"accessRole")=="reader",primary=item.TryGetProperty("primary",out var primary)&&primary.GetBoolean(),selectedByDefault=!item.TryGetProperty("selected",out var selected)||selected.GetBoolean()});
                        }
                    pageToken=NextGooglePageToken(json,seenPageTokens);
                }while(pageToken is not null);
            }
            catch(InvalidOperationException){}
        }
        foreach(var account in await AppleRecordsAsync(owner,token))
            list.Add(new{id=$"apple:{account.Id}",provider="apple",accountId=account.Id,accountLabel=account.Label,externalId=account.Server,name=account.Label,color="#ff3b30",readOnly=false,primary=true,selectedByDefault=true});
        return list;
    }
    public Task<IReadOnlyList<object>> GoogleEvents(string connection,string min,string max,string owner,CancellationToken token)=>GoogleCalendarEvents(connection,"primary",min,max,owner,token);
    public async Task<IReadOnlyList<object>> SourceEvents(string source,string min,string max,string owner,CancellationToken token){var parsed=await ResolveSource(source,owner,token);return parsed.Provider=="google"?await GoogleCalendarEvents(parsed.AccountId,parsed.External,min,max,owner,token):await AppleEvents(parsed.AccountId,min,max,owner,token);}
    public Task<object> CreateGoogle(string connection,JsonElement input,string owner,CancellationToken token)=>GoogleWrite(connection,"primary",null,input,owner,HttpMethod.Post,token);
    public async Task<object> CreateFromMessage(string messageId,string connection,JsonElement input,string owner,CancellationToken token)
    {
        await using(var owns=database.CreateCommand("SELECT EXISTS(SELECT 1 FROM messages m JOIN archives a ON a.id=m.archive_id WHERE m.id=$1 AND a.owner_user_id=$2)"))
        {
            owns.Parameters.AddWithValue(messageId);owns.Parameters.AddWithValue(owner);
            if(!Convert.ToBoolean(await owns.ExecuteScalarAsync(token)))throw new KeyNotFoundException("Message not found");
        }
        var result=await CreateGoogle(connection,input,owner,token);
        var value=JsonSerializer.SerializeToElement(result);
        var id=Required(value,"id");var title=Required(value,"title");var start=Required(value,"startAt");
        await using var link=database.CreateCommand("INSERT INTO message_calendar_events(message_id,connection_id,event_id,title,start_at,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(connection_id,event_id) DO UPDATE SET message_id=EXCLUDED.message_id,title=EXCLUDED.title,start_at=EXCLUDED.start_at");
        link.Parameters.AddWithValue(messageId);link.Parameters.AddWithValue(connection);link.Parameters.AddWithValue(id);link.Parameters.AddWithValue(title);link.Parameters.AddWithValue(start);link.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await link.ExecuteNonQueryAsync(token);return result;
    }
    public Task<object> UpdateGoogle(string connection,string eventId,JsonElement input,string owner,CancellationToken token)=>GoogleWrite(connection,"primary",eventId,input,owner,HttpMethod.Put,token);
    public async Task DeleteGoogle(string connection,string eventId,string owner,CancellationToken token)=>_ = await gmail.GoogleRequestAsync(connection,owner,$"{GoogleApi}/calendars/primary/events/{Uri.EscapeDataString(eventId)}",HttpMethod.Delete,null,token);
    public async Task<object> CreateSource(string source,JsonElement input,string owner,CancellationToken token){var parsed=await ResolveSource(source,owner,token);return parsed.Provider=="google"?await GoogleWrite(parsed.AccountId,parsed.External,null,input,owner,HttpMethod.Post,token):await AppleWrite(parsed.AccountId,null,input,owner,token);}
    public async Task<object> UpdateSource(string source,string eventId,JsonElement input,string owner,CancellationToken token){var parsed=await ResolveSource(source,owner,token);return parsed.Provider=="google"?await GoogleWrite(parsed.AccountId,parsed.External,eventId,input,owner,HttpMethod.Put,token):await AppleWrite(parsed.AccountId,eventId,input,owner,token);}
    public async Task DeleteSource(string source,string eventId,string owner,CancellationToken token)
    {
        var parsed=await ResolveSource(source,owner,token);
        if(parsed.Provider=="google")
        {
            await DeleteGoogleCalendar(parsed.AccountId,parsed.External,eventId,owner,token);
            return;
        }
        var account=await AppleRecordAsync(parsed.AccountId,owner,token)
            ??throw new KeyNotFoundException("Calendar source not found");
        await AppleRequest($"{account.Server.TrimEnd('/')}/{Uri.EscapeDataString(eventId)}.ics",account.Username,ApplePassword(account),HttpMethod.Delete,null,null,token);
    }

    private async Task<IReadOnlyList<object>> GoogleCalendarEvents(string connection,string calendar,string min,string max,string owner,CancellationToken token)
    {
        var baseUrl=$"{GoogleApi}/calendars/{Uri.EscapeDataString(calendar)}/events?singleEvents=true&orderBy=startTime&timeMin={Uri.EscapeDataString(min)}&timeMax={Uri.EscapeDataString(max)}&maxResults=2500";
        var list=new List<object>();
        string? pageToken=null;
        var seenPageTokens=new HashSet<string>(StringComparer.Ordinal);
        do
        {
            var json=await gmail.GoogleRequestAsync(connection,owner,GooglePageUrl(baseUrl,pageToken),HttpMethod.Get,null,token);
            if(json.TryGetProperty("items",out var items)&&items.ValueKind==JsonValueKind.Array)
                foreach(var item in items.EnumerateArray())list.Add(MapGoogle(item,connection));
            pageToken=NextGooglePageToken(json,seenPageTokens);
        }while(pageToken is not null);
        return list;
    }
    private async Task<object> GoogleWrite(string connection,string calendar,string? eventId,JsonElement input,string owner,HttpMethod method,CancellationToken token){var payload=JsonSerializer.SerializeToElement(new{summary=Required(input,"title"),description=String(input,"description")??"",location=String(input,"location")??"",start=GoogleTime(input,"startAt",Boolean(input,"allDay")),end=GoogleTime(input,"endAt",Boolean(input,"allDay"))});var url=$"{GoogleApi}/calendars/{Uri.EscapeDataString(calendar)}/events"+(eventId is null?"":$"/{Uri.EscapeDataString(eventId)}");return MapGoogle(await gmail.GoogleRequestAsync(connection,owner,url,method,payload,token),connection);}
    private async Task DeleteGoogleCalendar(string connection,string calendar,string eventId,string owner,CancellationToken token)=>_ = await gmail.GoogleRequestAsync(connection,owner,$"{GoogleApi}/calendars/{Uri.EscapeDataString(calendar)}/events/{Uri.EscapeDataString(eventId)}",HttpMethod.Delete,null,token);
    private static object MapGoogle(JsonElement item,string connection){var start=item.GetProperty("start");var end=item.GetProperty("end");var allDay=start.TryGetProperty("date",out _);return new{id=Text(item,"id")??"",connectionId=connection,provider="google",title=Text(item,"summary")??"(Untitled)",description=Text(item,"description")??"",location=Text(item,"location")??"",startAt=Text(start,allDay?"date":"dateTime")??"",endAt=Text(end,allDay?"date":"dateTime")??"",allDay,htmlLink=Text(item,"htmlLink"),meetingLink=Text(item,"hangoutLink"),organizer=item.TryGetProperty("organizer",out var organizer)?new{email=Text(organizer,"email")??"",displayName=Text(organizer,"displayName")} : null,attendees=item.TryGetProperty("attendees",out var attendees)?attendees.EnumerateArray().Select(value=>new{email=Text(value,"email")??"",displayName=Text(value,"displayName"),responseStatus=Text(value,"responseStatus")??"needsAction",organizer=value.TryGetProperty("organizer",out var o)&&o.GetBoolean(),self=value.TryGetProperty("self",out var s)&&s.GetBoolean()}).ToArray():System.Array.Empty<object>()};}
    private async Task<IReadOnlyList<object>> AppleEvents(string accountId,string min,string max,string owner,CancellationToken token)
    {
        var account=await AppleRecordAsync(accountId,owner,token)
            ??throw new KeyNotFoundException("Calendar source not found");
        string password;
        try{password=ApplePassword(account);}
        catch(InvalidOperationException error){await MarkAppleErrorAsync(account.Id,owner,error.Message,token);throw;}
        var start=DateTimeOffset.Parse(min).UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'");
        var end=DateTimeOffset.Parse(max).UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'");
        var report=$"<c:calendar-query xmlns:d=\"DAV:\" xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name=\"VCALENDAR\"><c:comp-filter name=\"VEVENT\"><c:time-range start=\"{start}\" end=\"{end}\"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";
        string text;
        try{text=await AppleRequest(account.Server,account.Username,password,new HttpMethod("REPORT"),report,"1",token);}
        catch(AppleCalendarProviderException error) when(error.StatusCode==HttpStatusCode.Conflict)
        {
            var calendarUrl=await DiscoverAppleCalendarAsync(account.Server,account.Username,password,token);
            if(NormalizeUrl(calendarUrl)==NormalizeUrl(account.Server))throw;
            await UpdateAppleCalendarUrlAsync(account.Id,owner,calendarUrl,token);
            text=await AppleRequest(calendarUrl,account.Username,password,new HttpMethod("REPORT"),report,"1",token);
        }
        var doc=XDocument.Parse(text);
        XNamespace cal="urn:ietf:params:xml:ns:caldav";
        var list=new List<object>();
        foreach(var data in doc.Descendants(cal+"calendar-data"))
        {
            var parsed=ParseIcs(data.Value,accountId);
            if(parsed is not null)list.Add(parsed);
        }
        return list;
    }

    private async Task<object> AppleWrite(string accountId,string? eventId,JsonElement input,string owner,CancellationToken token)
    {
        var account=await AppleRecordAsync(accountId,owner,token)
            ??throw new KeyNotFoundException("Calendar source not found");
        var id=eventId??Guid.NewGuid().ToString();
        var allDay=Boolean(input,"allDay");
        var start=IcsTime(Required(input,"startAt"),allDay);
        var end=IcsTime(Required(input,"endAt"),allDay);
        var ics=$"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Archive Mail//EN\r\nBEGIN:VEVENT\r\nUID:{EscapeIcs(id)}\r\nDTSTAMP:{DateTime.UtcNow:yyyyMMdd'T'HHmmss'Z'}\r\nDTSTART{(allDay?";VALUE=DATE":"")}:{start}\r\nDTEND{(allDay?";VALUE=DATE":"")}:{end}\r\nSUMMARY:{EscapeIcs(Required(input,"title"))}\r\nDESCRIPTION:{EscapeIcs(String(input,"description")??"")}\r\nLOCATION:{EscapeIcs(String(input,"location")??"")}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        await AppleRequest($"{account.Server.TrimEnd('/')}/{Uri.EscapeDataString(id)}.ics",account.Username,ApplePassword(account),HttpMethod.Put,ics,null,token,"text/calendar; charset=utf-8");
        return ParseIcs(ics,accountId)!;
    }

    private async Task<(string Provider,string AccountId,string External)> ResolveSource(string source,string owner,CancellationToken token)
    {
        if(source.StartsWith("apple:",StringComparison.Ordinal))
        {
            var id=source[6..];
            if(await AppleRecordAsync(id,owner,token) is null)throw new KeyNotFoundException("Calendar source not found");
            return("apple",id,id);
        }
        if(source.StartsWith("google:",StringComparison.Ordinal))
        {
            var parts=source.Split(':',3);
            if(parts.Length!=3||(await gmail.ListAsync(owner,token)).All(value=>value.Id!=parts[1]))throw new KeyNotFoundException("Calendar source not found");
            return("google",parts[1],Unbase64(parts[2]));
        }
        throw new KeyNotFoundException("Calendar source not found");
    }

    private async Task<IReadOnlyList<AppleRecord>> AppleRecordsAsync(string owner,CancellationToken token)
    {
        await using var command=database.CreateCommand(AppleRecordsSql);
        command.Parameters.AddWithValue(owner);
        await using var r=await command.ExecuteReaderAsync(token);
        var list=new List<AppleRecord>();
        while(await r.ReadAsync(token))list.Add(new(r.GetString(0),r.GetString(1),r.GetString(2),r.GetString(3),r.GetString(4)));
        return list;
    }

    private async Task<AppleRecord?> AppleRecordAsync(string id,string owner,CancellationToken token)
    {
        await using var command=database.CreateCommand(AppleRecordSql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(owner);
        await using var r=await command.ExecuteReaderAsync(token);
        return await r.ReadAsync(token)?new(r.GetString(0),r.GetString(1),r.GetString(2),r.GetString(3),r.GetString(4)):null;
    }
    private async Task<string> AppleRequest(string url,string username,string password,HttpMethod method,string? body,string? depth,CancellationToken token,string contentType="application/xml; charset=utf-8"){using var request=new HttpRequestMessage(method,url);request.Headers.Authorization=new AuthenticationHeaderValue("Basic",Convert.ToBase64String(Encoding.UTF8.GetBytes($"{username}:{password}")));if(depth is not null)request.Headers.TryAddWithoutValidation("Depth",depth);if(body is not null)request.Content=new StringContent(body,Encoding.UTF8,contentType.Split(';')[0]);using var response=await clients.CreateClient("external").SendAsync(request,token);var text=await response.Content.ReadAsStringAsync(token);if(!response.IsSuccessStatusCode)throw new AppleCalendarProviderException(response.StatusCode,$"Apple Calendar returned {(int)response.StatusCode}: {text[..Math.Min(300,text.Length)]}");return text;}
    private async Task<string> DiscoverAppleCalendarAsync(string server,string username,string password,CancellationToken token)
    {
        const string discoveryRequest="""<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/></d:prop></d:propfind>""";
        var rootUrl=server.TrimEnd('/');
        var rootDocument=XDocument.Parse(await AppleRequest(rootUrl,username,password,new HttpMethod("PROPFIND"),discoveryRequest,"0",token));
        if(IsAppleCalendarCollection(rootDocument.Root))return rootUrl;
        XNamespace dav="DAV:";XNamespace cal="urn:ietf:params:xml:ns:caldav";
        var homeHref=rootDocument.Descendants(cal+"calendar-home-set").Descendants(dav+"href").Select(value=>value.Value).FirstOrDefault();
        if(string.IsNullOrWhiteSpace(homeHref))
        {
            var principalHref=rootDocument.Descendants(dav+"current-user-principal").Descendants(dav+"href").Select(value=>value.Value).FirstOrDefault();
            if(string.IsNullOrWhiteSpace(principalHref))throw new InvalidOperationException("Apple Calendar did not return a CalDAV principal. Check the server URL and reconnect the account.");
            var principalUrl=ResolveAppleHref(rootUrl,principalHref);
            var principalDocument=XDocument.Parse(await AppleRequest(principalUrl,username,password,new HttpMethod("PROPFIND"),discoveryRequest,"0",token));
            homeHref=principalDocument.Descendants(cal+"calendar-home-set").Descendants(dav+"href").Select(value=>value.Value).FirstOrDefault();
        }
        if(string.IsNullOrWhiteSpace(homeHref))throw new InvalidOperationException("Apple Calendar did not return a calendar home. Reconnect the account with a valid app-specific password.");
        var homeUrl=ResolveAppleHref(rootUrl,homeHref);
        var calendars=XDocument.Parse(await AppleRequest(homeUrl,username,password,new HttpMethod("PROPFIND"),discoveryRequest,"1",token));
        var responses=calendars.Descendants(dav+"response")
            .Where(response=>IsAppleCalendarCollection(response))
            .ToArray();
        var selected=responses.FirstOrDefault(response=>response.Descendants(cal+"comp").Any(component=>string.Equals((string?)component.Attribute("name"),"VEVENT",StringComparison.OrdinalIgnoreCase)))
            ??responses.FirstOrDefault();
        var calendarHref=selected?.Elements(dav+"href").Select(value=>value.Value).FirstOrDefault();
        if(string.IsNullOrWhiteSpace(calendarHref))throw new InvalidOperationException("Apple Calendar did not expose an event calendar for this account.");
        return ResolveAppleHref(homeUrl,calendarHref);
    }
    private async Task UpdateAppleCalendarUrlAsync(string accountId,string owner,string calendarUrl,CancellationToken token)
    {
        await using var command=database.CreateCommand(UpdateAppleCalendarUrlSql);
        command.Parameters.AddWithValue(accountId);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(calendarUrl);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        if(await command.ExecuteNonQueryAsync(token)!=1)throw new KeyNotFoundException("Calendar source not found");
    }

    private async Task MarkAppleErrorAsync(string accountId,string owner,string error,CancellationToken token)
    {
        await using var command=database.CreateCommand(MarkAppleErrorSql);
        command.Parameters.AddWithValue(accountId);
        command.Parameters.AddWithValue(owner);
        command.Parameters.AddWithValue(error);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(token);
    }
    internal static bool IsAppleCalendarCollection(XContainer? value){if(value is null)return false;XNamespace cal="urn:ietf:params:xml:ns:caldav";return value.Descendants(cal+"calendar").Any();}
    internal static string ResolveAppleHref(string baseUrl,string href)=>new Uri(new Uri($"{baseUrl.TrimEnd('/')}/"),href).AbsoluteUri.TrimEnd('/');
    internal static string GooglePageUrl(string baseUrl,string? pageToken)
    {
        if(string.IsNullOrWhiteSpace(pageToken))return baseUrl;
        var separator=baseUrl.Contains('?',StringComparison.Ordinal)?'&':'?';
        return $"{baseUrl}{separator}pageToken={Uri.EscapeDataString(pageToken)}";
    }
    internal static string? NextGooglePageToken(JsonElement response,ISet<string> seen)
    {
        var next=Text(response,"nextPageToken");
        if(string.IsNullOrWhiteSpace(next))return null;
        if(!seen.Add(next))throw new InvalidOperationException("Google Calendar returned a repeated page token");
        return next;
    }
    private static string NormalizeUrl(string value)=>value.TrimEnd('/').ToLowerInvariant();
    private string ApplePassword(AppleRecord account){try{return protector.Unprotect(account.Secret);}catch(System.Security.Cryptography.CryptographicException error){throw new InvalidOperationException($"Apple Calendar account {account.Label} must be disconnected and authorized again because its saved credential cannot be decrypted",error);}}
    private static object? ParseIcs(string text,string account){var lines=text.Replace("\r\n ","").Split(new[]{"\r\n","\n"},StringSplitOptions.None);string? Value(string key)=>lines.FirstOrDefault(line=>line.StartsWith(key,StringComparison.OrdinalIgnoreCase))?.Split(':',2).ElementAtOrDefault(1);var id=Value("UID");var startLine=lines.FirstOrDefault(line=>line.StartsWith("DTSTART",StringComparison.OrdinalIgnoreCase));var endLine=lines.FirstOrDefault(line=>line.StartsWith("DTEND",StringComparison.OrdinalIgnoreCase));if(id is null||startLine is null||endLine is null)return null;var allDay=startLine.Contains("VALUE=DATE");var start=ParseIcsTime(startLine.Split(':',2)[1],allDay);var end=ParseIcsTime(endLine.Split(':',2)[1],allDay);return new{id,connectionId=account,sourceId=$"apple:{account}",provider="apple",title=UnescapeIcs(Value("SUMMARY")??"(Untitled)"),description=UnescapeIcs(Value("DESCRIPTION")??""),location=UnescapeIcs(Value("LOCATION")??""),startAt=start,endAt=end,allDay,htmlLink=(string?)null,meetingLink=(string?)null,organizer=(object?)null,attendees=System.Array.Empty<object>()};}
    private static object GoogleTime(JsonElement input,string name,bool allDay)=>allDay?new{date=DateTimeOffset.Parse(Required(input,name)).ToString("yyyy-MM-dd")}:(object)new{dateTime=DateTimeOffset.Parse(Required(input,name)).ToString("O")};
    private static string IcsTime(string value,bool allDay)=>allDay?DateTimeOffset.Parse(value).ToString("yyyyMMdd"):DateTimeOffset.Parse(value).UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'");
    private static string ParseIcsTime(string value,bool allDay)=>allDay?DateTime.ParseExact(value,"yyyyMMdd",null).ToString("yyyy-MM-dd"):DateTime.SpecifyKind(DateTime.ParseExact(value.TrimEnd('Z'),"yyyyMMdd'T'HHmmss",null),DateTimeKind.Utc).ToString("O");
    private static string EscapeIcs(string value)=>value.Replace("\\","\\\\").Replace("\r","").Replace("\n","\\n").Replace(",","\\,").Replace(";","\\;");private static string UnescapeIcs(string value)=>value.Replace("\\n","\n").Replace("\\,",",").Replace("\\;",";").Replace("\\\\","\\");
    private static string Base64(string value)=>Convert.ToBase64String(Encoding.UTF8.GetBytes(value)).TrimEnd('=').Replace('+','-').Replace('/','_');private static string Unbase64(string value){var normalized=value.Replace('-','+').Replace('_','/');normalized+=new string('=',(4-normalized.Length%4)%4);return Encoding.UTF8.GetString(Convert.FromBase64String(normalized));}
    private static string? Property(object value,string name)=>value.GetType().GetProperty(name)?.GetValue(value)?.ToString();private static string? Text(JsonElement input,string name)=>input.ValueKind==JsonValueKind.Object&&input.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.String?value.GetString():null;private static string? String(JsonElement input,string name)=>Text(input,name)?.Trim();private static string Required(JsonElement input,string name)=>String(input,name)??throw new ArgumentException($"{name} is required");private static bool Boolean(JsonElement input,string name)=>input.TryGetProperty(name,out var value)&&value.ValueKind==JsonValueKind.True;
    private sealed record AppleRecord(string Id,string Label,string Username,string Server,string Secret);
    private sealed class AppleCalendarProviderException(HttpStatusCode statusCode,string message):InvalidOperationException(message){public HttpStatusCode StatusCode{get;}=statusCode;}
}
