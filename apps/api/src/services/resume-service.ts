import { basename, extname } from "node:path";
import type { ResumeAsset } from "@email-client/shared";
import type { BlobStore } from "../storage/blob-store.js";
import type { EmailStore, ResumeAssetRecord } from "../storage/database.js";

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
};

export class ResumeService {
  constructor(
    private readonly database: EmailStore,
    private readonly blobs: BlobStore
  ) {}

  list(): ResumeAsset[] {
    return this.database.listResumeAssets();
  }

  async upload(filename: string, content: Buffer, name?: string): Promise<ResumeAsset> {
    const safeFilename = basename(filename.trim()).slice(0, 240);
    const extension = extname(safeFilename).toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (!safeFilename || !contentType) {
      throw new ResumeValidationError("Upload a PDF, DOC, or DOCX resume");
    }
    if (content.byteLength === 0) throw new ResumeValidationError("The resume file is empty");
    if (content.byteLength > MAX_RESUME_BYTES) {
      throw new ResumeValidationError("Resume files must be 5 MB or smaller");
    }
    const blob = await this.blobs.put(content);
    return this.database.createResumeAsset({
      name: name?.trim().slice(0, 120) || safeFilename.replace(/\.[^.]+$/, ""),
      filename: safeFilename,
      contentType,
      blob
    });
  }

  async read(id: string): Promise<{ asset: ResumeAssetRecord; content: Buffer }> {
    const asset = this.database.getResumeAssetRecord(id);
    if (!asset) throw new ResumeNotFoundError("Resume not found");
    return { asset, content: await this.blobs.read(asset.relativePath) };
  }

  async remove(id: string): Promise<void> {
    const removed = this.database.deleteResumeAsset(id);
    if (!removed) throw new ResumeNotFoundError("Resume not found");
    if (!this.database.isBlobPathReferenced(removed.relativePath)) {
      await this.blobs.remove(removed.relativePath);
    }
  }
}

export class ResumeValidationError extends Error {}
export class ResumeNotFoundError extends Error {}
