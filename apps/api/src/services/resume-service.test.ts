import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
import { ResumeService, ResumeValidationError } from "./resume-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ResumeService", () => {
  it("stores, reads, lists, and removes an uploaded resume", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-resume-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    await blobs.initialize();
    const service = new ResumeService(database, blobs);
    const content = Buffer.from("%PDF-test-resume");

    const uploaded = await service.upload("candidate.pdf", content, "Engineering resume");
    expect(uploaded).toMatchObject({
      name: "Engineering resume",
      filename: "candidate.pdf",
      contentType: "application/pdf",
      sizeBytes: content.byteLength
    });
    expect(service.list()).toEqual([uploaded]);
    expect((await service.read(uploaded.id)).content).toEqual(content);

    await service.remove(uploaded.id);
    expect(service.list()).toEqual([]);
    database.close();
  });

  it("rejects unsupported resume formats", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-resume-invalid-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    await blobs.initialize();
    const service = new ResumeService(database, blobs);

    await expect(service.upload("resume.txt", Buffer.from("text"))).rejects.toThrow(ResumeValidationError);
    database.close();
  });
});
