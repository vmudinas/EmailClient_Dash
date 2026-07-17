import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  "html",
  "head",
  "body",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "colgroup",
  "col",
  "img",
  "figure",
  "figcaption",
  "section",
  "article"
];

export function sanitizeEmailHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["class", "title", "dir", "lang", "aria-label"],
      a: ["href", "name", "title", "target", "rel"],
      img: ["src", "alt", "title", "width", "height", "data-remote-src"],
      table: ["width", "cellpadding", "cellspacing", "border", "role"],
      td: ["width", "height", "colspan", "rowspan", "align", "valign"],
      th: ["width", "height", "colspan", "rowspan", "align", "valign"],
      col: ["width", "span"]
    },
    allowedSchemes: ["mailto", "cid", "data", "http", "https"],
    allowedSchemesByTag: {
      img: ["cid", "data"],
      a: ["mailto", "http", "https"]
    },
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: "a",
        attribs: {
          ...attribs,
          target: "_blank",
          rel: "noopener noreferrer"
        }
      }),
      img: (_tagName, attribs) => {
        const source = attribs.src ?? "";
        if (!source.startsWith("cid:") && !source.startsWith("data:")) {
          // Remote images are blocked by default (they're a common tracking/read-receipt
          // vector), but a well-formed http(s) URL is kept in data-remote-src so the reader
          // can offer a one-time "Show images" action instead of losing it permanently at
          // import time. Anything else (unknown schemes, malformed values) is just dropped.
          const { src: _removed, ...safeAttribs } = attribs;
          const nextAttribs: Record<string, string> = {
            ...safeAttribs,
            alt: attribs.alt || "Remote image blocked"
          };
          if (/^https?:\/\//i.test(source)) nextAttribs["data-remote-src"] = source;
          return { tagName: "img", attribs: nextAttribs };
        }
        return { tagName: "img", attribs };
      }
    },
    disallowedTagsMode: "discard"
  });
}

