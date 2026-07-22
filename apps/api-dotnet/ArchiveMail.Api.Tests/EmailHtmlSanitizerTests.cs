using ArchiveMail.Api.Imports;
using System.Text.RegularExpressions;
using Xunit;

namespace ArchiveMail.Api.Tests;

public sealed class EmailHtmlSanitizerTests
{
    [Fact]
    public void RemovesActiveContentAndBlocksRemoteImages()
    {
        var result = EmailHtmlSanitizer.Sanitize("""
            <script>alert(1)</script><form action="https://evil.test"><input name="x"></form>
            <img src="https://tracker.test/pixel.gif" alt="pixel"><img src="cid:logo">
            <a href="https://example.test">Open</a>
            """)!;

        Assert.DoesNotContain("<script", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<form", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotMatch(new Regex("<img[^>]*\\ssrc=\\\"https://tracker\\.test", RegexOptions.IgnoreCase), result);
        Assert.Contains("data-remote-src=\"https://tracker.test/pixel.gif\"", result, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("src=\"cid:logo\"", result, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("noopener noreferrer", result, StringComparison.Ordinal);
    }

    [Fact]
    public void DropsExecutableOrMalformedImageSources()
    {
        var result = EmailHtmlSanitizer.Sanitize("<img src=\"javascript:alert(1)\" alt=\"bad\">")!;
        Assert.DoesNotContain("javascript:", result, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("data-remote-src", result, StringComparison.OrdinalIgnoreCase);
    }
}
