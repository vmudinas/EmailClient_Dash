import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
import { ImportService } from "./import-service.js";

const resources: Array<{
  directory: string;
  database: EmailDatabase;
  imports: ImportService;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.imports.close();
    resource.database.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

describe("ImportService.clearImport", () => {
  it("requires Stop, then clears a partial archive, upload, source, and attachment blob", async () => {
    const { directory, database, blobStore, imports } = await runtime();
    const sourcePath = join(directory, "partial.mbox");
    await writeFile(sourcePath, "From sender@example.test Mon Jul 13 00:00:00 2026\n\nbody\n");
    const archive = database.createArchive({
      name: "partial.mbox",
      sourceType: "mbox",
      fingerprint: "partial-clear",
      sizeBytes: 64
    });
    const folder = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const storedBlob = await blobStore.put(Buffer.from("attachment data"));
    database.insertMessage({
      archiveId: archive.id,
      folderId: folder.id,
      sourceKey: "partial-message",
      internetMessageId: null,
      subject: "Partial import",
      sender: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      receivedAt: null,
      bodyText: "Partial body",
      bodyHtml: null,
      headers: {},
      sizeBytes: 20,
      attachments: [{
        filename: "partial.txt",
        contentType: "text/plain",
        sizeBytes: storedBlob.sizeBytes,
        contentId: null,
        disposition: "attachment",
        textStatus: "indexed",
        extractedText: "attachment data",
        blob: storedBlob
      }]
    });
    const job = database.createImportJob({
      archiveId: archive.id,
      sourcePath,
      sourceName: "partial.mbox",
      sourceType: "mbox",
      sizeBytes: 64,
      ocrEnabled: false,
      temporarySource: true
    });
    const upload = database.createUploadSession({
      clientKey: "partial-upload",
      filename: "partial.mbox",
      sizeBytes: 64,
      tempPath: sourcePath,
      ocrEnabled: false
    });
    database.updateUploadSession(upload.id, { status: "completed", jobId: job.id });

    await expect(imports.clearImport(job.id)).rejects.toThrow("Stop the import");
    database.updateImportJob(job.id, { status: "cancelled", canResume: true });
    await imports.clearImport(job.id);

    expect(database.getImportJob(job.id)).toBeNull();
    expect(database.getArchive(archive.id)).toBeNull();
    expect(database.getUploadSession(upload.id)).toBeNull();
    await expect(access(sourcePath)).rejects.toBeTruthy();
    await expect(access(blobStore.resolve(storedBlob.relativePath))).rejects.toBeTruthy();
    expect(database.listDiagnostics().map((event) => event.message)).toContain("Import cleared: partial.mbox");
  });

  it("dismisses a completed import record without deleting its archive", async () => {
    const { directory, database, imports } = await runtime();
    const archive = database.createArchive({
      name: "complete.mbox",
      sourceType: "mbox",
      fingerprint: "complete-clear",
      sizeBytes: 20
    });
    database.completeArchive(archive.id, 0);
    const job = database.createImportJob({
      archiveId: archive.id,
      sourcePath: join(directory, "complete.mbox"),
      sourceName: "complete.mbox",
      sourceType: "mbox",
      sizeBytes: 20,
      ocrEnabled: false,
      temporarySource: true
    });
    database.updateImportJob(job.id, { status: "completed", canResume: false });

    await imports.clearImport(job.id);

    expect(database.getImportJob(job.id)).toBeNull();
    expect(database.getArchive(archive.id)).toMatchObject({ id: archive.id, status: "ready" });
  });
});

async function runtime(): Promise<{
  directory: string;
  database: EmailDatabase;
  blobStore: BlobStore;
  imports: ImportService;
}> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-clear-"));
  const database = new EmailDatabase(directory);
  const blobStore = new BlobStore(directory);
  const imports = new ImportService(database, blobStore);
  await imports.initialize();
  resources.push({ directory, database, imports });
  return { directory, database, blobStore, imports };
}
