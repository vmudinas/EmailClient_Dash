using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class SendingIdentityTests
{
    [Theory]
    [InlineData("ai@vitas.work")]
    [InlineData("code@vitas.work")]
    [InlineData("me@vitas.work")]
    [InlineData("gliukaz@gmail.com")]
    public void AllowsEveryConfiguredAddress(string address)
    {
        Assert.True(SendingIdentity.IsAllowed(address));
    }

    [Theory]
    [InlineData("AI@Vitas.Work")]
    [InlineData("  code@vitas.work  ")]
    [InlineData("GLIUKAZ@GMAIL.COM")]
    public void AcceptsDifferentSpellingsOfTheSameAddress(string address)
    {
        // Gmail, stored drafts and hand-typed settings disagree about case and padding; refusing a
        // send over that would be a false alarm rather than the protection this is here for.
        Assert.True(SendingIdentity.IsAllowed(address));
    }

    [Theory]
    [InlineData("someone@example.com")]
    [InlineData("ai@vitas.work.attacker.com")]
    [InlineData("ai@gmail.com")]
    [InlineData("")]
    [InlineData(null)]
    public void RejectsAnythingElse(string? address)
    {
        Assert.False(SendingIdentity.IsAllowed(address));
    }

    [Fact]
    public void DefaultsToTheAutomatedAddress()
    {
        Assert.Equal("ai@vitas.work", SendingIdentity.DefaultFor(developmentRelated: false));
    }

    [Fact]
    public void DefaultsRecruiterAndDevelopmentMailToTheDevelopmentAddress()
    {
        Assert.Equal("code@vitas.work", SendingIdentity.DefaultFor(developmentRelated: true));
    }

    [Fact]
    public void ResolveFallsBackToTheDefaultWhenNothingWasChosen()
    {
        Assert.Equal("ai@vitas.work", SendingIdentity.Resolve(null, developmentRelated: false));
        Assert.Equal("ai@vitas.work", SendingIdentity.Resolve("", developmentRelated: false));
        Assert.Equal("ai@vitas.work", SendingIdentity.Resolve("   ", developmentRelated: false));
    }

    [Fact]
    public void ResolveFallsBackToTheDevelopmentAddressForRecruiterMail()
    {
        Assert.Equal("code@vitas.work", SendingIdentity.Resolve(null, developmentRelated: true));
    }

    [Fact]
    public void ResolveKeepsAnExplicitChoiceOverTheDefault()
    {
        // Choosing a permitted address has to win, including choosing the automated address for a
        // recruiter thread; the default is a starting point, not an override.
        Assert.Equal("me@vitas.work", SendingIdentity.Resolve("me@vitas.work", developmentRelated: true));
        Assert.Equal("ai@vitas.work", SendingIdentity.Resolve("ai@vitas.work", developmentRelated: true));
        Assert.Equal("gliukaz@gmail.com", SendingIdentity.Resolve("gliukaz@gmail.com", developmentRelated: false));
    }

    [Fact]
    public void ResolveNormalizesWhatItReturns()
    {
        Assert.Equal("code@vitas.work", SendingIdentity.Resolve("  CODE@Vitas.Work ", developmentRelated: false));
    }

    [Fact]
    public void ResolveRefusesAnAddressOutsideTheList()
    {
        // The whole point of the allowlist: an unexpected address fails loudly at the mistake
        // rather than being silently rewritten to something that looks fine.
        var error = Assert.Throws<ArgumentException>(
            () => SendingIdentity.Resolve("someone@example.com", developmentRelated: false));
        Assert.Contains("someone@example.com", error.Message);
        Assert.Contains("ai@vitas.work", error.Message);
    }

    [Fact]
    public void TheConnectedAccountAddressIsNotImplicitlyAllowed()
    {
        // The previous behaviour fell back to the Gmail account's own address, which is exactly
        // what this change exists to stop.
        Assert.False(SendingIdentity.IsAllowed("vitas@gmail.com"));
        Assert.Throws<ArgumentException>(
            () => SendingIdentity.Resolve("vitas@gmail.com", developmentRelated: false));
    }
}
