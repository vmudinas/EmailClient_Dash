using AngleSharp.Html.Parser;

namespace ArchiveMail.Api.Imports;

public static class EmailHtmlSanitizer
{
    private static readonly HashSet<string> AllowedTags = new(StringComparer.OrdinalIgnoreCase)
    {
        "a", "abbr", "address", "article", "b", "blockquote", "br", "caption", "cite",
        "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt", "em",
        "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img",
        "li", "mark", "ol", "p", "pre", "q", "s", "section", "small", "span", "strong",
        "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul"
    };

    private static readonly HashSet<string> AllowedAttributes = new(StringComparer.OrdinalIgnoreCase)
    {
        "align", "alt", "aria-label", "border", "cellpadding", "cellspacing", "class", "colspan",
        "data-remote-src", "dir", "height", "href", "lang", "name", "rel", "role", "rowspan",
        "span", "src", "target", "title", "valign", "width"
    };

    public static string? Sanitize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var parser = new HtmlParser();
        var document = parser.ParseDocument(value);
        foreach (var element in document.All.ToArray())
        {
            if (element.LocalName is "html" or "head" or "body") continue;
            if (!AllowedTags.Contains(element.LocalName))
            {
                element.Remove();
                continue;
            }
            foreach (var attribute in element.Attributes.ToArray())
                if (!AllowedAttributes.Contains(attribute.Name)) element.RemoveAttribute(attribute.Name);
        }
        foreach (var anchor in document.QuerySelectorAll("a"))
        {
            var href = anchor.GetAttribute("href")?.Trim();
            if (!IsAllowedLink(href)) anchor.RemoveAttribute("href");
            anchor.SetAttribute("target", "_blank");
            anchor.SetAttribute("rel", "noopener noreferrer");
        }
        foreach (var image in document.QuerySelectorAll("img"))
        {
            var source = image.GetAttribute("src")?.Trim() ?? "";
            if (source.StartsWith("//", StringComparison.Ordinal)) source = $"https:{source}";
            if (Uri.TryCreate(source, UriKind.Absolute, out var uri)
                && uri.Scheme is "http" or "https")
            {
                image.RemoveAttribute("src");
                image.SetAttribute("data-remote-src", uri.AbsoluteUri);
                if (string.IsNullOrWhiteSpace(image.GetAttribute("alt")))
                    image.SetAttribute("alt", "Remote image blocked");
            }
            else if (!source.StartsWith("cid:", StringComparison.OrdinalIgnoreCase)
                     && !source.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            {
                image.RemoveAttribute("src");
                image.RemoveAttribute("data-remote-src");
            }
        }
        return document.Body?.InnerHtml ?? "";
    }

    private static bool IsAllowedLink(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.StartsWith('#')) return true;
        return Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" or "mailto";
    }
}
