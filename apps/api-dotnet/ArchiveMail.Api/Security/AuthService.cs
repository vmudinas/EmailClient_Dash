using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Npgsql;
using Org.BouncyCastle.Crypto.Generators;

namespace ArchiveMail.Api.Security;

public sealed class AuthService(NpgsqlDataSource database)
{
    public const string SessionItemKey = "archive-mail-session";
    private const int FailureLimit = 5;
    private static readonly TimeSpan BlockDuration = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan SessionDuration = TimeSpan.FromHours(12);
    private readonly ConcurrentDictionary<string, FailureState> _failures = new();

    public async Task<LoginResult> LoginAsync(
        LoginRequest request,
        string ipAddress,
        string? userAgent,
        CancellationToken cancellationToken)
    {
        var failure = _failures.GetOrAdd(ipAddress, _ => new FailureState());
        lock (failure)
        {
            if (failure.BlockedUntil > DateTimeOffset.UtcNow)
                throw new AuthException("Too many failed attempts. Try again shortly.", rateLimited: true);
        }

        const string userSql = """
            SELECT id, username, display_name, role, pin_hash, pin_salt,
                   is_active <> 0, must_change_pin <> 0, allowed_screens,
                   last_login_at, created_at, updated_at
            FROM users WHERE lower(username) = lower($1) LIMIT 1
            """;
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(userSql, connection);
        command.Parameters.AddWithValue(request.Username.Trim());
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        UserAuthRecord? user = null;
        if (await reader.ReadAsync(cancellationToken)) user = ReadUserAuth(reader);
        await reader.CloseAsync();

        if (user is null || !user.Public.IsActive || !VerifySecret(request.Pin, user.PinHash, user.PinSalt))
        {
            lock (failure)
            {
                failure.Count++;
                if (failure.Count >= FailureLimit)
                {
                    failure.BlockedUntil = DateTimeOffset.UtcNow.Add(BlockDuration);
                    failure.Count = 0;
                }
            }
            throw new AuthException("Invalid username or PIN");
        }
        _failures.TryRemove(ipAddress, out _);

        var accessToken = Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var sessionId = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow;
        var effectiveRole = user.Public.Role;
        var expiresAt = now.Add(SessionDuration).ToString("O");
        const string sessionSql = """
            WITH created_session AS (
              INSERT INTO auth_sessions (
                id, user_id, effective_role, token_hash, ip_address, user_agent,
                expires_at, created_at, last_seen_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
              RETURNING user_id
            )
            UPDATE users SET last_login_at = $8, updated_at = $8
            WHERE id = (SELECT user_id FROM created_session)
            """;
        await using var session = new NpgsqlCommand(sessionSql, connection);
        session.Parameters.AddWithValue(sessionId);
        session.Parameters.AddWithValue(user.Public.Id);
        session.Parameters.AddWithValue(effectiveRole);
        session.Parameters.AddWithValue(TokenHash(accessToken));
        session.Parameters.AddWithValue(ipAddress);
        session.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)userAgent ?? DBNull.Value
        });
        session.Parameters.AddWithValue(expiresAt);
        session.Parameters.AddWithValue(now.ToString("O"));
        await session.ExecuteNonQueryAsync(cancellationToken);

        var sessionDto = new SessionDto(sessionId, user.Public with
        {
            LastLoginAt = now.ToString("O"),
            UpdatedAt = now.ToString("O")
        }, effectiveRole, expiresAt);
        return new LoginResult(accessToken, sessionDto);
    }

    public async Task<SessionRecord?> AuthenticateAsync(HttpContext context, CancellationToken cancellationToken)
    {
        var authorization = context.Request.Headers.Authorization.ToString();
        var token = authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? authorization[7..].Trim()
            : context.Request.Cookies["archive_mail_session"];
        if (string.IsNullOrWhiteSpace(token)) return null;
        var ipAddress = ClientIp(context);

        const string sql = """
            SELECT s.id, s.effective_role, s.ip_address, s.expires_at,
                   u.id, u.username, u.display_name, u.role,
                   u.is_active <> 0, u.must_change_pin <> 0, u.allowed_screens,
                   u.last_login_at, u.created_at, u.updated_at
            FROM auth_sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = $1 AND s.revoked_at IS NULL
              AND s.expires_at > $2 AND u.is_active <> 0
            LIMIT 1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(TokenHash(token));
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var session = new SessionRecord(
            reader.GetString(0),
            new UserDto(
                reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.GetString(7),
                reader.GetBoolean(8), reader.GetBoolean(9), ParseScreens(reader.IsDBNull(10) ? null : reader.GetString(10)),
                reader.IsDBNull(11) ? null : reader.GetString(11), reader.GetString(12), reader.GetString(13)),
            reader.GetString(1), reader.GetString(2), reader.GetString(3));
        if (!string.Equals(session.IpAddress, ipAddress, StringComparison.Ordinal)) return null;
        return session;
    }

    public async Task LogoutAsync(string sessionId, CancellationToken cancellationToken)
    {
        const string sql = "UPDATE auth_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL";
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(sessionId);
        command.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task ChangePinAsync(SessionRecord session, string currentPin, string newPin, CancellationToken cancellationToken)
    {
        ValidatePin(currentPin);
        ValidatePin(newPin);
        if (currentPin == newPin) throw new ArgumentException("Choose a different PIN");
        const string selectSql = "SELECT pin_hash, pin_salt FROM users WHERE id=$1";
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var select = new NpgsqlCommand(selectSql, connection);
        select.Parameters.AddWithValue(session.User.Id);
        await using var reader = await select.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken) || !VerifySecret(currentPin, reader.GetString(0), reader.GetString(1)))
            throw new AuthException("Current PIN is incorrect");
        await reader.CloseAsync();
        var (hash, salt) = HashSecret(newPin);
        const string sql = """
            WITH changed_user AS (
              UPDATE users SET pin_hash=$2, pin_salt=$3, must_change_pin=0, updated_at=$4
              WHERE id=$1 RETURNING id
            )
            UPDATE auth_sessions SET revoked_at=$4
            WHERE user_id=(SELECT id FROM changed_user) AND revoked_at IS NULL
            """;
        await using var update = new NpgsqlCommand(sql, connection);
        update.Parameters.AddWithValue(session.User.Id);
        update.Parameters.AddWithValue(hash);
        update.Parameters.AddWithValue(salt);
        update.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await update.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<IReadOnlyList<UserDto>> ListUsersAsync(CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id, username, display_name, role, is_active<>0, must_change_pin<>0,
              allowed_screens, last_login_at, created_at, updated_at
            FROM users ORDER BY lower(username)
            """;
        await using var command = database.CreateCommand(sql);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var users = new List<UserDto>();
        while (await reader.ReadAsync(cancellationToken)) users.Add(ReadPublicUser(reader));
        return users;
    }

    public async Task<UserDto> CreateUserAsync(UserCreateRequest request, CancellationToken cancellationToken)
    {
        var username = NormalizeUsername(request.Username);
        var displayName = NormalizeDisplayName(request.DisplayName);
        var role = NormalizeRole(request.Role);
        ValidatePin(request.Pin);
        var screens = NormalizeScreens(role, request.AllowedScreens);
        var (hash, salt) = HashSecret(request.Pin);
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO users(id,username,display_name,role,pin_hash,pin_salt,is_active,must_change_pin,
              allowed_screens,created_at,updated_at)
            VALUES($1,$2,$3,$4,$5,$6,1,0,$7,$8,$8)
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        command.Parameters.AddWithValue(username);
        command.Parameters.AddWithValue(displayName);
        command.Parameters.AddWithValue(role);
        command.Parameters.AddWithValue(hash);
        command.Parameters.AddWithValue(salt);
        command.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = screens is null ? DBNull.Value : JsonSerializer.Serialize(screens)
        });
        command.Parameters.AddWithValue(now);
        try { await command.ExecuteNonQueryAsync(cancellationToken); }
        catch (PostgresException exception) when (exception.SqlState == PostgresErrorCodes.UniqueViolation)
        { throw new AuthConflictException("That username already exists"); }
        return (await GetUserAsync(id, cancellationToken))!;
    }

    public async Task<UserDto> UpdateUserAsync(string id, UserUpdateRequest request, CancellationToken cancellationToken)
    {
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        const string currentSql = "SELECT role,is_active<>0,allowed_screens FROM users WHERE id=$1 FOR UPDATE";
        await using var current = new NpgsqlCommand(currentSql, connection, transaction);
        current.Parameters.AddWithValue(id);
        await using var reader = await current.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) throw new AuthException("User not found");
        var currentRole = reader.GetString(0);
        var currentActive = reader.GetBoolean(1);
        var currentScreens = ParseScreens(reader.IsDBNull(2) ? null : reader.GetString(2));
        await reader.CloseAsync();
        var targetRole = request.Role is null ? currentRole : NormalizeRole(request.Role);
        var targetActive = request.IsActive ?? currentActive;
        if (currentRole == "admin" && currentActive && (targetRole != "admin" || !targetActive))
        {
            await using var count = new NpgsqlCommand("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active<>0", connection, transaction);
            if (Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken)) <= 1)
                throw new AuthConflictException("At least one active administrator is required");
        }
        var displayName = request.DisplayName is null ? null : NormalizeDisplayName(request.DisplayName);
        string? hash = null;
        string? salt = null;
        if (request.Pin is not null)
        {
            ValidatePin(request.Pin);
            (hash, salt) = HashSecret(request.Pin);
        }
        var screens = NormalizeScreens(targetRole, request.AllowedScreens ?? currentScreens);
        const string sql = """
            WITH changed_user AS (
              UPDATE users SET display_name=COALESCE($2,display_name), role=$3, is_active=$4,
                pin_hash=COALESCE($5,pin_hash), pin_salt=COALESCE($6,pin_salt),
                must_change_pin=CASE WHEN $5::text IS NULL THEN must_change_pin ELSE 0 END,
                allowed_screens=$7, updated_at=$8 WHERE id=$1
              RETURNING id
            )
            UPDATE auth_sessions SET revoked_at=$8
            WHERE user_id=(SELECT id FROM changed_user) AND revoked_at IS NULL
            """;
        await using var update = new NpgsqlCommand(sql, connection, transaction);
        update.Parameters.AddWithValue(id);
        update.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)displayName ?? DBNull.Value
        });
        update.Parameters.AddWithValue(targetRole);
        update.Parameters.AddWithValue(targetActive ? 1 : 0);
        update.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)hash ?? DBNull.Value
        });
        update.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = (object?)salt ?? DBNull.Value
        });
        update.Parameters.Add(new NpgsqlParameter
        {
            NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Text,
            Value = screens is null ? DBNull.Value : JsonSerializer.Serialize(screens)
        });
        update.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));
        await update.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return (await GetUserAsync(id, cancellationToken))!;
    }

    public async Task DeleteUserAsync(string id,string currentUserId,CancellationToken cancellationToken)
    {
        if(id==currentUserId)throw new AuthConflictException("You cannot delete your own account");
        await using var connection=await database.OpenConnectionAsync(cancellationToken);await using var transaction=await connection.BeginTransactionAsync(cancellationToken);
        await using(var user=new NpgsqlCommand("SELECT role,is_active<>0 FROM users WHERE id=$1 FOR UPDATE",connection,transaction)){user.Parameters.AddWithValue(id);await using var reader=await user.ExecuteReaderAsync(cancellationToken);if(!await reader.ReadAsync(cancellationToken))throw new AuthException("User not found");var role=reader.GetString(0);var active=reader.GetBoolean(1);await reader.CloseAsync();if(role=="admin"&&active){await using var count=new NpgsqlCommand("SELECT COUNT(*) FROM users WHERE role='admin' AND is_active<>0",connection,transaction);if(Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken))<=1)throw new AuthConflictException("At least one active administrator is required");}}
        await using(var owned=new NpgsqlCommand("SELECT EXISTS(SELECT 1 FROM managed_properties WHERE owner_user_id=$1)",connection,transaction)){owned.Parameters.AddWithValue(id);if(Convert.ToBoolean(await owned.ExecuteScalarAsync(cancellationToken)))throw new AuthConflictException("Transfer or remove this manager's properties before deleting the account");}
        await using(var unlink=new NpgsqlCommand("UPDATE property_tenants SET linked_user_id=NULL,updated_at=$2 WHERE linked_user_id=$1",connection,transaction)){unlink.Parameters.AddWithValue(id);unlink.Parameters.AddWithValue(DateTimeOffset.UtcNow.ToString("O"));await unlink.ExecuteNonQueryAsync(cancellationToken);}
        foreach(var sql in new[]{"DELETE FROM property_organization_members WHERE user_id=$1","UPDATE property_request_assignments SET assignee_user_id=NULL WHERE assignee_user_id=$1","DELETE FROM users WHERE id=$1"}){await using var remove=new NpgsqlCommand(sql,connection,transaction);remove.Parameters.AddWithValue(id);await remove.ExecuteNonQueryAsync(cancellationToken);}await transaction.CommitAsync(cancellationToken);
    }

    private async Task<UserDto?> GetUserAsync(string id, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT id,username,display_name,role,is_active<>0,must_change_pin<>0,allowed_screens,
              last_login_at,created_at,updated_at FROM users WHERE id=$1
            """;
        await using var command = database.CreateCommand(sql);
        command.Parameters.AddWithValue(id);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        return await reader.ReadAsync(cancellationToken) ? ReadPublicUser(reader) : null;
    }

    public static string ClientIp(HttpContext context) =>
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    private static UserAuthRecord ReadUserAuth(NpgsqlDataReader reader) => new(
        new UserDto(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
            reader.GetBoolean(6), reader.GetBoolean(7), ParseScreens(reader.IsDBNull(8) ? null : reader.GetString(8)),
            reader.IsDBNull(9) ? null : reader.GetString(9), reader.GetString(10), reader.GetString(11)),
        reader.GetString(4), reader.GetString(5));

    private static UserDto ReadPublicUser(NpgsqlDataReader reader) => new(
        reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3),
        reader.GetBoolean(4), reader.GetBoolean(5), ParseScreens(reader.IsDBNull(6) ? null : reader.GetString(6)),
        reader.IsDBNull(7) ? null : reader.GetString(7), reader.GetString(8), reader.GetString(9));

    private static string[]? ParseScreens(string? json)
    {
        if (json is null) return null;
        try { return JsonSerializer.Deserialize<string[]>(json); }
        catch (JsonException) { return null; }
    }

    internal static bool VerifySecret(string secret, string encodedHash, string salt)
    {
        byte[] expected;
        try { expected = Base64UrlDecode(encodedHash); }
        catch (FormatException) { return false; }
        var actual = SCrypt.Generate(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(salt), 16384, 8, 1, expected.Length);
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    internal static (string Hash, string Salt) HashSecret(string secret)
    {
        var salt = Base64UrlEncode(RandomNumberGenerator.GetBytes(16));
        var hash = SCrypt.Generate(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(salt), 16384, 8, 1, 64);
        return (Base64UrlEncode(hash), salt);
    }

    private static readonly HashSet<string> ScreenIds = ["calendar", "properties", "compose", "ai", "import", "settings"];

    private static string NormalizeUsername(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant() ?? "";
        if (normalized.Length is < 3 or > 64 || !System.Text.RegularExpressions.Regex.IsMatch(normalized, "^[a-z0-9][a-z0-9._-]*$"))
            throw new ArgumentException("Use 3 to 64 letters, numbers, periods, underscores, or hyphens");
        return normalized;
    }

    private static string NormalizeDisplayName(string? value)
    {
        var normalized = value?.Trim() ?? "";
        if (normalized.Length is < 1 or > 120) throw new ArgumentException("Enter a valid display name");
        return normalized;
    }

    private static string NormalizeRole(string? value) => value?.Trim().ToLowerInvariant() switch
    {
        "admin" => "admin",
        "user" => "user",
        "renter" => "renter",
        _ => throw new ArgumentException("Choose a valid role")
    };

    private static string[]? NormalizeScreens(string role, string[]? screens)
    {
        if (role == "admin") return null;
        if (role == "renter") return ["properties"];
        if (screens is null) return null;
        var normalized = screens.Distinct(StringComparer.Ordinal).ToArray();
        if (normalized.Length > ScreenIds.Count || normalized.Any(screen => !ScreenIds.Contains(screen)))
            throw new ArgumentException("Choose valid screen permissions");
        return normalized;
    }

    private static void ValidatePin(string? pin)
    {
        if (pin is null || pin.Length is < 4 or > 12 || pin.Any(character => !char.IsAsciiDigit(character)))
            throw new ArgumentException("PIN must contain 4 to 12 digits");
    }

    private static string TokenHash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized += new string('=', (4 - normalized.Length % 4) % 4);
        return Convert.FromBase64String(normalized);
    }

    private sealed record UserAuthRecord(UserDto Public, string PinHash, string PinSalt);
    private sealed class FailureState { public int Count; public DateTimeOffset BlockedUntil; }
}

public sealed class AuthException(string message, bool rateLimited = false) : Exception(message)
{
    public bool RateLimited { get; } = rateLimited;
}

public sealed class AuthConflictException(string message) : Exception(message);
