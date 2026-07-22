using System.Text.Json;
using ArchiveMail.Api.Endpoints;
using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Calendar;
using ArchiveMail.Api.Property;
using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Mail;
using ArchiveMail.Api.Security;
using ArchiveMail.Api.Productivity;
using ArchiveMail.Api.Gmail;
using Microsoft.OpenApi.Models;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.UseUrls(Environment.GetEnvironmentVariable("ASPNETCORE_URLS") ?? "http://0.0.0.0:3001");
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
});
builder.Services.Configure<ImportOptions>(builder.Configuration.GetSection("Import"));

var activeDatabase = DatabaseBootstrap.Resolve(builder.Configuration);
if (activeDatabase.Provider != DatabaseProviderIds.PostgreSql)
{
    throw new InvalidOperationException(
        "Microsoft SQL Server is not yet an activatable runtime. Select PostgreSQL until the SQL Server parity gate passes.");
}
var dataSourceBuilder = new NpgsqlDataSourceBuilder(activeDatabase.ConnectionString);
var dataSource = dataSourceBuilder.Build();
builder.Services.AddSingleton(activeDatabase);
builder.Services.AddSingleton(dataSource);
builder.Services.AddSingleton<DatabaseSettingsService>();
builder.Services.AddSingleton<AppSettingsService>();
builder.Services.AddSingleton<AdminSettingsViewService>();
builder.Services.AddSingleton<MailRepository>();
builder.Services.AddSingleton<SenderRuleRepository>();
builder.Services.AddSingleton<FollowUpRepository>();
builder.Services.AddSingleton<InboxTabRepository>();
builder.Services.AddSingleton<ObservabilityRepository>();
builder.Services.AddSingleton<TodoRepository>();
builder.Services.AddSingleton<ProductivityRepository>();
builder.Services.AddSingleton<GmailService>();
builder.Services.AddSingleton<AiService>();
builder.Services.AddSingleton<SmartRuleService>();
builder.Services.AddSingleton<CalendarService>();
builder.Services.AddSingleton<PropertyService>();
builder.Services.AddSingleton<PropertyPaymentGateway>();
builder.Services.AddSingleton<SharingService>();
builder.Services.AddSingleton<DatabaseInitializer>();
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<ImportJobRepository>();
builder.Services.AddSingleton<ImportBatchWriter>();
builder.Services.AddSingleton<PstStager>();
builder.Services.AddSingleton<MboxStager>();
builder.Services.AddSingleton<ArchiveStager>();
builder.Services.AddSingleton<UploadService>();
builder.Services.AddSingleton<AttachmentMaterializer>();
builder.Services.AddSingleton<ImportCoordinator>();
builder.Services.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<ImportCoordinator>());
builder.Services.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<AttachmentMaterializer>());
builder.Services.AddHostedService<GmailScheduledSyncService>();
builder.Services.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<AiService>());
builder.Services.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<SmartRuleService>());
builder.Services.AddHostedService<PropertyAutomationHostedService>();
builder.Services.AddHttpClient("external", client => client.Timeout = TimeSpan.FromSeconds(30));

builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(options =>
{
    options.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Archive Mail API",
        Version = "v1",
        Description = "Asynchronous C# API with resumable archive imports and provider-aware database configuration."
    });
    options.AddSecurityDefinition("Bearer", new OpenApiSecurityScheme
    {
        Type = SecuritySchemeType.Http,
        Scheme = "bearer",
        BearerFormat = "opaque",
        Description = "Archive Mail access token"
    });
});

var app = builder.Build();

await app.Services.GetRequiredService<DatabaseInitializer>().InitializeAsync(app.Lifetime.ApplicationStopping);

app.UseSwagger();
app.UseSwaggerUI(options =>
{
    options.SwaggerEndpoint("/swagger/v1/swagger.json", "Archive Mail API v1");
    options.RoutePrefix = "swagger";
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.Use(async (context, next) =>
{
    if (!context.Request.Path.StartsWithSegments("/api")
        || context.Request.Path == "/api/health"
        || context.Request.Path == "/api/auth/login"
        || context.Request.Path == "/api/gmail/oauth/callback"
        || context.Request.Path.StartsWithSegments("/api/auth/property-invitations")
        || context.Request.Path.StartsWithSegments("/api/property-webhooks"))
    {
        await next();
        return;
    }

    var auth = context.RequestServices.GetRequiredService<AuthService>();
    var session = await auth.AuthenticateAsync(context, context.RequestAborted);
    if (session is null)
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        await context.Response.WriteAsJsonAsync(new { error = "Login required" }, context.RequestAborted);
        return;
    }
    var denialReason = ApiRouteAuthorization.DenialReason(session, context.Request.Method, context.Request.Path);
    if (denialReason is not null)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new { error = denialReason }, context.RequestAborted);
        return;
    }
    context.Items[AuthService.SessionItemKey] = session;
    await next();
});

app.Use(async (context, next) =>
{
    await next();
    if (!context.Request.Path.StartsWithSegments("/api") || context.Request.Path == "/api/health") return;
    var session = context.Items[AuthService.SessionItemKey] as SessionRecord;
    await context.RequestServices.GetRequiredService<ObservabilityRepository>()
        .RecordAuditAsync(context, session, CancellationToken.None);
});

app.MapGet("/api/health", async (NpgsqlDataSource database, CancellationToken cancellationToken) =>
{
    await using var command = database.CreateCommand("SELECT 1");
    await command.ExecuteScalarAsync(cancellationToken);
    return Results.Ok(new
    {
        status = "ok",
        api = "csharp",
        database = activeDatabase.Provider,
        databaseConfigurationSource = activeDatabase.Source,
        importer = "async-batched-resumable"
    });
}).WithName("Health").WithTags("System").Produces(StatusCodes.Status200OK);

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
app.MapAdminEndpoints();
if (Directory.Exists(Path.Combine(app.Environment.ContentRootPath, "wwwroot")))
    app.MapFallbackToFile("index.html");
app.Run();

public partial class Program;
