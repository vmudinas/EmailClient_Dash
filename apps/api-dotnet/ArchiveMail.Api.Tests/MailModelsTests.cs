using System.Text.Json;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MailModelsTests
{
    [Fact]
    public void SerializesMailTrackingCountUsingTheWebContractName()
    {
        var json = JsonSerializer.Serialize(
            new InboxCategoryCountsDto(1, 8, 2, 3, 4, 5, 6, 7, 9),
            new JsonSerializerOptions(JsonSerializerDefaults.Web));

        Assert.Contains("\"mail_tracking\":7", json, StringComparison.Ordinal);
        Assert.Contains("\"jobs\":8", json, StringComparison.Ordinal);
        Assert.Contains("\"focus\":9", json, StringComparison.Ordinal);
        Assert.DoesNotContain("mailTracking", json, StringComparison.Ordinal);
    }

    [Fact]
    public void UnifiedInboxScopeMatchesEveryInboxFolderWithoutChoosingOneAccount()
    {
        Assert.Contains("inbox_folder.id = m.folder_id", MailRepository.InboxOnlyCondition, StringComparison.Ordinal);
        Assert.Contains("lower(trim(inbox_folder.name)) = 'inbox'", MailRepository.InboxOnlyCondition, StringComparison.Ordinal);
    }

    [Fact]
    public void SummaryIndicatorsUseLegacyConversationFallbacksAndPersistedAiState()
    {
        Assert.Contains(
            "COALESCE(NULLIF(m.conversation_key, ''), m.id)",
            MailRepository.SummaryColumns,
            StringComparison.Ordinal);
        Assert.Contains("ai_message_analysis", MailRepository.SummaryColumns, StringComparison.Ordinal);
        Assert.Contains("thread_message.conversation_key = m.conversation_key", MailRepository.SummaryColumns, StringComparison.Ordinal);
        Assert.DoesNotContain("false AS has_ai_analysis", MailRepository.SummaryColumns, StringComparison.Ordinal);
    }

    [Fact]
    public void FollowUpLookupRecognizesRemindersCreatedBeforeThreadBackfill()
    {
        Assert.Contains("fu.message_id=@message", FollowUpRepository.ExistingPendingSql, StringComparison.Ordinal);
        Assert.Contains("source.conversation_key=@conversation", FollowUpRepository.ExistingPendingSql, StringComparison.Ordinal);
        Assert.Contains("FOR UPDATE OF fu", FollowUpRepository.ExistingPendingSql, StringComparison.Ordinal);
    }
}
