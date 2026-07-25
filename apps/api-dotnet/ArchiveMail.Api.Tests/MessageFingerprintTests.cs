using ArchiveMail.Api.Ai;
using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class MessageFingerprintTests
{
    [Theory]
    [InlineData("Re: Boiler repair", "boiler repair")]
    [InlineData("RE: RE: Fwd: Boiler repair", "boiler repair")]
    [InlineData("FW: Boiler   repair", "boiler repair")]
    [InlineData("Re[2]: Boiler repair", "boiler repair")]
    [InlineData("Boiler repair", "boiler repair")]
    public void Subject_normalization_strips_reply_and_forward_prefixes(string subject, string expected) =>
        Assert.Equal(expected, MessageFingerprint.NormalizeSubject(subject));

    [Theory]
    [InlineData("Landlord <owner@example.com>", "owner@example.com")]
    [InlineData("OWNER@Example.com", "owner@example.com")]
    [InlineData("\"Owner, The\" <Owner@example.com>", "owner@example.com")]
    public void Address_normalization_extracts_and_lowercases(string address, string expected) =>
        Assert.Equal(expected, MessageFingerprint.NormalizeAddress(address));

    [Fact]
    public void Quoted_history_is_removed_below_the_boundary()
    {
        const string body = "Thanks, that works.\n\nOn Tue, 1 Jul 2026 at 09:00, Sam <sam@example.com> wrote:\n> Are you free?";
        Assert.Equal("Thanks, that works.", MessageFingerprint.StripQuotedHistory(body).Trim());
    }

    [Fact]
    public void Quote_gutter_is_removed_without_an_explicit_boundary()
    {
        const string body = "Confirmed.\n> previous line\n> another line";
        Assert.Equal("Confirmed.", MessageFingerprint.StripQuotedHistory(body).Trim());
    }

    [Fact]
    public void Signature_block_is_removed()
    {
        const string body = "See attached.\n-- \nSam\nCEO";
        Assert.Equal("See attached.", MessageFingerprint.StripSignature(body).Trim());
    }

    [Fact]
    public void Identical_message_reimported_produces_the_same_content_hash()
    {
        var first = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        var second = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        Assert.Equal(first, second);
    }

    [Fact]
    public void Reply_prefix_and_whitespace_do_not_change_the_content_hash()
    {
        var original = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        var noisy = MessageFingerprint.ContentHash("Re: Invoice  42", "Billing <BILLING@example.com>", "Payment is   due Friday.\n");
        Assert.Equal(original, noisy);
    }

    [Fact]
    public void Quote_trimmed_forward_matches_the_original_content_hash()
    {
        var original = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        var forwarded = MessageFingerprint.ContentHash(
            "Fwd: Invoice 42",
            "billing@example.com",
            "Payment is due Friday.\n\n-----Original Message-----\nFrom: someone@example.com\nSent: Monday\nAnything here");
        Assert.Equal(original, forwarded);
    }

    [Fact]
    public void Attachment_stripped_copy_hashes_differently()
    {
        var withAttachment = MessageFingerprint.ContentHash(
            "Invoice 42", "billing@example.com", "Payment is due Friday.", ["abc123"]);
        var without = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        Assert.NotEqual(withAttachment, without);
    }

    [Fact]
    public void Attachment_order_does_not_change_the_content_hash()
    {
        var forward = MessageFingerprint.ContentHash("Report", "a@example.com", "See files", ["aaa", "bbb"]);
        var reverse = MessageFingerprint.ContentHash("Report", "a@example.com", "See files", ["BBB", "aaa"]);
        Assert.Equal(forward, reverse);
    }

    [Fact]
    public void Different_bodies_hash_differently()
    {
        var first = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Friday.");
        var second = MessageFingerprint.ContentHash("Invoice 42", "billing@example.com", "Payment is due Monday.");
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void Simhash_of_a_lightly_edited_body_stays_within_the_near_duplicate_threshold()
    {
        const string original = "The boiler in the upstairs flat is leaking again and needs a plumber this week. "
            + "Please arrange a visit and confirm the appointment time with the tenant.";
        const string edited = "The boiler in the upstairs flat is leaking again and needs a plumber this week. "
            + "Please arrange a visit and confirm the appointment time with the tenant today.";
        var distance = MessageFingerprint.HammingDistance(
            MessageFingerprint.SimHash(original), MessageFingerprint.SimHash(edited));
        Assert.True(
            distance <= DeduplicationService.NearDuplicateHammingThreshold,
            $"expected a near-duplicate distance, got {distance}");
    }

    [Fact]
    public void Digit_signature_separates_one_template_with_different_numbers()
    {
        var first = MessageFingerprint.DigitSignature("Your order 12345 has shipped and costs 42 pounds.");
        var second = MessageFingerprint.DigitSignature("Your order 67890 has shipped and costs 99 pounds.");
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void Digit_signature_matches_for_the_same_message_reworded_without_numbers()
    {
        var first = MessageFingerprint.DigitSignature("Your order 12345 has shipped.");
        var second = MessageFingerprint.DigitSignature("Your order 12345 has now shipped!");
        Assert.Equal(first, second);
    }

    [Fact]
    public void Digit_signature_preserves_order_so_transposed_numbers_differ()
    {
        Assert.NotEqual(
            MessageFingerprint.DigitSignature("invoice 10 for 20 pounds"),
            MessageFingerprint.DigitSignature("invoice 20 for 10 pounds"));
    }

    [Fact]
    public void Digit_signature_is_empty_for_bodies_without_numbers() =>
        Assert.Equal("", MessageFingerprint.DigitSignature("Please confirm when convenient."));

    [Fact]
    public void Simhash_of_unrelated_bodies_exceeds_the_near_duplicate_threshold()
    {
        const string first = "The boiler in the upstairs flat is leaking again and needs a plumber this week.";
        const string second = "Your quarterly investment statement is now available to download from the portal.";
        var distance = MessageFingerprint.HammingDistance(
            MessageFingerprint.SimHash(first), MessageFingerprint.SimHash(second));
        Assert.True(
            distance > DeduplicationService.NearDuplicateHammingThreshold,
            $"expected unrelated bodies to differ, got {distance}");
    }

    [Fact]
    public void Simhash_is_stable_across_calls()
    {
        const string body = "Please confirm the delivery window for tomorrow morning.";
        Assert.Equal(MessageFingerprint.SimHash(body), MessageFingerprint.SimHash(body));
    }

    [Fact]
    public void Empty_body_produces_a_zero_simhash_which_is_skipped_by_scans()
    {
        Assert.Equal(0, MessageFingerprint.SimHash(""));
        Assert.Equal(0, MessageFingerprint.SimHash(null));
    }

    [Fact]
    public void Identical_simhash_values_share_every_band()
    {
        const string body = "Please confirm the delivery window for tomorrow morning.";
        var left = MessageFingerprint.SimHash(body);
        var right = MessageFingerprint.SimHash(body);
        Assert.Equal(MessageFingerprint.Bands(left), MessageFingerprint.Bands(right));
        Assert.Equal(4, MessageFingerprint.Bands(left).Length);
    }
}
