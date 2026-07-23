using System.Xml.Linq;
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
}
