using ArchiveMail.Api.Imports;
using ArchiveMail.Api.Security;

namespace ArchiveMail.Api.Infrastructure;

public sealed class AdminSettingsViewService(
    DatabaseSettingsService databaseSettings,
    ActiveDatabaseConfiguration active,
    ImportJobRepository jobs,
    ImportCoordinator coordinator,
    AuthService auth,
    AppSettingsService appSettings)
{
    public async Task<object> ViewAsync(CancellationToken cancellationToken)
    {
        var database = databaseSettings.View();
        var counts = await jobs.CountsAsync(cancellationToken);
        var users = await auth.ListUsersAsync(cancellationToken);
        var application = appSettings.Current();
        var gmail = application.GmailValue;
        var publicUrl = Environment.GetEnvironmentVariable("EMAIL_CLIENT_PUBLIC_URL")?.Trim().TrimEnd('/');
        var drafts = application.DraftsValue;
        var stocks = application.StocksValue;
        var news = application.NewsValue;
        var ai = application.AiValue;
        var lithuanian = application.LithuanianValue;
        var polling = application.PollingValue;
        // Merge the catalog with saved overrides so the admin screen gets labels, defaults
        // and effective values in one payload and never has to hardcode the loop list.
        var pollingLoops = PollingDefaults.Catalog.Select(definition =>
        {
            var configured = polling.For(definition.Key);
            return new
            {
                key = definition.Key,
                label = definition.Label,
                description = definition.Description,
                enabled = configured.Enabled,
                intervalMs = configured.IntervalMs ?? definition.IntervalMs,
                defaultIntervalMs = definition.IntervalMs,
                activeIntervalMs = definition.ActiveIntervalMs is null
                    ? (int?)null
                    : configured.ActiveIntervalMs ?? definition.ActiveIntervalMs,
                defaultActiveIntervalMs = definition.ActiveIntervalMs,
                activeLabel = definition.ActiveLabel,
                customized = configured.IntervalMs is not null
                    || configured.ActiveIntervalMs is not null
                    || !configured.Enabled
            };
        }).ToArray();
        var emptyUsage = new
        {
            todayRequests = 0,
            monthRequests = 0,
            todayInputTokens = 0,
            todayOutputTokens = 0,
            monthInputTokens = 0,
            monthOutputTokens = 0
        };
        object Provider(string id, AiProviderRuntimeSettings configured) => new
        {
            configured = configured.ApiKey.Length > 0,
            apiKeyConfigured = configured.ApiKey.Length > 0,
            savedApiKeyConfigured = configured.ApiKey.Length > 0 && string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(id == "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY")),
            environmentApiKeyConfigured = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(id == "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY")),
            source = configured.ApiKey.Length == 0 ? "none" : !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(id == "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY")) ? "environment" : "admin",
            model = configured.Model
        };
        return new
        {
            polling = new
            {
                minimumIntervalMs = PollingDefaults.MinimumIntervalMs,
                maximumIntervalMs = PollingDefaults.MaximumIntervalMs,
                loops = pollingLoops
            },
            database = new
            {
                database.ActiveProvider,
                activeConnectionString = database.ActiveConnectionSummary,
                database.ConfiguredProvider,
                configuredConnectionString = database.ConfiguredConnectionSummary,
                database.RestartRequired,
                database.Providers,
                structuredDataPath = $"{database.ActiveProvider} database",
                attachmentBlobPath = Path.Combine(active.DataDirectory, "blobs"),
                postgresMigrationTargetConfigured = database.ActiveProvider == DatabaseProviderIds.PostgreSql,
                importRuntime = new
                {
                    activeJobs = counts.Active,
                    queuedJobs = counts.Queued,
                    concurrency = 1,
                    batchSize = coordinator.BatchSize,
                    throttleMs = 0,
                    latencyThresholdMs = 0,
                    throttledForApiLatency = false,
                    parserConcurrency = coordinator.ParserConcurrency
                }
            },
            security = new { sessionLifetimeMinutes = 720, defaultPinWarning = users.Any(user => user.Role == "admin" && user.IsActive && user.MustChangePin) },
            gmail = new
            {
                configured = gmail.ClientId.Length > 0,
                clientId = gmail.ClientId,
                clientSecretConfigured = gmail.ClientSecret.Length > 0,
                source = gmail.ClientId.Length == 0 ? "none" : !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GMAIL_CLIENT_ID")) ? "environment" : "admin",
                settingsPath = appSettings.SettingsPath,
                configurationError = (string?)null,
                oauthCallbackUrl = string.IsNullOrWhiteSpace(publicUrl) ? null : $"{publicUrl}/api/gmail/oauth/callback",
                syncIntervalMinutes = gmail.SyncIntervalMinutes,
                syncIntervalEnvManaged = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GMAIL_SYNC_INTERVAL_MINUTES")),
                syncMailboxActions = gmail.SyncMailboxActions,
                syncMailboxActionsEnvManaged = !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("GMAIL_SYNC_MAILBOX_ACTIONS"))
            },
            drafts = new { drafts.DefaultFromAddress, drafts.SenderName, settingsPath = appSettings.SettingsPath, configurationError = (string?)null },
            stocks = new { symbols = stocks.Symbols ?? Array.Empty<string>(), stocks.SecondsPerSymbol, settingsPath = appSettings.SettingsPath, configurationError = (string?)null },
            news = new { enabledSources = news.EnabledSources ?? Array.Empty<string>(), news.SecondsPerHeadline, settingsPath = appSettings.SettingsPath, configurationError = (string?)null },
            lithuanian = new
            {
                apiKeyConfigured = lithuanian.ApiKey.Length > 0,
                environmentManaged = !string.IsNullOrWhiteSpace(
                    Environment.GetEnvironmentVariable(LithuanianDefaults.ApiKeyVariable)),
                source = lithuanian.ApiKey.Length == 0
                    ? "none"
                    : !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(LithuanianDefaults.ApiKeyVariable))
                        ? "environment"
                        : "admin",
                model = lithuanian.Model,
                defaultModel = LithuanianDefaults.TranscriptionModel,
                learnerCount = users.Count(user => user.Role == "lucas"),
                settingsPath = appSettings.SettingsPath,
                configurationError = (string?)null
            },
            ai = new
            {
                ai.ActiveProvider,
                ai.Enabled,
                ai.Concurrency,
                ai.DailyRequestLimit,
                ai.MonthlyRequestLimit,
                settingsPath = appSettings.SettingsPath,
                configurationError = (string?)null,
                usage = emptyUsage,
                providers = new Dictionary<string, object>
                {
                    ["openai"] = Provider("openai", ai.OpenAi ?? new("", AiModelDefaults.OpenAi)),
                    ["deepseek"] = Provider("deepseek", ai.DeepSeek ?? new("", AiModelDefaults.DeepSeek))
                }
            }
        };
    }
}
