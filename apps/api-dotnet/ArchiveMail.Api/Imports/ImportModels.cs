using System.Text.Json;

namespace ArchiveMail.Api.Imports;

public sealed record ImportJobDto(
    string Id,
    string? ArchiveId,
    string SourceName,
    string SourceType,
    string Status,
    string Phase,
    long ProcessedItems,
    long? TotalItems,
    long ProcessedBytes,
    long TotalBytes,
    long ErrorCount,
    bool OcrEnabled,
    bool CanResume,
    string? Message,
    string CreatedAt,
    string UpdatedAt);

public sealed record ImportRuntimeDto(
    int ActiveJobs,
    int QueuedJobs,
    int Concurrency,
    int BatchSize,
    int ThrottleMs,
    int LatencyThresholdMs,
    bool ThrottledForApiLatency,
    int ParserConcurrency,
    string WorkerId);

public sealed record ImportJobRecord(
    ImportJobDto Public,
    string SourcePath,
    bool TemporarySource,
    JsonDocument Checkpoint,
    string? StagingPath,
    string? WorkerId,
    int Attempt);

public sealed record ImportCheckpoint(
    int Version,
    string Stage,
    string? LastFile,
    long CommittedItems,
    long DiscoveredItems,
    string? SourceFingerprint)
{
    public static ImportCheckpoint Empty => new(2, "queued", null, 0, 0, null);
}

public sealed record ParsedMessage(
    string Id,
    string ArchiveId,
    string FolderPath,
    string SourceKey,
    string? InternetMessageId,
    string? ConversationKey,
    string Subject,
    string? SenderName,
    string SenderAddress,
    string ToJson,
    string CcJson,
    string BccJson,
    string RecipientsText,
    string? SentAt,
    string? ReceivedAt,
    string BodyText,
    string? BodyHtml,
    string HeadersJson,
    bool HasAttachments,
    int AttachmentCount,
    long SizeBytes,
    string InboxCategory,
    string CreatedAt,
    string SourceFile);

public sealed record UploadSessionDto(
    string Id,
    string Filename,
    long SizeBytes,
    long ReceivedBytes,
    string Status,
    bool OcrEnabled,
    string? JobId,
    string? Message,
    string CreatedAt,
    string UpdatedAt);

public sealed record UploadSessionRecord(
    UploadSessionDto Public,
    string ClientKey,
    string TempPath,
    string? OwnerUserId);

public sealed class ImportOptions
{
    public bool Enabled { get; set; } = false;
    public string DataDirectory { get; set; } = "/data";
    public int BatchSize { get; set; } = 1000;
    public int ParserConcurrency { get; set; } = 4;
    public int ReadPstJobs { get; set; } = 4;
    public int LeaseSeconds { get; set; } = 120;
    public string ReadPstPath { get; set; } = "readpst";
}
