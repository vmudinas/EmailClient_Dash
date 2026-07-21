import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_FILE_BYTES = 100 * 1024 * 1024;
const ALLOWED_TYPES = new Map([
  ["application/pdf", ".pdf"],
  ["application/msword", ".doc"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["video/mp4", ".mp4"],
  ["video/quicktime", ".mov"],
  ["video/webm", ".webm"],
  ["text/plain", ".txt"]
]);

export interface StoredPropertyFile {
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export class PropertyFileValidationError extends Error {}

export class PropertyFileService {
  private readonly root: string;

  constructor(dataDir: string) {
    this.root = resolve(dataDir, "property-files");
    mkdirSync(this.root, { recursive: true });
  }

  save(
    namespace: "documents" | "requests" | "receipts",
    filename: string,
    contentType: string | undefined,
    body: Buffer
  ): StoredPropertyFile {
    const normalizedType = contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const expectedExtension = ALLOWED_TYPES.get(normalizedType);
    if (!expectedExtension) throw new PropertyFileValidationError("Unsupported property file type");
    if (!Buffer.isBuffer(body) || body.byteLength === 0) {
      throw new PropertyFileValidationError("Choose a non-empty file");
    }
    const maxBytes = namespace === "requests" ? MAX_REQUEST_FILE_BYTES : MAX_FILE_BYTES;
    if (body.byteLength > maxBytes) {
      throw new PropertyFileValidationError(
        namespace === "requests" ? "Maintenance attachments cannot exceed 100 MB" : "Property files cannot exceed 25 MB"
      );
    }
    validateSignature(normalizedType, body);
    const safeFilename = safeName(filename, expectedExtension);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const storageKey = `${namespace}/${sha256.slice(0, 2)}/${randomUUID()}${expectedExtension}`;
    const path = resolve(this.root, storageKey);
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, body, { mode: 0o600 });
    renameSync(temporaryPath, path);
    return { storageKey, filename: safeFilename, contentType: normalizedType, sizeBytes: body.byteLength, sha256 };
  }

  read(storageKey: string): Buffer | null {
    const path = this.path(storageKey);
    return existsSync(path) ? readFileSync(path) : null;
  }

  remove(storageKey: string): void {
    rmSync(this.path(storageKey), { force: true });
  }

  path(storageKey: string): string {
    if (!/^(documents|requests|receipts)\/[a-f0-9]{2}\/[a-f0-9-]+\.[a-z0-9]+$/i.test(storageKey)) {
      throw new PropertyFileValidationError("Invalid property file reference");
    }
    return resolve(this.root, storageKey);
  }
}

function safeName(value: string, expectedExtension: string): string {
  const original = basename(value.trim() || `file${expectedExtension}`)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 240);
  const extension = extname(original).toLowerCase();
  return extension ? original : `${original}${expectedExtension}`;
}

function validateSignature(contentType: string, body: Buffer): void {
  if (contentType === "application/pdf" && body.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new PropertyFileValidationError("The uploaded file is not a valid PDF");
  }
  if (contentType === "image/jpeg" && !(body[0] === 0xff && body[1] === 0xd8)) {
    throw new PropertyFileValidationError("The uploaded file is not a valid JPEG");
  }
  if (contentType === "image/png" && body.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new PropertyFileValidationError("The uploaded file is not a valid PNG");
  }
  if (contentType.endsWith("wordprocessingml.document") && body.subarray(0, 2).toString("ascii") !== "PK") {
    throw new PropertyFileValidationError("The uploaded file is not a valid DOCX document");
  }
  if ((contentType === "video/mp4" || contentType === "video/quicktime")
    && body.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new PropertyFileValidationError("The uploaded file is not a valid MP4 or MOV video");
  }
  if (contentType === "video/webm" && !body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    throw new PropertyFileValidationError("The uploaded file is not a valid WebM video");
  }
}
