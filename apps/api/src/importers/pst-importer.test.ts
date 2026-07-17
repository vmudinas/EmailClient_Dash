import { describe, expect, it } from "vitest";
import type { PSTMessage, PSTRecipient } from "pst-extractor";
import { normalizePstMessage } from "./pst-importer.js";

describe("normalizePstMessage", () => {
  it("normalizes PST email properties and recipient groups", () => {
    const recipients = [
      fakeRecipient(1, "Maya Chen", "maya@example.test"),
      fakeRecipient(2, "Eli Turner", "eli@example.test")
    ];
    const message = {
      descriptorNodeId: { toString: () => "42" },
      internetMessageId: "<pst@example.test>",
      subject: "PST fixture",
      senderName: "Priya Shah",
      senderEmailAddress: "priya@example.test",
      clientSubmitTime: new Date("2026-07-01T10:00:00.000Z"),
      creationTime: null,
      messageDeliveryTime: new Date("2026-07-01T10:01:00.000Z"),
      body: "A normalized PST message.",
      bodyRTF: "",
      bodyHTML: "<p>A normalized <strong>PST</strong> message.</p><script>bad()</script>",
      messageClass: "IPM.Note",
      displayTo: "Maya Chen",
      displayCC: "Eli Turner",
      numberOfRecipients: recipients.length,
      getRecipient: (index: number) => recipients[index] ?? null,
      numberOfAttachments: 0,
      getAttachment: () => {
        throw new Error("No attachments");
      }
    } as unknown as PSTMessage;

    const normalized = normalizePstMessage(message, "Mailbox/Inbox");
    expect(normalized.sourceKey).toBe("pst:42");
    expect(normalized.to[0]?.address).toBe("maya@example.test");
    expect(normalized.cc[0]?.address).toBe("eli@example.test");
    expect(normalized.bodyHtml).not.toContain("<script");
    expect(normalized.receivedAt).toBe("2026-07-01T10:01:00.000Z");
  });
});

function fakeRecipient(
  recipientType: number,
  displayName: string,
  address: string
): PSTRecipient {
  return {
    recipientType,
    displayName,
    smtpAddress: address,
    emailAddress: address
  } as unknown as PSTRecipient;
}

