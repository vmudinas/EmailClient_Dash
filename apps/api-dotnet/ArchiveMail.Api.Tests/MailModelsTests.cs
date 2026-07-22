using System.Text.Json;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MailModelsTests
{
    [Fact]
    public void SerializesMailTrackingCountUsingTheWebContractName()
    {
        var json = JsonSerializer.Serialize(
            new InboxCategoryCountsDto(1, 2, 3, 4, 5, 6, 7),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"mail_tracking\":7", json, StringComparison.Ordinal);
        Assert.DoesNotContain("mailTracking", json, StringComparison.Ordinal);
    }
}
