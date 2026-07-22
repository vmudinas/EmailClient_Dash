namespace ArchiveMail.Api.Security;

public sealed record LoginRequest(string Username, string Pin, string? PairingToken = null);
public sealed record PinChangeRequest(string CurrentPin, string NewPin);
public sealed record UserCreateRequest(string Username, string DisplayName, string Role, string Pin, string[]? AllowedScreens);
public sealed record UserUpdateRequest(string? DisplayName, string? Role, bool? IsActive, string? Pin, string[]? AllowedScreens);

public sealed record UserDto(
    string Id,
    string Username,
    string DisplayName,
    string Role,
    bool IsActive,
    bool MustChangePin,
    string[]? AllowedScreens,
    string? LastLoginAt,
    string CreatedAt,
    string UpdatedAt);

public sealed record SessionDto(string Id, UserDto User, string Role, string ExpiresAt);
public sealed record LoginResult(string AccessToken, SessionDto Session);

public sealed record SessionRecord(
    string Id,
    UserDto User,
    string Role,
    string IpAddress,
    string ExpiresAt);
