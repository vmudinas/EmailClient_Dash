using ArchiveMail.Api.Endpoints;
using ArchiveMail.Api.Gmail;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MailEndpointMutationContractTests
{
    [Fact]
    public void StatePatchMapsReadAndStarChangesToTheProviderContract()
    {
        Assert.Equal(
            [GmailMailboxAction.Read, GmailMailboxAction.Unstar],
            MailEndpoints.GmailStateActions(new MessageStatePatch(true, false, null, null)));
        Assert.Equal(
            [GmailMailboxAction.Unread, GmailMailboxAction.Star],
            MailEndpoints.GmailStateActions(new MessageStatePatch(false, true, null, null)));
        Assert.Empty(MailEndpoints.GmailStateActions(new MessageStatePatch(null, null, ["local"], "local note")));
    }

    [Theory]
    [InlineData("archived", "Archive")]
    [InlineData("trash", "Trash")]
    [InlineData("spam", "Spam")]
    public void BulkDestinationsMapToTheirProviderContract(string destination, string expectedActionName)
    {
        var expected = Enum.Parse<GmailMailboxAction>(expectedActionName);
        Assert.Equal(expected, MailEndpoints.GmailBulkMoveAction(destination));
    }

    [Fact]
    public void UnknownBulkDestinationHasNoProviderMutation()
    {
        Assert.Null(MailEndpoints.GmailBulkMoveAction("custom-folder"));
    }

    [Fact]
    public void PartialProviderFailureNeverClaimsThatMessageAsLocallyEligible()
    {
        var result = new GmailMailboxMutationResult(
            ["gmail-ok"], ["gmail-failed"], ["Reconnect the account"]);

        Assert.Equal(
            ["gmail-ok", "local-only", "unknown-owner-checked-by-repository"],
            result.EligibleLocalMessageIds(
                ["gmail-ok", "gmail-failed", "local-only", "unknown-owner-checked-by-repository"]));
    }
}
