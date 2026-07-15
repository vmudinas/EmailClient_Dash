import type { EmailAddress } from "@email-client/shared";

export interface RawAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  disposition: "inline" | "attachment";
  content: Buffer;
}

export interface NormalizedMessage {
  sourceKey: string;
  folderPath: string;
  internetMessageId: string | null;
  subject: string;
  sender: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  sentAt: string | null;
  receivedAt: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, string>;
  sizeBytes: number;
  attachments: RawAttachment[];
}

export interface ImporterContext {
  signal: AbortSignal;
  sourceName: string;
  startAfterMessage: number;
  totalItems: number | null;
  onMessage(message: NormalizedMessage, index: number, sourceOffset: number): Promise<void>;
  onTotal(total: number): void;
  onProgress(processed: number, total: number | null, sourceOffset: number): void;
  onError(stage: string, error: unknown, sourceKey?: string): void;
}
