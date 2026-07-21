import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, extname, resolve } from "node:path";

const MAX_PROPERTY_IMAGE_BYTES = 5 * 1024 * 1024;
const GENERIC_PROPERTY_IMAGE = "generic-property.svg";

export class PropertyImageValidationError extends Error {}

export class PropertyAssetService {
  readonly imageDir: string;
  readonly bundledDir: string;
  readonly privateImageDir: string;

  constructor(
    dataDir: string,
    bundledDir = resolve(process.cwd(), "apps/api/property-assets"),
    privateImageDir = resolve(process.cwd(), "data/property-images")
  ) {
    this.imageDir = resolve(dataDir, "property-images");
    this.bundledDir = bundledDir;
    this.privateImageDir = privateImageDir;
    mkdirSync(this.imageDir, { recursive: true });
  }

  installSeedImages(filenames: string[]): void {
    for (const rawFilename of filenames) {
      const filename = basename(rawFilename);
      const destination = resolve(this.imageDir, filename);
      if (existsSync(destination)) continue;
      const source = [this.privateImageDir, this.bundledDir]
        .map((directory) => resolve(directory, filename))
        .find((candidate) => candidate !== destination && existsSync(candidate));
      if (source) copyFileSync(source, destination);
    }
  }

  save(propertyId: string, contentType: string | undefined, body: Buffer): string {
    if (body.length === 0) throw new PropertyImageValidationError("Choose an image to upload");
    if (body.length > MAX_PROPERTY_IMAGE_BYTES) {
      throw new PropertyImageValidationError("Property photos must be 5 MB or smaller");
    }
    const extension = extensionForContentType(contentType);
    if (!extension) throw new PropertyImageValidationError("Use a JPEG, PNG, or WebP image");
    const filename = `${propertyId}.${extension}`;
    const path = resolve(this.imageDir, filename);
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, body, { mode: 0o600 });
    renameSync(temporaryPath, path);
    return filename;
  }

  read(filename: string): { body: Buffer; contentType: string } | null {
    const safeFilename = basename(filename);
    const path = [this.imageDir, this.privateImageDir]
      .map((directory) => resolve(directory, safeFilename))
      .find((candidate) => existsSync(candidate))
      ?? resolve(this.bundledDir, GENERIC_PROPERTY_IMAGE);
    if (!existsSync(path)) return null;
    return {
      body: readFileSync(path),
      contentType: contentTypeForExtension(extname(path).toLowerCase())
    };
  }
}

function extensionForContentType(contentType: string | undefined): string | null {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  return null;
}

function contentTypeForExtension(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  return "image/jpeg";
}
