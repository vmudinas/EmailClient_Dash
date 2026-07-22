using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Data.SqlClient;
using Npgsql;

namespace ArchiveMail.Api.Infrastructure;

public static class DatabaseProviderIds
{
    public const string PostgreSql = "postgresql";
    public const string SqlServer = "mssql";

    public static string Normalize(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "postgres" or PostgreSql => PostgreSql,
        "sqlserver" or "sql-server" or SqlServer => SqlServer,
        "sqlite" => throw new InvalidOperationException("SQLite is not supported by the C# API"),
        "mysql" => throw new InvalidOperationException("MySQL is not supported; choose PostgreSQL or Microsoft SQL Server"),
        null or "" => PostgreSql,
        _ => throw new InvalidOperationException("Database provider must be postgresql or mssql")
    };
}

public sealed record ActiveDatabaseConfiguration(
    string Provider,
    string ConnectionString,
    string Source,
    string DataDirectory,
    string SettingsPath,
    bool EnvironmentManaged);

public sealed record DatabaseProviderOption(
    string Id,
    string Label,
    bool Available,
    bool CanTest,
    string Description);

public sealed record DatabaseSettingsView(
    string ActiveProvider,
    string ActiveConnectionSummary,
    string ConfiguredProvider,
    string ConfiguredConnectionSummary,
    bool ConnectionStringConfigured,
    bool RestartRequired,
    bool EnvironmentManaged,
    string ConfigurationSource,
    string SettingsPath,
    IReadOnlyList<DatabaseProviderOption> Providers);

public sealed record DatabaseSettingsRequest(string Provider, string ConnectionString);
public sealed record DatabaseConnectionTestResult(
    bool Success,
    string Provider,
    long LatencyMs,
    string ServerVersion,
    string Message);

internal sealed record PersistedDatabaseSettings(
    string Provider,
    string ProtectedConnectionString,
    int Version = 1);

public static class DatabaseBootstrap
{
    public static ActiveDatabaseConfiguration Resolve(IConfiguration configuration)
    {
        var dataDirectory = Path.GetFullPath(
            Environment.GetEnvironmentVariable("EMAIL_CLIENT_DATA_DIR")
            ?? configuration["Import:DataDirectory"]
            ?? "/data");
        Directory.CreateDirectory(dataDirectory);
        var store = new DatabaseSettingsStore(dataDirectory);

        var environmentProvider = Environment.GetEnvironmentVariable("EMAIL_CLIENT_DATABASE_PROVIDER")
            ?? Environment.GetEnvironmentVariable("Database__Provider");
        var environmentConnection = Environment.GetEnvironmentVariable("ConnectionStrings__ArchiveMail")
            ?? Environment.GetEnvironmentVariable("ARCHIVE_MAIL_CONNECTION_STRING")
            ?? Environment.GetEnvironmentVariable("DATABASE_URL");
        if (!string.IsNullOrWhiteSpace(environmentProvider)
            || !string.IsNullOrWhiteSpace(environmentConnection))
        {
            var provider = DatabaseProviderIds.Normalize(environmentProvider);
            var connectionString = ResolveConnectionString(provider, environmentConnection, configuration);
            return new(provider, connectionString, "environment", dataDirectory, store.SettingsPath, true);
        }

        var saved = store.TryLoad();
        if (saved is not null)
            return new(saved.Value.Provider, saved.Value.ConnectionString, "admin", dataDirectory, store.SettingsPath, false);

        var configuredProvider = DatabaseProviderIds.Normalize(configuration["Database:Provider"]);
        var configuredConnection = configuration.GetConnectionString("ArchiveMail")
            ?? configuration["Database:ConnectionString"];
        var usesPostgresBootstrapEnvironment = configuredProvider == DatabaseProviderIds.PostgreSql
            && !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("PGHOST"));
        return new(
            configuredProvider,
            ResolveConnectionString(configuredProvider, configuredConnection, configuration),
            usesPostgresBootstrapEnvironment ? "environment-bootstrap" : "configuration",
            dataDirectory,
            store.SettingsPath,
            false);
    }

    private static string ResolveConnectionString(
        string provider,
        string? connectionString,
        IConfiguration configuration)
    {
        if (!string.IsNullOrWhiteSpace(connectionString)) return connectionString.Trim();
        if (provider == DatabaseProviderIds.PostgreSql)
            return PostgresSettings.ResolveConnectionString(configuration);
        throw new InvalidOperationException("Set ConnectionStrings__ArchiveMail before starting with Microsoft SQL Server");
    }
}

public sealed class DatabaseSettingsStore
{
    private const string SettingsFileName = "database-settings.json";
    private readonly IDataProtector _protector;

    public DatabaseSettingsStore(string dataDirectory)
    {
        var fullDataDirectory = Path.GetFullPath(dataDirectory);
        Directory.CreateDirectory(fullDataDirectory);
        SettingsPath = Path.Combine(fullDataDirectory, SettingsFileName);
        var keysDirectory = Path.Combine(fullDataDirectory, "data-protection-keys");
        Directory.CreateDirectory(keysDirectory);
        RestrictDirectory(keysDirectory);
        var provider = DataProtectionProvider.Create(
            new DirectoryInfo(keysDirectory),
            options => options.SetApplicationName("ArchiveMail.DatabaseSettings.v1"));
        _protector = provider.CreateProtector("database-connection-string");
    }

    public string SettingsPath { get; }

    public (string Provider, string ConnectionString)? TryLoad()
    {
        if (!File.Exists(SettingsPath)) return null;
        try
        {
            var persisted = JsonSerializer.Deserialize<PersistedDatabaseSettings>(
                File.ReadAllText(SettingsPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (persisted is null || persisted.Version != 1) return null;
            return (
                DatabaseProviderIds.Normalize(persisted.Provider),
                _protector.Unprotect(persisted.ProtectedConnectionString));
        }
        catch (Exception exception) when (exception is IOException or JsonException or System.Security.Cryptography.CryptographicException)
        {
            throw new InvalidOperationException(
                $"Database settings at {SettingsPath} could not be read. Restore the matching data-protection key directory or remove the invalid settings file.",
                exception);
        }
    }

    public void Save(string provider, string connectionString)
    {
        var persisted = new PersistedDatabaseSettings(
            DatabaseProviderIds.Normalize(provider),
            _protector.Protect(connectionString.Trim()));
        var temporaryPath = $"{SettingsPath}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(persisted, new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }) + Environment.NewLine);
        RestrictFile(temporaryPath);
        File.Move(temporaryPath, SettingsPath, true);
        RestrictFile(SettingsPath);
    }

    private static void RestrictDirectory(string path)
    {
        if (OperatingSystem.IsWindows()) return;
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    private static void RestrictFile(string path)
    {
        if (OperatingSystem.IsWindows()) return;
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}

public sealed class DatabaseSettingsService(
    ActiveDatabaseConfiguration active,
    ILogger<DatabaseSettingsService> logger)
{
    private static readonly DatabaseProviderOption[] ProviderOptions =
    [
        new(
            DatabaseProviderIds.PostgreSql,
            "PostgreSQL",
            true,
            true,
            "Production provider. Imports use Npgsql binary COPY and PostgreSQL full-text search."),
        new(
            DatabaseProviderIds.SqlServer,
            "Microsoft SQL Server",
            false,
            true,
            "Connection testing is available. Activation remains locked until the SQL Server schema, queries, search, and SqlBulkCopy importer pass parity tests.")
    ];

    private readonly DatabaseSettingsStore _store = new(active.DataDirectory);

    public DatabaseSettingsView View()
    {
        var saved = active.EnvironmentManaged ? null : _store.TryLoad();
        var configuredProvider = saved?.Provider ?? active.Provider;
        var configuredConnection = saved?.ConnectionString ?? active.ConnectionString;
        return new(
            active.Provider,
            MaskConnectionString(active.Provider, active.ConnectionString),
            configuredProvider,
            MaskConnectionString(configuredProvider, configuredConnection),
            !string.IsNullOrWhiteSpace(configuredConnection),
            configuredProvider != active.Provider || configuredConnection != active.ConnectionString,
            active.EnvironmentManaged,
            active.Source,
            _store.SettingsPath,
            ProviderOptions);
    }

    public async Task<DatabaseConnectionTestResult> TestAsync(
        DatabaseSettingsRequest request,
        CancellationToken cancellationToken)
    {
        var provider = DatabaseProviderIds.Normalize(request.Provider);
        if (string.IsNullOrWhiteSpace(request.ConnectionString))
            throw new InvalidOperationException("Connection string is required");
        var stopwatch = Stopwatch.StartNew();
        string version;
        if (provider == DatabaseProviderIds.PostgreSql)
        {
            var builder = new NpgsqlConnectionStringBuilder(request.ConnectionString.Trim())
            {
                Timeout = 10,
                CommandTimeout = 10,
                ApplicationName = "archive-mail-connection-test"
            };
            await using var connection = new NpgsqlConnection(builder.ConnectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = new NpgsqlCommand("SELECT version()", connection);
            version = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)) ?? "PostgreSQL";
        }
        else
        {
            var builder = new SqlConnectionStringBuilder(request.ConnectionString.Trim())
            {
                ConnectTimeout = 10,
                ApplicationName = "archive-mail-connection-test"
            };
            await using var connection = new SqlConnection(builder.ConnectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = new SqlCommand("SELECT @@VERSION", connection);
            version = Convert.ToString(await command.ExecuteScalarAsync(cancellationToken)) ?? "Microsoft SQL Server";
        }
        stopwatch.Stop();
        logger.LogInformation("Database connection test succeeded for {Provider} in {LatencyMs} ms", provider, stopwatch.ElapsedMilliseconds);
        return new(true, provider, stopwatch.ElapsedMilliseconds, FirstLine(version), "Connection succeeded");
    }

    public async Task<DatabaseSettingsView> SaveAsync(
        DatabaseSettingsRequest request,
        CancellationToken cancellationToken)
    {
        if (active.EnvironmentManaged)
            throw new InvalidOperationException("Database settings are managed by environment variables on this server");
        var provider = DatabaseProviderIds.Normalize(request.Provider);
        var option = ProviderOptions.Single(item => item.Id == provider);
        if (!option.Available)
            throw new DatabaseProviderNotReadyException(option.Description);
        await TestAsync(request, cancellationToken);
        _store.Save(provider, request.ConnectionString);
        return View();
    }

    public static string MaskConnectionString(string provider, string connectionString)
    {
        if (string.IsNullOrWhiteSpace(connectionString)) return "Not configured";
        try
        {
            if (DatabaseProviderIds.Normalize(provider) == DatabaseProviderIds.PostgreSql)
            {
                var builder = new NpgsqlConnectionStringBuilder(connectionString);
                if (!string.IsNullOrEmpty(builder.Password)) builder.Password = "********";
                return builder.ConnectionString;
            }
            var sqlBuilder = new SqlConnectionStringBuilder(connectionString);
            if (!string.IsNullOrEmpty(sqlBuilder.Password)) sqlBuilder.Password = "********";
            return sqlBuilder.ConnectionString;
        }
        catch (ArgumentException)
        {
            return "Configured (details hidden because the connection string could not be parsed)";
        }
    }

    private static string FirstLine(string value) =>
        value.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? value;
}

public sealed class DatabaseProviderNotReadyException(string message) : Exception(message);
