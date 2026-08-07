using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using MimeKit;
using ArchiveMail.Api.Mail;

namespace ArchiveMail.Api.Imports;

public static class EmlParser
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static async Task<ParsedMessage> ParseAsync(
        string archiveId,
        string stagingPath,
        string filePath,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(
            filePath, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 128 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
        var message = await MimeMessage.LoadAsync(stream, cancellationToken);
        var relativePath = Path.GetRelativePath(stagingPath, filePath).Replace(Path.DirectorySeparatorChar, '/');
        var folderPath = Path.GetDirectoryName(relativePath)?.Replace(Path.DirectorySeparatorChar, '/') ?? "Mailbox";
        if (string.IsNullOrWhiteSpace(folderPath) || folderPath == ".") folderPath = "Mailbox";
        var sender = message.From.Mailboxes.FirstOrDefault();
        var to = Addresses(message.To);
        var cc = Addresses(message.Cc);
        var bcc = Addresses(message.Bcc);
        var receivedAt = message.Date != DateTimeOffset.MinValue ? message.Date.UtcDateTime.ToString("O") : null;
        var headers = message.Headers
            .GroupBy(header => header.Field.ToLowerInvariant(), StringComparer.OrdinalIgnoreCase)
            .ToDictionary(
                group => group.Key,
                group => string.Join("\n", group.Select(header => header.Value)),
                StringComparer.OrdinalIgnoreCase);
        var internetMessageId = string.IsNullOrWhiteSpace(message.MessageId) ? null : message.MessageId.Trim();
        var conversationKey = ConversationKey(
            archiveId,
            internetMessageId,
            message.References,
            message.InReplyTo);
        var stableInput = $"{relativePath}\n{internetMessageId ?? string.Empty}";
        var stableHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stableInput))).ToLowerInvariant();
        var recipients = to.Concat(cc).Concat(bcc).Select(address => address.Address);
        var attachmentCount = message.Attachments.Count();
        var createdAt = DateTimeOffset.UtcNow.ToString("O");
        var inboxCategory = MessageCategorizer.Classify(
            sender?.Address?.Trim() ?? string.Empty,
            string.IsNullOrWhiteSpace(message.Subject) ? "(No subject)" : message.Subject.Trim(),
            message.TextBody?.Trim() ?? string.Empty,
            headers);

        return new ParsedMessage(
            Guid.NewGuid().ToString(),
            archiveId,
            folderPath,
            $"eml:{stableHash}",
            internetMessageId,
            conversationKey,
            string.IsNullOrWhiteSpace(message.Subject) ? "(No subject)" : message.Subject.Trim(),
            string.IsNullOrWhiteSpace(sender?.Name) ? null : sender.Name.Trim(),
            sender?.Address?.Trim() ?? string.Empty,
            JsonSerializer.Serialize(to, JsonOptions),
            JsonSerializer.Serialize(cc, JsonOptions),
            JsonSerializer.Serialize(bcc, JsonOptions),
            string.Join(' ', recipients),
            receivedAt,
            receivedAt,
            message.TextBody?.Trim() ?? string.Empty,
            EmailHtmlSanitizer.Sanitize(message.HtmlBody),
            JsonSerializer.Serialize(headers, JsonOptions),
            attachmentCount > 0,
            attachmentCount,
            new FileInfo(filePath).Length,
            inboxCategory,
            createdAt,
            relativePath);
    }

    /// <summary>
    /// Uses the oldest RFC 5322 reference as the stable root of a conversation.  A root message
    /// falls back to its own Message-Id.  The archive namespace prevents two imported accounts
    /// that happen to contain the same public Message-Id from sharing follow-up or reply state.
    /// Messages without any usable id deliberately keep a null key and use their local id as the
    /// legacy fallback in repository queries.
    /// </summary>
    internal static string? ConversationKey(
        string archiveId,
        string? internetMessageId,
        IEnumerable<string> references,
        string? inReplyTo)
    {
        var root = references.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))
            ?? (string.IsNullOrWhiteSpace(inReplyTo) ? null : inReplyTo)
            ?? (string.IsNullOrWhiteSpace(internetMessageId) ? null : internetMessageId);
        if (root is null) return null;
        var normalized = root.Trim().Trim('<', '>').Trim();
        return normalized.Length == 0 ? null : $"archive:{archiveId}:rfc822:{normalized}";
    }

    private static IReadOnlyList<EmailAddressDto> Addresses(InternetAddressList list) =>
        list.Mailboxes.Select(address => new EmailAddressDto(
            string.IsNullOrWhiteSpace(address.Name) ? null : address.Name.Trim(),
            address.Address?.Trim() ?? string.Empty)).ToArray();

    private sealed record EmailAddressDto(string? Name, string Address);
}
