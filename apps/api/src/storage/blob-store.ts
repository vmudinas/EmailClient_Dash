import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface StoredBlob {
  sha256: string;
  relativePath: string;
  sizeBytes: number;
}

export class BlobStore {
  readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = resolve(dataDir, "blobs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async put(content: Buffer): Promise<StoredBlob> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const relativePath = `${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
    const destination = resolve(this.rootDir, relativePath);

    try {
      await stat(destination);
    } catch {
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, content, { flag: "wx" });
      try {
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        try {
          await stat(destination);
        } catch {
          throw error;
        }
      }
    }

    return { sha256, relativePath, sizeBytes: content.byteLength };
  }

  async read(relativePath: string): Promise<Buffer> {
    return readFile(this.resolve(relativePath));
  }

  async remove(relativePath: string): Promise<void> {
    await rm(this.resolve(relativePath), { force: true });
  }

  resolve(relativePath: string): string {
    const absolute = resolve(this.rootDir, relativePath);
    // path.relative + isAbsolute is separator-agnostic, unlike a hardcoded "/" prefix
    // check, which never matches on Windows where resolve() joins with "\".
    const fromRoot = relative(this.rootDir, absolute);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error("Invalid blob path");
    }
    return absolute;
  }
}

