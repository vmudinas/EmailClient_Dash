namespace ArchiveMail.Api.Mail;

public sealed record SenderFilingRuleDto(
    string Id,
    string ArchiveId,
    string MatchField,
    string MatchAddress,
    string SenderAddress,
    string? SenderName,
    string RuleType,
    string SourceScope,
    string? SourceFolderId,
    string? SourceFolderPath,
    string FolderId,
    string FolderPath,
    long MessageCount,
    string CreatedAt,
    string UpdatedAt);

public sealed record SenderFilingStatusDto(
    string ArchiveId,
    string ArchiveName,
    bool Enabled,
    IReadOnlyList<SenderFilingRuleDto> Rules,
    string? LastRunAt,
    long LastRunMovedMessages,
    long LastRunCreatedFolders);

public sealed record SenderFilingRuleCreateRequest(
    string ArchiveId,
    string ArchiveScope,
    string MatchField,
    string MatchAddress,
    string SourceScope,
    string? SourceFolderId,
    string? DestinationFolderId,
    string? DestinationFolderName,
    bool ApplyExisting = true);

public sealed record SenderFilingRuleCreateResultDto(
    IReadOnlyList<SenderFilingStatusDto> Statuses,
    long CreatedRules,
    long CreatedFolders,
    long MovedMessages);

public sealed record ArchiveSelectionRequest(string ArchiveId);
public sealed record FolderSelectionRequest(string FolderId);
