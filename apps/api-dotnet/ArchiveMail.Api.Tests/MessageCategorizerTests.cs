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
    [InlineData("alerts@indeed.com", "12 new jobs matching product designer", "", "jobs")]
    [InlineData("jobs-noreply@linkedin.com", "New job alert for senior engineer", "", "jobs")]
    [InlineData("recruiter@company.test", "Interview for the platform role", "", "jobs")]
    public void ClassifiesImportantInboxCategories(string sender, string subject, string body, string expected)
    {
        Assert.Equal(expected, MessageCategorizer.Classify(sender, subject, body, new Dictionary<string, string>()));
    }

    [Fact]
    public void Reply_context_always_stays_with_people_even_when_bulk_headers_and_keywords_match()
    {
        var headers = new Dictionary<string, string>
        {
            ["In-Reply-To"] = "<original@example.test>",
            ["List-Unsubscribe"] = "<mailto:unsubscribe@example.test>",
            ["X-Archive-Mail-Gmail-Label-Ids"] = "CATEGORY_PROMOTIONS"
        };

        Assert.Equal("primary", MessageCategorizer.Classify(
            "person@example.test", "Re: invoice and package update", "Thanks, I will take care of it.", headers));
    }

    [Fact]
    public void Custom_tabs_cannot_move_a_reply_out_of_people()
    {
        var tabs = new[]
        {
            new InboxTabDefinitionDto("primary", "People", "", true, 0, "#176747", [], [], false),
            new InboxTabDefinitionDto("promotions", "Newsletters", "", true, 1, "#6f7457", ["deal"], [], false)
        };

        Assert.Equal("primary", MessageCategorizer.ClassifyWithTabs(
            "person@example.test", "Re: the deal", "Following up", new Dictionary<string, string> { ["References"] = "<one@example.test>" }, tabs));
    }
}
