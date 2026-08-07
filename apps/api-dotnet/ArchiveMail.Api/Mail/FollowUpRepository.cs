using Npgsql;

namespace ArchiveMail.Api.Mail;

public sealed record MessageFollowUpDto(
    string Id, string MessageId, string Subject, EmailAddressDto Sender, string DueAt, string Note,
    string Status, string? CompletedAt, string CreatedAt, string UpdatedAt);
public sealed record MessageFollowUpCreateRequest(string DueAt, string Note = "");
public sealed record MessageFollowUpPatchRequest(string? DueAt, string? Note, string? Status);

public sealed class FollowUpRepository(NpgsqlDataSource database)
{
    internal const string ExistingPendingSql = """
        SELECT fu.id
        FROM message_follow_ups fu JOIN messages source ON source.id=fu.message_id
        WHERE fu.status='pending' AND (
          fu.conversation_key=@conversation OR fu.message_id=@message OR
          (source.conversation_key IS NOT NULL AND source.conversation_key=@conversation))
        ORDER BY CASE WHEN fu.conversation_key=@conversation THEN 0 ELSE 1 END,fu.updated_at DESC
        LIMIT 1 FOR UPDATE OF fu
        """;

    public async Task<MessageFollowUpDto> CreateAsync(string messageId, MessageFollowUpCreateRequest request,
        string ownerUserId, CancellationToken cancellationToken)
    {
        var dueAt = ValidateDueAt(request.DueAt);
        var note = ValidateNote(request.Note);
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string messageSql = """
            SELECT COALESCE(NULLIF(m.conversation_key,''),m.id) FROM messages m JOIN archives a ON a.id=m.archive_id
            WHERE m.id=@message AND a.owner_user_id=@owner
            """;
        await using var message = new NpgsqlCommand(messageSql, connection, transaction);
        message.Parameters.AddWithValue("message", messageId);
        message.Parameters.AddWithValue("owner", ownerUserId);
        var conversation = Convert.ToString(await message.ExecuteScalarAsync(cancellationToken));
        if (string.IsNullOrEmpty(conversation)) throw new MailNotFoundException("Message not found");
        // A Gmail full reconciliation can add a provider thread key to a message that was already
        // imported. Follow-ups created before that backfill used the message id as their key. Match
        // both representations so reconciliation never makes an existing reminder disappear or
        // permits a duplicate reminder for the same conversation.
        await using var existing = new NpgsqlCommand(ExistingPendingSql, connection, transaction);
        existing.Parameters.AddWithValue("conversation", conversation);
        existing.Parameters.AddWithValue("message", messageId);
        var id = Convert.ToString(await existing.ExecuteScalarAsync(cancellationToken));
        var now = DateTimeOffset.UtcNow.ToString("O");
        if (string.IsNullOrEmpty(id))
        {
            id = Guid.NewGuid().ToString();
            const string insertSql = """
                INSERT INTO message_follow_ups(id,message_id,conversation_key,due_at,note,status,created_at,updated_at)
                VALUES(@id,@message,@conversation,@due,@note,'pending',@now,@now)
                """;
            await using var insert = new NpgsqlCommand(insertSql, connection, transaction);
            insert.Parameters.AddWithValue("id", id);
            insert.Parameters.AddWithValue("message", messageId);
            insert.Parameters.AddWithValue("conversation", conversation);
            insert.Parameters.AddWithValue("due", dueAt);
            insert.Parameters.AddWithValue("note", note);
            insert.Parameters.AddWithValue("now", now);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }
        else
        {
            await using var update = new NpgsqlCommand(
                "UPDATE message_follow_ups SET message_id=@message,conversation_key=@conversation,due_at=@due,note=@note,updated_at=@now WHERE id=@id", connection, transaction);
            update.Parameters.AddWithValue("message", messageId);
            update.Parameters.AddWithValue("conversation", conversation);
            update.Parameters.AddWithValue("due", dueAt);
            update.Parameters.AddWithValue("note", note);
            update.Parameters.AddWithValue("now", now);
            update.Parameters.AddWithValue("id", id);
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
        return (await GetAsync(id, ownerUserId, cancellationToken))!;
    }

    public async Task<IReadOnlyList<MessageFollowUpDto>> ListAsync(string? status, string ownerUserId, CancellationToken cancellationToken)
    {
        if (status is not null) status = ValidateStatus(status);
        var sql = $"""
            {SelectSql}
            WHERE a.owner_user_id=@owner {(status is null ? "" : "AND fu.status=@status")}
            ORDER BY CASE fu.status WHEN 'pending' THEN 0 ELSE 1 END,fu.due_at,fu.created_at
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (status is not null) command.Parameters.AddWithValue("status", status);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var results = new List<MessageFollowUpDto>();
        while (await reader.ReadAsync(cancellationToken)) results.Add(Read(reader));
        return results;
    }

    public async Task<MessageFollowUpDto> UpdateAsync(string id, MessageFollowUpPatchRequest request,
        string ownerUserId, CancellationToken cancellationToken)
    {
        if (request.DueAt is null && request.Note is null && request.Status is null)
            throw new ArgumentException("At least one follow-up field is required");
        var due = request.DueAt is null ? null : ValidateDueAt(request.DueAt);
        var note = request.Note is null ? null : ValidateNote(request.Note);
        var status = request.Status is null ? null : ValidateStatus(request.Status);
        const string sql = """
            UPDATE message_follow_ups fu SET due_at=COALESCE(@due,fu.due_at), note=COALESCE(@note,fu.note),
              status=COALESCE(@status,fu.status),
              completed_at=CASE WHEN @status='completed' THEN @now WHEN @status IS NOT NULL THEN NULL ELSE fu.completed_at END,
              updated_at=@now
            FROM messages m JOIN archives a ON a.id=m.archive_id
            WHERE fu.id=@id AND m.id=fu.message_id AND a.owner_user_id=@owner
            """;
        await using var command = database.CreateCommand(sql);
        AddNullable(command, "due", due);
        AddNullable(command, "note", note);
        AddNullable(command, "status", status);
        command.Parameters.AddWithValue("now", DateTimeOffset.UtcNow.ToString("O"));
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) throw new MailNotFoundException("Follow-up not found");
        return (await GetAsync(id, ownerUserId, cancellationToken))!;
    }

    public async Task DeleteAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        const string sql = """
            DELETE FROM message_follow_ups fu USING messages m,archives a
            WHERE fu.id=@id AND m.id=fu.message_id AND a.id=m.archive_id AND a.owner_user_id=@owner
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        if (await command.ExecuteNonQueryAsync(cancellationToken) == 0) throw new MailNotFoundException("Follow-up not found");
    }

    private async Task<MessageFollowUpDto?> GetAsync(string id, string ownerUserId, CancellationToken cancellationToken)
    {
        var sql = $"{SelectSql} WHERE fu.id=@id AND a.owner_user_id=@owner";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue("id", id);
        command.Parameters.AddWithValue("owner", ownerUserId);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? Read(reader) : null;
    }

    private static MessageFollowUpDto Read(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2),
        new(reader.IsDBNull(3) ? null : reader.GetString(3), reader.GetString(4)), reader.GetString(5),
        reader.GetString(6), reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8),
        reader.GetString(9), reader.GetString(10));

    private static string ValidateDueAt(string value) => DateTimeOffset.TryParse(value, out var parsed)
        ? parsed.ToString("O") : throw new ArgumentException("Enter a valid follow-up date");
    private static string ValidateNote(string value) => value.Trim().Length <= 2_000
        ? value.Trim() : throw new ArgumentException("Follow-up note is too long");
    private static string ValidateStatus(string value) => value.Trim().ToLowerInvariant() switch
    {
        "pending" => "pending",
        "completed" => "completed",
        "dismissed" => "dismissed",
        _ => throw new ArgumentException("Choose a valid follow-up status")
    };
    private static void AddNullable(NpgsqlCommand command, string name, string? value) => command.Parameters.Add(new NpgsqlParameter
    {
        ParameterName = name,
        NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
        Value = (object?)value ?? DBNull.Value
    });

    private const string SelectSql = """
        SELECT fu.id,fu.message_id,m.subject,m.sender_name,m.sender_address,fu.due_at,fu.note,fu.status,
          fu.completed_at,fu.created_at,fu.updated_at
        FROM message_follow_ups fu JOIN messages m ON m.id=fu.message_id JOIN archives a ON a.id=m.archive_id
        """;
}
