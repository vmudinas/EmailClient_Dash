import { access, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
import { ImportService } from "./import-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ImportService", () => {
  it("imports an MBOX into independent searchable storage", async () => {
    const dataDir = await temporaryDirectory();
    const sourcePath = join(dataDir, "fixture.mbox");
    await writeFile(sourcePath, fixtureMbox(), "utf8");
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    const service = new ImportService(database, blobs);
    await service.initialize();

    const started = await service.startImport(sourcePath, { ocrEnabled: false });
    const completed = await waitForJob(database, started.id);
    expect(completed.status).toBe("completed");
    expect(completed.processedItems).toBe(6);
    expect(completed.totalItems).toBe(6);
    expect(completed.processedBytes).toBe(completed.totalBytes);

    await unlink(sourcePath);
    const archive = database.listArchives()[0]!;
    expect(archive.messageCount).toBe(6);
    expect(archive.attachmentCount).toBe(1);

    const bodyHit = database.search({ q: "project aurora" }).items[0]!;
    expect(bodyHit.message.subject).toBe("Planning notes");
    const attachmentHit = database.search({ q: "rollback procedure" }).items[0]!;
    expect(attachmentHit.matchedIn).toBe("attachment");

    const detail = database.getMessage(attachmentHit.message.id)!;
    const storedAttachment = database.getAttachmentBlob(detail.attachments[0]!.id)!;
    await expect(access(blobs.resolve(storedAttachment.relativePath))).resolves.toBeUndefined();

    const duplicate = await service.startImport(
      await recreateSource(dataDir),
      { ocrEnabled: false }
    );
    const duplicateResult = await waitForJob(database, duplicate.id);
    expect(duplicateResult.status).toBe("failed");
    expect(database.listArchives()).toHaveLength(1);

    await service.close();
    database.close();
  });

  it("routes newly imported undated messages into an Unknown date child mailbox", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    const service = new ImportService(database, blobs);
    await service.initialize();
    const archive = database.createArchive({
      name: "Undated mail",
      sourceType: "mbox",
      fingerprint: "undated-import-fixture",
      sizeBytes: 100
    });

    await service.persistNormalizedMessage({
      archiveId: archive.id,
      message: {
        sourceKey: "undated-message",
        folderPath: "Inbox",
        internetMessageId: null,
        subject: "Missing timestamp",
        sender: { name: null, address: "sender@example.test" },
        to: [],
        cc: [],
        bcc: [],
        sentAt: null,
        receivedAt: null,
        bodyText: "No date headers were available.",
        bodyHtml: null,
        headers: {},
        sizeBytes: 50,
        attachments: []
      },
      ocrEnabled: false,
      signal: new AbortController().signal
    });
    database.completeArchive(archive.id, 0);

    const folders = database.listFolders(archive.id);
    const inbox = folders.find((folder) => folder.path === "Inbox")!;
    const unknownDate = folders.find((folder) => folder.path === "Inbox/Unknown date")!;
    expect(inbox.messageCount).toBe(0);
    expect(unknownDate).toMatchObject({ parentId: inbox.id, messageCount: 1 });
    expect(database.listMessages({ folderId: unknownDate.id }).items[0]?.subject).toBe("Missing timestamp");

    await service.close();
    database.close();
  });

  it("waits for an active import to stop before deleting its archive and temporary source", async () => {
    const dataDir = await temporaryDirectory();
    const sourcePath = join(dataDir, "temporary-source.mbox");
    await writeFile(sourcePath, fixtureMbox().repeat(50), "utf8");
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    const service = new ImportService(database, blobs);
    await service.initialize();

    const started = await service.startImport(
      sourcePath,
      { ocrEnabled: false },
      true,
      "temporary-source.mbox"
    );
    await service.removeArchive(started.archiveId!);

    expect(database.getArchive(started.archiveId!)).toBeNull();
    expect(database.getImportJob(started.id)).toBeNull();
    await expect(access(sourcePath)).rejects.toThrow();
    expect(database.listDiagnostics().some((event) => (
      event.message === "Archive removed: temporary-source.mbox"
    ))).toBe(true);

    await service.close();
    database.close();
  });
});

async function waitForJob(database: EmailDatabase, jobId: string): Promise<NonNullable<ReturnType<EmailDatabase["getImportJob"]>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = database.getImportJob(jobId);
    if (job && ["completed", "completed_with_errors", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for import");
}

async function recreateSource(dataDir: string): Promise<string> {
  const path = join(dataDir, "fixture-copy.mbox");
  await writeFile(path, fixtureMbox(), "utf8");
  return path;
}

function fixtureMbox(): string {
  const messages = [
    simpleMessage("one", "Planning notes", "Project Aurora is ready for the design review."),
    simpleMessage("two", "Search performance", "The local full text index is ready."),
    simpleMessage("three", "Mobile viewer", "The pairing token is read only."),
    simpleMessage("four", "Storage", "Attachments use managed local blob storage."),
    simpleMessage("five", "Import status", "Checkpoint progress is resumable."),
    [
    "From sender@example.test Wed Jul 01 12:00:00 2026",
    "From: Eli Turner <eli@example.test>",
    "To: Product <product@example.test>",
    "Date: Thu, 02 Jul 2026 12:00:00 +0000",
    "Subject: Release checklist",
    "Message-ID: <checklist@example.test>",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=fixture-boundary",
    "",
    "--fixture-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "The checklist is attached.",
    "--fixture-boundary",
    "Content-Type: text/plain; name=checklist.txt",
    "Content-Disposition: attachment; filename=checklist.txt",
    "",
    "Verify rollback procedure and signed installer.",
    "--fixture-boundary--",
    ""
    ].join("\n")
  ];
  return messages.join("");
}

function simpleMessage(id: string, subject: string, body: string): string {
  return [
    "From sender@example.test Wed Jul 01 12:00:00 2026",
    "From: Maya Chen <maya@example.test>",
    "To: Product <product@example.test>",
    "Date: Wed, 01 Jul 2026 12:00:00 +0000",
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.test>`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    ""
  ].join("\n");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-import-"));
  directories.push(directory);
  return directory;
}
