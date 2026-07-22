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

    [Fact]
    public void CapsPairedLoginToViewerRoleAndSharingExpiry()
    {
        var now = new DateTimeOffset(2026, 7, 22, 12, 0, 0, TimeSpan.Zero);
        var sharingExpiry = now.AddHours(8);

        var limits = AuthService.ResolveSessionLimits("admin", "viewer", sharingExpiry, now);

        Assert.Equal("viewer", limits.Role);
        Assert.Equal(sharingExpiry, limits.ExpiresAt);
    }

    [Fact]
    public void RejectsAnExpiredPairedLogin()
    {
        var now = DateTimeOffset.UtcNow;
        Assert.Throws<AuthException>(() => AuthService.ResolveSessionLimits("user", "viewer", now, now));
    }
}
