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
            null,
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

    private static IReadOnlyList<EmailAddressDto> Addresses(InternetAddressList list) =>
        list.Mailboxes.Select(address => new EmailAddressDto(
            string.IsNullOrWhiteSpace(address.Name) ? null : address.Name.Trim(),
            address.Address?.Trim() ?? string.Empty)).ToArray();

    private sealed record EmailAddressDto(string? Name, string Address);
}
