namespace ArchiveMail.Api.Mail;

/// <summary>
/// The addresses this deployment is allowed to send from.
///
/// Gmail will happily send from whatever the caller puts in the From header, so without a check
/// here a mistake anywhere -- a stale draft, an AI path that forgets to set an address, a future
/// endpoint -- silently goes out under the connected account's own address. The list is closed
/// and enforced on the server rather than offered in the UI, because the point is a guarantee
/// rather than a convenience.
/// </summary>
public static class SendingIdentity
{
    /// <summary>Automated and general mail.</summary>
    public const string Ai = "ai@vitas.work";

    /// <summary>Recruiters and development work, where a person expects a person.</summary>
    public const string Development = "code@vitas.work";

    /// <summary>Personal mail on the same domain.</summary>
    public const string Personal = "me@vitas.work";

    /// <summary>The long-standing personal account, kept as an option.</summary>
    public const string Legacy = "gliukaz@gmail.com";

    public static readonly IReadOnlyList<string> Allowed = [Ai, Development, Personal, Legacy];

    /// <summary>
    /// Trims and lowercases so that stored, typed and Gmail-supplied spellings compare equal.
    /// Addresses are case-insensitive in the part that matters here, and a trailing space from a
    /// settings field should not be the reason a send is refused.
    /// </summary>
    public static string Normalize(string? address) => address?.Trim().ToLowerInvariant() ?? "";

    public static bool IsAllowed(string? address) => Allowed.Contains(Normalize(address));

    /// <summary>
    /// The address a draft should go out from when nothing has been chosen explicitly.
    /// Recruiter and development threads come from <see cref="Development"/> so a reply about
    /// engineering work does not arrive from an address that reads as automated; everything else
    /// defaults to <see cref="Ai"/>.
    /// </summary>
    public static string DefaultFor(bool developmentRelated) => developmentRelated ? Development : Ai;

    /// <summary>
    /// Resolves what to store or send: an explicit choice when it is permitted, the default
    /// otherwise. Throws when a caller asked for an address outside the list, so the refusal is
    /// visible at the point of the mistake instead of being quietly rewritten.
    /// </summary>
    public static string Resolve(string? requested, bool developmentRelated)
    {
        var normalized = Normalize(requested);
        if (normalized.Length == 0) return DefaultFor(developmentRelated);
        if (!IsAllowed(normalized)) throw new ArgumentException(Rejection(requested));
        return normalized;
    }

    public static string Rejection(string? address) =>
        $"'{address}' is not one of the addresses this server may send from ({string.Join(", ", Allowed)})";
}
