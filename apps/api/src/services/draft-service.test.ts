import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobStore } from "../storage/blob-store.js";
import { EmailDatabase } from "../storage/database.js";
import { DraftService } from "./draft-service.js";
import type { GmailService } from "./gmail-service.js";
import { ResumeService } from "./resume-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DraftService", () => {
  it("sends a persisted draft with its selected resume and removes it only after success", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-draft-"));
    directories.push(dataDir);
    const database = new EmailDatabase(dataDir);
    const blobs = new BlobStore(dataDir);
    await blobs.initialize();
    const archive = database.createArchive({
      name: "Gmail",
      sourceType: "gmail",
      fingerprint: "draft-service",
      sizeBytes: 0
    });
    const folder = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    const connection = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: archive.id,
      folderId: folder.id,
      query: "",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    const resumes = new ResumeService(database, blobs);
    const resumeContent = Buffer.from("%PDF-resume");
    const resume = await resumes.upload("resume.pdf", resumeContent, "Engineering resume");
    const sendMessage = vi.fn().mockResolvedValue({
      id: "gmail-message-id",
      threadId: "gmail-thread-id",
      localCopyImported: true
    });
    const service = new DraftService(
      database,
      { sendMessage } as unknown as GmailService,
      resumes
    );
    const draft = service.create({
      connectionId: connection.id,
      to: ["recruiter@example.test"],
      cc: [],
      bcc: [],
      subject: "Re: TypeScript role",
      bodyText: "Thank you for reaching out.",
      fromAddress: null,
      sourceMessageId: null,
      resumeId: resume.id
    });

    await expect(service.send(draft.id)).resolves.toMatchObject({ id: "gmail-message-id" });
    expect(sendMessage).toHaveBeenCalledWith(
      connection.id,
      expect.objectContaining({ to: ["recruiter@example.test"], subject: "Re: TypeScript role" }),
      [{ filename: "resume.pdf", contentType: "application/pdf", content: resumeContent }]
    );
    expect(service.list()).toEqual([]);
    database.close();
  });
});
