namespace ArchiveMail.Api.Property;

/// <summary>
/// Pure validation and money rules for rent payments. Kept free of database and HTTP dependencies so
/// every rule is unit testable — this is the code that decides whether money is recorded, so it must
/// not depend on integration wiring to be verified.
/// </summary>
public static class PropertyPaymentRules
{
    /// <summary>Providers that can hold a payment. Must stay in sync with PROPERTY_PAYMENT_PROVIDER_IDS.</summary>
    public static readonly IReadOnlySet<string> Providers =
        new HashSet<string>(StringComparer.Ordinal) { "stripe", "paypal", "zelle", "apple_cash", "manual" };

    /// <summary>Must stay in sync with PROPERTY_PAYMENT_STATUS_IDS.</summary>
    public static readonly IReadOnlySet<string> Statuses =
        new HashSet<string>(StringComparer.Ordinal) { "pending", "processing", "succeeded", "failed", "refunded", "cancelled" };

    /// <summary>Must stay in sync with PROPERTY_PAYMENT_METHOD_IDS.</summary>
    public static readonly IReadOnlySet<string> Methods =
        new HashSet<string>(StringComparer.Ordinal)
        { "card", "apple_pay", "google_pay", "ach", "paypal", "venmo", "zelle", "apple_cash", "cash", "check", "other" };

    /// <summary>Which payment methods each provider is able to settle.</summary>
    private static readonly Dictionary<string, string[]> MethodsByProvider = new(StringComparer.Ordinal)
    {
        ["stripe"] = ["card", "apple_pay", "google_pay", "ach"],
        ["paypal"] = ["paypal", "venmo", "card"],
        ["zelle"] = ["zelle"],
        ["apple_cash"] = ["apple_cash"],
        ["manual"] = ["cash", "check", "other"]
    };

    /// <summary>A sanity ceiling so a typo cannot record a nine-figure rent payment. $1,000,000.</summary>
    public const long MaxAmountCents = 100_000_000;

    /// <summary>Providers whose funds move through a hosted provider checkout.</summary>
    public static bool IsProviderCheckout(string provider) => provider is "stripe" or "paypal";

    /// <summary>
    /// Providers settled out of band: the tenant sends money directly and a manager confirms receipt.
    /// Apple Cash is here because Apple publishes no merchant API for receiving Apple Cash — it is a
    /// person-to-person transfer, so the only correct implementation is instructions plus confirmation.
    /// </summary>
    public static bool IsInstructionProvider(string provider) => provider is "zelle" or "apple_cash" or "manual";

    /// <summary>
    /// Decides the status a newly created payment may start in.
    ///
    /// Only a manager may declare a payment already settled. A tenant creating their own payment always
    /// starts at "pending" — otherwise a tenant could self-report a rent payment as succeeded and have the
    /// ledger and receipt written without any money moving.
    /// </summary>
    public static string NormalizeCreateStatus(string? requested, bool isManager)
    {
        if (string.IsNullOrWhiteSpace(requested)) return "pending";
        var status = requested.Trim();
        if (!Statuses.Contains(status)) throw new ArgumentException($"Unsupported payment status: {status}");
        if (!isManager && status != "pending")
            throw new ArgumentException("Only a property manager can record a payment as already settled");
        return status;
    }

    /// <summary>Managers may set any valid status when updating; tenants never reach this path.</summary>
    public static string NormalizeUpdateStatus(string? requested)
    {
        var status = (requested ?? "").Trim();
        if (!Statuses.Contains(status)) throw new ArgumentException($"Unsupported payment status: {status}");
        return status;
    }

    public static string NormalizeProvider(string? provider)
    {
        var value = (provider ?? "").Trim();
        if (!Providers.Contains(value)) throw new ArgumentException($"Unsupported payment provider: {value}");
        return value;
    }

    /// <summary>
    /// Validates the method and that the provider can actually settle it — e.g. Apple Pay is a wallet
    /// presented through Stripe, never a provider of its own, so apple_pay + paypal is rejected.
    /// </summary>
    public static string NormalizeMethod(string? method, string provider)
    {
        var value = (method ?? "").Trim();
        if (!Methods.Contains(value)) throw new ArgumentException($"Unsupported payment method: {value}");
        if (!MethodsByProvider.TryGetValue(provider, out var allowed))
            throw new ArgumentException($"Unsupported payment provider: {provider}");
        if (!allowed.Contains(value, StringComparer.Ordinal))
            throw new ArgumentException($"{Label(value)} cannot be settled through {Label(provider)}");
        return value;
    }

    /// <summary>The default method for a provider, used when the caller does not name one.</summary>
    public static string DefaultMethod(string provider) => MethodsByProvider[provider][0];

    /// <summary>A payment must be a positive amount within the sanity ceiling.</summary>
    public static long ValidateAmountCents(long? amountCents)
    {
        if (amountCents is not { } amount) throw new ArgumentException("amountCents is required");
        if (amount <= 0) throw new ArgumentException("Payment amount must be greater than zero");
        if (amount > MaxAmountCents) throw new ArgumentException("Payment amount exceeds the maximum allowed");
        return amount;
    }

    /// <summary>How much of a payment can still be refunded once earlier refunds are counted.</summary>
    public static long RemainingRefundable(long amountCents, long alreadyRefundedCents) =>
        Math.Max(0, amountCents - Math.Max(0, alreadyRefundedCents));

    /// <summary>
    /// Validates a refund against the amount already refunded. Without this a partial refund could be
    /// repeated until the ledger went arbitrarily negative — the payment providers reject an over-refund,
    /// but the out-of-band providers have no such backstop.
    /// </summary>
    public static long ValidateRefundAmount(long? requested, long amountCents, long alreadyRefundedCents)
    {
        var remaining = RemainingRefundable(amountCents, alreadyRefundedCents);
        if (remaining <= 0) throw new InvalidOperationException("This payment has already been fully refunded");
        var amount = requested ?? remaining;
        if (amount <= 0) throw new ArgumentException("Refund amount must be greater than zero");
        if (amount > remaining)
            throw new ArgumentException($"Refund amount exceeds the {Money(remaining)} still refundable on this payment");
        return amount;
    }

    /// <summary>
    /// How much of a payment to allocate against a charge. Never more than the charge still owes, so an
    /// overpayment cannot make a charge appear over-settled in the ledger.
    /// </summary>
    public static long AllocationCents(long paymentAmountCents, long chargeOutstandingCents) =>
        Math.Max(0, Math.Min(paymentAmountCents, chargeOutstandingCents));

    /// <summary>True when a refund settles the whole payment and the status should become "refunded".</summary>
    public static bool IsFullRefund(long refundAmountCents, long amountCents, long alreadyRefundedCents) =>
        alreadyRefundedCents + refundAmountCents >= amountCents;

    private static string Money(long cents) => $"${cents / 100m:0.00}";

    private static string Label(string value) =>
        value switch
        {
            "apple_pay" => "Apple Pay",
            "apple_cash" => "Apple Cash",
            "google_pay" => "Google Pay",
            "ach" => "ACH",
            "paypal" => "PayPal",
            "stripe" => "Stripe",
            "zelle" => "Zelle",
            "venmo" => "Venmo",
            "manual" => "manual recording",
            _ => value.Replace('_', ' ')
        };
}
