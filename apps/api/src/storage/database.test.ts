import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { EmailDatabase, toFtsQuery } from "./database.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EmailDatabase", () => {
  it("indexes message and attachment text and updates local state", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "mail.mbox",
      sourceType: "mbox",
      fingerprint: "fixture",
      sizeBytes: 120
    });
    const folder = database.ensureFolder(archive.id, "Archive/Inbox", "Inbox", null);
    database.insertMessage({
      archiveId: archive.id,
      folderId: folder.id,
      sourceKey: "message-1",
      internetMessageId: "<one@example.test>",
      subject: "Quarterly launch plan",
      sender: { name: "Maya Chen", address: "maya@example.test" },
      to: [{ name: "Product", address: "product@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2026-07-01T12:00:00.000Z",
      receivedAt: "2026-07-01T12:00:00.000Z",
      bodyText: "The desktop rollout is ready for review.",
      bodyHtml: "<p>The desktop rollout is ready for review.</p>",
      headers: { "message-id": "<one@example.test>" },
      sizeBytes: 100,
      attachments: [{
        filename: "checklist.txt",
        contentType: "text/plain",
        sizeBytes: 20,
        contentId: null,
        disposition: "attachment",
        textStatus: "indexed",
        extractedText: "Verify rollback and signed installer",
        blob: {
          sha256: "a".repeat(64),
          relativePath: "aa/aa/blob",
          sizeBytes: 20
        }
      }]
    });
    database.completeArchive(archive.id, 0);

    expect(database.search({ q: "rollout" }).items).toHaveLength(1);
    const attachmentHit = database.search({ q: "\"signed installer\"" }).items[0]!;
    expect(attachmentHit.matchedIn).toBe("attachment");
    expect(attachmentHit.matchedAttachmentName).toBe("checklist.txt");
    expect(database.search({ q: "launch", from: "maya" }).items).toHaveLength(1);
    expect(database.search({ q: "launch", from: "nobody" }).items).toHaveLength(0);

    const message = database.listMessages({ archiveId: archive.id }).items[0]!;
    expect(database.getArchive(archive.id)?.unreadCount).toBe(1);
    expect(database.listFolders(archive.id)[0]?.unreadCount).toBe(1);
    const state = database.updateMessageState(message.id, {
      isRead: true,
      isStarred: true,
      tags: ["release", "release"],
      note: "Check with support."
    });
    expect(state.tags).toEqual(["release"]);
    expect(database.getMessage(message.id)?.state).toMatchObject({
      isRead: true,
      isStarred: true,
      note: "Check with support."
    });
    expect(database.getArchive(archive.id)?.unreadCount).toBe(0);
    expect(database.getFolder(folder.id)?.unreadCount).toBe(0);
    database.close();
  });

  it("lists mail by newest received date and keeps undated records at the bottom", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "date-order.mbox",
      sourceType: "mbox",
      fingerprint: "date-order-fixture",
      sizeBytes: 300
    });
    const folder = database.ensureFolder(archive.id, "Inbox", "Inbox", null);

    insertDatedMessage(database, archive.id, folder.id, "older", "2026-07-01T12:00:00.000Z");
    insertDatedMessage(database, archive.id, folder.id, "newest", "2026-07-03T12:00:00.000Z");
    insertDatedMessage(database, archive.id, folder.id, "sent-fallback", null, "2026-07-02T12:00:00.000Z");
    insertDatedMessage(database, archive.id, folder.id, "undated", null, null);
    database.completeArchive(archive.id, 0);

    expect(database.listMessages({ folderId: folder.id }).items.map((message) => message.subject)).toEqual([
      "newest",
      "sent-fallback",
      "older",
      "undated"
    ]);
    expect(database.search({ q: "ordering-marker", folderId: folder.id, sort: "newest" }).items
      .map((hit) => hit.message.subject)).toEqual([
      "newest",
      "sent-fallback",
      "older",
      "undated"
    ]);
    database.close();
  });

  it("migrates existing undated mail into a dedicated child mailbox", async () => {
    const dataDir = await temporaryDirectory();
    let database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Existing archive",
      sourceType: "mbox",
      fingerprint: "existing-undated-fixture",
      sizeBytes: 200
    });
    const source = database.ensureFolder(archive.id, "Gmail-Archive", "Gmail-Archive", null);
    insertDatedMessage(database, archive.id, source.id, "dated", "2026-07-03T12:00:00.000Z");
    insertDatedMessage(database, archive.id, source.id, "undated", null, null);
    database.completeArchive(archive.id, 0);
    database.close();

    const rawDatabase = new BetterSqlite3(join(dataDir, "archive-mail.sqlite"));
    rawDatabase.pragma("user_version = 9");
    rawDatabase.close();

    database = new EmailDatabase(dataDir);
    const folders = database.listFolders(archive.id);
    const migratedSource = folders.find((folder) => folder.id === source.id)!;
    const unknownDate = folders.find((folder) => folder.path === "Gmail-Archive/Unknown date")!;
    expect(migratedSource.messageCount).toBe(1);
    expect(unknownDate).toMatchObject({
      parentId: source.id,
      name: "Unknown date",
      messageCount: 1
    });
    expect(database.listMessages({ folderId: migratedSource.id }).items.map((message) => message.subject))
      .toEqual(["dated"]);
    expect(database.listMessages({ folderId: unknownDate.id }).items.map((message) => message.subject))
      .toEqual(["undated"]);
    expect(database.search({ q: "ordering-marker", folderId: unknownDate.id }).items[0]?.message.folderPath)
      .toBe("Gmail-Archive/Unknown date");
    expect(database.listDiagnostics()[0]).toMatchObject({
      category: "system",
      context: { operation: "organize_undated_messages", movedMessages: 1 }
    });
    database.close();
  });

  it("turns plain text and phrases into safe FTS expressions", () => {
    expect(toFtsQuery("launch plan")).toBe("\"launch\" AND \"plan\"");
    expect(toFtsQuery("\"launch plan\"")).toBe("\"launch plan\"");
    expect(toFtsQuery("  * OR ((  ")).toBe("\"OR\"");
  });

  it("renames archives and mailbox trees while keeping folder search current", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "original.mbox",
      sourceType: "mbox",
      fingerprint: "rename-fixture",
      sizeBytes: 80
    });
    const root = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const child = database.ensureFolder(archive.id, "Inbox/Receipts", "Receipts", root.id);
    database.insertMessage({
      archiveId: archive.id,
      folderId: child.id,
      sourceKey: "rename-message",
      internetMessageId: null,
      subject: "Invoice",
      sender: { name: null, address: "billing@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      receivedAt: null,
      bodyText: "Payment received",
      bodyHtml: null,
      headers: {},
      sizeBytes: 20,
      attachments: []
    });
    database.completeArchive(archive.id, 0);

    expect(database.renameArchive(archive.id, "Personal mail").name).toBe("Personal mail");
    expect(database.renameFolder(root.id, "Primary").path).toBe("Primary");
    expect(database.getFolder(child.id)?.path).toBe("Primary/Receipts");
    expect(database.search({ q: "Primary" }).items[0]?.message.folderPath).toBe("Primary/Receipts");
    database.close();
  });

  it("deletes mailbox trees and archives while preserving shared blob references", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "deletion.mbox",
      sourceType: "mbox",
      fingerprint: "deletion-fixture",
      sizeBytes: 500
    });
    const root = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const child = database.ensureFolder(archive.id, "Inbox/Receipts", "Receipts", root.id);
    const retained = database.ensureFolder(archive.id, "Saved", "Saved", null);
    const sharedBlob = {
      sha256: "b".repeat(64),
      relativePath: "bb/shared",
      sizeBytes: 12
    };
    insertDeletionMessage(database, archive.id, root.id, "root", "Recursive root message", sharedBlob);
    insertDeletionMessage(database, archive.id, child.id, "child", "Recursive child message", {
      sha256: "c".repeat(64),
      relativePath: "cc/child-only",
      sizeBytes: 15
    });
    insertDeletionMessage(database, archive.id, retained.id, "retained", "This message survives", sharedBlob);
    database.completeArchive(archive.id, 0);

    expect(database.search({ q: "recursive" }).items).toHaveLength(2);
    expect(database.deleteFolder(root.id)).toEqual(["cc/child-only"]);
    expect(database.getFolder(root.id)).toBeNull();
    expect(database.getFolder(child.id)).toBeNull();
    expect(database.search({ q: "recursive" }).items).toHaveLength(0);
    expect(database.search({ q: "survives" }).items).toHaveLength(1);
    expect(database.getArchive(archive.id)).toMatchObject({
      messageCount: 1,
      folderCount: 1,
      attachmentCount: 1
    });
    expect(database.deleteArchive(archive.id)).toEqual(["bb/shared"]);
    expect(database.getArchive(archive.id)).toBeNull();
    expect(database.search({ q: "survives" }).items).toHaveLength(0);
    database.close();
  });

  it("combines archives transactionally without losing local state, Gmail destinations, or attachments", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const target = database.createArchive({
      name: "Combined mail",
      sourceType: "mbox",
      fingerprint: "merge-target",
      sizeBytes: 200
    });
    const source = database.createArchive({
      name: "Older mail",
      sourceType: "gmail",
      fingerprint: "merge-source",
      sizeBytes: 300
    });
    const targetInbox = database.ensureFolder(target.id, "Inbox", "Inbox", null);
    const sourceInbox = database.ensureFolder(source.id, "Inbox", "Inbox", null);
    const sharedBlob = {
      sha256: "d".repeat(64),
      relativePath: "dd/shared-merge",
      sizeBytes: 18
    };
    insertDeletionMessage(database, target.id, targetInbox.id, "duplicate-key", "Target copy", sharedBlob);
    const sourceMessageId = insertDeletionMessage(
      database,
      source.id,
      sourceInbox.id,
      "duplicate-key",
      "Source copy with merge marker",
      sharedBlob
    );
    database.updateMessageState(sourceMessageId, {
      isRead: true,
      isStarred: true,
      tags: ["keep"],
      note: "Preserve this state"
    });
    database.completeArchive(target.id, 0);
    database.completeArchive(source.id, 1);
    const gmail = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: source.id,
      folderId: sourceInbox.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      refreshToken: "refresh-token"
    });

    const result = database.mergeArchives(source.id, target.id);

    expect(result).toMatchObject({
      movedMessages: 1,
      movedFolders: 1,
      movedAttachments: 1,
      archive: {
        id: target.id,
        sizeBytes: 500,
        status: "ready_with_errors",
        messageCount: 2,
        folderCount: 1,
        attachmentCount: 2
      }
    });
    expect(database.getArchive(source.id)).toBeNull();
    expect(database.getMessage(sourceMessageId)?.state).toMatchObject({
      isRead: true,
      isStarred: true,
      tags: ["keep"],
      note: "Preserve this state"
    });
    expect(database.search({ q: "merge marker" }).items[0]?.message.folderPath).toBe("Inbox");
    expect(database.getGmailConnection(gmail.id)).toMatchObject({
      archiveId: target.id,
      folderId: targetInbox.id,
      folderPath: "Inbox"
    });
    expect(database.deleteArchive(target.id)).toEqual(["dd/shared-merge"]);
    database.close();
  });

  it("combines mailbox trees transactionally without losing state, Gmail destinations, or attachments", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Mailbox merge",
      sourceType: "mbox",
      fingerprint: "mailbox-merge",
      sizeBytes: 400
    });
    const destination = database.ensureFolder(archive.id, "Saved", "Saved", null);
    const source = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const child = database.ensureFolder(archive.id, "Inbox/Receipts", "Receipts", source.id);
    const sourceMessageId = insertDeletionMessage(database, archive.id, source.id, "mailbox-root", "Root merge text", {
      sha256: "e".repeat(64),
      relativePath: "ee/mailbox-root",
      sizeBytes: 11
    });
    insertDeletionMessage(database, archive.id, child.id, "mailbox-child", "Child merge text", {
      sha256: "f".repeat(64),
      relativePath: "ff/mailbox-child",
      sizeBytes: 12
    });
    database.updateMessageState(sourceMessageId, {
      isRead: true,
      isStarred: true,
      tags: ["merged"],
      note: "Keep mailbox state"
    });
    database.completeArchive(archive.id, 0);
    const gmail = database.createGmailConnection({
      email: "mailbox@example.test",
      archiveId: archive.id,
      folderId: child.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      refreshToken: "mailbox-refresh-token"
    });

    expect(() => database.mergeFolders(source.id, child.id)).toThrow("child mailboxes");
    const result = database.mergeFolders(source.id, destination.id);

    expect(result).toMatchObject({
      mailbox: { id: destination.id, path: "Saved", messageCount: 2 },
      movedMessages: 2,
      removedMailboxes: 2,
      movedAttachments: 2
    });
    expect(database.getFolder(source.id)).toBeNull();
    expect(database.getFolder(child.id)).toBeNull();
    expect(database.getArchive(archive.id)).toMatchObject({
      messageCount: 2,
      folderCount: 1,
      attachmentCount: 2
    });
    expect(database.getMessage(sourceMessageId)?.state).toMatchObject({
      isRead: true,
      isStarred: true,
      tags: ["merged"],
      note: "Keep mailbox state"
    });
    expect(database.search({ q: "merge text" }).items.every((hit) => hit.message.folderPath === "Saved")).toBe(true);
    expect(database.getGmailConnection(gmail.id)).toMatchObject({
      archiveId: archive.id,
      folderId: destination.id,
      folderPath: "Saved"
    });
    expect(database.deleteArchive(archive.id).sort()).toEqual(["ee/mailbox-root", "ff/mailbox-child"]);
    database.close();
  });

  it("keeps multiple Gmail accounts separate when they share one local mailbox", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Shared Gmail",
      sourceType: "gmail",
      fingerprint: "shared-gmail-accounts",
      sizeBytes: 0
    });
    const inbox = database.ensureFolder(archive.id, "Unified inbox", "Unified inbox", null);
    database.completeArchive(archive.id, 0);

    const first = database.createGmailConnection({
      email: "first@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      refreshToken: "first-refresh-token"
    });
    const second = database.createGmailConnection({
      email: "second@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      refreshToken: "second-refresh-token"
    });

    expect(database.listGmailConnections()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, email: "first@example.test", folderId: inbox.id }),
      expect.objectContaining({ id: second.id, email: "second@example.test", folderId: inbox.id })
    ]));
    expect(database.listGmailConnections()).toHaveLength(2);

    const reauthorized = database.createGmailConnection({
      email: "FIRST@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "newer_than:90d",
      ocrEnabled: true,
      canSend: true,
      refreshToken: "replacement-refresh-token"
    });
    expect(reauthorized.id).toBe(first.id);
    expect(reauthorized).toMatchObject({ query: "newer_than:90d", ocrEnabled: true });
    expect(database.listGmailConnections()).toHaveLength(2);
    database.close();
  });

  it("persists AI jobs, analyses, usage limits, and restart recovery", async () => {
    const dataDir = await temporaryDirectory();
    let database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "AI mail",
      sourceType: "mbox",
      fingerprint: "ai-storage",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const messageId = insertDeletionMessage(database, archive.id, inbox.id, "ai-message", "Review the attached contract", {
      sha256: "1".repeat(64),
      relativePath: "11/ai-message",
      sizeBytes: 18
    });
    database.completeArchive(archive.id, 0);

    const job = database.createAiJob({
      messageId,
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "content-hash"
    });
    expect(() => database.createAiJob({
      messageId,
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "content-hash"
    })).toThrow();
    expect(database.claimNextAiJob()).toMatchObject({ id: job.id, status: "running", attempts: 1 });
    database.upsertMessageAnalysis({
      messageId,
      summary: "A contract needs review.",
      categories: ["Legal", "Review"],
      priority: "high",
      actionRequired: true,
      actionSummary: "Review the contract",
      spamProbability: 0.02,
      phishingProbability: 0.01,
      draftRecommended: false,
      confidence: 0.91,
      signals: ["Explicit review request"],
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "content-hash"
    });
    database.completeAiJob(job.id);
    expect(database.getMessageAnalysis(messageId)).toMatchObject({
      categories: ["Legal", "Review"],
      actionRequired: true,
      priority: "high"
    });
    expect(database.consumeAiRequest(1, 10)).toBe(true);
    expect(database.consumeAiRequest(1, 10)).toBe(false);
    database.recordAiTokenUsage(120, 35);
    expect(database.getAiUsageSummary()).toMatchObject({
      todayRequests: 1,
      monthRequests: 1,
      todayInputTokens: 120,
      todayOutputTokens: 35
    });

    const interrupted = database.createAiJob({
      messageId,
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "new-content-hash"
    });
    expect(database.claimNextAiJob()?.id).toBe(interrupted.id);
    database.close();
    database = new EmailDatabase(dataDir);
    expect(database.getAiJob(interrupted.id)).toMatchObject({
      status: "queued",
      error: "Analysis interrupted; restarted locally"
    });
    expect(database.listAiJobs()).toHaveLength(2);
    database.close();
  });

  it("persists upload state and detailed import diagnostics", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "large.mbox",
      sourceType: "mbox",
      fingerprint: "diagnostic-fixture",
      sizeBytes: 1_000
    });
    const job = database.createImportJob({
      archiveId: archive.id,
      sourcePath: "/tmp/large.mbox",
      sourceName: "large.mbox",
      sourceType: "mbox",
      sizeBytes: 1_000,
      ocrEnabled: false,
      temporarySource: true
    });
    const upload = database.createUploadSession({
      clientKey: "client-key",
      filename: "large.mbox",
      sizeBytes: 1_000,
      tempPath: "/tmp/partial.mbox",
      ocrEnabled: false
    });
    database.updateUploadSession(upload.id, { receivedBytes: 400, message: "partial" });
    database.addImportError(job.id, "message", "Malformed MIME section", "message-7");

    expect(database.findResumableUpload("client-key")?.receivedBytes).toBe(400);
    expect(database.listDiagnostics()[0]).toMatchObject({
      level: "warning",
      category: "parser",
      jobId: job.id,
      archiveId: archive.id,
      sourceName: "large.mbox"
    });
    expect(database.getImportJob(job.id)?.errorCount).toBe(1);
    expect(database.clearDiagnostics()).toBe(1);
    expect(database.listDiagnostics()).toEqual([]);
    expect(database.getImportJob(job.id)?.errorCount).toBe(1);
    database.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-db-"));
  directories.push(directory);
  return directory;
}

function insertDeletionMessage(
  database: EmailDatabase,
  archiveId: string,
  folderId: string,
  sourceKey: string,
  bodyText: string,
  blob: { sha256: string; relativePath: string; sizeBytes: number }
): string {
  return database.insertMessage({
    archiveId,
    folderId,
    sourceKey,
    internetMessageId: null,
    subject: sourceKey,
    sender: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    bcc: [],
    sentAt: null,
    receivedAt: null,
    bodyText,
    bodyHtml: null,
    headers: {},
    sizeBytes: 25,
    attachments: [{
      filename: `${sourceKey}.txt`,
      contentType: "text/plain",
      sizeBytes: blob.sizeBytes,
      contentId: null,
      disposition: "attachment",
      textStatus: "indexed",
      extractedText: bodyText,
      blob
    }]
  });
}

function insertDatedMessage(
  database: EmailDatabase,
  archiveId: string,
  folderId: string,
  sourceKey: string,
  receivedAt: string | null,
  sentAt: string | null = receivedAt
): string {
  return database.insertMessage({
    archiveId,
    folderId,
    sourceKey,
    internetMessageId: null,
    subject: sourceKey,
    sender: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    bcc: [],
    sentAt,
    receivedAt,
    bodyText: "ordering-marker",
    bodyHtml: null,
    headers: {},
    sizeBytes: 25,
    attachments: []
  });
}
