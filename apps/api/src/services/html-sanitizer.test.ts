import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./html-sanitizer.js";

describe("sanitizeEmailHtml", () => {
  it("removes active content and blocks remote images", () => {
    const value = sanitizeEmailHtml(`
      <script>alert(1)</script>
      <form action="https://evil.test"><input name="x"></form>
      <img src="https://tracker.test/pixel.gif" alt="pixel">
      <img src="cid:logo">
      <a href="https://example.test">Open</a>
    `);
    expect(value).not.toContain("<script");
    expect(value).not.toContain("<form");
    expect(value).not.toContain("tracker.test");
    expect(value).toContain("cid:logo");
    expect(value).toContain("noopener noreferrer");
  });
});

