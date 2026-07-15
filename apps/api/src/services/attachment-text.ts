import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Worker } from "node:worker_threads";
import sanitizeHtml from "sanitize-html";
import type { Attachment } from "@email-client/shared";

export interface ExtractedAttachmentText {
  text: string;
  status: Attachment["textStatus"];
}

const OFFICE_EXTENSIONS = new Set([
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".odp",
  ".ods",
  ".rtf",
  ".csv",
  ".md",
  ".html",
  ".htm"
]);

const PLAIN_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".ics",
  ".vcf"
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"]);
const IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/tiff",
  "image/bmp",
  "image/webp"
]);

export interface AttachmentTextExtractorOptions {
  workerUrl?: URL;
  workerExecArgv?: string[];
  workerTimeoutMs?: number;
}

interface WorkerResponse {
  id: string;
  result?: ExtractedAttachmentText;
  error?: string;
  stack?: string | null;
}

interface PendingExtraction {
  resolve(value: ExtractedAttachmentText): void;
  reject(error: Error): void;
  signal: AbortSignal;
  onAbort(): void;
  timeout: NodeJS.Timeout;
}

export class AttachmentTextExtractor {
  private worker: Worker | null = null;
  private readonly pending = new Map<string, PendingExtraction>();

  constructor(private readonly options: AttachmentTextExtractorOptions = {}) {}

  async extract(
    filename: string,
    contentType: string,
    content: Buffer,
    ocrEnabled: boolean,
    signal: AbortSignal
  ): Promise<ExtractedAttachmentText> {
    if (signal.aborted) throw abortError();
    const extension = extname(filename).toLowerCase();

    if (PLAIN_TEXT_EXTENSIONS.has(extension) || contentType.startsWith("text/plain")) {
      return { text: normalizeExtractedText(content.toString("utf8")), status: "indexed" };
    }

    if (extension === ".html" || extension === ".htm" || contentType === "text/html") {
      return {
        text: normalizeExtractedText(sanitizeHtml(content.toString("utf8"), { allowedTags: [] })),
        status: "indexed"
      };
    }

    if (OFFICE_EXTENSIONS.has(extension)) {
      return this.extractInWorker(filename, contentType, content, ocrEnabled, signal);
    }

    if (IMAGE_EXTENSIONS.has(extension) || IMAGE_CONTENT_TYPES.has(contentType.split(";", 1)[0]!.toLowerCase())) {
      if (!ocrEnabled) return { text: "", status: "unsupported" };
      return this.extractInWorker(filename, contentType, content, true, signal);
    }

    return { text: "", status: "unsupported" };
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Attachment text extractor closed");
    for (const pending of this.pending.values()) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (worker) await worker.terminate();
  }

  private extractInWorker(
    filename: string,
    contentType: string,
    content: Buffer,
    ocrEnabled: boolean,
    signal: AbortSignal
  ): Promise<ExtractedAttachmentText> {
    if (signal.aborted) return Promise.reject(abortError());
    const worker = this.getWorker();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const onAbort = () => this.failWorker(worker, abortError());
      const timeoutMs = Math.max(1, this.options.workerTimeoutMs ?? 60_000);
      const timeout = setTimeout(() => this.failWorker(
        worker,
        new Error(`Attachment text extraction timed out after ${Math.ceil(timeoutMs / 1_000)} seconds`)
      ), timeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, signal, onAbort, timeout });
      signal.addEventListener("abort", onAbort, { once: true });
      worker.postMessage({ id, filename, contentType, content, ocrEnabled });
    });
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const runningTypeScript = import.meta.url.endsWith(".ts");
    const worker = new Worker(this.options.workerUrl ?? new URL(
      runningTypeScript ? "./attachment-text-worker.ts" : "./attachment-text-worker.js",
      import.meta.url
    ), {
      execArgv: this.options.workerExecArgv ?? (runningTypeScript ? ["--import", "tsx"] : [])
    });
    this.worker = worker;
    worker.on("message", (response: WorkerResponse) => this.handleWorkerResponse(response));
    worker.on("error", (error) => this.failWorker(
      worker,
      new Error(`Attachment text worker crashed: ${error.message}`, { cause: error })
    ));
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.failWorker(worker, new Error(`Attachment text worker stopped unexpectedly (${code})`));
      }
    });
    return worker;
  }

  private handleWorkerResponse(response: WorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    pending.signal.removeEventListener("abort", pending.onAbort);
    clearTimeout(pending.timeout);
    if (response.result) {
      pending.resolve(response.result);
      return;
    }
    const error = new Error(response.error || "Attachment text extraction failed");
    if (response.stack) error.stack = response.stack;
    pending.reject(error);
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const pending of this.pending.values()) {
      pending.signal.removeEventListener("abort", pending.onAbort);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    void worker.terminate().catch(() => undefined);
  }
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

function abortError(): Error {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}
