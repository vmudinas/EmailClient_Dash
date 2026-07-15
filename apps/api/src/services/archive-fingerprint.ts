import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { ImportSourceType } from "@email-client/shared";

export interface ArchiveFingerprint {
  hash: string;
  totalMessages: number | null;
}

export async function fingerprintArchive(
  sourcePath: string,
  sourceType: ImportSourceType,
  signal: AbortSignal,
  onProgress: (bytesRead: number) => void
): Promise<ArchiveFingerprint> {
  const hash = createHash("sha256");
  const counter = sourceType === "mbox" ? new MboxMessageCounter() : null;
  const stream = createReadStream(sourcePath);
  const abort = () => stream.destroy(abortError());
  signal.addEventListener("abort", abort, { once: true });

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      counter?.add(buffer);
      onProgress(stream.bytesRead);
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }

  return {
    hash: hash.digest("hex"),
    totalMessages: counter?.count ?? null
  };
}

export class MboxMessageCounter {
  private readonly prefix = Buffer.from("From ");
  private atLineStart = true;
  private prefixIndex = 0;
  count = 0;

  add(chunk: Buffer): void {
    for (const byte of chunk) {
      if (!this.atLineStart) {
        if (byte === 0x0a) this.atLineStart = true;
        continue;
      }

      if (byte === this.prefix[this.prefixIndex]) {
        this.prefixIndex += 1;
        if (this.prefixIndex === this.prefix.length) {
          this.count += 1;
          this.atLineStart = false;
          this.prefixIndex = 0;
        }
        continue;
      }

      this.prefixIndex = 0;
      this.atLineStart = byte === 0x0a;
    }
  }
}

function abortError(): Error {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}
