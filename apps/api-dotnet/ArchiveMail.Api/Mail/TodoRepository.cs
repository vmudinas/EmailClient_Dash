using Npgsql;

namespace ArchiveMail.Api.Mail;

public sealed record TodoDto(string Id, string Date, string Text, bool Completed, long Position, string CreatedAt, string UpdatedAt);
public sealed record TodoCreateRequest(string Date, string Text);
public sealed record TodoPatchRequest(string? Text, bool? Completed, long? Position);

public sealed class TodoRepository(NpgsqlDataSource database)
{
    public async Task<IReadOnlyList<TodoDto>> ListAsync(string start, string end, string owner, CancellationToken token)
    {
        ValidateDate(start); ValidateDate(end);
        const string sql = "SELECT id,todo_date,text,completed<>0,position,created_at,updated_at FROM todos WHERE owner_user_id=@owner AND todo_date BETWEEN @start AND @end ORDER BY todo_date,position,created_at";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("owner", owner); command.Parameters.AddWithValue("start", start); command.Parameters.AddWithValue("end", end);
        await using var reader = await command.ExecuteReaderAsync(token);
        var results = new List<TodoDto>(); while (await reader.ReadAsync(token)) results.Add(Read(reader)); return results;
    }

    public async Task<TodoDto> CreateAsync(TodoCreateRequest request, string owner, CancellationToken token)
    {
        ValidateDate(request.Date); var text = ValidateText(request.Text); var id = Guid.NewGuid().ToString(); var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO todos(id,owner_user_id,todo_date,text,completed,position,created_at,updated_at)
            VALUES(@id,@owner,@date,@text,0,(SELECT COALESCE(MAX(position),-1)+1 FROM todos WHERE owner_user_id=@owner AND todo_date=@date),@now,@now)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id); command.Parameters.AddWithValue("owner", owner); command.Parameters.AddWithValue("date", request.Date);
        command.Parameters.AddWithValue("text", text); command.Parameters.AddWithValue("now", now); await command.ExecuteNonQueryAsync(token);
        return (await GetAsync(id, owner, token))!;
    }

    public async Task<TodoDto> UpdateAsync(string id, TodoPatchRequest request, string owner, CancellationToken token)
    {
        if (request.Text is null && request.Completed is null && request.Position is null) throw new ArgumentException("Invalid to-do update");
        if (request.Position is < 0) throw new ArgumentException("Position cannot be negative");
        const string sql = """
            UPDATE todos SET text=COALESCE(@text,text),completed=COALESCE(@completed,completed),position=COALESCE(@position,position),updated_at=@now
            WHERE id=@id AND owner_user_id=@owner
            """;
        await using var command = database.CreateCommand(sql);
        AddNullable(command, "text", request.Text is null ? null : ValidateText(request.Text), NpgsqlTypes.NpgsqlDbType.Text);
        AddNullable(command, "completed", request.Completed is null ? null : request.Completed.Value ? 1L : 0L, NpgsqlTypes.NpgsqlDbType.Bigint);
        AddNullable(command, "position", request.Position, NpgsqlTypes.NpgsqlDbType.Bigint);
        command.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O")); command.Parameters.AddWithValue("id", id); command.Parameters.AddWithValue("owner", owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("To-do item not found"); return (await GetAsync(id, owner, token))!;
    }

    public async Task DeleteAsync(string id, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand("DELETE FROM todos WHERE id=@id AND owner_user_id=@owner"); command.Parameters.AddWithValue("id", id); command.Parameters.AddWithValue("owner", owner);
        if (await command.ExecuteNonQueryAsync(token) == 0) throw new MailNotFoundException("To-do item not found");
    }
    private async Task<TodoDto?> GetAsync(string id, string owner, CancellationToken token)
    {
        await using var command = database.CreateCommand("SELECT id,todo_date,text,completed<>0,position,created_at,updated_at FROM todos WHERE id=@id AND owner_user_id=@owner");
        command.Parameters.AddWithValue("id", id); command.Parameters.AddWithValue("owner", owner); await using var reader = await command.ExecuteReaderAsync(token); return await reader.ReadAsync(token) ? Read(reader) : null;
    }
    private static TodoDto Read(NpgsqlDataReader r) => new(r.GetString(0), r.GetString(1), r.GetString(2), r.GetBoolean(3), r.GetInt64(4), r.GetString(5), r.GetString(6));
    private static void ValidateDate(string value) { if (!DateOnly.TryParseExact(value, "yyyy-MM-dd", out _)) throw new ArgumentException("date must be YYYY-MM-DD"); }
    private static string ValidateText(string value) { var text = value.Trim(); if (text.Length is < 1 or > 2000) throw new ArgumentException("Enter a valid to-do item"); return text; }
    private static void AddNullable(NpgsqlCommand command, string name, object? value, NpgsqlTypes.NpgsqlDbType type) => command.Parameters.Add(new NpgsqlParameter { ParameterName = name, NpgsqlDbType = type, Value = value ?? DBNull.Value });
}
