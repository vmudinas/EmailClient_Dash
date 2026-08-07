using System.Text.RegularExpressions;

namespace ArchiveMail.Api.Mail;

public static partial class MessageCategorizer
{
    private static readonly string[] SocialDomains =
        ["facebookmail.com", "instagram.com", "linkedin.com", "meetup.com", "nextdoor.com", "pinterest.com", "redditmail.com", "tiktok.com", "twitter.com"];
    private static readonly string[] TrackingDomains = ["dhl.com", "fedex.com", "ups.com", "usps.com"];
    private static readonly string[] AmazonDomains = ["amazon.com", "amazon.co.uk", "amazon.ca"];
    private static readonly string[] JobDomains =
        ["indeed.com", "glassdoor.com", "ziprecruiter.com", "monster.com", "greenhouse.io", "lever.co", "myworkdayjobs.com", "workday.com", "icims.com", "smartrecruiters.com"];

    public static string Classify(string senderAddress, string subject, string bodyText, IReadOnlyDictionary<string, string> headers)
    {
        var sender = senderAddress.Trim().ToLowerInvariant();
        var domain = sender.Split('@').LastOrDefault() ?? "";
        var senderName = sender.Split('@').FirstOrDefault() ?? "";
        var body = bodyText[..Math.Min(2_000, bodyText.Length)];
        var categoryText = $"{sender} {subject} {body}";
        // A reply is a conversation even when Gmail or a mailing-list header says otherwise.
        // Protect it before any content keyword can file a person's response as a bill, update,
        // social notification, or promotion.
        if (Header(headers, "in-reply-to") is not null || Header(headers, "references") is not null
            || ReplySubject().IsMatch(subject)) return "primary";
        if (JobDomains.Any(value => DomainMatches(domain, value)) || Job().IsMatch(categoryText)
            || (DomainMatches(domain, "linkedin.com") && LinkedInJob().IsMatch(categoryText))) return "jobs";
        if (Medical().IsMatch(categoryText)) return "medical";
        if (Bills().IsMatch(categoryText)) return "bills";
        if (TrackingDomains.Any(value => DomainMatches(domain, value))
            || (AmazonDomains.Any(value => DomainMatches(domain, value)) && AmazonTracking().IsMatch($"{subject} {body}"))
            || Tracking().IsMatch($"{subject} {body}")) return "mail_tracking";

        var labels = Header(headers, "x-archive-mail-gmail-label-ids")?.Split(',', StringSplitOptions.TrimEntries);
        if (labels?.Contains("CATEGORY_PROMOTIONS") == true) return "promotions";
        if (labels?.Contains("CATEGORY_SOCIAL") == true) return "social";
        if (labels?.Any(label => label is "CATEGORY_UPDATES" or "CATEGORY_FORUMS") == true) return "updates";
        if (SocialDomains.Any(value => DomainMatches(domain, value)) || Social().IsMatch(subject)) return "social";
        var precedence = Header(headers, "precedence")?.ToLowerInvariant();
        if (Header(headers, "list-unsubscribe") is not null || Header(headers, "list-id") is not null
            || precedence is "bulk" or "list" || PromotionSender().IsMatch(senderName)
            || Promotion().IsMatch($"{subject} {body}")) return "promotions";
        if (Header(headers, "auto-submitted") is not null || AutomatedSender().IsMatch(senderName) || Updates().IsMatch(subject))
            return "updates";
        return "primary";
    }

    public static string ClassifyWithTabs(
        string senderAddress,
        string subject,
        string bodyText,
        IReadOnlyDictionary<string, string> headers,
        IReadOnlyList<InboxTabDefinitionDto> tabs)
    {
        var enabled = tabs.Where(tab => tab.Enabled).OrderBy(tab => tab.Position).ToArray();
        var sender = senderAddress.Trim().ToLowerInvariant();
        var domain = sender.Split('@').LastOrDefault() ?? "";
        var searchable = $"{sender} {subject} {bodyText[..Math.Min(2_000, bodyText.Length)]}".ToLowerInvariant();
        if (Header(headers, "in-reply-to") is not null || Header(headers, "references") is not null
            || ReplySubject().IsMatch(subject))
            return enabled.FirstOrDefault(tab => tab.Id == "primary")?.Id ?? enabled.FirstOrDefault()?.Id ?? "primary";
        foreach (var tab in enabled)
        {
            if (tab.Id == "primary") continue;
            var domainMatch = tab.SenderDomains.Any(value => DomainMatches(domain, value));
            var keywordMatch = tab.Keywords.Any(keyword => KeywordMatches(searchable, keyword));
            if (domainMatch || keywordMatch) return tab.Id;
        }
        var classified = Classify(senderAddress, subject, bodyText, headers);
        return enabled.Any(tab => tab.Id == classified && !tab.KeywordOnly)
            ? classified
            : enabled.FirstOrDefault(tab => tab.Id == "primary")?.Id ?? enabled.FirstOrDefault()?.Id ?? "primary";
    }

    private static string? Header(IReadOnlyDictionary<string, string> headers, string name) =>
        headers.FirstOrDefault(entry => string.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase)).Value;
    private static bool DomainMatches(string actual, string expected) => actual == expected || actual.EndsWith($".{expected}", StringComparison.Ordinal);
    private static bool KeywordMatches(string value, string keyword)
    {
        var normalized = keyword.Trim().ToLowerInvariant();
        if (normalized.Length == 0) return false;
        var prefix = char.IsLetterOrDigit(normalized[0]) ? "(?:^|[^a-z0-9])" : "";
        var suffix = char.IsLetterOrDigit(normalized[^1]) ? "(?=$|[^a-z0-9])" : "";
        return Regex.IsMatch(value, $"{prefix}{Regex.Escape(normalized)}{suffix}", RegexOptions.IgnoreCase);
    }

    [GeneratedRegex(@"\b(clinic|dental|dentist|doctor|health(?:care)?|hospital|lab results?|medical|mychart|patient portal|pharmacy|prescription|telehealth|vaccin(?:e|ation))\b", RegexOptions.IgnoreCase)] private static partial Regex Medical();
    [GeneratedRegex(@"^\s*(?:re|fwd?):\s*", RegexOptions.IgnoreCase)] private static partial Regex ReplySubject();
    [GeneratedRegex(@"\b(application (?:received|status|update)|candidate|career opportunity|hiring manager|interview|job alert|jobs? (?:for you|matching)|recruiter|talent acquisition|thank you for applying|your (?:application|candidacy|resume|résumé))\b", RegexOptions.IgnoreCase)] private static partial Regex Job();
    [GeneratedRegex(@"\b(apply|career|hiring|job|position|recruiter)\b", RegexOptions.IgnoreCase)] private static partial Regex LinkedInJob();
    [GeneratedRegex(@"\b(amount due|auto-?pay|balance due|bill(?:ing)?|credit card statement|invoice|mortgage|payment due|rent due|statement (?:is )?ready|tax notice|utility bill)\b", RegexOptions.IgnoreCase)] private static partial Regex Bills();
    [GeneratedRegex(@"\b(arriv(?:al|es|ing)|delivered|in transit|out for delivery|package|parcel|shipment|shipped|tracking(?: number| update)?)\b", RegexOptions.IgnoreCase)] private static partial Regex Tracking();
    [GeneratedRegex(@"\b(arriv(?:es|ing)|delivery|order|package|shipment|shipped)\b", RegexOptions.IgnoreCase)] private static partial Regex AmazonTracking();
    [GeneratedRegex(@"\b(commented|connection request|friend request|invited you|liked your|mentioned you|new connection|new follower|new post|shared a post|tagged you)\b", RegexOptions.IgnoreCase)] private static partial Regex Social();
    [GeneratedRegex(@"\b(coupon|deal|discount|exclusive offer|flash sale|free shipping|limited time|newsletter|promo(?:tion)?|save \d+%|sale|special offer|unsubscribe)\b", RegexOptions.IgnoreCase)] private static partial Regex Promotion();
    [GeneratedRegex(@"(?:deal|marketing|newsletter|offer|promo|sales)", RegexOptions.IgnoreCase)] private static partial Regex PromotionSender();
    [GeneratedRegex(@"(?:alert|automated|notification|notify|no-?reply)", RegexOptions.IgnoreCase)] private static partial Regex AutomatedSender();
    [GeneratedRegex(@"\b(account alert|appointment|confirmation|delivery|digest|invoice|order|password|payment|receipt|reservation|security|shipment|shipping|statement|status update|tracking|verification|verify)\b", RegexOptions.IgnoreCase)] private static partial Regex Updates();
}
