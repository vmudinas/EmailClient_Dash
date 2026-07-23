using System.Text;
using System.Text.RegularExpressions;
using Npgsql;

namespace ArchiveMail.Api.Infrastructure;

internal sealed class DatabaseSchemaContract
{
    private static readonly Regex CreateTablePattern = new(
        @"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(?<table>[a-z_][a-z0-9_]*)\s*\(",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex ColumnPattern = new(
        @"^(?<column>[a-z_][a-z0-9_]*)\s+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex DefaultPattern = new(
        @"\bDEFAULT\s+(?<value>'(?:''|[^'])*'|[-+]?\d+(?:\.\d+)?|TRUE|FALSE|NULL|CURRENT_TIMESTAMP(?:\(\))?)(?=\s|$)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex UniqueIndexPattern = new(
        @"CREATE\s+UNIQUE\s+INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+(?<index>[a-z_][a-z0-9_]*)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private readonly IReadOnlyList<ExpectedColumn> columns;
    private readonly IReadOnlySet<string> tables;
    private readonly IReadOnlySet<string> uniqueIndexes;

    private DatabaseSchemaContract(
        IReadOnlyList<ExpectedColumn> columns,
        IReadOnlySet<string> tables,
        IReadOnlySet<string> uniqueIndexes)
    {
        this.columns = columns;
        this.tables = tables;
        this.uniqueIndexes = uniqueIndexes;
        DefaultRepairSql = BuildDefaultRepairSql(columns);
    }

    internal string DefaultRepairSql { get; }
    internal IReadOnlyList<ExpectedColumn> Columns => columns;
    internal IReadOnlySet<string> Tables => tables;
    internal IReadOnlySet<string> UniqueIndexes => uniqueIndexes;

    internal static DatabaseSchemaContract FromSql(params string[] scripts)
    {
        var columns = new Dictionary<(string Table, string Column), ExpectedColumn>();
        var tables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var uniqueIndexes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var sql in scripts)
        {
            foreach (Match match in UniqueIndexPattern.Matches(sql))
                uniqueIndexes.Add(match.Groups["index"].Value);

            foreach (Match match in CreateTablePattern.Matches(sql))
            {
                var table = match.Groups["table"].Value;
                tables.Add(table);
                var openingParenthesis = match.Index + match.Length - 1;
                var closingParenthesis = FindClosingParenthesis(sql, openingParenthesis);
                if (closingParenthesis < 0)
                    throw new InvalidOperationException($"Could not parse CREATE TABLE statement for {table}.");

                var body = sql[(openingParenthesis + 1)..closingParenthesis];
                foreach (var definition in SplitTopLevel(body))
                {
                    var trimmed = definition.Trim();
                    var columnMatch = ColumnPattern.Match(trimmed);
                    if (!columnMatch.Success) continue;

                    var column = columnMatch.Groups["column"].Value;
                    if (IsTableConstraint(column)) continue;
                    var defaultMatch = DefaultPattern.Match(trimmed);
                    columns[(table, column)] = new ExpectedColumn(
                        table,
                        column,
                        trimmed.Contains("NOT NULL", StringComparison.OrdinalIgnoreCase),
                        defaultMatch.Success ? defaultMatch.Groups["value"].Value : null);
                }
            }
        }

        return new DatabaseSchemaContract(
            columns.Values.OrderBy(value => value.Table).ThenBy(value => value.Column).ToArray(),
            tables,
            uniqueIndexes);
    }

    internal async Task ValidateAsync(
        NpgsqlConnection connection,
        string schema,
        CancellationToken cancellationToken)
    {
        var actualColumns = new Dictionary<(string Table, string Column), ActualColumn>();
        const string columnSql = """
            SELECT table_name, column_name, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = @schema;
            """;
        await using (var command = new NpgsqlCommand(columnSql, connection))
        {
            command.Parameters.AddWithValue("schema", schema);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                actualColumns[(reader.GetString(0), reader.GetString(1))] = new ActualColumn(
                    reader.GetString(2).Equals("YES", StringComparison.OrdinalIgnoreCase),
                    reader.IsDBNull(3) ? null : reader.GetString(3));
            }
        }

        var actualTables = actualColumns.Keys
            .Select(value => value.Table)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        var actualIndexes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        const string indexSql = "SELECT indexname FROM pg_indexes WHERE schemaname = @schema;";
        await using (var command = new NpgsqlCommand(indexSql, connection))
        {
            command.Parameters.AddWithValue("schema", schema);
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken)) actualIndexes.Add(reader.GetString(0));
        }

        var problems = new List<string>();
        problems.AddRange(tables.Except(actualTables, StringComparer.OrdinalIgnoreCase)
            .Select(table => $"missing table {table}"));
        foreach (var expected in columns)
        {
            if (!actualColumns.TryGetValue((expected.Table, expected.Column), out var actual))
            {
                problems.Add($"missing column {expected.Table}.{expected.Column}");
                continue;
            }

            if (expected.NotNull && actual.Nullable)
                problems.Add($"nullable column {expected.Table}.{expected.Column} must be NOT NULL");
            if (expected.DefaultSql is not null && actual.DefaultSql is null)
                problems.Add($"missing default on {expected.Table}.{expected.Column}");
        }
        problems.AddRange(uniqueIndexes
            .Where(index => !IndexExistsOrHasEquivalent(index, actualIndexes))
            .Select(index => $"missing unique index {index}"));

        if (problems.Count > 0)
            throw new InvalidOperationException(
                "PostgreSQL schema contract validation failed: " + string.Join("; ", problems));
    }

    private static string BuildDefaultRepairSql(IEnumerable<ExpectedColumn> expectedColumns)
    {
        var sql = new StringBuilder();
        foreach (var column in expectedColumns.Where(value => value.DefaultSql is not null))
        {
            sql.Append("ALTER TABLE ")
                .Append(QuoteIdentifier(column.Table))
                .Append(" ALTER COLUMN ")
                .Append(QuoteIdentifier(column.Column))
                .Append(" SET DEFAULT ")
                .Append(column.DefaultSql)
                .AppendLine(";");
        }
        return sql.ToString();
    }

    private static string QuoteIdentifier(string value) => $"\"{value.Replace("\"", "\"\"")}\"";

    private static bool IndexExistsOrHasEquivalent(string index, IReadOnlySet<string> actualIndexes)
    {
        if (actualIndexes.Contains(index)) return true;
        if (!index.Equals(
                "deferred_attachment_jobs_message_conflict_idx",
                StringComparison.OrdinalIgnoreCase))
            return false;
        return actualIndexes.Contains("deferred_attachment_jobs_message_id_key")
            || actualIndexes.Contains("deferred_attachment_jobs_message_id_unique");
    }

    private static bool IsTableConstraint(string value) =>
        value.Equals("PRIMARY", StringComparison.OrdinalIgnoreCase)
        || value.Equals("UNIQUE", StringComparison.OrdinalIgnoreCase)
        || value.Equals("CHECK", StringComparison.OrdinalIgnoreCase)
        || value.Equals("FOREIGN", StringComparison.OrdinalIgnoreCase)
        || value.Equals("CONSTRAINT", StringComparison.OrdinalIgnoreCase);

    private static int FindClosingParenthesis(string sql, int openingParenthesis)
    {
        var depth = 0;
        var inQuote = false;
        for (var index = openingParenthesis; index < sql.Length; index++)
        {
            var current = sql[index];
            if (current == '\'')
            {
                if (inQuote && index + 1 < sql.Length && sql[index + 1] == '\'') index++;
                else inQuote = !inQuote;
            }
            else if (!inQuote && current == '(')
                depth++;
            else if (!inQuote && current == ')' && --depth == 0)
                return index;
        }
        return -1;
    }

    private static IEnumerable<string> SplitTopLevel(string value)
    {
        var start = 0;
        var depth = 0;
        var inQuote = false;
        for (var index = 0; index < value.Length; index++)
        {
            var current = value[index];
            if (current == '\'')
            {
                if (inQuote && index + 1 < value.Length && value[index + 1] == '\'') index++;
                else inQuote = !inQuote;
            }
            else if (!inQuote && current == '(')
                depth++;
            else if (!inQuote && current == ')')
                depth--;
            else if (!inQuote && depth == 0 && current == ',')
            {
                yield return value[start..index];
                start = index + 1;
            }
        }
        yield return value[start..];
    }

    internal sealed record ExpectedColumn(string Table, string Column, bool NotNull, string? DefaultSql);
    private sealed record ActualColumn(bool Nullable, string? DefaultSql);
}
