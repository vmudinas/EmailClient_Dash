using System.Globalization;
using System.Text;

namespace ArchiveMail.Api.Learning;

/// <summary>
/// Scores a spoken attempt against the word being practised.
///
/// The browser transcribes the take with its own Lithuanian speech recognition and sends the
/// text; the score is computed here so every client produces the same number for the same
/// transcript. What this measures is which word was recognised, not how closely the learner's
/// voice matches a particular speaker -- comparing a child's voice to a synthesized one as raw
/// audio would produce a percentage with no meaning behind it.
/// </summary>
internal static class LithuanianScoring
{
    internal const int MaxTranscriptLength = 400;

    /// <summary>
    /// Percentage match between what was heard and the target word, or null when there is no
    /// transcript to compare -- an unscored take is still worth keeping.
    /// </summary>
    internal static int? Score(string? transcript, string target)
    {
        var heard = Fold(transcript);
        var expected = Fold(target);
        if (heard.Length == 0 || expected.Length == 0) return null;
        var distance = Distance(heard, expected);
        var longest = Math.Max(heard.Length, expected.Length);
        return (int)Math.Round(100.0 * (longest - distance) / longest, MidpointRounding.AwayFromZero);
    }

    internal static bool Passed(int score, int passMark) => score >= passMark;

    /// <summary>
    /// Lowercases, drops everything that is not a letter, digit, or a single separating space, and
    /// folds Lithuanian diacritics. Recognizers are inconsistent about ą/č/ę/ė/į/š/ų/ū/ž, and the
    /// learner is being judged on the sounds produced rather than on the recognizer's spelling.
    ///
    /// Spaces are kept as separators so a phrase is compared word for word: without them
    /// "labas rytas" and "labasrytas" would be identical, and a run-together attempt would score
    /// as a perfect one.
    /// </summary>
    internal static string Fold(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var decomposed = value.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var folded = new StringBuilder(decomposed.Length);
        foreach (var character in decomposed)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(character) == UnicodeCategory.NonSpacingMark) continue;
            if (char.IsLetterOrDigit(character)) folded.Append(character);
            // Collapse any run of whitespace or punctuation between words into one space.
            else if (folded.Length > 0 && folded[^1] != ' ') folded.Append(' ');
        }
        return folded.ToString().TrimEnd().Normalize(NormalizationForm.FormC);
    }

    internal static string NormalizeTranscript(string? value)
    {
        var transcript = value?.Trim() ?? "";
        return transcript.Length > MaxTranscriptLength ? transcript[..MaxTranscriptLength] : transcript;
    }

    /// <summary>Levenshtein distance over two rows, which is all the score needs.</summary>
    private static int Distance(string left, string right)
    {
        if (left == right) return 0;
        if (left.Length == 0) return right.Length;
        if (right.Length == 0) return left.Length;

        var previous = new int[right.Length + 1];
        var current = new int[right.Length + 1];
        for (var column = 0; column <= right.Length; column++) previous[column] = column;

        for (var row = 1; row <= left.Length; row++)
        {
            current[0] = row;
            for (var column = 1; column <= right.Length; column++)
            {
                var substitution = previous[column - 1] + (left[row - 1] == right[column - 1] ? 0 : 1);
                current[column] = Math.Min(Math.Min(current[column - 1] + 1, previous[column] + 1), substitution);
            }
            (previous, current) = (current, previous);
        }
        return previous[right.Length];
    }
}
