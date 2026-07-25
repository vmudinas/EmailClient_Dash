using ArchiveMail.Api.Security;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ApiRouteAuthorizationTests
{
    [Theory]
    [InlineData("GET", "/api/ai/review-queue", "ai")]
    [InlineData("GET", "/api/calendar/sources", "calendar")]
    [InlineData("POST", "/api/admin/import", "import")]
    [InlineData("GET", "/api/properties/overview", "properties")]
    [InlineData("PATCH", "/api/admin/smart-mail-rules/rule-1", "settings")]
    [InlineData("POST", "/api/drafts/draft-1/send", "compose")]
    public void MapsProtectedRoutesToTheirScreen(string method, string path, string screen)
    {
        var session = Session("user", []);
        Assert.Equal(screen, ApiRouteAuthorization.ScreenForPath(path));
        Assert.Equal(ApiRouteAuthorization.ScreenDenied,
            ApiRouteAuthorization.DenialReason(session, method, new PathString(path)));
    }

    [Theory]
    [InlineData("GET", "/api/property-platform/overview")]
    [InlineData("GET", "/api/properties/property-1/photo")]
    [InlineData("POST", "/api/property-service-requests/request-1/comments")]
    [InlineData("POST", "/api/property-payments/payment-1/checkout")]
    [InlineData("GET", "/api/auth/session")]
    [InlineData("POST", "/api/auth/logout")]
    [InlineData("PATCH", "/api/auth/pin")]
    public void AllowsRenterPortalRoutes(string method, string path)
    {
        Assert.Null(ApiRouteAuthorization.DenialReason(Session("renter", ["properties"]), method, new PathString(path)));
    }

    [Theory]
    [InlineData("GET", "/api/gmail/connections")]
    [InlineData("GET", "/api/calendar/sources")]
    [InlineData("GET", "/api/messages")]
    [InlineData("POST", "/api/properties")]
    public void RejectsRenterRoutesOutsideThePortalAllowlist(string method, string path)
    {
        Assert.Equal(ApiRouteAuthorization.RenterDenied,
            ApiRouteAuthorization.DenialReason(Session("renter", ["properties"]), method, new PathString(path)));
    }

    [Theory]
    [InlineData("GET", "/api/lithuanian/words")]
    [InlineData("POST", "/api/lithuanian/words")]
    [InlineData("POST", "/api/lithuanian/words/word-1/recordings")]
    [InlineData("GET", "/api/lithuanian/recordings/take-1/content")]
    [InlineData("DELETE", "/api/lithuanian/recordings/take-1")]
    [InlineData("POST", "/api/diagnostics/client")]
    [InlineData("GET", "/api/auth/session")]
    [InlineData("POST", "/api/auth/logout")]
    [InlineData("PATCH", "/api/auth/pin")]
    public void AllowsLucasTheLithuanianTrainer(string method, string path)
    {
        Assert.Null(ApiRouteAuthorization.DenialReason(Session("lucas", []), method, new PathString(path)));
    }

    [Theory]
    [InlineData("GET", "/api/messages")]
    [InlineData("GET", "/api/properties/overview")]
    [InlineData("GET", "/api/calendar/sources")]
    [InlineData("GET", "/api/admin/users")]
    [InlineData("POST", "/api/admin/import")]
    public void RejectsEverythingOutsideTheTrainerForLucas(string method, string path)
    {
        Assert.Equal(ApiRouteAuthorization.LucasDenied,
            ApiRouteAuthorization.DenialReason(Session("lucas", []), method, new PathString(path)));
    }

    [Fact]
    public void KeepsTheTrainerOutOfTheRenterAllowlist()
    {
        Assert.Equal(ApiRouteAuthorization.RenterDenied, ApiRouteAuthorization.DenialReason(
            Session("renter", ["properties"]), "GET", new PathString("/api/lithuanian/words")));
    }

    [Fact]
    public void LeavesBaselineMailOpenForStandardUsers()
    {
        Assert.Null(ApiRouteAuthorization.DenialReason(Session("user", []), "GET", new PathString("/api/messages")));
    }

    [Fact]
    public void AdminRoleIsNotScreenFiltered()
    {
        Assert.Null(ApiRouteAuthorization.DenialReason(Session("admin", []), "GET", new PathString("/api/ai/review-queue")));
    }

    private static SessionRecord Session(string userRole, string[]? screens) => new(
        "session-1",
        new UserDto("user-1", "person", "Person", userRole, true, false, screens, null,
            DateTimeOffset.UtcNow.ToString("O"), DateTimeOffset.UtcNow.ToString("O")),
        userRole,
        "127.0.0.1",
        DateTimeOffset.UtcNow.AddHours(1).ToString("O"));
}
