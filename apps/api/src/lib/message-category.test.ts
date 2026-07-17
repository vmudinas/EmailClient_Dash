import { describe, expect, it } from "vitest";
import { classifyInboxCategory, gmailInboxCategory } from "./message-category.js";

describe("message categories", () => {
  it("uses Gmail category labels when available", () => {
    expect(gmailInboxCategory(["INBOX", "CATEGORY_PROMOTIONS"])).toBe("promotions");
    expect(gmailInboxCategory(["CATEGORY_SOCIAL"])).toBe("social");
    expect(gmailInboxCategory(["CATEGORY_FORUMS"])).toBe("updates");
    expect(gmailInboxCategory(["INBOX", "CATEGORY_PERSONAL"])).toBe("primary");
  });

  it("classifies imported mail with deterministic header and sender signals", () => {
    expect(classifyInboxCategory({
      senderAddress: "news@store.example",
      subject: "Weekend sale",
      bodyText: "Save 30% today",
      headers: { "list-unsubscribe": "<mailto:leave@store.example>" }
    })).toBe("promotions");
    expect(classifyInboxCategory({
      senderAddress: "messages-noreply@linkedin.com",
      subject: "A new connection request",
      bodyText: "",
      headers: {}
    })).toBe("social");
    expect(classifyInboxCategory({
      senderAddress: "no-reply@bank.example",
      subject: "Your monthly statement is ready",
      bodyText: "",
      headers: {}
    })).toBe("updates");
    expect(classifyInboxCategory({
      senderAddress: "manager@example.com",
      subject: "Project plan",
      bodyText: "Can we review this tomorrow?",
      headers: {}
    })).toBe("primary");
  });
});
