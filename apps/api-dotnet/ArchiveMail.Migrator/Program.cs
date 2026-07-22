using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Npgsql;
using NpgsqlTypes;

SQLitePCL.raw.SetProvider(new SQLitePCL.SQLite3Provider_sqlite3());

var sqlitePath = Argument("--sqlite") ?? "/data/archive-mail.sqlite";
var reset = args.Contains("--reset", StringComparer.Ordinal);
if (reset && !args.Contains("--confirm-reset", StringComparer.Ordinal))
    throw new InvalidOperationException("--reset requires --confirm-reset because it replaces the target PostgreSQL schema");
if (!File.Exists(sqlitePath)) throw new FileNotFoundException("Legacy SQLite database was not found", sqlitePath);
var schema = Environment.GetEnvironmentVariable("POSTGRES_SCHEMA")?.Trim() is { Length: > 0 } configuredSchema
    ? configuredSchema : "archive_mail";
if (!Regex.IsMatch(schema, "^[A-Za-z_][A-Za-z0-9_]*$")) throw new ArgumentException("POSTGRES_SCHEMA is invalid");
var connectionString = Environment.GetEnvironmentVariable("DATABASE_URL")?.Trim();
if (string.IsNullOrWhiteSpace(connectionString))
{
    var builder = new NpgsqlConnectionStringBuilder
    {
        Host = Environment.GetEnvironmentVariable("PGHOST") ?? "postgres",
        Port = int.TryParse(Environment.GetEnvironmentVariable("PGPORT"), out var port) ? port : 5432,
        Database = Environment.GetEnvironmentVariable("PGDATABASE") ?? "archive_mail",
        Username = Environment.GetEnvironmentVariable("PGUSER") ?? "archive_mail",
        Password = Environment.GetEnvironmentVariable("PGPASSWORD") ?? throw new InvalidOperationException("PGPASSWORD is required"),
        ApplicationName = "archive-mail-sqlite-cutover",
        CommandTimeout = 0
    };
    connectionString = builder.ConnectionString;
}

await using var sqlite = new SqliteConnection(new SqliteConnectionStringBuilder
{
    DataSource = Path.GetFullPath(sqlitePath),
    Mode = SqliteOpenMode.ReadOnly,
    Cache = SqliteCacheMode.Private
}.ConnectionString);
await sqlite.OpenAsync();
await using var postgres = new NpgsqlConnection(connectionString);
await postgres.OpenAsync();
var qSchema = Quote(schema);
if (reset)
{
    await ExecuteAsync(postgres, $"DROP SCHEMA IF EXISTS {qSchema} CASCADE; CREATE SCHEMA {qSchema};");
}
else await ExecuteAsync(postgres, $"CREATE SCHEMA IF NOT EXISTS {qSchema};");
await ExecuteAsync(postgres, $"SET search_path TO {qSchema}, public;");

var tables = await TablesAsync(sqlite);
Console.WriteLine($"Migrating {tables.Count} SQLite tables into PostgreSQL schema {schema}...");
var definitions = new Dictionary<string, IReadOnlyList<Column>>(StringComparer.Ordinal);
foreach (var table in tables)
{
    var columns = await ColumnsAsync(sqlite, table);
    definitions[table] = columns;
    var parts = columns.Select(column => $"{Quote(column.Name)} {PostgresType(column.Type)}" +
        (column.NotNull ? " NOT NULL" : "") + DefaultClause(column.DefaultValue)).ToList();
    var primary = columns.Where(column => column.PrimaryKeyPosition > 0).OrderBy(column => column.PrimaryKeyPosition).ToArray();
    if (primary.Length > 0) parts.Add($"PRIMARY KEY ({string.Join(',', primary.Select(column => Quote(column.Name)))})");
    await ExecuteAsync(postgres, $"CREATE TABLE {Qualified(schema, table)} ({string.Join(',', parts)})");
}

foreach (var table in tables)
{
    var columns = definitions[table];
    var count = await CopyAsync(sqlite, postgres, schema, table, columns);
    Console.WriteLine($"  {table}: {count:N0} rows");
}

foreach (var table in tables) await CreateIndexesAsync(sqlite, postgres, schema, table);
foreach (var table in tables) await CreateForeignKeysAsync(sqlite, postgres, schema, table, tables);

foreach (var table in tables)
{
    var sqliteCount = await CountSqliteAsync(sqlite, table);
    await using var command = new NpgsqlCommand($"SELECT COUNT(*) FROM {Qualified(schema, table)}", postgres);
    var postgresCount = Convert.ToInt64(await command.ExecuteScalarAsync());
    if (sqliteCount != postgresCount) throw new InvalidOperationException($"Row-count validation failed for {table}: SQLite={sqliteCount}, PostgreSQL={postgresCount}");
}
if (tables.Contains("import_jobs", StringComparer.Ordinal) &&
    definitions["import_jobs"].Select(column => column.Name).Contains("status", StringComparer.Ordinal) &&
    definitions["import_jobs"].Select(column => column.Name).Contains("checkpoint_version", StringComparer.Ordinal))
{
    await ExecuteAsync(postgres, $"""
        UPDATE {Qualified(schema, "import_jobs")}
        SET status='failed', can_resume=0, worker_id=NULL, lease_until=NULL,
            message='Legacy Node import stopped during PostgreSQL cutover. Clear it and restart with the C# importer.',
            updated_at='{DateTimeOffset.UtcNow:O}'
        WHERE status IN ('queued','running','cancelled') AND processed_items>0 AND checkpoint_version<>2
        """);
}
Console.WriteLine("SQLite to PostgreSQL migration completed and every table row count matched.");

string? Argument(string name)
{
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

static async Task<IReadOnlyList<string>> TablesAsync(SqliteConnection connection)
{
    const string sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
    await using var command = connection.CreateCommand(); command.CommandText = sql;
    await using var reader = await command.ExecuteReaderAsync(); var result = new List<string>();
    while (await reader.ReadAsync())
    {
        var name = reader.GetString(0);
        if (name == "message_fts" || name.StartsWith("message_fts_", StringComparison.Ordinal)) continue;
        result.Add(name);
    }
    return result;
}

static async Task<IReadOnlyList<Column>> ColumnsAsync(SqliteConnection connection, string table)
{
    await using var command = connection.CreateCommand(); command.CommandText = $"PRAGMA table_info({Quote(table)})";
    await using var reader = await command.ExecuteReaderAsync(); var result = new List<Column>();
    while (await reader.ReadAsync()) result.Add(new(
        reader.GetString(1), reader.IsDBNull(2) ? "TEXT" : reader.GetString(2), reader.GetInt64(3) != 0,
        reader.IsDBNull(4) ? null : reader.GetString(4), Convert.ToInt32(reader.GetInt64(5))));
    return result;
}

static async Task<long> CopyAsync(SqliteConnection sqlite, NpgsqlConnection postgres, string schema, string table, IReadOnlyList<Column> columns)
{
    if (columns.Count == 0) return 0;
    await using var select = sqlite.CreateCommand(); select.CommandText = $"SELECT {string.Join(',', columns.Select(column => Quote(column.Name)))} FROM {Quote(table)}";
    await using var reader = await select.ExecuteReaderAsync();
    var copySql = $"COPY {Qualified(schema, table)} ({string.Join(',', columns.Select(column => Quote(column.Name)))}) FROM STDIN (FORMAT BINARY)";
    await using var writer = await postgres.BeginBinaryImportAsync(copySql); long count = 0;
    while (await reader.ReadAsync())
    {
        await writer.StartRowAsync();
        for (var index = 0; index < columns.Count; index++)
        {
            if (await reader.IsDBNullAsync(index)) { await writer.WriteNullAsync(); continue; }
            var type = PostgresType(columns[index].Type);
            if (type == "BYTEA") await writer.WriteAsync((byte[])reader.GetValue(index), NpgsqlDbType.Bytea);
            else if (type == "BIGINT") await writer.WriteAsync(Convert.ToInt64(reader.GetValue(index)), NpgsqlDbType.Bigint);
            else if (type == "DOUBLE PRECISION") await writer.WriteAsync(Convert.ToDouble(reader.GetValue(index)), NpgsqlDbType.Double);
            else await writer.WriteAsync(Convert.ToString(reader.GetValue(index)) ?? "", NpgsqlDbType.Text);
        }
        count++;
    }
    await writer.CompleteAsync(); return count;
}

static async Task CreateIndexesAsync(SqliteConnection sqlite, NpgsqlConnection postgres, string schema, string table)
{
    await using var list = sqlite.CreateCommand(); list.CommandText = $"PRAGMA index_list({Quote(table)})";
    await using var reader = await list.ExecuteReaderAsync(); var indexes = new List<(string Name, bool Unique, bool Partial, string Origin)>();
    while (await reader.ReadAsync()) indexes.Add((reader.GetString(1), reader.GetInt64(2) != 0, reader.GetInt64(4) != 0, reader.GetString(3)));
    foreach (var index in indexes)
    {
        await using var info = sqlite.CreateCommand(); info.CommandText = $"PRAGMA index_info({Quote(index.Name)})";
        await using var infoReader = await info.ExecuteReaderAsync(); var columns = new List<string>();
        while (await infoReader.ReadAsync()) if (infoReader.GetInt64(1) >= 0 && !infoReader.IsDBNull(2)) columns.Add(infoReader.GetString(2));
        if (columns.Count == 0) continue;
        var name = index.Name.StartsWith("sqlite_autoindex_", StringComparison.Ordinal)
            ? $"{table}_{string.Join('_', columns)}_unique"[..Math.Min(60, $"{table}_{string.Join('_', columns)}_unique".Length)] : index.Name;
        string? where = null;
        if (index.Partial)
        {
            await using var source = sqlite.CreateCommand(); source.CommandText = "SELECT sql FROM sqlite_master WHERE type='index' AND name=$name"; source.Parameters.AddWithValue("name", index.Name);
            var raw = Convert.ToString(await source.ExecuteScalarAsync()); var whereAt = raw?.IndexOf(" WHERE ", StringComparison.OrdinalIgnoreCase) ?? -1;
            if (whereAt >= 0) where = raw![whereAt..].Replace("COLLATE NOCASE", "", StringComparison.OrdinalIgnoreCase);
        }
        var unique = index.Unique ? "UNIQUE " : "";
        await ExecuteAsync(postgres, $"CREATE {unique}INDEX IF NOT EXISTS {Quote(name)} ON {Qualified(schema, table)} ({string.Join(',', columns.Select(Quote))}){where}");
    }
}

static async Task CreateForeignKeysAsync(SqliteConnection sqlite, NpgsqlConnection postgres, string schema, string table, IReadOnlyList<string> tables)
{
    await using var command = sqlite.CreateCommand(); command.CommandText = $"PRAGMA foreign_key_list({Quote(table)})";
    await using var reader = await command.ExecuteReaderAsync(); var rows = new List<ForeignKey>();
    while (await reader.ReadAsync()) rows.Add(new(Convert.ToInt32(reader.GetInt64(0)),Convert.ToInt32(reader.GetInt64(1)),reader.GetString(2),reader.GetString(3),reader.GetString(4),reader.GetString(5),reader.GetString(6)));
    foreach (var group in rows.GroupBy(row => row.Id))
    {
        var first = group.First(); if (!tables.Contains(first.Target, StringComparer.Ordinal)) continue;
        var ordered = group.OrderBy(row => row.Sequence).ToArray(); var name = $"fk_{table}_{first.Target}_{group.Key}";
        var sql = $"ALTER TABLE {Qualified(schema, table)} ADD CONSTRAINT {Quote(name)} FOREIGN KEY ({string.Join(',', ordered.Select(row => Quote(row.From)))}) REFERENCES {Qualified(schema, first.Target)} ({string.Join(',', ordered.Select(row => Quote(row.To)))}) ON DELETE {Action(first.OnDelete)} ON UPDATE {Action(first.OnUpdate)} NOT VALID";
        await ExecuteAsync(postgres, sql);
    }
}

static async Task<long> CountSqliteAsync(SqliteConnection connection, string table)
{ await using var command = connection.CreateCommand(); command.CommandText = $"SELECT COUNT(*) FROM {Quote(table)}"; return Convert.ToInt64(await command.ExecuteScalarAsync()); }
static async Task ExecuteAsync(NpgsqlConnection connection, string sql)
{ await using var command = new NpgsqlCommand(sql, connection); await command.ExecuteNonQueryAsync(); }
static string PostgresType(string type)
{ var value = type.ToUpperInvariant(); return value.Contains("BLOB") ? "BYTEA" : value.Contains("INT") ? "BIGINT" : value.Contains("REAL") || value.Contains("FLOA") || value.Contains("DOUB") ? "DOUBLE PRECISION" : "TEXT"; }
static string DefaultClause(string? value)
{
    if (string.IsNullOrWhiteSpace(value)) return ""; var normalized = value.Trim();
    if (Regex.IsMatch(normalized, "^(NULL|TRUE|FALSE|CURRENT_(DATE|TIME|TIMESTAMP)|[-+]?\\d+(\\.\\d+)?|'([^']|'')*')$", RegexOptions.IgnoreCase)) return $" DEFAULT {normalized}";
    if (normalized.StartsWith('"') && normalized.EndsWith('"')) return $" DEFAULT '{normalized[1..^1].Replace("\"\"", "\"").Replace("'", "''")}'";
    return "";
}
static string Action(string value) => value.ToUpperInvariant() is "CASCADE" or "RESTRICT" or "SET NULL" or "SET DEFAULT" ? value.ToUpperInvariant() : "NO ACTION";
static string Quote(string value) => $"\"{value.Replace("\"", "\"\"")}\"";
static string Qualified(string schema, string table) => $"{Quote(schema)}.{Quote(table)}";
sealed record Column(string Name,string Type,bool NotNull,string? DefaultValue,int PrimaryKeyPosition);
sealed record ForeignKey(int Id,int Sequence,string Target,string From,string To,string OnUpdate,string OnDelete);
