using System.Text.Json.Serialization;

namespace ArchiveMail.Api.Mail;

public sealed record ArchiveDto(
    string Id,
    string Name,
    string SourceType,
    string Status,
    long SizeBytes,
    long MessageCount,
    long UnreadCount,
    long StarredCount,
    long StarredUnreadCount,
    long FolderCount,
    long AttachmentCount,
    long ErrorCount,
    string? ImportedAt,
    string CreatedAt);

public sealed record FolderDto(
    string Id,
    string ArchiveId,
    string? ParentId,
    string Name,
    string Path,
    long MessageCount,
    long UnreadCount);

public sealed record EmailAddressDto(string? Name, string Address);
public sealed record LocalMessageStateDto(bool IsRead, bool IsStarred, string[] Tags, string Note, string? UpdatedAt);
public sealed record ShipmentSummaryDto(
    string Carrier,
    string Merchant,
    string? TrackingNumber,
    string? OrderNumber,
    string Status,
    string? EstimatedDeliveryDate,
    string? TrackingUrl);

public sealed record MessageSummaryDto(
    string Id,
    string ArchiveId,
    string FolderId,
    string FolderPath,
    string Subject,
    EmailAddressDto Sender,
    IReadOnlyList<EmailAddressDto> Recipients,
    string? SentAt,
    string? ReceivedAt,
    string Preview,
    bool HasAttachments,
    long AttachmentCount,
    string InboxCategory,
    bool HasAiAnalysis,
    bool HasCalendarEvent,
    bool HasPendingFollowUp,
    bool HasReply,
    LocalMessageStateDto State,
    ShipmentSummaryDto? Shipment = null);

public sealed record AttachmentDto(
    string Id,
    string MessageId,
    string Filename,
    string ContentType,
    long SizeBytes,
    string? ContentId,
    string Disposition,
    string TextStatus);

public sealed record MessageDetailDto(
    string Id,
    string ArchiveId,
    string FolderId,
    string FolderPath,
    string Subject,
    EmailAddressDto Sender,
    IReadOnlyList<EmailAddressDto> Recipients,
    string? SentAt,
    string? ReceivedAt,
    string Preview,
    bool HasAttachments,
    long AttachmentCount,
    string InboxCategory,
    bool HasAiAnalysis,
    bool HasCalendarEvent,
    bool HasPendingFollowUp,
    bool HasReply,
    LocalMessageStateDto State,
    IReadOnlyList<EmailAddressDto> To,
    IReadOnlyList<EmailAddressDto> Cc,
    IReadOnlyList<EmailAddressDto> Bcc,
    string BodyText,
    string? BodyHtml,
    IReadOnlyDictionary<string, string> Headers,
    IReadOnlyList<AttachmentDto> Attachments,
    ShipmentSummaryDto? Shipment = null);

public sealed record MessageThreadDto(string MessageId, long TotalMessages, IReadOnlyList<MessageSummaryDto> Messages);
public sealed record CursorPageDto<T>(IReadOnlyList<T> Items, string? NextCursor);
public sealed record SearchHitDto(
    MessageSummaryDto Message,
    double Score,
    string MatchedIn,
    string? MatchedAttachmentId,
    string? MatchedAttachmentName,
    string Snippet);

public sealed record InboxCategoryCountsDto(
    long Primary,
    long Promotions,
    long Social,
    long Updates,
    long Bills,
    long Medical,
    [property: JsonPropertyName("mail_tracking")]
    long MailTracking);

public sealed record MessageFilters(
    string? ArchiveId,
    string? FolderId,
    bool? IsRead,
    bool? Starred,
    string? InboxCategory,
    string? From,
    string? To,
    string? After,
    string? Before,
    bool? HasAttachment,
    string? Cursor,
    int? Limit);

public sealed record MessageStatePatch(bool? IsRead, bool? IsStarred, string[]? Tags, string? Note);
public sealed record NamePatch(string Name);
public sealed record CreateFolderRequest(string Name, string? ParentId);
public sealed record CombineArchiveRequest(string TargetArchiveId);
public sealed record CombineFolderRequest(string TargetFolderId);
public sealed record MoveFolderRequest(string? TargetParentId);
public sealed record MoveMessageRequest(string FolderId);
public sealed record BulkReadRequest(string[] MessageIds);
public sealed record BulkMoveFolderRequest(string[] MessageIds, string FolderId);
public sealed record BulkReadResult(long Updated, long AlreadyRead, long Failed);
public sealed record BulkFolderMoveResult(string FolderId, string FolderPath, long Moved, long AlreadyThere, long Failed, string[] ProcessedMessageIds);
// Combines report through the import job they create, so there is no merge result to return.
public sealed record MailboxMoveResult(FolderDto Mailbox, long MovedMailboxes);
public sealed record BulkMoveRequest(string[] MessageIds, string Destination);
public sealed record BulkMoveResult(string Destination, string[] FolderPaths, long Moved, long AlreadyThere, long Failed, long SenderRules, string[] ProcessedMessageIds);
public sealed record SenderFolderRuleResult(string SenderAddress, string FolderId, string FolderPath, long MovedMessages, MessageDetailDto Message);
public sealed record SenderSpamRuleResult(string SenderAddress, string SpamFolderId, string SpamFolderPath, long MovedMessages, MessageDetailDto Message);
public sealed record AttachmentContentDto(string Filename, string ContentType, long SizeBytes, string RelativePath);

public sealed class MailNotFoundException(string message) : Exception(message);
public sealed class MailConflictException(string message) : Exception(message);
