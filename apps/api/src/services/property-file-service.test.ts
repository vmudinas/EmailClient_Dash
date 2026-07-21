import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyFileService } from "./property-file-service.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyFileService", () => {
  it("removes a saved file when a later database operation fails", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-files-"));
    temporaryDirs.push(directory);
    const files = new PropertyFileService(directory);
    const saved = files.save("requests", "details.txt", "text/plain", Buffer.from("Request details"));

    expect(files.read(saved.storageKey)?.toString()).toBe("Request details");
    files.remove(saved.storageKey);
    expect(files.read(saved.storageKey)).toBeNull();
  });

  it("stores supported maintenance videos", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-files-"));
    temporaryDirs.push(directory);
    const files = new PropertyFileService(directory);
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftyp"),
      Buffer.from("isom0000isomiso2")
    ]);

    const saved = files.save("requests", "leak.mp4", "video/mp4", mp4);

    expect(saved).toMatchObject({ filename: "leak.mp4", contentType: "video/mp4" });
    expect(files.read(saved.storageKey)).toEqual(mp4);
  });
});
