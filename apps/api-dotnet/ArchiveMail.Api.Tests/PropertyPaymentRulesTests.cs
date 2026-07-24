using ArchiveMail.Api.Infrastructure;
using ArchiveMail.Api.Property;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class PropertyPaymentRulesTests
{
    // ---------- status: a tenant must never be able to self-report a settled payment ----------

    [Fact]
    public void Tenant_cannot_create_a_payment_that_is_already_succeeded()
    {
        var error = Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeCreateStatus("succeeded", isManager: false));
        Assert.Contains("manager", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("processing")]
    [InlineData("refunded")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public void Tenant_cannot_create_a_payment_in_any_non_pending_status(string status) =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeCreateStatus(status, isManager: false));

    [Fact]
    public void Tenant_may_create_a_pending_payment() =>
        Assert.Equal("pending", PropertyPaymentRules.NormalizeCreateStatus("pending", isManager: false));

    [Fact]
    public void Missing_status_defaults_to_pending_for_everyone()
    {
        Assert.Equal("pending", PropertyPaymentRules.NormalizeCreateStatus(null, isManager: false));
        Assert.Equal("pending", PropertyPaymentRules.NormalizeCreateStatus("  ", isManager: true));
    }

    [Fact]
    public void Manager_may_record_a_payment_that_already_settled() =>
        Assert.Equal("succeeded", PropertyPaymentRules.NormalizeCreateStatus("succeeded", isManager: true));

    [Fact]
    public void Unknown_status_is_rejected_even_for_a_manager() =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeCreateStatus("paid", isManager: true));

    [Fact]
    public void Update_status_must_be_a_known_status()
    {
        Assert.Equal("succeeded", PropertyPaymentRules.NormalizeUpdateStatus("succeeded"));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeUpdateStatus("settled"));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeUpdateStatus(null));
    }

    // ---------- amount ----------

    [Fact]
    public void Amount_must_be_present_and_positive()
    {
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateAmountCents(null));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateAmountCents(0));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateAmountCents(-5_000));
        Assert.Equal(150_000, PropertyPaymentRules.ValidateAmountCents(150_000));
    }

    [Fact]
    public void Amount_is_capped_so_a_typo_cannot_record_an_absurd_payment()
    {
        Assert.Equal(PropertyPaymentRules.MaxAmountCents, PropertyPaymentRules.ValidateAmountCents(PropertyPaymentRules.MaxAmountCents));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateAmountCents(PropertyPaymentRules.MaxAmountCents + 1));
    }

    // ---------- provider and method pairing ----------

    [Theory]
    [InlineData("stripe")]
    [InlineData("paypal")]
    [InlineData("zelle")]
    [InlineData("apple_cash")]
    [InlineData("manual")]
    public void Known_providers_are_accepted(string provider) =>
        Assert.Equal(provider, PropertyPaymentRules.NormalizeProvider(provider));

    [Theory]
    [InlineData("apple_pay")]
    [InlineData("venmo_direct")]
    [InlineData("")]
    [InlineData(null)]
    public void Unknown_providers_are_rejected(string? provider) =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeProvider(provider));

    [Fact]
    public void Apple_pay_settles_through_stripe_because_it_is_a_wallet_not_a_processor() =>
        Assert.Equal("apple_pay", PropertyPaymentRules.NormalizeMethod("apple_pay", "stripe"));

    [Fact]
    public void Apple_pay_cannot_be_claimed_against_a_provider_that_cannot_settle_it()
    {
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeMethod("apple_pay", "paypal"));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeMethod("apple_pay", "zelle"));
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeMethod("apple_pay", "manual"));
    }

    [Fact]
    public void Apple_cash_is_its_own_out_of_band_provider()
    {
        Assert.Equal("apple_cash", PropertyPaymentRules.NormalizeMethod("apple_cash", "apple_cash"));
        Assert.True(PropertyPaymentRules.IsInstructionProvider("apple_cash"));
        Assert.False(PropertyPaymentRules.IsProviderCheckout("apple_cash"));
    }

    [Fact]
    public void Card_cannot_be_recorded_against_a_cash_only_provider() =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeMethod("card", "manual"));

    [Fact]
    public void Unknown_methods_are_rejected() =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeMethod("crypto", "stripe"));

    [Theory]
    [InlineData("stripe", "card")]
    [InlineData("paypal", "paypal")]
    [InlineData("zelle", "zelle")]
    [InlineData("apple_cash", "apple_cash")]
    [InlineData("manual", "cash")]
    public void Each_provider_has_a_usable_default_method(string provider, string expected) =>
        Assert.Equal(expected, PropertyPaymentRules.DefaultMethod(provider));

    [Fact]
    public void Provider_checkout_applies_only_to_the_hosted_providers()
    {
        Assert.True(PropertyPaymentRules.IsProviderCheckout("stripe"));
        Assert.True(PropertyPaymentRules.IsProviderCheckout("paypal"));
        foreach (var provider in new[] { "zelle", "apple_cash", "manual" })
            Assert.True(PropertyPaymentRules.IsInstructionProvider(provider));
    }

    // ---------- refunds: the over-refund hole ----------

    [Fact]
    public void A_full_refund_defaults_to_the_whole_payment() =>
        Assert.Equal(100_000, PropertyPaymentRules.ValidateRefundAmount(null, 100_000, 0));

    [Fact]
    public void Repeated_partial_refunds_cannot_exceed_the_payment()
    {
        // $1000 payment, $600 already refunded: at most $400 may still be refunded.
        Assert.Equal(40_000, PropertyPaymentRules.RemainingRefundable(100_000, 60_000));
        Assert.Equal(40_000, PropertyPaymentRules.ValidateRefundAmount(40_000, 100_000, 60_000));
        var error = Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateRefundAmount(40_001, 100_000, 60_000));
        Assert.Contains("400.00", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_fully_refunded_payment_cannot_be_refunded_again() =>
        Assert.Throws<InvalidOperationException>(() => PropertyPaymentRules.ValidateRefundAmount(1, 100_000, 100_000));

    [Fact]
    public void Refund_amount_must_be_positive() =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.ValidateRefundAmount(0, 100_000, 0));

    [Fact]
    public void Omitting_the_amount_refunds_only_what_remains() =>
        Assert.Equal(25_000, PropertyPaymentRules.ValidateRefundAmount(null, 100_000, 75_000));

    [Fact]
    public void Refund_status_becomes_refunded_only_once_the_payment_is_whole()
    {
        Assert.False(PropertyPaymentRules.IsFullRefund(40_000, 100_000, 0));
        Assert.True(PropertyPaymentRules.IsFullRefund(40_000, 100_000, 60_000));
        Assert.True(PropertyPaymentRules.IsFullRefund(100_000, 100_000, 0));
    }

    [Fact]
    public void Remaining_refundable_never_goes_negative_on_legacy_over_refunded_rows() =>
        Assert.Equal(0, PropertyPaymentRules.RemainingRefundable(100_000, 250_000));

    // ---------- allocation against a charge ----------

    [Fact]
    public void An_overpayment_only_allocates_what_the_charge_still_owes() =>
        Assert.Equal(80_000, PropertyPaymentRules.AllocationCents(100_000, 80_000));

    [Fact]
    public void A_partial_payment_allocates_the_whole_payment() =>
        Assert.Equal(30_000, PropertyPaymentRules.AllocationCents(30_000, 80_000));

    [Fact]
    public void Nothing_is_allocated_to_an_already_settled_charge()
    {
        Assert.Equal(0, PropertyPaymentRules.AllocationCents(100_000, 0));
        Assert.Equal(0, PropertyPaymentRules.AllocationCents(100_000, -5_000));
    }

    // ---------- out-of-band recipients (Zelle email / Apple Cash phone) ----------

    [Theory]
    [InlineData("landlord@example.com", "landlord@example.com")]
    [InlineData("  Landlord@Example.COM  ", "landlord@example.com")]
    public void An_email_recipient_is_accepted_and_lowercased(string input, string expected) =>
        Assert.Equal(expected, PropertyPaymentRules.NormalizeRecipient(input, "Zelle recipient"));

    [Theory]
    [InlineData("5551234567", "+15551234567")]
    [InlineData("(555) 123-4567", "+15551234567")]
    [InlineData("555-123-4567", "+15551234567")]
    [InlineData("1 555 123 4567", "+15551234567")]
    [InlineData("+1 555 123 4567", "+15551234567")]
    public void A_us_mobile_number_is_normalized_to_e164(string input, string expected) =>
        Assert.Equal(expected, PropertyPaymentRules.NormalizeRecipient(input, "Apple Cash recipient"));

    [Fact]
    public void An_international_number_keeps_its_country_code() =>
        Assert.Equal("+447700900123", PropertyPaymentRules.NormalizeRecipient("+44 7700 900123", "Apple Cash recipient"));

    [Theory]
    [InlineData("not a recipient")]
    [InlineData("nobody@")]
    [InlineData("@example.com")]
    [InlineData("landlord@example")]
    [InlineData("land lord@example.com")]
    [InlineData("555")]
    [InlineData("12345")]
    public void A_malformed_recipient_is_rejected(string input) =>
        Assert.Throws<ArgumentException>(() => PropertyPaymentRules.NormalizeRecipient(input, "Zelle recipient"));

    [Fact]
    public void The_error_names_the_setting_so_the_admin_knows_which_field_is_wrong()
    {
        var error = Assert.Throws<ArgumentException>(
            () => PropertyPaymentRules.NormalizeRecipient("nope", "Apple Cash recipient"));
        Assert.Contains("Apple Cash recipient", error.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_blank_recipient_clears_the_setting(string? input) =>
        Assert.Null(PropertyPaymentRules.NormalizeRecipient(input, "Zelle recipient"));

    // ---------- the enums must not drift from the database constraints ----------

    [Fact]
    public void Provider_and_status_constraints_exist_in_the_schema()
    {
        foreach (var expected in new[]
        {
            "property_payments_amount_positive",
            "property_payments_provider_check",
            "property_payments_status_check",
            "property_rent_charges_amount_positive"
        })
            Assert.Contains(expected, DatabaseInitializer.PropertySchemaSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_rule_provider_is_allowed_by_the_database_constraint()
    {
        foreach (var provider in PropertyPaymentRules.Providers)
            Assert.Contains($"'{provider}'", DatabaseInitializer.PropertySchemaSql, StringComparison.Ordinal);
    }

    [Fact]
    public void Every_rule_status_is_allowed_by_the_database_constraint()
    {
        foreach (var status in PropertyPaymentRules.Statuses)
            Assert.Contains($"'{status}'", DatabaseInitializer.PropertySchemaSql, StringComparison.Ordinal);
    }
}
