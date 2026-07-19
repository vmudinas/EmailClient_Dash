import { DEFAULT_INBOX_TABS } from "@email-client/shared";
import { describe, expect, it } from "vitest";
import { classifyInboxCategory, classifyInboxCategoryWithTabs, gmailInboxCategory } from "./message-category.js";

describe("message categories", () => {
  it("uses Gmail category labels when available", () => {
    expect(gmailInboxCategory(["INBOX", "CATEGORY_PROMOTIONS"])).toBe("promotions");
    expect(gmailInboxCategory(["CATEGORY_SOCIAL"])).toBe("social");
    expect(gmailInboxCategory(["CATEGORY_FORUMS"])).toBe("updates");
    expect(gmailInboxCategory(["INBOX", "CATEGORY_PERSONAL"])).toBe("primary");
  });

  it("classifies imported mail with deterministic header and sender signals", () => {
    expect(classifyInboxCategory({
      senderAddress: "billing@utility.example",
      subject: "Your utility bill is ready",
      bodyText: "Payment due July 30",
      headers: { "x-archive-mail-gmail-label-ids": "CATEGORY_UPDATES" }
    })).toBe("bills");
    expect(classifyInboxCategory({
      senderAddress: "notifications@mychart.example",
      subject: "New lab results in your patient portal",
      bodyText: "Your doctor posted a result.",
      headers: { "x-archive-mail-gmail-label-ids": "CATEGORY_UPDATES" }
    })).toBe("medical");
    expect(classifyInboxCategory({
      senderAddress: "tracking@fedex.com",
      subject: "Your package is out for delivery",
      bodyText: "Tracking number 123",
      headers: { "x-archive-mail-gmail-label-ids": "CATEGORY_UPDATES" }
    })).toBe("mail_tracking");
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
    })).toBe("bills");
    expect(classifyInboxCategory({
      senderAddress: "manager@example.com",
      subject: "Project plan",
      bodyText: "Can we review this tomorrow?",
      headers: {}
    })).toBe("primary");
  });

  it("keeps a renamed strict tab keyword-only and matches short keywords as complete terms", () => {
    const tabs = DEFAULT_INBOX_TABS.map((tab) => tab.id === "medical" ? {
      ...tab,
      label: "Jobs",
      description: "Development jobs",
      keywords: ["ai", "python", ".net", "aws", "c#", "job"],
      keywordOnly: true
    } : tab);

    expect(classifyInboxCategoryWithTabs({
      senderAddress: "recruiter@example.test",
      subject: "AI Engineer job using Python and AWS",
      bodyText: "C# and .NET experience preferred.",
      headers: {}
    }, tabs)).toBe("medical");
    expect(classifyInboxCategoryWithTabs({
      senderAddress: "clinic@example.test",
      subject: "Doctor appointment available",
      bodyText: "Details were sent by email.",
      headers: {}
    }, tabs)).toBe("primary");
    expect(classifyInboxCategoryWithTabs({
      senderAddress: "news@example.test",
      subject: "Your email details are available",
      bodyText: "General account information.",
      headers: {}
    }, tabs)).toBe("primary");
  });
});
