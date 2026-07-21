import { describe, expect, it, vi } from "vitest";
import { PSTMessage, type PSTFolder, type PSTRecipient } from "pst-extractor";
import { importFromRootFolder, normalizePstMessage } from "./pst-importer.js";
import type { ImporterContext } from "./types.js";

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

describe("importFromRootFolder", () => {
  it("skips a folder whose child list can't be read instead of aborting the whole import", async () => {
    const goodMessage = fakeMessage("11", "Kept message");
    const inbox = fakeFolder({
      name: "Inbox",
      children: [goodMessage]
    });
    const brokenSearchFolder = fakeFolder({
      name: "To-Do Search",
      children: [],
      getSubFoldersError: new Error("PSTFile::findBtreeItem Unable to find 524334 is desc: true")
    });
    const root = fakeFolder({
      name: "Mailbox",
      subfolders: [inbox, brokenSearchFolder]
    });

    const onMessage = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const context: ImporterContext = {
      signal: new AbortController().signal,
      sourceName: "mailexport.pst",
      startAfterMessage: 0,
      totalItems: null,
      onMessage,
      onTotal: vi.fn(),
      onProgress: vi.fn(),
      onError
    };

    await importFromRootFolder(root, context);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ subject: "Kept message" });
    expect(onError).toHaveBeenCalledWith(
      "folder",
      expect.objectContaining({ message: expect.stringContaining("findBtreeItem") }),
      "Mailbox/To-Do Search"
    );
  });
});

interface FakeFolderOptions {
  name: string;
  children?: PSTMessage[];
  subfolders?: PSTFolder[];
  getSubFoldersError?: Error;
}

function fakeFolder(options: FakeFolderOptions): PSTFolder {
  const children = options.children ?? [];
  let cursor = 0;
  return {
    displayName: options.name,
    moveChildCursorTo: (index: number) => { cursor = index; },
    getNextChild: () => (cursor < children.length ? children[cursor++] : null),
    getSubFolders: () => {
      if (options.getSubFoldersError) throw options.getSubFoldersError;
      return options.subfolders ?? [];
    }
  } as unknown as PSTFolder;
}

function fakeMessage(nodeId: string, subject: string): PSTMessage {
  // importFromRootFolder checks `instanceof PSTMessage`, so the fake must
  // actually chain to the real prototype rather than just structurally match.
  // PSTMessage's real fields are getter-only, so plain assignment (which the
  // prototype chain intercepts) throws — Object.defineProperties creates
  // shadowing own data properties instead, bypassing the inherited getters.
  const message = Object.create(PSTMessage.prototype) as PSTMessage;
  Object.defineProperties(message, Object.fromEntries(
    Object.entries({
      descriptorNodeId: { toString: () => nodeId },
      messageClass: "IPM.Note",
      internetMessageId: `<${nodeId}@example.test>`,
      subject,
      senderName: "Sender",
      senderEmailAddress: "sender@example.test",
      clientSubmitTime: new Date("2026-07-01T10:00:00.000Z"),
      creationTime: null,
      messageDeliveryTime: null,
      body: "Body",
      bodyRTF: "",
      bodyHTML: null,
      displayTo: "",
      displayCC: "",
      numberOfRecipients: 0,
      getRecipient: () => null,
      numberOfAttachments: 0,
      getAttachment: () => { throw new Error("No attachments"); }
    }).map(([key, value]) => [key, { value, enumerable: true, configurable: true }])
  ));
  return message;
}

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

