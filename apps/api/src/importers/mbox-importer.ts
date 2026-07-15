import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MboxStream } from "node-mbox";
import {
  simpleParser,
  type AddressObject,
  type ParsedMail
} from "mailparser";
import type { EmailAddress } from "@email-client/shared";
import { sanitizeEmailHtml } from "../services/html-sanitizer.js";
import type { ImporterContext, NormalizedMessage, RawAttachment } from "./types.js";

export async function importMboxFile(sourcePath: string, context: ImporterContext): Promise<void> {
  if (context.signal.aborted) throw abortError();
  const source = createReadStream(sourcePath);
  const mailbox = MboxStream(source);
  let index = 0;

  const abort = () => source.destroy();
  const forwardSourceError = (error: Error) => mailbox.destroy(error);
  context.signal.addEventListener("abort", abort, { once: true });
  source.on("error", forwardSourceError);

  try {
    const consumer = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const messageBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const currentIndex = index++;
        void consumeMessage(
          messageBuffer,
          currentIndex,
          context.sourceName,
          source.bytesRead,
          context
        ).then(() => callback(), callback);
      }
    });
    await pipeline(mailbox, consumer, { signal: context.signal });
  } finally {
    context.signal.removeEventListener("abort", abort);
    source.removeListener("error", forwardSourceError);
    source.destroy();
  }
}

async function consumeMessage(
  messageBuffer: Buffer,
  currentIndex: number,
  sourceName: string,
  sourceOffset: number,
  context: ImporterContext
): Promise<void> {
  if (context.signal.aborted) throw abortError();
  if (currentIndex < context.startAfterMessage) {
    context.onProgress(currentIndex + 1, context.totalItems, sourceOffset);
    return;
  }

  try {
    const parsed = await simpleParser(messageBuffer, {
      skipImageLinks: true,
      keepCidLinks: true
    });
    const message = normalizeMboxMessage(
      parsed,
      messageBuffer,
      currentIndex,
      basename(sourceName)
    );
    await context.onMessage(message, currentIndex, sourceOffset);
  } catch (error) {
    if (context.signal.aborted || errorName(error) === "AbortError") throw abortError();
    context.onError("message", error, `mbox:${currentIndex}`);
  }
  context.onProgress(currentIndex + 1, context.totalItems, sourceOffset);
}

export function normalizeMboxMessage(
  parsed: ParsedMail,
  raw: Buffer,
  index: number,
  archiveName: string
): NormalizedMessage {
  return normalizeRfc822Message(
    parsed,
    raw,
    `mbox:${index}:${parsed.messageId ?? ""}`,
    archiveName.replace(/\.(mbox|mbx)$/i, "") || "Archive"
  );
}

export function normalizeRfc822Message(
  parsed: ParsedMail,
  raw: Buffer,
  sourceKey: string,
  folderPath: string
): NormalizedMessage {
  const to = normalizeAddresses(parsed.to);
  const cc = normalizeAddresses(parsed.cc);
  const bcc = normalizeAddresses(parsed.bcc);
  const sender = normalizeAddresses(parsed.from)[0] ?? { name: null, address: "" };
  const date = parsed.date?.toISOString() ?? null;
  return {
    sourceKey,
    folderPath,
    internetMessageId: parsed.messageId ?? null,
    subject: parsed.subject?.trim() || "(No subject)",
    sender,
    to,
    cc,
    bcc,
    sentAt: date,
    receivedAt: date,
    bodyText: parsed.text?.trim() || "",
    bodyHtml: typeof parsed.html === "string" ? sanitizeEmailHtml(parsed.html) : null,
    headers: normalizeHeaders(parsed.headers),
    sizeBytes: raw.byteLength,
    attachments: parsed.attachments.map((attachment, attachmentIndex): RawAttachment => ({
      filename: attachment.filename || `attachment-${attachmentIndex + 1}`,
      contentType: attachment.contentType || "application/octet-stream",
      contentId: trimContentId(attachment.contentId),
      disposition: attachment.contentDisposition === "inline" ? "inline" : "attachment",
      content: attachment.content
    }))
  };
}

function normalizeAddresses(
  input: AddressObject | AddressObject[] | undefined
): EmailAddress[] {
  const groups = !input ? [] : Array.isArray(input) ? input : [input];
  return groups.flatMap((group) => group.value.map((entry) => ({
    name: entry.name?.trim() || null,
    address: entry.address?.trim() || ""
  }))).filter((entry) => entry.name || entry.address);
}

function normalizeHeaders(headers: Map<string, unknown>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (value instanceof Date) output[key] = value.toISOString();
    else if (typeof value === "string") output[key] = value;
    else if (value !== undefined && value !== null) output[key] = JSON.stringify(value);
  }
  return output;
}

function trimContentId(value: string | undefined): string | null {
  return value?.replace(/^<|>$/g, "") || null;
}

function abortError(): Error {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}

function errorName(error: unknown): string | null {
  return error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name ?? "")
    : null;
}
