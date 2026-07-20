import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, rm, access } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { UploadSession, UploadSessionCreate } from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import { ImportService } from "./import-service.js";

export class UploadConflictError extends Error {}
export class UploadValidationError extends Error {}

export class UploadService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: string,
    private readonly database: EmailStore,
    private readonly imports: ImportService
  ) {}

  async createOrResume(input: UploadSessionCreate, ownerUserId: string | null = null): Promise<UploadSession> {
    validateFilename(input.filename);
    const clientKey = uploadClientKey(input);
    const existing = this.database.findResumableUpload(clientKey, ownerUserId);
    if (existing) {
      try {
        await access(existing.tempPath);
        return existing;
      } catch {
        this.database.updateUploadSession(existing.id, {
          status: "cancelled",
          message: "The partial upload file was missing; a new upload was started"
        });
      }
    }

    const incomingDir = resolve(this.dataDir, "incoming");
    await mkdir(incomingDir, { recursive: true });
    const id = randomUUID();
    const safeName = safeFilename(input.filename);
    const suffix = extname(safeName) || ".mbox";
    const tempPath = resolve(incomingDir, `${id}${suffix.toLowerCase()}`);
    const file = await open(tempPath, "wx");
    await file.close();
    const session = this.database.createUploadSession({
      id,
      ownerUserId,
      clientKey,
      filename: safeName,
      sizeBytes: input.sizeBytes,
      tempPath,
      ocrEnabled: input.ocrEnabled
    });
    this.database.recordDiagnostic({
      level: "info",
      category: "upload",
      message: `Upload session created for ${safeName}`,
      sourceName: safeName,
      context: { uploadId: id, sizeBytes: input.sizeBytes, ocrEnabled: input.ocrEnabled }
    });
    return session;
  }

  get(id: string): UploadSession | null {
    return this.database.getUploadSession(id);
  }

  list(ownerUserId?: string): UploadSession[] {
    return this.database.listUploadSessions(25, ownerUserId);
  }

  async append(id: string, offset: number, chunk: Buffer): Promise<UploadSession> {
    return this.withQueue(id, async () => {
      const session = this.database.getUploadSessionRecord(id);
      if (!session) throw new UploadValidationError("Upload session not found");
      if (session.status === "cancelled" || session.status === "completed") {
        throw new UploadConflictError(`Upload is already ${session.status}`);
      }
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new UploadValidationError("Upload offset is invalid");
      }
      if (offset !== session.receivedBytes) {
        throw new UploadConflictError(`Expected upload offset ${session.receivedBytes}`);
      }
      if (chunk.byteLength === 0) throw new UploadValidationError("Upload chunk is empty");
      if (offset + chunk.byteLength > session.sizeBytes) {
        throw new UploadValidationError("Upload exceeds the declared file size");
      }

      try {
        const file = await open(session.tempPath, "r+");
        try {
          const result = await file.write(chunk, 0, chunk.byteLength, offset);
          if (result.bytesWritten !== chunk.byteLength) {
            throw new Error(`Only ${result.bytesWritten} of ${chunk.byteLength} bytes were written`);
          }
          await file.sync();
        } finally {
          await file.close();
        }
        const receivedBytes = offset + chunk.byteLength;
        return this.database.updateUploadSession(id, {
          receivedBytes,
          status: "uploading",
          message: `Received ${receivedBytes} of ${session.sizeBytes} bytes`
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.database.updateUploadSession(id, { status: "failed", message });
        this.database.recordDiagnostic({
          level: "error",
          category: "upload",
          message: `Could not store an upload chunk: ${message}`,
          stack: error instanceof Error ? error.stack : null,
          sourceName: session.filename,
          context: { uploadId: id, offset, chunkBytes: chunk.byteLength }
        });
        throw error;
      }
    });
  }

  async complete(id: string): Promise<UploadSession> {
    return this.withQueue(id, async () => {
      const session = this.database.getUploadSessionRecord(id);
      if (!session) throw new UploadValidationError("Upload session not found");
      if (session.status === "completed") return session;
      if (session.status === "cancelled") throw new UploadConflictError("Upload was cancelled");
      if (session.receivedBytes !== session.sizeBytes) {
        throw new UploadConflictError(
          `Upload is incomplete: received ${session.receivedBytes} of ${session.sizeBytes} bytes`
        );
      }

      try {
        await validateArchiveHeader(session.tempPath, session.filename);
        this.database.updateUploadSession(id, {
          status: "ready",
          message: "Upload complete; creating import job"
        });
        const job = await this.imports.startImport(
          session.tempPath,
          { ocrEnabled: session.ocrEnabled },
          true,
          session.filename,
          session.ownerUserId
        );
        const completed = this.database.updateUploadSession(id, {
          status: "completed",
          jobId: job.id,
          message: "Upload complete; import started"
        });
        this.database.recordDiagnostic({
          level: "info",
          category: "upload",
          message: `Upload completed and import job ${job.id} started`,
          jobId: job.id,
          archiveId: job.archiveId,
          sourceName: session.filename,
          context: { uploadId: id, sizeBytes: session.sizeBytes }
        });
        return completed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.database.updateUploadSession(id, { status: "failed", message });
        this.database.recordDiagnostic({
          level: "error",
          category: "upload",
          message: `Upload could not start an import: ${message}`,
          stack: error instanceof Error ? error.stack : null,
          sourceName: session.filename,
          context: { uploadId: id, receivedBytes: session.receivedBytes }
        });
        throw error;
      }
    });
  }

  async cancel(id: string): Promise<UploadSession> {
    return this.withQueue(id, async () => {
      const session = this.database.getUploadSessionRecord(id);
      if (!session) throw new UploadValidationError("Upload session not found");
      if (session.status === "completed") {
        throw new UploadConflictError("The import has already started; cancel the import job instead");
      }
      await rm(session.tempPath, { force: true });
      const cancelled = this.database.updateUploadSession(id, {
        status: "cancelled",
        message: "Upload cancelled and partial file removed"
      });
      this.database.recordDiagnostic({
        level: "warning",
        category: "upload",
        message: "Upload cancelled by the user",
        sourceName: session.filename,
        context: { uploadId: id, receivedBytes: session.receivedBytes }
      });
      return cancelled;
    });
  }

  private async withQueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(id, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(id) === current) this.queues.delete(id);
    }
  }
}

function uploadClientKey(input: UploadSessionCreate): string {
  return createHash("sha256")
    .update(`${input.filename}\u0000${input.sizeBytes}\u0000${input.lastModified}\u0000${input.ocrEnabled}`)
    .digest("hex");
}

function validateFilename(filename: string): void {
  const extension = extname(filename).toLowerCase();
  if (extension && extension !== ".pst" && extension !== ".mbox" && extension !== ".mbx") {
    throw new UploadValidationError("Choose a PST, MBOX, MBX, or extensionless MBOX file");
  }
}

async function validateArchiveHeader(path: string, filename: string): Promise<void> {
  const extension = extname(filename).toLowerCase();
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await file.read(header, 0, header.byteLength, 0);
    if (bytesRead === 0) throw new UploadValidationError("The selected archive is empty");
    const content = header.subarray(0, bytesRead);
    const isPst = content.subarray(0, 4).toString("ascii") === "!BDN";
    const mboxText = content.toString("utf8").replace(/^\uFEFF/, "").replace(/^\r?\n+/, "");
    const isMbox = mboxText.startsWith("From ");
    if (extension === ".pst" && !isPst) {
      throw new UploadValidationError("The file has a .pst name but does not have a PST header");
    }
    if ((extension === ".mbox" || extension === ".mbx" || extension === "") && !isMbox) {
      throw new UploadValidationError("The file does not appear to be an MBOX archive");
    }
  } finally {
    await file.close();
  }
}

function safeFilename(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 240) || "archive";
}
