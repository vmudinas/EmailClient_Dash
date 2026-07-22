using System.Globalization;
using System.Text.RegularExpressions;

namespace ArchiveMail.Api.Mail;

public static partial class ShipmentExtractor
{
    public static ShipmentSummaryDto? Extract(
        string? senderName, string senderAddress, string subject, string bodyText, string? receivedAt, string? sentAt)
    {
        var text = Normalize($"{subject}\n{bodyText[..Math.Min(8_000, bodyText.Length)]}");
        var identity = Normalize($"{senderName ?? ""} {senderAddress} {subject}");
        var carrier = Carrier(identity, text);
        var tracking = TrackingNumber(text, carrier);
        var order = OrderNumber().Match(text) is { Success: true } orderMatch ? orderMatch.Groups[1].Value.ToUpperInvariant() : null;
        var status = ShipmentStatus(text);
        var date = DeliveryDate(text, receivedAt ?? sentAt);
        if (carrier == "unknown" && tracking is null && order is null && date is null && status == "unknown") return null;
        var merchant = Merchant(senderName, identity, text, carrier);
        return new(carrier, merchant, tracking, order, status, date, TrackingUrl(carrier, tracking));
    }

    private static string Carrier(string identity, string text)
    {
        var value = $"{identity} {text[..Math.Min(2_000, text.Length)]}";
        if (Regex.IsMatch(value, @"\b(?:amazon logistics|amazon shipping)\b|\bTBA\d{8,}\b", RegexOptions.IgnoreCase)
            || (Regex.IsMatch(identity, @"\bamazon\.(?:com|co\.uk|ca)\b", RegexOptions.IgnoreCase)
                && Regex.IsMatch(text, @"\b(?:arriv(?:es|ing)|delivery|order|package|shipment|shipped)\b", RegexOptions.IgnoreCase))) return "amazon";
        if (Regex.IsMatch(value, @"\b(?:UPS|ups\.com|1Z[A-Z0-9]{16})\b", RegexOptions.IgnoreCase)) return "ups";
        if (Regex.IsMatch(value, @"\b(?:FedEx|fedex\.com)\b", RegexOptions.IgnoreCase)) return "fedex";
        if (Regex.IsMatch(value, @"\b(?:USPS|U\.S\. Postal Service|United States Postal Service|usps\.com)\b", RegexOptions.IgnoreCase)) return "usps";
        if (Regex.IsMatch(value, @"\b(?:DHL|dhl\.com)\b", RegexOptions.IgnoreCase)) return "dhl";
        return "unknown";
    }

    private static string? TrackingNumber(string text, string carrier)
    {
        var patterns = new List<string> { @"\b(1Z[A-Z0-9]{16})\b", @"\b(TBA\d{8,})\b", @"\b([A-Z]{2}\d{9}US)\b" };
        if (carrier == "fedex") patterns.Add(@"\b(\d{12}|\d{15})\b");
        if (carrier == "usps") patterns.Add(@"\b(\d{20,22})\b");
        if (carrier == "dhl") patterns.AddRange([@"\b(\d{10})\b", @"\b(JD\d{16,20})\b"]);
        foreach (var pattern in patterns)
        {
            var match = Regex.Match(text, pattern, RegexOptions.IgnoreCase);
            if (match.Success) return NormalizeId(match.Groups[1].Value);
        }
        var labelled = Regex.Match(text, @"\btracking(?:\s+(?:number|no\.?|id))?\s*(?:is|:|#)?\s*([A-Z0-9][A-Z0-9 -]{7,29})", RegexOptions.IgnoreCase);
        if (!labelled.Success) return null;
        var value = Regex.Split(labelled.Groups[1].Value, @"\s{2,}|\b(?:track|status|estimated|expected|arriv)", RegexOptions.IgnoreCase)[0];
        var candidate = NormalizeId(value);
        return candidate.Any(char.IsDigit) && candidate.Length is >= 8 and <= 30 ? candidate : null;
    }

    private static string ShipmentStatus(string text)
    {
        if (Regex.IsMatch(text, @"\b(?:package|order|shipment)?\s*(?:has been|was|is) delivered\b|\bdelivered (?:today|yesterday|at|on|to)\b", RegexOptions.IgnoreCase)) return "delivered";
        if (Regex.IsMatch(text, @"\b(?:delivery|package|shipment).{0,35}(?:delayed|exception)|\bdelayed in transit\b", RegexOptions.IgnoreCase)) return "delayed";
        if (Regex.IsMatch(text, @"\bout for delivery\b", RegexOptions.IgnoreCase)) return "out_for_delivery";
        if (Regex.IsMatch(text, @"\bin transit\b|\bon the way\b", RegexOptions.IgnoreCase)) return "in_transit";
        if (Regex.IsMatch(text, @"\b(?:has |have )?shipped\b|\bshipment (?:confirmation|created)\b", RegexOptions.IgnoreCase)) return "shipped";
        if (Regex.IsMatch(text, @"\border (?:confirmed|confirmation|received)\b|\bthanks? for your order\b", RegexOptions.IgnoreCase)) return "order_confirmed";
        return "unknown";
    }

    private static string Merchant(string? senderName, string identity, string text, string carrier)
    {
        foreach (var candidate in new[] { "Amazon", "Walmart", "Target", "eBay", "Etsy", "Apple", "Best Buy" })
            if (Regex.IsMatch($"{identity} {text[..Math.Min(2_000, text.Length)]}", $@"\b{Regex.Escape(candidate)}\b", RegexOptions.IgnoreCase)) return candidate;
        var fromOrder = Regex.Match(text, @"\b(?:order|shipment|package) from\s+([A-Z][A-Za-z0-9 &'._-]{1,39})", RegexOptions.IgnoreCase);
        if (fromOrder.Success) return fromOrder.Groups[1].Value.Split('|', '•')[0].Trim();
        if (!string.IsNullOrWhiteSpace(senderName) && !Regex.IsMatch(senderName, @"\b(?:amazon logistics|dhl|fedex|shipment|shipping|ups|usps)\b", RegexOptions.IgnoreCase))
            return senderName[..Math.Min(60, senderName.Length)].Trim();
        return carrier switch { "amazon" => "Amazon", "ups" => "UPS", "fedex" => "FedEx", "usps" => "USPS", "dhl" => "DHL", _ => "Shipment" };
    }

    private static string? DeliveryDate(string text, string? referenceValue)
    {
        var reference = DateTimeOffset.TryParse(referenceValue, out var parsed) ? parsed.Date : DateTimeOffset.UtcNow.Date;
        var relative = Regex.Match(text, @"\b(?:arriv(?:es|ing)|delivery|delivered|expected|estimated delivery)(?:\s+(?:by|on))?\s*:?-?\s*(today|tomorrow)\b", RegexOptions.IgnoreCase);
        if (relative.Success) return DateOnly.FromDateTime(reference.AddDays(relative.Groups[1].Value.Equals("tomorrow", StringComparison.OrdinalIgnoreCase) ? 1 : 0).Date).ToString("yyyy-MM-dd");
        var named = Regex.Match(text, @"\b(?:arriv(?:es|ing)|delivery|delivered|expected|estimated delivery)(?:\s+(?:by|on))?\s*:?-?\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\s*,?\s*)?((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:\s*,\s*\d{4})?)", RegexOptions.IgnoreCase);
        if (!named.Success) return null;
        var formats = new[] { "MMMM d, yyyy", "MMM d, yyyy", "MMMM d yyyy", "MMM d yyyy", "MMMM d", "MMM d" };
        if (!DateTime.TryParseExact(named.Groups[1].Value.Replace("  ", " "), formats, CultureInfo.InvariantCulture, DateTimeStyles.AllowWhiteSpaces, out var date)) return null;
        if (!named.Groups[1].Value.Contains(reference.Year.ToString(), StringComparison.Ordinal)) date = new DateTime(reference.Year, date.Month, date.Day);
        if (date < reference.AddDays(-45)) date = date.AddYears(1);
        return DateOnly.FromDateTime(date).ToString("yyyy-MM-dd");
    }

    private static string? TrackingUrl(string carrier, string? tracking)
    {
        if (carrier == "amazon") return "https://www.amazon.com/gp/css/order-history";
        if (tracking is null) return null;
        var encoded = Uri.EscapeDataString(tracking);
        return carrier switch
        {
            "ups" => $"https://www.ups.com/track?loc=en_US&tracknum={encoded}",
            "fedex" => $"https://www.fedex.com/fedextrack/?trknbr={encoded}",
            "usps" => $"https://tools.usps.com/go/TrackConfirmAction?tLabels={encoded}",
            "dhl" => $"https://www.dhl.com/us-en/home/tracking/tracking-parcel.html?submit=1&tracking-id={encoded}",
            _ => null
        };
    }

    private static string Normalize(string value) => Regex.Replace(value.Replace('\u00a0', ' '), @"\s+", " ").Trim();
    private static string NormalizeId(string value) => Regex.Replace(value, @"[\s-]+", "").ToUpperInvariant();
    [GeneratedRegex(@"\border(?:\s+(?:number|no\.?|id))?\s*(?:is|:|#)?\s*([A-Z0-9][A-Z0-9-]{4,29})\b", RegexOptions.IgnoreCase)] private static partial Regex OrderNumber();
}
