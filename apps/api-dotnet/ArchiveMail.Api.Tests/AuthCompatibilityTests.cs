using ArchiveMail.Api.Security;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class AuthCompatibilityTests
{
    [Fact]
    public void VerifiesNodeScryptPinHash()
    {
        const string nodeHash = "x_UUoKXCO8o3eKOPrXTSe9AgRaTXwyQdU5mfb-fkj0brJaIzN2HCqLiA1mu7xL7F1iVegTn9Fi3YN9QRBXmf2w";

        Assert.True(AuthService.VerifySecret("2332", nodeHash, "test-salt"));
        Assert.False(AuthService.VerifySecret("2333", nodeHash, "test-salt"));
    }
}
