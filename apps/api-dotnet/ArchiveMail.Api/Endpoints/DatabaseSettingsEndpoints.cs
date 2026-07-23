using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Security;
using System.Net.Http.Json;
using System.Text.Json;

namespace ArchiveMail.Api.Endpoints;

public static class DatabaseSettingsEndpoints
{
    public static IEndpointRouteBuilder MapDatabaseSettingsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/settings", async (HttpContext context, AdminSettingsViewService settings, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            return Results.Ok(await settings.ViewAsync(token));
        }).WithName("GetAdminSettings").WithTags("Admin settings");

        var group = app.MapGroup("/api/admin/settings/database").WithTags("Database settings");

        group.MapGet("/", (HttpContext context, DatabaseSettingsService settings) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            return Results.Ok(settings.View());
        }).WithName("GetDatabaseSettings").Produces<DatabaseSettingsView>();

        group.MapPost("/test", async (
            DatabaseSettingsRequest request,
            HttpContext context,
            DatabaseSettingsService settings,
            CancellationToken cancellationToken) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            try
            {
                return Results.Ok(await settings.TestAsync(request, cancellationToken));
            }
            catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Npgsql.NpgsqlException or Microsoft.Data.SqlClient.SqlException)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("TestDatabaseConnection").Produces<DatabaseConnectionTestResult>().Produces(StatusCodes.Status400BadRequest);

        group.MapMethods("/", ["PATCH"], async (
            DatabaseSettingsRequest request,
            HttpContext context,
            DatabaseSettingsService settings,
            AdminSettingsViewService adminSettings,
            CancellationToken cancellationToken) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            try
            {
                await settings.SaveAsync(request, cancellationToken);
                return Results.Ok(await adminSettings.ViewAsync(cancellationToken));
            }
            catch (DatabaseProviderNotReadyException exception)
            {
                return Results.Conflict(new { error = exception.Message });
            }
            catch (Exception exception) when (exception is ArgumentException or InvalidOperationException or Npgsql.NpgsqlException or Microsoft.Data.SqlClient.SqlException)
            {
                return Results.BadRequest(new { error = exception.Message });
            }
        }).WithName("UpdateDatabaseSettings")
            .Produces(StatusCodes.Status400BadRequest).Produces(StatusCodes.Status409Conflict);

        app.MapMethods("/api/admin/settings/gmail", ["PATCH"], async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.UpdateGmail(request);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("UpdateGmailSettings").WithTags("Admin settings");
        app.MapDelete("/api/admin/settings/gmail", async (HttpContext context, AppSettingsService application,
            AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.ClearGmail();
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("ClearGmailSettings").WithTags("Admin settings");
        app.MapMethods("/api/admin/settings/drafts", ["PATCH"], async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.UpdateDrafts(request);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("UpdateDraftSettings").WithTags("Admin settings");
        app.MapMethods("/api/admin/settings/stocks", ["PATCH"], async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.UpdateStocks(request);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("UpdateStockSettings").WithTags("Admin settings");
        app.MapMethods("/api/admin/settings/news", ["PATCH"], async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.UpdateNews(request);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("UpdateNewsSettings").WithTags("Admin settings");
        app.MapMethods("/api/admin/settings/ai", ["PATCH"], async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.UpdateAi(request);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("UpdateAiSettings").WithTags("Admin settings");
        app.MapPost("/api/admin/settings/ai/active", async (JsonElement request, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            if (!request.TryGetProperty("provider", out var value) || value.ValueKind != JsonValueKind.String)
                return Results.BadRequest(new { error = "provider is required" });
            try { application.SetActiveAi(value.GetString() ?? ""); return Results.Ok(await admin.ViewAsync(token)); }
            catch (ArgumentException error) { return Results.BadRequest(new { error = error.Message }); }
        }).WithName("SetActiveAiProvider").WithTags("Admin settings");
        app.MapDelete("/api/admin/settings/ai/key", async (string? provider, HttpContext context,
            AppSettingsService application, AdminSettingsViewService admin, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            application.ClearAiKey(provider ?? application.Current().AiValue.ActiveProvider);
            return Results.Ok(await admin.ViewAsync(token));
        }).WithName("ClearAiProviderKey").WithTags("Admin settings");
        app.MapGet("/api/admin/settings/ai/models", async (string? provider, HttpContext context,
            AppSettingsService application, IHttpClientFactory clients, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            return await AiModels(application, clients, provider, token);
        }).WithName("ListAiModels").WithTags("Admin settings");
        app.MapPost("/api/admin/settings/ai/test", async (string? provider, HttpContext context,
            AppSettingsService application, IHttpClientFactory clients, CancellationToken token) =>
        {
            if (!IsAdmin(context)) return Results.Forbid();
            return await TestAiProvider(application, clients, provider, token);
        }).WithName("TestAiProvider").WithTags("Admin settings");

        return app;
    }

    private static async Task<IResult> AiModels(AppSettingsService application, IHttpClientFactory clients,
        string? provider, CancellationToken token)
    {
        var settings = application.Current().AiValue;
        var id = provider is "deepseek" ? "deepseek" : "openai";
        var configured = id == "deepseek" ? settings.DeepSeek : settings.OpenAi;
        if (string.IsNullOrWhiteSpace(configured?.ApiKey))
            return Results.BadRequest(new { error = $"Configure the {id} API key first" });
        var endpoint = id == "deepseek" ? "https://api.deepseek.com/models" : "https://api.openai.com/v1/models";
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", configured.ApiKey);
        try
        {
            using var response = await clients.CreateClient("external").SendAsync(request, token);
            var body = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: token);
            if (!response.IsSuccessStatusCode)
                return Results.BadRequest(new { error = $"{id} rejected the credentials ({(int)response.StatusCode})" });
            var models = body.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array
                ? data.EnumerateArray().Select(item => item.TryGetProperty("id", out var model) ? model.GetString() : null)
                    .Where(model => !string.IsNullOrWhiteSpace(model)).Order().Select(model => new { id = model, label = model, description = (string?)null, pricing = (string?)null }).ToArray()
                : [];
            return Results.Ok(models);
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
        {
            return Results.BadRequest(new { error = $"Could not reach {id}: {error.Message}" });
        }
    }

    private static async Task<IResult> TestAiProvider(AppSettingsService application, IHttpClientFactory clients,
        string? provider, CancellationToken token)
    {
        var settings = application.Current().AiValue;
        var id = provider is "deepseek" ? "deepseek" : "openai";
        var configured = id == "deepseek" ? settings.DeepSeek : settings.OpenAi;
        if (string.IsNullOrWhiteSpace(configured?.ApiKey))
            return Results.BadRequest(new { error = $"Configure the {id} API key first" });
        if (string.IsNullOrWhiteSpace(configured.Model))
            return Results.BadRequest(new { error = $"Choose a {id} model first" });

        var endpoint = id == "deepseek"
            ? "https://api.deepseek.com/chat/completions"
            : "https://api.openai.com/v1/chat/completions";
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", configured.ApiKey);
        request.Content = JsonContent.Create(new
        {
            model = configured.Model,
            messages = new[] { new { role = "user", content = "Reply with OK." } }
        });

        try
        {
            using var response = await clients.CreateClient("ai").SendAsync(request, token);
            var body = await response.Content.ReadAsStringAsync(token);
            if (!response.IsSuccessStatusCode)
                return Results.BadRequest(new
                {
                    error = $"{id} rejected model {configured.Model} ({(int)response.StatusCode}): {ProviderError(body)}"
                });

            using var json = JsonDocument.Parse(body);
            if (!json.RootElement.TryGetProperty("choices", out var choices)
                || choices.ValueKind != JsonValueKind.Array
                || choices.GetArrayLength() == 0)
                return Results.BadRequest(new { error = $"{id} returned an invalid chat-completion response" });
            return Results.Ok(new { ok = true, provider = id, model = configured.Model });
        }
        catch (Exception error) when (error is HttpRequestException or TaskCanceledException or JsonException)
        {
            return Results.BadRequest(new { error = $"Could not complete a test request with {id}: {error.Message}" });
        }
    }

    internal static string ProviderError(string body)
    {
        try
        {
            using var json = JsonDocument.Parse(body);
            if (json.RootElement.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.Object
                    && error.TryGetProperty("message", out var message)
                    && message.ValueKind == JsonValueKind.String)
                    return message.GetString() ?? "Provider rejected the request";
                if (error.ValueKind == JsonValueKind.String) return error.GetString() ?? "Provider rejected the request";
            }
        }
        catch (JsonException)
        {
            // Fall back to the provider's bounded plain-text response.
        }
        var normalized = string.Join(' ', body.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        return normalized.Length == 0 ? "Provider rejected the request" : normalized[..Math.Min(normalized.Length, 300)];
    }

    private static bool IsAdmin(HttpContext context) =>
        context.Items[AuthService.SessionItemKey] is SessionRecord { Role: "admin" };
}
