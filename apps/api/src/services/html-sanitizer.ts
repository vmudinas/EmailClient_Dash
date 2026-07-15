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
      img: ["src", "alt", "title", "width", "height"],
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
          const { src: _removed, ...safeAttribs } = attribs;
          return { tagName: "img", attribs: { ...safeAttribs, alt: attribs.alt || "Remote image blocked" } };
        }
        return { tagName: "img", attribs };
      }
    },
    disallowedTagsMode: "discard"
  });
}

