using ArchiveMail.Api.Endpoints;
using ArchiveMail.Api.Imports;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class EndpointInventoryTests
{
    [Fact]
    public void Every_api_handler_is_registered_once_and_tagged_for_swagger()
    {
        var builder = WebApplication.CreateBuilder();
        foreach (var serviceType in typeof(ImportJobRepository).Assembly.GetTypes()
                     .Where(type => type.IsClass
                         && !type.IsAbstract
                         && !type.ContainsGenericParameters
                         && type.Namespace?.StartsWith("ArchiveMail.Api", StringComparison.Ordinal) == true))
            builder.Services.AddSingleton(serviceType, _ => null!);
        builder.Services.AddSingleton<NpgsqlDataSource>(_ => null!);
        builder.Services.AddHttpClient();
        using var app = builder.Build();
        app.MapImportEndpoints();
        app.MapAuthEndpoints();
        app.MapDatabaseSettingsEndpoints();
        app.MapMailEndpoints();
        app.MapSenderRuleEndpoints();
        app.MapFollowUpEndpoints();
        app.MapInboxTabEndpoints();
        app.MapObservabilityEndpoints();
        app.MapTodoEndpoints();
        app.MapTickerEndpoints();
        app.MapProductivityEndpoints();
        app.MapGmailEndpoints();
        app.MapAiEndpoints();
        app.MapSmartRuleEndpoints();
        app.MapCalendarEndpoints();
        app.MapPropertyEndpoints();
        app.MapLithuanianEndpoints();
        app.MapAdminEndpoints();

        var endpoints = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .SelectMany(endpoint => endpoint.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods
                .Select(method => new EndpointContract(
                    method,
                    endpoint.RoutePattern.RawText ?? string.Empty,
                    endpoint.Metadata.GetMetadata<ITagsMetadata>()?.Tags ?? []))
                ?? [])
            .ToArray();

        Assert.True(endpoints.Length >= 140, $"Expected at least 140 API operations, found {endpoints.Length}.");
        Assert.All(endpoints, endpoint =>
        {
            Assert.StartsWith("/api/", endpoint.Route, StringComparison.Ordinal);
            Assert.NotEmpty(endpoint.Tags);
        });

        var duplicates = endpoints
            .GroupBy(endpoint => $"{endpoint.Method} {endpoint.Route}", StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();
        Assert.Empty(duplicates);
    }

    private sealed record EndpointContract(string Method, string Route, IReadOnlyList<string> Tags);
}
