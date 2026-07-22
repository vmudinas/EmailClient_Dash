using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MessageCategorizerTests
{
    [Theory]
    [InlineData("ship-confirm@amazon.com", "Your order is arriving tomorrow", "", "mail_tracking")]
    [InlineData("updates@fedex.com", "Your package is out for delivery", "", "mail_tracking")]
    [InlineData("billing@utility.test", "Your utility bill is due", "", "bills")]
    [InlineData("notify@linkedin.com", "Someone mentioned you", "", "social")]
    [InlineData("doctor@clinic.test", "Your appointment", "", "medical")]
    public void ClassifiesImportantInboxCategories(string sender, string subject, string body, string expected)
    {
        Assert.Equal(expected, MessageCategorizer.Classify(sender, subject, body, new Dictionary<string, string>()));
    }
}
