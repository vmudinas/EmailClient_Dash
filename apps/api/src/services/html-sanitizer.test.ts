import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./html-sanitizer.js";

describe("sanitizeEmailHtml", () => {
  it("removes active content and blocks remote images from loading by default", () => {
    const value = sanitizeEmailHtml(`
      <script>alert(1)</script>
      <form action="https://evil.test"><input name="x"></form>
      <img src="https://tracker.test/pixel.gif" alt="pixel">
      <img src="cid:logo">
      <a href="https://example.test">Open</a>
    `);
    expect(value).not.toContain("<script");
    expect(value).not.toContain("<form");
    expect(value).not.toMatch(/<img[^>]*\ssrc="https:\/\/tracker\.test/);
    expect(value).toContain("cid:logo");
    expect(value).toContain("noopener noreferrer");
  });

  it("keeps a blocked remote image's URL in data-remote-src for an opt-in reveal", () => {
    const value = sanitizeEmailHtml('<img src="https://tracker.test/pixel.gif" alt="pixel">');
    expect(value).toContain('data-remote-src="https://tracker.test/pixel.gif"');
    expect(value).not.toMatch(/<img[^>]*\ssrc=/);
  });

  it("does not preserve a malformed or non-http(s) image source", () => {
    const value = sanitizeEmailHtml('<img src="javascript:alert(1)" alt="bad">');
    expect(value).not.toContain("javascript:");
    expect(value).not.toContain("data-remote-src");
  });
});

