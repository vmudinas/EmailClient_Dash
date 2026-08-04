using ArchiveMail.Api.Endpoints;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Npgsql;
using Xunit;

namespace ArchiveMail.Api.Tests;

/// <summary>
/// Both halves of the same failure: combining a large archive keeps the database saturated for as
/// long as it runs, and everything else in the process has to survive that. It did not - the API
/// vanished mid-merge (502, then "Failed to fetch" in the browser) and the reads that did get
/// through returned bare 500s.
/// </summary>
public sealed class ApiAvailabilityUnderLoadTests
{
    [Fact]
    public void AFaultedBackgroundWorkerDoesNotStopTheApi()
    {
        // The host's default is StopHost: one worker throwing out of ExecuteAsync stopped the whole
        // application, so a transient database failure in, say, the deduplication backfill took the
        // API down with it while the merge that caused it carried on fine.
        var services = new ServiceCollection();
        services.AddResilientBackgroundWorkers();

        var options = services.BuildServiceProvider().GetRequiredService<IOptions<HostOptions>>().Value;

        Assert.Equal(BackgroundServiceExceptionBehavior.Ignore, options.BackgroundServiceExceptionBehavior);
    }

    [Fact]
    public void ADatabaseTooBusyToAnswerIsRetryableRatherThanABareFailure()
    {
        // These reached the browser as "Request failed (500)" with no body, which reads as a broken
        // application. The client prefers a JSON `error` over its status-code fallback, so a 503
        // carrying a reason is what the user actually sees.
        foreach (var transient in new Exception[]
        {
            new NpgsqlException("Exception while reading from stream"),
            new TimeoutException("Timeout during reading attempt")
        })
        {
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, StatusOf(MailEndpoints.MailError(transient)));
        }
    }

    [Fact]
    public void GmailProviderFailuresCarryTheirReasonInsteadOfReturningABare500()
    {
        var result = ProductivityEndpoints.ProductivityError(
            new InvalidOperationException("Google rejected the sending identity"));

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, StatusOf(result));
    }

    [Fact]
    public void AStatementThePostgresServerRejectedStaysLoud()
    {
        // Deliberately not folded into the retryable case above. The server understood the
        // statement and refused it, which is a bug here, and swallowing it as "try again later"
        // would hide it behind a message that says it fixes itself.
        var rejected = new PostgresException("column does not exist", "ERROR", "ERROR", "42703");

        Assert.Throws<PostgresException>(() => MailEndpoints.MailError(rejected));
    }

    [Theory]
    [InlineData(typeof(MailNotFoundException), StatusCodes.Status404NotFound)]
    [InlineData(typeof(MailConflictException), StatusCodes.Status409Conflict)]
    [InlineData(typeof(ArgumentException), StatusCodes.Status400BadRequest)]
    public void TheEstablishedMailFailuresKeepTheirStatuses(Type failure, int expected)
    {
        var error = (Exception)Activator.CreateInstance(failure, "boom")!;

        Assert.Equal(expected, StatusOf(MailEndpoints.MailError(error)));
    }

    private static int StatusOf(IResult result) =>
        Assert.IsAssignableFrom<IStatusCodeHttpResult>(result).StatusCode
        ?? throw new InvalidOperationException("The result did not carry a status code");
}
