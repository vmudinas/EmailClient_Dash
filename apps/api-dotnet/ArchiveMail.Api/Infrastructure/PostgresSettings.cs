using Npgsql;

namespace ArchiveMail.Api.Infrastructure;

public static class PostgresSettings
{
    public static string ResolveConnectionString(IConfiguration configuration)
    {
        var configured = configuration["Postgres:ConnectionString"];
        var builder = string.IsNullOrWhiteSpace(configured)
            ? new NpgsqlConnectionStringBuilder()
            : new NpgsqlConnectionStringBuilder(configured);

        builder.Host = Environment.GetEnvironmentVariable("PGHOST") ?? builder.Host;
        builder.Port = ParseInt(Environment.GetEnvironmentVariable("PGPORT"), builder.Port == 0 ? 5432 : builder.Port);
        builder.Database = Environment.GetEnvironmentVariable("PGDATABASE") ?? builder.Database;
        builder.Username = Environment.GetEnvironmentVariable("PGUSER") ?? builder.Username;
        builder.Password = Environment.GetEnvironmentVariable("PGPASSWORD") ?? builder.Password;
        builder.MaxPoolSize = ParseInt(configuration["Postgres:MaxPoolSize"], builder.MaxPoolSize);
        var schema = ResolveSchema(configuration);
        builder.SearchPath = $"{schema},public";
        builder.ApplicationName = "archive-mail-csharp";
        builder.NoResetOnClose = false;
        return builder.ConnectionString;
    }

    public static string ResolveSchema(IConfiguration configuration)
    {
        var schema = Environment.GetEnvironmentVariable("POSTGRES_SCHEMA")
            ?? configuration["Postgres:Schema"]
            ?? "archive_mail";
        if (!System.Text.RegularExpressions.Regex.IsMatch(schema, "^[a-zA-Z_][a-zA-Z0-9_]*$"))
            throw new InvalidOperationException("PostgreSQL schema must be a simple identifier");
        return schema;
    }

    private static int ParseInt(string? value, int fallback) =>
        int.TryParse(value, out var parsed) ? parsed : fallback;
}
