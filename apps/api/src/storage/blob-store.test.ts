import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore } from "./blob-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BlobStore", () => {
  it("stores content-addressed blobs and reads them back by their nested sha256 path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-blobs-"));
    directories.push(dataDir);
    const store = new BlobStore(dataDir);
    await store.initialize();

    const stored = await store.put(Buffer.from("attachment content", "utf8"));
    expect(stored.relativePath).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
    expect((await store.read(stored.relativePath)).toString("utf8")).toBe("attachment content");

    await store.remove(stored.relativePath);
    await expect(store.read(stored.relativePath)).rejects.toThrow();
  });

  it("rejects a relative path that escapes the blob root", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-blobs-traversal-"));
    directories.push(dataDir);
    const store = new BlobStore(dataDir);
    await store.initialize();

    expect(() => store.resolve("../outside.txt")).toThrow("Invalid blob path");
    expect(() => store.resolve("../../etc/passwd")).toThrow("Invalid blob path");
    expect(store.resolve("ab/cd/abcd1234")).toBe(join(store.rootDir, "ab", "cd", "abcd1234"));
  });
});
