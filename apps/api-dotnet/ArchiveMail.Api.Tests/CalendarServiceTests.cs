using System.Xml.Linq;
using System.Text.Json;
using ArchiveMail.Api.Calendar;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class CalendarServiceTests
{
    [Fact]
    public void ResolvesAppleCalendarHrefAgainstTheServerOrigin()
    {
        var result = CalendarService.ResolveAppleHref(
            "https://caldav.icloud.com",
            "/123456789/calendars/home/");

        Assert.Equal("https://caldav.icloud.com/123456789/calendars/home", result);
    }

    [Fact]
    public void RecognizesCalDavCalendarCollections()
    {
        var document = XDocument.Parse(
            """
            <d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
              <d:response>
                <d:href>/123/calendars/home/</d:href>
                <d:propstat>
                  <d:prop>
                    <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
                  </d:prop>
                </d:propstat>
              </d:response>
            </d:multistatus>
            """);

        Assert.True(CalendarService.IsAppleCalendarCollection(document.Root));
    }

    [Fact]
    public void EveryAppleAccountLookupAndMutationIsOwnerScoped()
    {
        var ownerScopedSql = new[]
        {
            CalendarService.AccountsSql,
            CalendarService.ReconnectAppleAccountSql,
            CalendarService.DeleteAppleAccountSql,
            CalendarService.AppleRecordsSql,
            CalendarService.AppleRecordSql,
            CalendarService.UpdateAppleCalendarUrlSql,
            CalendarService.MarkAppleErrorSql
        };

        Assert.All(ownerScopedSql, sql =>
            Assert.Contains("owner_user_id=", sql.Replace(" ", ""), StringComparison.Ordinal));
        Assert.Contains("owner_user_id", CalendarService.InsertAppleAccountSql, StringComparison.Ordinal);
    }

    [Fact]
    public void GooglePageTokensAreEncodedAndCannotLoopForever()
    {
        var url = CalendarService.GooglePageUrl(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=2500",
            "next/page + token");
        using var response = JsonDocument.Parse("""{"nextPageToken":"repeat"}""");
        var seen = new HashSet<string>(StringComparer.Ordinal);

        Assert.EndsWith("&pageToken=next%2Fpage%20%2B%20token", url, StringComparison.Ordinal);
        Assert.Equal("repeat", CalendarService.NextGooglePageToken(response.RootElement, seen));
        var error = Assert.Throws<InvalidOperationException>(() =>
            CalendarService.NextGooglePageToken(response.RootElement, seen));
        Assert.Contains("repeated page token", error.Message, StringComparison.OrdinalIgnoreCase);
    }
}
