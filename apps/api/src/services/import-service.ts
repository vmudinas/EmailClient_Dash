import { randomUUID } from "node:crypto";
import { access, rm, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type {
  ImportJob,
  ImportOptions,
  ImportSourceType
} from "@email-client/shared";
import type { ImporterContext, NormalizedMessage, RawAttachment } from "../importers/types.js";
import { importMboxFile } from "../importers/mbox-importer.js";
import { importPstFile } from "../importers/pst-importer.js";
import { BlobStore } from "../storage/blob-store.js";
import {
  UNKNOWN_DATE_FOLDER_NAME,
  type AttachmentInput,
  type EmailStore,
  type ImportJobRecord
} from "../storage/database.js";
import { AttachmentTextExtractor } from "./attachment-text.js";
import { fingerprintArchive } from "./archive-fingerprint.js";

export class UnsupportedArchiveError extends Error {}

export class ImportService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly folderCache = new Map<string, Map<string, string>>();
  private readonly extractor = new AttachmentTextExtractor();

  constructor(
    readonly database: EmailStore,
    readonly blobStore: BlobStore
  ) {}

  async initialize(): Promise<void> {
    await this.blobStore.initialize();
  }

  async startImport(
    sourcePath: string,
    options: ImportOptions,
    temporarySource = false,
    sourceName = basename(sourcePath)
  ): Promise<ImportJob> {
    const sourceType = sourceTypeFromPath(sourcePath);
    const file = await stat(sourcePath);
    if (!file.isFile()) throw new UnsupportedArchiveError("The selected source is not a file");

    const archiveId = randomUUID();
    this.database.createArchive({
      id: archiveId,
      name: sourceName,
      sourceType,
      fingerprint: `pending:${archiveId}`,
      sizeBytes: file.size,
      replaceArchiveId: options.replaceArchiveId
    });
    const job = this.database.createImportJob({
      archiveId,
      sourcePath,
      sourceName,
      sourceType,
      sizeBytes: file.size,
      ocrEnabled: options.ocrEnabled,
      temporarySource
    });
    this.database.recordDiagnostic({
      level: "info",
      category: "import",
      message: `Import queued for ${sourceName}`,
      jobId: job.id,
      archiveId,
      sourceName,
      context: { sourceType, sizeBytes: file.size, ocrEnabled: options.ocrEnabled, temporarySource }
    });
    this.launchJob(job.id);
    return job;
  }

  async cancelImport(jobId: string): Promise<ImportJob> {
    const job = this.database.getImportJob(jobId);
    if (!job) throw new Error("Import job not found");
    const controller = this.controllers.get(jobId);
    if (controller) controller.abort();
    const cancelled = this.database.updateImportJob(jobId, {
      status: "cancelled",
      canResume: true,
      message: "Import cancelled"
    });
    this.database.recordDiagnostic({
      level: "warning",
      category: "import",
      message: "Import cancelled by the user",
      jobId,
      archiveId: job.archiveId,
      sourceName: job.sourceName
    });
    return cancelled;
  }

  async resumeImport(jobId: string): Promise<ImportJob> {
    const job = this.database.getImportJobRecord(jobId);
    if (!job) throw new Error("Import job not found");
    if (this.controllers.has(jobId)) return this.database.getImportJob(jobId)!;
    await access(job.sourcePath);
    const updated = this.database.updateImportJob(jobId, {
      status: "queued",
      canResume: false,
      message: "Queued to resume"
    });
    this.database.resumeArchive(job.archiveId);
    this.database.recordDiagnostic({
      level: "info",
      category: "import",
      message: "Import queued to resume from its checkpoint",
      jobId,
      archiveId: job.archiveId,
      sourceName: job.sourceName,
      context: { checkpoint: job.checkpoint }
    });
    this.launchJob(jobId);
    return updated;
  }

  async clearImport(jobId: string): Promise<void> {
    const job = this.database.getImportJobRecord(jobId);
    if (!job) throw new Error("Import job not found");
    if (job.status === "running" || job.status === "queued") {
      throw new Error("Stop the import before clearing it");
    }

    const run = this.runs.get(jobId);
    if (run) await run;
    this.database.deleteUploadSessionsForJob(jobId);

    const partialImport = job.status === "paused" || job.status === "cancelled" || job.status === "failed";
    if (partialImport) {
      await this.removeArchive(job.archiveId);
    } else if (!this.database.deleteImportJob(jobId)) {
      throw new Error("Import job not found");
    }

    this.database.recordDiagnostic({
      level: "info",
      category: "import",
      message: `Import cleared: ${job.sourceName}`,
      jobId,
      archiveId: job.archiveId,
      sourceName: job.sourceName,
      context: { partialDataRemoved: partialImport }
    });
  }

  async removeArchive(archiveId: string): Promise<void> {
    const archive = this.database.getArchive(archiveId);
    const jobs = this.database.listImportJobRecordsForArchive(archiveId);
    for (const job of jobs) this.controllers.get(job.id)?.abort();
    await Promise.allSettled(
      jobs.map((job) => this.runs.get(job.id)).filter((run): run is Promise<void> => Boolean(run))
    );
    const paths = this.database.deleteArchive(archiveId);
    const temporarySources = jobs
      .filter((job) => job.temporarySource)
      .map((job) => job.sourcePath);
    await Promise.all([
      ...paths.map((path) => this.blobStore.remove(path)),
      ...temporarySources.map((path) => rm(path, { force: true }))
    ]);
    this.folderCache.delete(archiveId);
    this.database.recordDiagnostic({
      level: "info",
      category: "system",
      message: `Archive removed${archive ? `: ${archive.name}` : ""}`,
      archiveId,
      sourceName: archive?.name ?? null
    });
  }

  async removeFolder(folderId: string): Promise<void> {
    const folder = this.database.getFolder(folderId);
    if (!folder) throw new Error("Mailbox not found");
    const paths = this.database.deleteFolder(folderId);
    await Promise.all(paths.map((path) => this.blobStore.remove(path)));
    this.folderCache.delete(folder.archiveId);
    this.database.recordDiagnostic({
      level: "info",
      category: "system",
      message: `Mailbox removed: ${folder.path}`,
      archiveId: folder.archiveId,
      sourceName: folder.name,
      context: { folderId, path: folder.path }
    });
  }

  async persistNormalizedMessage(input: {
    archiveId: string;
    message: NormalizedMessage;
    ocrEnabled: boolean;
    signal: AbortSignal;
    onAttachmentError?(error: unknown, attachment: RawAttachment): void;
  }): Promise<boolean> {
    if (this.database.hasMessage(input.archiveId, input.message.sourceKey)) return false;
    const folderId = this.ensureFolderPath(
      input.archiveId,
      destinationFolderPath(input.message)
    );
    const attachments = await mapWithConcurrency(
      input.message.attachments,
      2,
      async (attachment) => this.persistAttachment(
        attachment,
        input.ocrEnabled,
        input.signal,
        input.onAttachmentError
      )
    );

    this.database.insertMessage({
      archiveId: input.archiveId,
      folderId,
      sourceKey: input.message.sourceKey,
      internetMessageId: input.message.internetMessageId,
      subject: input.message.subject,
      sender: input.message.sender,
      to: input.message.to,
      cc: input.message.cc,
      bcc: input.message.bcc,
      sentAt: input.message.sentAt,
      receivedAt: input.message.receivedAt,
      bodyText: input.message.bodyText,
      bodyHtml: input.message.bodyHtml,
      headers: input.message.headers,
      sizeBytes: input.message.sizeBytes,
      attachments
    });
    return true;
  }

  invalidateFolderCache(archiveId: string): void {
    this.folderCache.delete(archiveId);
  }

  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.runs.values());
    await this.extractor.close();
  }

  private launchJob(jobId: string): void {
    if (this.runs.has(jobId)) return;
    const run = this.runJob(jobId);
    this.runs.set(jobId, run);
    void run.finally(() => {
      if (this.runs.get(jobId) === run) this.runs.delete(jobId);
    }).catch(() => undefined);
  }

  private async runJob(jobId: string): Promise<void> {
    if (this.controllers.has(jobId)) return;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);

    try {
      const job = this.requireJob(jobId);
      this.database.recordDiagnostic({
        level: "info",
        category: "import",
        message: "Import worker started",
        jobId,
        archiveId: job.archiveId,
        sourceName: job.sourceName,
        context: { checkpoint: job.checkpoint }
      });
      const file = await stat(job.sourcePath);
      this.database.updateImportJob(jobId, {
        status: "running",
        phase: "fingerprinting",
        processedBytes: 0,
        totalBytes: file.size,
        canResume: false,
        message: job.sourceType === "mbox"
          ? "Scanning archive and counting emails"
          : "Scanning archive"
      });
      const fingerprint = await fingerprintArchive(
        job.sourcePath,
        job.sourceType,
        controller.signal,
        (bytesRead) => this.updateByteProgressThrottled(jobId, bytesRead, file.size, {
          ...job.checkpoint,
          fingerprintBytes: bytesRead
        })
      );
      this.database.updateArchiveFingerprint(job.archiveId, fingerprint.hash, file.size);

      const existing = this.database.findReadyArchiveByFingerprint(fingerprint.hash);
      const replacing = this.database.getReplaceArchiveId(job.archiveId);
      if (existing && existing.id !== replacing) {
        throw new Error(`This archive is already imported as "${existing.name}"`);
      }

      const startAfterMessage = Number(job.checkpoint.messageIndex ?? 0);
      const knownTotal = job.sourceType === "mbox" ? fingerprint.totalMessages : job.totalItems;
      this.database.updateImportJob(jobId, {
        phase: "parsing",
        processedItems: startAfterMessage,
        totalItems: knownTotal,
        processedBytes: 0,
        message: job.sourceType === "pst" ? "Counting email messages" : "Importing messages"
      });

      let lastProgressWrite = 0;
      let latestProcessed = startAfterMessage;
      let latestTotal: number | null = knownTotal;
      let latestSourceOffset = Number(job.checkpoint.sourceOffset ?? 0);
      const context: ImporterContext = {
        signal: controller.signal,
        sourceName: job.sourceName,
        startAfterMessage,
        totalItems: knownTotal,
        onMessage: async (
          message: NormalizedMessage,
          index: number,
          sourceOffset: number
        ) => {
          if (controller.signal.aborted) throw abortError();
          latestProcessed = index + 1;
          latestSourceOffset = sourceOffset;
          await this.persistMessage(job, message, controller.signal);
          if (Date.now() - lastProgressWrite > 200) {
            lastProgressWrite = Date.now();
            this.database.updateImportJob(jobId, {
              processedItems: index + 1,
              processedBytes: job.sourceType === "mbox" ? sourceOffset : 0,
              checkpoint: { messageIndex: index + 1, sourceOffset },
              message: "Importing messages"
            });
          }
        },
        onTotal: (total: number) => {
          latestTotal = total;
          context.totalItems = total;
          this.database.updateImportJob(jobId, {
            totalItems: total,
            message: "Importing messages"
          });
        },
        onProgress: (processed: number, total: number | null, sourceOffset: number) => {
          const reportedProcessed = Math.max(startAfterMessage, processed);
          latestProcessed = reportedProcessed;
          latestTotal = total;
          latestSourceOffset = sourceOffset;
          if (Date.now() - lastProgressWrite <= 200) return;
          lastProgressWrite = Date.now();
          this.database.updateImportJob(jobId, {
            processedItems: reportedProcessed,
            totalItems: total,
            processedBytes: job.sourceType === "mbox" ? sourceOffset : 0,
            checkpoint: { messageIndex: reportedProcessed, sourceOffset }
          });
        },
        onError: (stage: string, error: unknown, sourceKey?: string) => {
          this.database.addImportError(jobId, stage, errorMessage(error), sourceKey);
        }
      };

      if (job.sourceType === "pst") {
        await importPstFile(job.sourcePath, context);
      } else {
        await importMboxFile(job.sourcePath, context);
      }

      if (controller.signal.aborted) throw abortError();
      this.database.updateImportJob(jobId, {
        processedItems: latestProcessed,
        totalItems: latestTotal,
        processedBytes: file.size,
        checkpoint: {
          messageIndex: latestProcessed,
          sourceOffset: latestSourceOffset
        }
      });
      this.database.updateImportJob(jobId, {
        phase: "finalizing",
        message: "Finalizing search index"
      });

      const finishedJob = this.database.getImportJob(jobId)!;
      const replaceArchiveId = this.database.getReplaceArchiveId(job.archiveId);
      this.database.completeArchive(job.archiveId, finishedJob.errorCount);

      if (replaceArchiveId) {
        this.database.copyMessageState(replaceArchiveId, job.archiveId);
        const orphanedPaths = this.database.deleteArchive(replaceArchiveId);
        await Promise.all(orphanedPaths.map((path) => this.blobStore.remove(path)));
      }

      this.database.updateImportJob(jobId, {
        status: finishedJob.errorCount > 0 ? "completed_with_errors" : "completed",
        phase: "finalizing",
        canResume: false,
        message: finishedJob.errorCount > 0
          ? `Import completed with ${finishedJob.errorCount} warning${finishedJob.errorCount === 1 ? "" : "s"}`
          : "Import complete"
      });

      this.database.recordDiagnostic({
        level: finishedJob.errorCount > 0 ? "warning" : "info",
        category: "import",
        message: finishedJob.errorCount > 0
          ? `Import completed with ${finishedJob.errorCount} issue${finishedJob.errorCount === 1 ? "" : "s"}`
          : "Import completed successfully",
        jobId,
        archiveId: job.archiveId,
        sourceName: job.sourceName,
        context: { processedItems: latestProcessed, errorCount: finishedJob.errorCount }
      });

      if (job.temporarySource) await rm(job.sourcePath, { force: true });
    } catch (error) {
      const latest = this.database.getImportJob(jobId);
      if (!latest) return;
      if (errorName(error) === "AbortError" || latest?.status === "cancelled") {
        if (latest?.status !== "cancelled") {
          this.database.updateImportJob(jobId, {
            status: "cancelled",
            canResume: true,
            message: "Import cancelled"
          });
        }
        const cancelled = this.database.getImportJob(jobId);
        this.database.recordDiagnostic({
          level: "warning",
          category: "import",
          message: "Import worker stopped at a resumable checkpoint",
          jobId,
          archiveId: cancelled?.archiveId ?? null,
          sourceName: cancelled?.sourceName ?? null
        });
      } else {
        this.database.addImportError(jobId, "archive", errorMessage(error));
        const failedJob = this.database.getImportJobRecord(jobId);
        if (failedJob) this.database.failArchive(failedJob.archiveId);
        this.database.updateImportJob(jobId, {
          status: "failed",
          canResume: true,
          message: errorMessage(error)
        });
      }
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async persistMessage(
    job: ImportJobRecord,
    message: NormalizedMessage,
    signal: AbortSignal
  ): Promise<void> {
    await this.persistNormalizedMessage({
      archiveId: job.archiveId,
      message,
      ocrEnabled: job.ocrEnabled,
      signal,
      onAttachmentError: (error, attachment) => {
        this.database.addImportError(
          job.id,
          "attachment",
          `${attachment.filename}: ${errorMessage(error)}`,
          message.sourceKey
        );
      }
    });
  }

  private async persistAttachment(
    attachment: RawAttachment,
    ocrEnabled: boolean,
    signal: AbortSignal,
    onError?: (error: unknown, attachment: RawAttachment) => void
  ): Promise<AttachmentInput> {
    const blob = await this.blobStore.put(attachment.content);
    try {
      const extracted = await this.extractor.extract(
        attachment.filename,
        attachment.contentType,
        attachment.content,
        ocrEnabled,
        signal
      );
      return {
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.content.byteLength,
        contentId: attachment.contentId,
        disposition: attachment.disposition,
        textStatus: extracted.status,
        extractedText: extracted.text,
        blob
      };
    } catch (error) {
      if (errorName(error) === "AbortError") throw error;
      onError?.(error, attachment);
      return {
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.content.byteLength,
        contentId: attachment.contentId,
        disposition: attachment.disposition,
        textStatus: "failed",
        extractedText: "",
        blob
      };
    }
  }

  private ensureFolderPath(archiveId: string, rawPath: string): string {
    let cache = this.folderCache.get(archiveId);
    if (!cache) {
      cache = new Map();
      for (const folder of this.database.listFolders(archiveId)) cache.set(folder.path, folder.id);
      this.folderCache.set(archiveId, cache);
    }

    const parts = rawPath.split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) parts.push("Archive");
    let parentId: string | null = null;
    let path = "";
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      const cached = cache.get(path);
      if (cached) {
        parentId = cached;
        continue;
      }
      const folder = this.database.ensureFolder(archiveId, path, name, parentId);
      cache.set(path, folder.id);
      parentId = folder.id;
    }
    return parentId!;
  }

  private updateByteProgressThrottled(
    jobId: string,
    processedBytes: number,
    totalBytes: number,
    checkpoint: Record<string, unknown>
  ): void {
    const job = this.database.getImportJob(jobId);
    if (!job || Date.now() - new Date(job.updatedAt).getTime() < 250) return;
    this.database.updateImportJob(jobId, {
      processedBytes,
      totalBytes,
      checkpoint
    });
  }

  private requireJob(jobId: string): ImportJobRecord {
    const job = this.database.getImportJobRecord(jobId);
    if (!job) throw new Error(`Import job ${jobId} not found`);
    return job;
  }
}

function destinationFolderPath(message: NormalizedMessage): string {
  const sourcePath = message.folderPath.trim() || "Archive";
  if (message.receivedAt || message.sentAt) return sourcePath;
  const leafName = sourcePath.split("/").at(-1)?.trim();
  if (leafName?.toLowerCase() === UNKNOWN_DATE_FOLDER_NAME.toLowerCase()) return sourcePath;
  return `${sourcePath}/${UNKNOWN_DATE_FOLDER_NAME}`;
}

function sourceTypeFromPath(sourcePath: string): ImportSourceType {
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".pst") return "pst";
  if (extension === ".mbox" || extension === ".mbx" || extension === "") return "mbox";
  throw new UnsupportedArchiveError("Choose a .pst, .mbox, or .mbx file");
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      output[index] = await mapper(items[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return output;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("Import cancelled");
  error.name = "AbortError";
  return error;
}
