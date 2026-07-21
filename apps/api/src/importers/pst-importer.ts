import {
  PSTFile,
  PSTFolder,
  PSTMessage,
  type PSTAttachment,
  type PSTRecipient
} from "pst-extractor";
import type { EmailAddress } from "@email-client/shared";
import { sanitizeEmailHtml } from "../services/html-sanitizer.js";
import type { ImporterContext, NormalizedMessage, RawAttachment } from "./types.js";

interface FolderNode {
  folder: PSTFolder;
  path: string;
}

export async function importPstFile(sourcePath: string, context: ImporterContext): Promise<void> {
  const pst = new PSTFile(sourcePath);
  await importFromRootFolder(pst.getRootFolder(), context);
}

// Split out from importPstFile so tests can drive the folder-walking and
// error-tolerance logic against a fake PSTFolder tree without a real PST file.
export async function importFromRootFolder(root: PSTFolder, context: ImporterContext): Promise<void> {
  const folders = flattenFolders(root, (path, error) => context.onError("folder", error, path));
  const total = await countEmailMessages(folders, context);
  context.onTotal(total);
  let processed = 0;

  for (const node of folders) {
    let child: PSTMessage | null;
    try {
      node.folder.moveChildCursorTo(0);
      child = node.folder.getNextChild();
    } catch (error) {
      context.onError("folder", error, node.path);
      continue;
    }
    while (child != null) {
      if (context.signal.aborted) throw abortError();
      if (child instanceof PSTMessage && isEmailMessage(child.messageClass)) {
        const currentIndex = processed++;
        if (currentIndex >= context.startAfterMessage) {
          const sourceKey = `pst:${child.descriptorNodeId.toString()}`;
          try {
            await context.onMessage(normalizePstMessage(child, node.path), currentIndex, currentIndex);
          } catch (error) {
            context.onError("message", error, sourceKey);
          }
        }
        context.onProgress(processed, total, processed);
      }
      try {
        child = node.folder.getNextChild();
      } catch (error) {
        context.onError("folder", error, node.path);
        break;
      }
      await yieldToEventLoop();
    }
  }
}

async function countEmailMessages(
  folders: FolderNode[],
  context: Pick<ImporterContext, "signal" | "onError">
): Promise<number> {
  let count = 0;
  for (const node of folders) {
    let child: PSTMessage | null;
    try {
      node.folder.moveChildCursorTo(0);
      child = node.folder.getNextChild();
    } catch (error) {
      context.onError("folder", error, node.path);
      continue;
    }
    while (child != null) {
      if (context.signal.aborted) throw abortError();
      if (child instanceof PSTMessage && isEmailMessage(child.messageClass)) count += 1;
      try {
        child = node.folder.getNextChild();
      } catch (error) {
        context.onError("folder", error, node.path);
        break;
      }
      await yieldToEventLoop();
    }
  }
  return count;
}

export function normalizePstMessage(message: PSTMessage, folderPath: string): NormalizedMessage {
  const recipients = readRecipients(message);
  const sentAt = (message.clientSubmitTime ?? message.creationTime)?.toISOString() ?? null;
  const receivedAt = message.messageDeliveryTime?.toISOString() ?? sentAt;
  return {
    sourceKey: `pst:${message.descriptorNodeId.toString()}`,
    folderPath,
    internetMessageId: message.internetMessageId || null,
    subject: message.subject?.trim() || "(No subject)",
    sender: {
      name: message.senderName?.trim() || null,
      address: message.senderEmailAddress?.trim() || ""
    },
    to: recipients.to,
    cc: recipients.cc,
    bcc: recipients.bcc,
    sentAt,
    receivedAt,
    bodyText: message.body?.trim() || stripRtf(message.bodyRTF || ""),
    bodyHtml: message.bodyHTML ? sanitizeEmailHtml(message.bodyHTML) : null,
    headers: {
      "message-id": message.internetMessageId || "",
      "message-class": message.messageClass || "",
      "display-to": message.displayTo || "",
      "display-cc": message.displayCC || ""
    },
    sizeBytes: 0,
    attachments: readAttachments(message)
  };
}

// Some PST files carry orphaned internal search/system folders (e.g. Outlook's
// "To-Do Search", "ItemProcSearch") whose child-folder pointer is broken even
// though the folder itself holds no real mail. getSubFolders() throws for
// exactly that folder; treating it as childless (rather than aborting the
// whole import) loses nothing since these folders are never real mailboxes.
function flattenFolders(root: PSTFolder, onFolderError: (path: string, error: unknown) => void): FolderNode[] {
  const output: FolderNode[] = [];
  const visit = (folder: PSTFolder, parentPath: string) => {
    const name = folder.displayName?.trim() || (parentPath ? "Unnamed" : "Mailbox");
    const path = parentPath ? `${parentPath}/${name}` : name;
    output.push({ folder, path });
    let children: PSTFolder[];
    try {
      children = folder.getSubFolders();
    } catch (error) {
      onFolderError(path, error);
      return;
    }
    for (const child of children) visit(child, path);
  };
  visit(root, "");
  return output;
}

function readRecipients(message: PSTMessage): {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
} {
  const result: { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] } = {
    to: [],
    cc: [],
    bcc: []
  };
  for (let index = 0; index < message.numberOfRecipients; index += 1) {
    const recipient = message.getRecipient(index);
    if (!recipient) continue;
    const address = recipientToAddress(recipient);
    if (recipient.recipientType === 2) result.cc.push(address);
    else if (recipient.recipientType === 3) result.bcc.push(address);
    else result.to.push(address);
  }
  return result;
}

function recipientToAddress(recipient: PSTRecipient): EmailAddress {
  return {
    name: recipient.displayName?.trim() || null,
    address: recipient.smtpAddress?.trim() || recipient.emailAddress?.trim() || ""
  };
}

function readAttachments(message: PSTMessage): RawAttachment[] {
  const output: RawAttachment[] = [];
  for (let index = 0; index < message.numberOfAttachments; index += 1) {
    const attachment = message.getAttachment(index);
    const content = readAttachmentContent(attachment);
    if (!content) continue;
    output.push({
      filename: attachment.longFilename || attachment.filename || `attachment-${index + 1}`,
      contentType: attachment.mimeTag || "application/octet-stream",
      contentId: attachment.contentId?.replace(/^<|>$/g, "") || null,
      disposition: attachment.renderingPosition >= 0 ? "inline" : "attachment",
      content
    });
  }
  return output;
}

function readAttachmentContent(attachment: PSTAttachment): Buffer | null {
  const stream = attachment.fileInputStream;
  if (!stream) return null;
  const chunks: Buffer[] = [];
  const bufferSize = 64 * 1024;
  let remaining = attachment.filesize || attachment.size;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(bufferSize, remaining));
    const bytesRead = stream.read(buffer);
    if (!bytesRead) break;
    chunks.push(buffer.subarray(0, bytesRead));
    remaining -= bytesRead;
  }
  return Buffer.concat(chunks);
}

function isEmailMessage(messageClass: string): boolean {
  const normalized = messageClass.toUpperCase();
  return normalized.includes("IPM.NOTE")
    || normalized.startsWith("REPORT.")
    || normalized.startsWith("IPM.SCHEDULE.MEETING");
}

function stripRtf(value: string): string {
  return value
    .replace(/\\'[0-9a-f]{2}/gi, " ")
    .replace(/\\[a-z]+-?\d* ?/gi, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function abortError(): Error {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}
