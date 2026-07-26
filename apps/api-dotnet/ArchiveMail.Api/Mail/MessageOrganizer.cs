using System.Text.RegularExpressions;

namespace ArchiveMail.Api.Mail;

/// <summary>
/// Rule-based half of "Organize": four labels per message - who it is from, what kind of mail it is,
/// how much it matters, and whether it is selling something.
///
/// Deterministic first, model second. Sending every message in an archive to an AI provider is the
/// obvious implementation and the wrong one: it is the owner's own API key, an archive runs to
/// hundreds of thousands of messages, and the great majority of them are bulk mail that a
/// List-Unsubscribe header identifies for nothing. Everything decidable from headers, the sender and
/// the subject is decided here for free; only what survives is worth a token.
///
/// Pure and side-effect free so the vocabulary and the confidence rules are testable without a
/// database or a provider.
/// </summary>
public static partial class MessageOrganizer
{
    /// <summary>
    /// Fixed vocabularies. The model is given these and its answers are checked against them, so an
    /// invented label can never reach the database and break the filters built on top of it.
    /// </summary>
    public static readonly string[] Types =
        ["personal", "work", "financial", "travel", "shopping", "health", "legal", "notification", "newsletter", "social", "other"];

    public static readonly string[] Importances = ["critical", "high", "normal", "low"];

    public static readonly string[] Commercials = ["advertising", "promotional", "transactional", "not_commercial"];

    public static readonly string[] Axes = ["person", "type", "importance", "commercial"];

    /// <summary>
    /// Below this, a rule-based guess is treated as a starting point rather than an answer and the
    /// message is handed to the model. Bulk mail identified by its headers scores well above it;
    /// an ordinary message from a person the rules know nothing about does not.
    /// </summary>
    public const double ConfidentEnough = 0.75;

    public sealed record Labels(string Person, string Type, string Importance, string Commercial, double Confidence);

    /// <summary>
    /// Everything the rules can settle on their own. <see cref="Labels.Confidence"/> reports how much
    /// of the answer came from real evidence rather than a default.
    /// </summary>
    public static Labels Classify(
        string senderName,
        string senderAddress,
        string subject,
        string bodyText,
        IReadOnlyDictionary<string, string> headers)
    {
        var address = MessageFingerprint.NormalizeAddress(senderAddress);
        var domain = address.Split('@').LastOrDefault() ?? "";
        var localPart = address.Split('@').FirstOrDefault() ?? "";
        var body = bodyText[..Math.Min(2_000, bodyText.Length)];
        var haystack = $"{subject} {body}";

        var bulk = Header(headers, "list-unsubscribe") is not null
            || Header(headers, "list-id") is not null
            || Header(headers, "precedence")?.ToLowerInvariant() is "bulk" or "list";
        var automated = Header(headers, "auto-submitted") is not null || AutomatedSender().IsMatch(localPart);
        var category = MessageCategorizer.Classify(senderAddress, subject, bodyText, headers);

        var person = Person(senderName, address, localPart, bulk || automated);
        var (type, typeConfidence) = Type(category, domain, localPart, haystack, bulk);
        var (commercial, commercialConfidence) = Commercial(category, haystack, bulk, automated);
        var (importance, importanceConfidence) = Importance(type, commercial, haystack, bulk);

        // The weakest axis sets the score: a message whose type is certain but whose importance is a
        // guess is still worth asking about.
        var confidence = Math.Min(typeConfidence, Math.Min(commercialConfidence, importanceConfidence));
        return new Labels(person, type, importance, commercial, confidence);
    }

    /// <summary>
    /// Who the mail is from, as something a human recognizes. Bulk and automated senders are named
    /// after their organization rather than the mailbox, so "no-reply@acme.com" files under "Acme"
    /// instead of scattering across "no-reply", "noreply" and "donotreply".
    /// </summary>
    internal static string Person(string senderName, string address, string localPart, bool impersonal)
    {
        var name = senderName.Trim().Trim('"').Trim();
        if (impersonal || name.Length == 0)
        {
            var organization = Organization(address);
            if (organization.Length > 0) return organization;
        }
        if (name.Length > 0) return Shorten(name);
        if (localPart.Length > 0) return Shorten(localPart.Replace('.', ' ').Replace('_', ' '));
        return "Unknown";
    }

    /// <summary>The registrable-looking part of a domain, title-cased: mail.acme.co.uk -> Acme.</summary>
    internal static string Organization(string address)
    {
        var domain = address.Split('@').LastOrDefault() ?? "";
        if (domain.Length == 0) return "";
        var parts = domain.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return "";
        // Skip the public suffix, including two-part ones like co.uk, then take what is left of it.
        var index = parts.Length - 2;
        if (parts.Length >= 3 && parts[^2].Length <= 3 && parts[^1].Length <= 3) index = parts.Length - 3;
        var label = parts[Math.Max(0, index)];
        return label.Length == 0 ? "" : char.ToUpperInvariant(label[0]) + label[1..];
    }

    private static string Shorten(string value)
    {
        var collapsed = Whitespace().Replace(value, " ").Trim();
        return collapsed.Length <= 80 ? collapsed : collapsed[..80];
    }

    private static (string Value, double Confidence) Type(
        string category, string domain, string localPart, string haystack, bool bulk)
    {
        // The inbox categoriser has already done this work for the cases it covers; reusing its
        // verdict keeps the two features from disagreeing about the same message.
        switch (category)
        {
            case "medical": return ("health", 0.9);
            case "bills": return ("financial", 0.9);
            case "mail_tracking": return ("shopping", 0.85);
            case "social": return ("social", 0.9);
        }
        if (Travel().IsMatch(haystack)) return ("travel", 0.8);
        if (Legal().IsMatch(haystack)) return ("legal", 0.8);
        if (Financial().IsMatch(haystack)) return ("financial", 0.8);
        if (Shopping().IsMatch(haystack)) return ("shopping", 0.78);
        if (bulk && Newsletter().IsMatch(haystack)) return ("newsletter", 0.85);
        if (bulk) return ("newsletter", 0.76);
        if (category == "promotions") return ("newsletter", 0.76);
        if (category == "updates" || AutomatedSender().IsMatch(localPart)) return ("notification", 0.8);
        if (FreeMailDomains.Contains(domain)) return ("personal", 0.6);
        // Nothing decisive: a real person or a business writing directly. Worth a model call.
        return ("other", 0.3);
    }

    private static (string Value, double Confidence) Commercial(
        string category, string haystack, bool bulk, bool automated)
    {
        var advertising = Advertising().IsMatch(haystack);
        if (bulk && advertising) return ("advertising", 0.92);
        if (bulk) return ("promotional", 0.82);
        if (category == "promotions") return (advertising ? "advertising" : "promotional", 0.8);
        if (Transactional().IsMatch(haystack)) return ("transactional", 0.85);
        if (category is "bills" or "mail_tracking") return ("transactional", 0.85);
        if (automated) return ("transactional", 0.76);
        if (advertising) return ("advertising", 0.7);
        return ("not_commercial", 0.45);
    }

    private static (string Value, double Confidence) Importance(
        string type, string commercial, string haystack, bool bulk)
    {
        if (Urgent().IsMatch(haystack) && !bulk) return ("critical", 0.85);
        if (commercial is "advertising" or "promotional") return ("low", 0.88);
        if (type == "newsletter") return ("low", 0.85);
        if (type is "financial" or "legal" or "health") return ("high", 0.8);
        if (type == "notification") return ("normal", 0.78);
        // Everything else is a judgement about what this owner cares about, which rules cannot make.
        return ("normal", 0.35);
    }

    /// <summary>Keeps a model answer inside the vocabulary, falling back to the rule-based value.</summary>
    public static string Constrain(string? value, string[] vocabulary, string fallback)
    {
        var normalized = value?.Trim().ToLowerInvariant().Replace(' ', '_');
        return normalized is not null && vocabulary.Contains(normalized, StringComparer.Ordinal)
            ? normalized
            : fallback;
    }

    private static readonly HashSet<string> FreeMailDomains = new(StringComparer.Ordinal)
    {
        "gmail.com", "googlemail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com",
        "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.ru", "yandex.ru"
    };

    private static string? Header(IReadOnlyDictionary<string, string> headers, string name) =>
        headers.FirstOrDefault(entry => string.Equals(entry.Key, name, StringComparison.OrdinalIgnoreCase)).Value;

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)] private static partial Regex Whitespace();
    [GeneratedRegex(@"(?:alert|automated|automatic|bot|daemon|do-?not-?reply|mailer|newsletter|no-?reply|notification|notify|postmaster|support)", RegexOptions.IgnoreCase)] private static partial Regex AutomatedSender();
    [GeneratedRegex(@"\b(boarding pass|booking|check-?in|departure|flight|hotel|itinerary|rental car|reservation|trip to)\b", RegexOptions.IgnoreCase)] private static partial Regex Travel();
    [GeneratedRegex(@"\b(affidavit|attorney|contract|court|deed|lawsuit|lease agreement|legal notice|litigation|notary|solicitor|subpoena|terms of service update)\b", RegexOptions.IgnoreCase)] private static partial Regex Legal();
    [GeneratedRegex(@"\b(account statement|balance|bank|deposit|dividend|invoice|loan|mortgage|payment|payroll|pension|refund|tax|transfer|withdrawal)\b", RegexOptions.IgnoreCase)] private static partial Regex Financial();
    [GeneratedRegex(@"\b(cart|delivered|dispatch|order (?:confirm|number|placed|update)|purchase|receipt|return label|shipped|tracking)\b", RegexOptions.IgnoreCase)] private static partial Regex Shopping();
    [GeneratedRegex(@"\b(digest|edition|issue #?\d+|newsletter|round-?up|this week|weekly update)\b", RegexOptions.IgnoreCase)] private static partial Regex Newsletter();
    [GeneratedRegex(@"\b(\d+% off|act now|buy now|clearance|coupon|deal|discount|exclusive offer|flash sale|free shipping|last chance|limited time|lowest price|offer ends|promo code|sale ends|save (?:big|now|\d+)|shop now|special offer|upgrade today)\b", RegexOptions.IgnoreCase)] private static partial Regex Advertising();
    [GeneratedRegex(@"\b(confirmation|invoice|order (?:confirm|number)|password reset|payment (?:received|due)|receipt|security code|shipping|statement|verification code|verify your)\b", RegexOptions.IgnoreCase)] private static partial Regex Transactional();
    [GeneratedRegex(@"\b(action required|asap|deadline|expires today|final notice|immediately|overdue|past due|response needed|suspended|urgent)\b", RegexOptions.IgnoreCase)] private static partial Regex Urgent();
}
