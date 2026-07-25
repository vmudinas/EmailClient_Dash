using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;

namespace ArchiveMail.Api.Infrastructure;

public sealed record GmailRuntimeSettings(
    string ClientId = "",
    string ClientSecret = "",
    int SyncIntervalMinutes = 15,
    bool SyncMailboxActions = false);

public sealed record DraftRuntimeSettings(string DefaultFromAddress = "", string SenderName = "");
public sealed record StockRuntimeSettings(string[]? Symbols = null, int SecondsPerSymbol = 8);
public sealed record NewsRuntimeSettings(string[]? EnabledSources = null, int SecondsPerHeadline = 8);
public sealed record AiProviderRuntimeSettings(string ApiKey = "", string Model = "");
public sealed record AiRuntimeSettings(
    string ActiveProvider = "openai",
    bool Enabled = false,
    int Concurrency = 1,
    int DailyRequestLimit = 0,
    int MonthlyRequestLimit = 0,
    AiProviderRuntimeSettings? OpenAi = null,
    AiProviderRuntimeSettings? DeepSeek = null);
public sealed record PropertyIntegrationRuntimeSettings(
    string StripeSecretKey="",string StripeWebhookSecret="",string PaypalClientId="",string PaypalClientSecret="",
    string PaypalWebhookId="",string PaypalEnvironment="sandbox",string? ZelleRecipient=null,string ZelleNote="",
    string? AppleCashRecipient=null,string AppleCashNote="",
    string TwilioAccountSid="",string TwilioAuthToken="",string TwilioMessagingServiceSid="",string? GmailConnectionId=null);

public sealed record PollingLoopSettings(bool Enabled = true, int? IntervalMs = null, int? ActiveIntervalMs = null);

/// <summary>Per-loop overrides for <see cref="PollingDefaults.Catalog"/>, keyed by loop id.</summary>
public sealed record PollingRuntimeSettings(IReadOnlyDictionary<string, PollingLoopSettings>? Loops = null)
{
    public PollingLoopSettings For(string key) =>
        Loops is not null && Loops.TryGetValue(key, out var configured) ? configured : new();
}

public sealed record AppRuntimeSettings(
    GmailRuntimeSettings? Gmail = null,
    DraftRuntimeSettings? Drafts = null,
    StockRuntimeSettings? Stocks = null,
    NewsRuntimeSettings? News = null,
    AiRuntimeSettings? Ai = null,
    PropertyIntegrationRuntimeSettings? PropertyIntegrations = null,
    PollingRuntimeSettings? Polling = null)
{
    public GmailRuntimeSettings GmailValue => Gmail ?? new();
    public DraftRuntimeSettings DraftsValue => Drafts ?? new();
    public StockRuntimeSettings StocksValue => Stocks ?? new(["SPY", "QQQ"], 8);
    public NewsRuntimeSettings NewsValue => News ?? new(["cnn", "bbc", "aljazeera", "foxnews"], 8);
    public AiRuntimeSettings AiValue => Ai ?? new(
        OpenAi: new("", AiModelDefaults.OpenAi),
        DeepSeek: new("", AiModelDefaults.DeepSeek));
    public PropertyIntegrationRuntimeSettings PropertyIntegrationsValue => PropertyIntegrations ?? new();
    public PollingRuntimeSettings PollingValue => Polling ?? new();
}

public sealed class AppSettingsService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };
    private readonly object _gate = new();
    private readonly IDataProtector _protector;
    private AppRuntimeSettings _settings;

    public AppSettingsService(ActiveDatabaseConfiguration database)
    {
        SettingsPath = Path.Combine(database.DataDirectory, "app-settings.protected.json");
        var keysDirectory = Path.Combine(database.DataDirectory, "data-protection-keys");
        Directory.CreateDirectory(keysDirectory);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(keysDirectory, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var provider = DataProtectionProvider.Create(
            new DirectoryInfo(keysDirectory),
            options => options.SetApplicationName("ArchiveMail.AppSettings.v1"));
        _protector = provider.CreateProtector("application-settings");
        _settings = Load();
        if (ImportLegacyGmailSettings(database.DataDirectory)) Save();
    }

    public string SettingsPath { get; }

    public AppRuntimeSettings Current()
    {
        lock (_gate) return WithEnvironment(_settings);
    }

    public AppRuntimeSettings UpdateGmail(JsonElement input)
    {
        lock (_gate)
        {
            var current = _settings.GmailValue;
            _settings = _settings with { Gmail = current with
            {
                ClientId = String(input, "clientId") ?? current.ClientId,
                ClientSecret = String(input, "clientSecret") ?? current.ClientSecret,
                SyncIntervalMinutes = Integer(input, "syncIntervalMinutes") ?? current.SyncIntervalMinutes,
                SyncMailboxActions = Boolean(input, "syncMailboxActions") ?? current.SyncMailboxActions
            }};
            Save();
            return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings ClearGmail()
    {
        lock (_gate) { _settings = _settings with { Gmail = new() }; Save(); return WithEnvironment(_settings); }
    }

    public AppRuntimeSettings UpdateDrafts(JsonElement input)
    {
        lock (_gate)
        {
            var current = _settings.DraftsValue;
            _settings = _settings with { Drafts = current with
            {
                DefaultFromAddress = String(input, "defaultFromAddress") ?? current.DefaultFromAddress,
                SenderName = String(input, "senderName") ?? current.SenderName
            }};
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings UpdateStocks(JsonElement input)
    {
        lock (_gate)
        {
            var current = _settings.StocksValue;
            var symbols = Strings(input, "symbols") ?? current.Symbols ?? [];
            _settings = _settings with { Stocks = current with
            {
                Symbols = symbols.Select(value => value.Trim().ToUpperInvariant()).Where(value => value.Length > 0).Distinct().Take(20).ToArray(),
                SecondsPerSymbol = Math.Clamp(Integer(input, "secondsPerSymbol") ?? current.SecondsPerSymbol, 2, 60)
            }};
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings UpdateNews(JsonElement input)
    {
        lock (_gate)
        {
            var current = _settings.NewsValue;
            var sources = Strings(input, "enabledSources") ?? current.EnabledSources ?? [];
            _settings = _settings with { News = current with
            {
                EnabledSources = sources.Where(value => value is "cnn" or "bbc" or "aljazeera" or "foxnews").Distinct().ToArray(),
                SecondsPerHeadline = Math.Clamp(Integer(input, "secondsPerHeadline") ?? current.SecondsPerHeadline, 2, 60)
            }};
            Save(); return WithEnvironment(_settings);
        }
    }

    /// <summary>
    /// Merges one loop's overrides. Unknown keys are rejected rather than stored, so a typo
    /// cannot silently accumulate dead settings that the admin screen never surfaces again.
    /// </summary>
    public AppRuntimeSettings UpdatePolling(JsonElement input)
    {
        var key = String(input, "key") ?? throw new ArgumentException("A polling loop key is required");
        var definition = PollingDefaults.Find(key)
            ?? throw new ArgumentException($"Unknown polling loop: {key}");
        lock (_gate)
        {
            var current = _settings.PollingValue;
            var existing = current.For(key);
            var loops = current.Loops is null
                ? new Dictionary<string, PollingLoopSettings>(StringComparer.Ordinal)
                : new Dictionary<string, PollingLoopSettings>(current.Loops, StringComparer.Ordinal);

            var interval = Integer(input, "intervalMs") ?? existing.IntervalMs;
            var activeInterval = Integer(input, "activeIntervalMs") ?? existing.ActiveIntervalMs;
            loops[key] = existing with
            {
                Enabled = Boolean(input, "enabled") ?? existing.Enabled,
                IntervalMs = interval is null ? null : PollingDefaults.ClampInterval(interval.Value),
                // Only the loops that actually declare a busy rate can carry one.
                ActiveIntervalMs = definition.ActiveIntervalMs is null || activeInterval is null
                    ? null
                    : PollingDefaults.ClampInterval(activeInterval.Value)
            };
            _settings = _settings with { Polling = current with { Loops = loops } };
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings UpdateAi(JsonElement input)
    {
        lock (_gate)
        {
            var current = _settings.AiValue;
            var providerId = String(input, "provider") ?? current.ActiveProvider;
            var provider = providerId == "deepseek"
                ? current.DeepSeek ?? new("", AiModelDefaults.DeepSeek)
                : current.OpenAi ?? new("", AiModelDefaults.OpenAi);
            provider = provider with
            {
                ApiKey = String(input, "apiKey") ?? provider.ApiKey,
                Model = String(input, "model") ?? provider.Model
            };
            _settings = _settings with { Ai = current with
            {
                Enabled = Boolean(input, "enabled") ?? current.Enabled,
                Concurrency = Math.Clamp(Integer(input, "concurrency") ?? current.Concurrency, 1, 8),
                DailyRequestLimit = Math.Max(0, Integer(input, "dailyRequestLimit") ?? current.DailyRequestLimit),
                MonthlyRequestLimit = Math.Max(0, Integer(input, "monthlyRequestLimit") ?? current.MonthlyRequestLimit),
                OpenAi = providerId == "openai" ? provider : current.OpenAi,
                DeepSeek = providerId == "deepseek" ? provider : current.DeepSeek
            }};
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings SetActiveAi(string provider)
    {
        if (provider is not ("openai" or "deepseek")) throw new ArgumentException("Unknown AI provider");
        lock (_gate)
        {
            var current = _settings.AiValue;
            _settings = _settings with { Ai = current with { ActiveProvider = provider } };
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings ClearAiKey(string provider)
    {
        lock (_gate)
        {
            var current = _settings.AiValue;
            _settings = _settings with { Ai = provider == "deepseek"
                ? current with { DeepSeek = (current.DeepSeek ?? new("", AiModelDefaults.DeepSeek)) with { ApiKey = "" } }
                : current with { OpenAi = (current.OpenAi ?? new("", AiModelDefaults.OpenAi)) with { ApiKey = "" } } };
            Save(); return WithEnvironment(_settings);
        }
    }

    public AppRuntimeSettings UpdatePropertyIntegrations(JsonElement input)
    {
        lock(_gate)
        {
            var current=_settings.PropertyIntegrationsValue;
            _settings=_settings with { PropertyIntegrations=current with {
                StripeSecretKey=Boolean(input,"clearStripeSecretKey")==true?"":String(input,"stripeSecretKey")??current.StripeSecretKey,
                StripeWebhookSecret=Boolean(input,"clearStripeWebhookSecret")==true?"":String(input,"stripeWebhookSecret")??current.StripeWebhookSecret,
                PaypalClientId=String(input,"paypalClientId")??current.PaypalClientId,
                PaypalClientSecret=Boolean(input,"clearPaypalClientSecret")==true?"":String(input,"paypalClientSecret")??current.PaypalClientSecret,
                PaypalWebhookId=String(input,"paypalWebhookId")??current.PaypalWebhookId,
                PaypalEnvironment=String(input,"paypalEnvironment")??current.PaypalEnvironment,
                ZelleRecipient=input.TryGetProperty("zelleRecipient",out var zelle)&&zelle.ValueKind==JsonValueKind.Null?null:Property.PropertyPaymentRules.NormalizeRecipient(String(input,"zelleRecipient"),"Zelle recipient")??current.ZelleRecipient,
                ZelleNote=String(input,"zelleNote")??current.ZelleNote,
                AppleCashRecipient=input.TryGetProperty("appleCashRecipient",out var appleCash)&&appleCash.ValueKind==JsonValueKind.Null?null:Property.PropertyPaymentRules.NormalizeRecipient(String(input,"appleCashRecipient"),"Apple Cash recipient")??current.AppleCashRecipient,
                AppleCashNote=String(input,"appleCashNote")??current.AppleCashNote,
                TwilioAccountSid=String(input,"twilioAccountSid")??current.TwilioAccountSid,
                TwilioAuthToken=Boolean(input,"clearTwilioAuthToken")==true?"":String(input,"twilioAuthToken")??current.TwilioAuthToken,
                TwilioMessagingServiceSid=String(input,"twilioMessagingServiceSid")??current.TwilioMessagingServiceSid,
                GmailConnectionId=input.TryGetProperty("gmailConnectionId",out var gmail)&&gmail.ValueKind==JsonValueKind.Null?null:String(input,"gmailConnectionId")??current.GmailConnectionId
            }};Save();return WithEnvironment(_settings);
        }
    }

    private AppRuntimeSettings Load()
    {
        if (!File.Exists(SettingsPath)) return new();
        try
        {
            var protectedValue = File.ReadAllText(SettingsPath);
            return JsonSerializer.Deserialize<AppRuntimeSettings>(_protector.Unprotect(protectedValue), JsonOptions) ?? new();
        }
        catch (Exception error) when (error is IOException or JsonException or System.Security.Cryptography.CryptographicException)
        {
            throw new InvalidOperationException("Application settings could not be decrypted. Restore /data/data-protection-keys with the settings file.", error);
        }
    }

    private bool ImportLegacyGmailSettings(string dataDirectory)
    {
        if (!string.IsNullOrWhiteSpace(_settings.GmailValue.ClientId)) return false;
        var legacyPath = Path.Combine(dataDirectory, "gmail-oauth-settings.json");
        if (!File.Exists(legacyPath)) return false;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(legacyPath));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return false;
            var installed = Object(root, "installed");
            var web = Object(root, "web");
            var clientId = String(root, "clientId") ?? String(root, "client_id")
                ?? String(installed, "client_id") ?? String(web, "client_id");
            if (string.IsNullOrWhiteSpace(clientId)) return false;
            var clientSecret = String(root, "clientSecret") ?? String(root, "client_secret")
                ?? String(installed, "client_secret") ?? String(web, "client_secret") ?? "";
            var current = _settings.GmailValue;
            _settings = _settings with { Gmail = current with
            {
                ClientId = clientId,
                ClientSecret = clientSecret,
                SyncIntervalMinutes = Integer(root, "syncIntervalMinutes") ?? current.SyncIntervalMinutes,
                SyncMailboxActions = Boolean(root, "syncMailboxActions") ?? current.SyncMailboxActions
            }};
            return true;
        }
        catch (Exception error) when (error is IOException or JsonException)
        {
            return false;
        }
    }

    private void Save()
    {
        var temporary = $"{SettingsPath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, _protector.Protect(JsonSerializer.Serialize(_settings, JsonOptions)));
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        File.Move(temporary, SettingsPath, true);
    }

    private static AppRuntimeSettings WithEnvironment(AppRuntimeSettings source)
    {
        var gmail = source.GmailValue;
        gmail = gmail with
        {
            ClientId = Environment.GetEnvironmentVariable("GMAIL_CLIENT_ID")?.Trim() is { Length: > 0 } client ? client : gmail.ClientId,
            ClientSecret = Environment.GetEnvironmentVariable("GMAIL_CLIENT_SECRET")?.Trim() is { Length: > 0 } secret ? secret : gmail.ClientSecret,
            SyncIntervalMinutes = int.TryParse(Environment.GetEnvironmentVariable("GMAIL_SYNC_INTERVAL_MINUTES"),out var interval)?Math.Clamp(interval,1,1440):gmail.SyncIntervalMinutes,
            SyncMailboxActions = bool.TryParse(Environment.GetEnvironmentVariable("GMAIL_SYNC_MAILBOX_ACTIONS"),out var mailboxActions)?mailboxActions:gmail.SyncMailboxActions
        };
        var ai = source.AiValue;
        ai = ai with
        {
            OpenAi = (ai.OpenAi ?? new("", AiModelDefaults.OpenAi)) with
            {
                ApiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY")?.Trim() is { Length: > 0 } openAiKey ? openAiKey : ai.OpenAi?.ApiKey ?? ""
            },
            DeepSeek = (ai.DeepSeek ?? new("", AiModelDefaults.DeepSeek)) with
            {
                ApiKey = Environment.GetEnvironmentVariable("DEEPSEEK_API_KEY")?.Trim() is { Length: > 0 } deepSeekKey ? deepSeekKey : ai.DeepSeek?.ApiKey ?? "",
                // An archive configured before DeepSeek retired a model name would otherwise fail every
                // single AI job with a 400 until an administrator noticed and edited the setting by hand.
                Model = AiModelDefaults.NormalizeDeepSeekModel(ai.DeepSeek?.Model)
            }
        };
        var property=source.PropertyIntegrationsValue with {
            StripeSecretKey=Environment.GetEnvironmentVariable("STRIPE_SECRET_KEY")?.Trim() is {Length:>0} stripe?stripe:source.PropertyIntegrationsValue.StripeSecretKey,
            StripeWebhookSecret=Environment.GetEnvironmentVariable("STRIPE_WEBHOOK_SECRET")?.Trim() is {Length:>0} stripeHook?stripeHook:source.PropertyIntegrationsValue.StripeWebhookSecret,
            PaypalClientId=Environment.GetEnvironmentVariable("PAYPAL_CLIENT_ID")?.Trim() is {Length:>0} paypalId?paypalId:source.PropertyIntegrationsValue.PaypalClientId,
            PaypalClientSecret=Environment.GetEnvironmentVariable("PAYPAL_CLIENT_SECRET")?.Trim() is {Length:>0} paypalSecret?paypalSecret:source.PropertyIntegrationsValue.PaypalClientSecret,
            PaypalWebhookId=Environment.GetEnvironmentVariable("PAYPAL_WEBHOOK_ID")?.Trim() is {Length:>0} paypalHook?paypalHook:source.PropertyIntegrationsValue.PaypalWebhookId,
            PaypalEnvironment=Environment.GetEnvironmentVariable("PAYPAL_ENVIRONMENT")?.Trim().ToLowerInvariant() is "live"?"live":source.PropertyIntegrationsValue.PaypalEnvironment,
            ZelleRecipient=Environment.GetEnvironmentVariable("ZELLE_RECIPIENT")?.Trim() is {Length:>0} zelle?zelle:source.PropertyIntegrationsValue.ZelleRecipient,
            ZelleNote=Environment.GetEnvironmentVariable("ZELLE_PAYMENT_NOTE")?.Trim() is {Length:>0} zelleNote?zelleNote:source.PropertyIntegrationsValue.ZelleNote,
            TwilioAccountSid=Environment.GetEnvironmentVariable("TWILIO_ACCOUNT_SID")?.Trim() is {Length:>0} sid?sid:source.PropertyIntegrationsValue.TwilioAccountSid,
            TwilioAuthToken=Environment.GetEnvironmentVariable("TWILIO_AUTH_TOKEN")?.Trim() is {Length:>0} auth?auth:source.PropertyIntegrationsValue.TwilioAuthToken,
            TwilioMessagingServiceSid=Environment.GetEnvironmentVariable("TWILIO_MESSAGING_SERVICE_SID")?.Trim() is {Length:>0} messaging?messaging:source.PropertyIntegrationsValue.TwilioMessagingServiceSid,
            GmailConnectionId=Environment.GetEnvironmentVariable("PROPERTY_GMAIL_CONNECTION_ID")?.Trim() is {Length:>0} propertyGmail?propertyGmail:source.PropertyIntegrationsValue.GmailConnectionId
        };
        return source with { Gmail = gmail, Ai = ai, PropertyIntegrations=property };
    }

    private static string? String(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String
            ? item.GetString()?.Trim() : null;
    private static JsonElement Object(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item)
            && item.ValueKind == JsonValueKind.Object ? item : default;
    private static int? Integer(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item) && item.TryGetInt32(out var result) ? result : null;
    private static bool? Boolean(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item) && item.ValueKind is JsonValueKind.True or JsonValueKind.False ? item.GetBoolean() : null;
    private static string[]? Strings(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.Array
            ? item.EnumerateArray().Where(entry => entry.ValueKind == JsonValueKind.String).Select(entry => entry.GetString() ?? "").ToArray()
            : null;
}
