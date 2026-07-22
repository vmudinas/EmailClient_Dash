using ArchiveMail.Api.Mail;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class ShipmentExtractorTests
{
    [Fact]
    public void ExtractsAmazonArrival()
    {
        var value = ShipmentExtractor.Extract("Amazon", "shipment-tracking@amazon.com",
            "Your order is arriving tomorrow", "Order #123-1234567 Tracking TBA123456789",
            "2026-07-21T12:00:00Z", null);
        Assert.NotNull(value);
        Assert.Equal("amazon", value.Carrier);
        Assert.Equal("2026-07-22", value.EstimatedDeliveryDate);
        Assert.Equal("TBA123456789", value.TrackingNumber);
    }

    [Fact]
    public void ExtractsUpsTrackingUrlAndStatus()
    {
        var value = ShipmentExtractor.Extract("UPS", "updates@ups.com", "Out for delivery",
            "Tracking number 1Z999AA10123456784", "2026-07-21T12:00:00Z", null);
        Assert.NotNull(value);
        Assert.Equal("ups", value.Carrier);
        Assert.Equal("out_for_delivery", value.Status);
        Assert.Contains("1Z999AA10123456784", value.TrackingUrl);
    }
}
