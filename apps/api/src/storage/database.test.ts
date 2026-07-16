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
    expect(database.listMessages({ archiveId: archive.id, starred: true }).items).toEqual([
      expect.objectContaining({ id: message.id, folderId: folder.id, folderPath: folder.path })
    ]);
    expect(database.search({ q: "rollout", archiveId: archive.id, starred: true }).items[0]?.message)
      .toMatchObject({ id: message.id, folderId: folder.id, folderPath: folder.path });
    expect(database.getArchive(archive.id)).toMatchObject({
      starredCount: 1,
      starredUnreadCount: 0
    });
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

  it("adopts a legacy queued schedule into live run progress during migration", async () => {
    const dataDir = await temporaryDirectory();
    let database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Legacy schedule",
      sourceType: "mbox",
      fingerprint: "legacy-schedule-progress",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const firstMessageId = insertDatedMessage(database, archive.id, inbox.id, "legacy-1", "2026-07-15T12:00:00.000Z");
    const secondMessageId = insertDatedMessage(database, archive.id, inbox.id, "legacy-2", "2026-07-15T12:01:00.000Z");
    database.completeArchive(archive.id, 0);
    const schedule = database.createAiSchedule({
      name: "Legacy Inbox Sweep",
      folderId: inbox.id,
      mode: "all",
      intervalMinutes: 60,
      provider: "deepseek",
      model: "deepseek-chat",
      skills: ["summarize"],
      prompt: "",
      enabled: true
    });
    for (const [index, messageId] of [firstMessageId, secondMessageId].entries()) {
      database.createAiJob({
        messageId,
        provider: "deepseek",
        model: "deepseek-chat",
        skills: ["summarize"],
        prompt: "",
        promptVersion: "legacy-v1",
        contentHash: `legacy-hash-${index}`
      });
    }
    const startedAt = new Date().toISOString();
    database.recordAiScheduleRun(schedule.id, startedAt, "Queued 2 of 3 messages");
    database.close();

    const rawDatabase = new BetterSqlite3(join(dataDir, "archive-mail.sqlite"));
    rawDatabase.pragma("user_version = 16");
    rawDatabase.close();

    database = new EmailDatabase(dataDir);
    expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      status: "processing",
      totalMessages: 3,
      queuedJobs: 2,
      skippedMessages: 1,
      queued: 2,
      running: 0,
      percent: 0
    });
    const claimed = database.claimNextAiJob()!;
    database.completeAiJob(claimed.id);
    expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      status: "processing",
      queued: 1,
      completed: 1,
      processedJobs: 1,
      percent: 50
    });
    database.close();
  });

  it("adds sender rule types when upgrading an existing version 18 database", async () => {
    const dataDir = await temporaryDirectory();
    let database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Legacy sender rules",
      sourceType: "gmail",
      fingerprint: "legacy-sender-rule-type",
      sizeBytes: 10
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "legacy-sender-rule-message",
      "Legacy Vendor",
      "legacy-vendor@example.test"
    );
    database.completeArchive(archive.id, 0);
    database.organizeTopSenderFolders(archive.id);
    database.close();

    const rawDatabase = new BetterSqlite3(join(dataDir, "archive-mail.sqlite"));
    rawDatabase.pragma("foreign_keys = OFF");
    rawDatabase.exec(`
      DROP INDEX sender_filing_rules_archive_idx;
      ALTER TABLE sender_filing_rules RENAME TO sender_filing_rules_v19;
      CREATE TABLE sender_filing_rules (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        sender_name TEXT,
        folder_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(archive_id) REFERENCES archives(id) ON DELETE CASCADE,
        FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE,
        UNIQUE(archive_id, sender_address)
      );
      INSERT INTO sender_filing_rules (
        id, archive_id, sender_address, sender_name, folder_id, created_at, updated_at
      )
      SELECT id, archive_id, sender_address, sender_name, folder_id, created_at, updated_at
      FROM sender_filing_rules_v19;
      DROP TABLE sender_filing_rules_v19;
      CREATE INDEX sender_filing_rules_archive_idx
        ON sender_filing_rules(archive_id, created_at);
      PRAGMA user_version = 18;
    `);
    rawDatabase.close();

    database = new EmailDatabase(dataDir);
    expect(database.getSenderFilingStatus(archive.id).rules[0]).toMatchObject({
      senderAddress: "legacy-vendor@example.test",
      ruleType: "folder"
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
      canManageCalendar: false,
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
      canManageCalendar: false,
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
      canManageCalendar: false,
      refreshToken: "first-refresh-token"
    });
    const second = database.createGmailConnection({
      email: "second@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
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
      canManageCalendar: false,
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
      provider: "openai",
      model: "test-model",
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on contract obligations.",
      promptVersion: "test-v1",
      contentHash: "content-hash"
    });
    expect(() => database.createAiJob({
      messageId,
      provider: "openai",
      model: "test-model",
      skills: ["summarize"],
      prompt: "",
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
      provider: "deepseek",
      model: "test-model",
      skills: ["detect-phishing"],
      prompt: "Flag requests for credentials.",
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

  it("moves a single message between mailboxes in the same archive and keeps counts and search current", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Move test",
      sourceType: "mbox",
      fingerprint: "move-message-fixture",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const archived = database.ensureFolder(archive.id, "Archived", "Archived", null);
    const messageId = insertDatedMessage(database, archive.id, inbox.id, "move-me", "2026-07-01T00:00:00.000Z");
    database.completeArchive(archive.id, 0);

    expect(database.getFolder(inbox.id)?.messageCount).toBe(1);
    expect(database.getFolder(archived.id)?.messageCount).toBe(0);

    database.moveMessage(messageId, archived.id);

    expect(database.getMessage(messageId)?.folderId).toBe(archived.id);
    expect(database.getMessage(messageId)?.folderPath).toBe("Archived");
    expect(database.getFolder(inbox.id)?.messageCount).toBe(0);
    expect(database.getFolder(archived.id)?.messageCount).toBe(1);
    expect(database.search({ q: "ordering-marker", folderId: archived.id }).items).toHaveLength(1);

    const otherArchive = database.createArchive({
      name: "Other archive",
      sourceType: "mbox",
      fingerprint: "move-message-other",
      sizeBytes: 50
    });
    const otherFolder = database.ensureFolder(otherArchive.id, "Somewhere else", "Somewhere else", null);
    database.completeArchive(otherArchive.id, 0);
    expect(() => database.moveMessage(messageId, otherFolder.id))
      .toThrow("Messages can only be moved within the same archive");

    database.close();
  });

  it("exposes durable analysis and calendar-event indicators on message summaries", async () => {
    const dataDir = await temporaryDirectory();
    let database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Message indicators",
      sourceType: "mbox",
      fingerprint: "message-indicators",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const messageId = insertDatedMessage(database, archive.id, inbox.id, "indicator-message", "2026-07-16T12:00:00.000Z");
    database.completeArchive(archive.id, 0);
    expect(database.listMessages({ folderId: inbox.id }).items[0]).toMatchObject({
      hasAiAnalysis: false,
      hasCalendarEvent: false
    });

    database.upsertMessageAnalysis({
      messageId,
      summary: "An interview is scheduled.",
      categories: ["Recruitment"],
      priority: "high",
      actionRequired: true,
      actionSummary: "Attend the interview",
      spamProbability: 0,
      phishingProbability: 0,
      draftRecommended: false,
      confidence: 0.95,
      signals: ["Specific interview time"],
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "content-hash"
    });
    database.linkMessageCalendarEvent(messageId, archive.id, {
      id: "event-1",
      connectionId: archive.id,
      title: "Interview",
      description: "",
      location: "",
      startAt: "2026-07-21T16:00:00.000Z",
      endAt: "2026-07-21T17:00:00.000Z",
      allDay: false,
      htmlLink: null,
      meetingLink: null,
      organizer: null,
      attendees: []
    });
    expect(database.listMessages({ folderId: inbox.id }).items[0]).toMatchObject({
      hasAiAnalysis: true,
      hasCalendarEvent: true
    });

    database.close();
    database = new EmailDatabase(dataDir);
    expect(database.getMessage(messageId)).toMatchObject({ hasAiAnalysis: true, hasCalendarEvent: true });
    database.unlinkMessageCalendarEvent(archive.id, "event-1");
    expect(database.getMessage(messageId)).toMatchObject({ hasAiAnalysis: true, hasCalendarEvent: false });
    database.close();
  });

  it("files the top 20 Inbox senders, leaves Spam and other senders alone, and routes future mail", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Sender rules",
      sourceType: "gmail",
      fingerprint: "sender-rules-fixture",
      sizeBytes: 0
    });
    const inbox = database.ensureFolder(archive.id, "Account/Inbox", "Inbox", null);
    const spam = database.ensureFolder(archive.id, "Account/Spam", "Spam", null);

    for (let senderIndex = 0; senderIndex < 21; senderIndex += 1) {
      const messageCount = 21 - senderIndex;
      for (let messageIndex = 0; messageIndex < messageCount; messageIndex += 1) {
        insertSenderMessage(
          database,
          archive.id,
          inbox.id,
          `sender-${senderIndex}-message-${messageIndex}`,
          `Sender ${senderIndex}`,
          `sender${senderIndex}@example.test`
        );
      }
    }
    const spamMessageId = insertSenderMessage(
      database,
      archive.id,
      spam.id,
      "top-sender-spam",
      "Sender 0",
      "sender0@example.test"
    );
    database.completeArchive(archive.id, 0);

    const organized = database.organizeTopSenderFolders(archive.id);

    expect(organized.enabled).toBe(true);
    expect(organized.rules).toHaveLength(20);
    expect(organized.lastRunMovedMessages).toBe(230);
    expect(organized.lastRunCreatedFolders).toBe(21);
    expect(organized.rules[0]).toMatchObject({
      senderAddress: "sender0@example.test",
      messageCount: 21,
      folderPath: "Top Senders/Sender 0"
    });
    expect(database.listMessages({ folderId: inbox.id, limit: 100 }).items).toHaveLength(1);
    expect(database.listMessages({ folderId: inbox.id, limit: 100 }).items[0]?.sender.address)
      .toBe("sender20@example.test");
    expect(database.getMessage(spamMessageId)?.folderId).toBe(spam.id);

    const futureFiledId = insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "future-top-sender",
      "Sender 0",
      "SENDER0@EXAMPLE.TEST"
    );
    const futureInboxId = insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "future-other-sender",
      "Other Sender",
      "other@example.test"
    );
    expect(database.getMessage(futureFiledId)?.folderPath).toBe("Top Senders/Sender 0");
    expect(database.getMessage(futureInboxId)?.folderId).toBe(inbox.id);

    const rerun = database.organizeTopSenderFolders(archive.id);
    expect(rerun.rules).toHaveLength(20);
    expect(rerun.lastRunMovedMessages).toBe(0);
    expect(rerun.lastRunCreatedFolders).toBe(0);

    expect(database.clearSenderFilingRules(archive.id).enabled).toBe(false);
    const afterDisableId = insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "after-disable",
      "Sender 0",
      "sender0@example.test"
    );
    expect(database.getMessage(afterDisableId)?.folderId).toBe(inbox.id);
    database.close();
  });

  it("moves every existing sender message to Spam and routes future Inbox mail there", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Spam sender rules",
      sourceType: "gmail",
      fingerprint: "spam-sender-rules-fixture",
      sizeBytes: 0
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const archived = database.ensureFolder(archive.id, "Archived", "Archived", null);
    const firstMessageId = insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "spam-sender-first",
      "Persistent Spammer",
      "SPAMMER@example.test"
    );
    insertSenderMessage(
      database,
      archive.id,
      archived.id,
      "spam-sender-second",
      "Persistent Spammer",
      "spammer@example.test"
    );
    database.completeArchive(archive.id, 0);

    const result = database.markSenderAsSpam(firstMessageId);

    expect(result).toMatchObject({
      senderAddress: "spammer@example.test",
      spamFolderPath: "Spam",
      movedMessages: 2,
      message: { id: firstMessageId, folderPath: "Spam" }
    });
    expect(database.getSenderFilingStatus(archive.id).rules).toEqual([
      expect.objectContaining({
        senderAddress: "spammer@example.test",
        ruleType: "spam",
        folderPath: "Spam",
        messageCount: 2
      })
    ]);

    const futureMessageId = insertSenderMessage(
      database,
      archive.id,
      inbox.id,
      "spam-sender-future",
      "Persistent Spammer",
      "spammer@example.test"
    );
    expect(database.getMessage(futureMessageId)?.folderPath).toBe("Spam");
    database.close();
  });

  it("stores per-day to-do items ordered by position and supports editing and removal", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);

    const first = database.createTodo({ date: "2026-07-15", text: "Write the report" });
    const second = database.createTodo({ date: "2026-07-15", text: "Call the vendor" });
    database.createTodo({ date: "2026-07-16", text: "Different day" });

    expect(database.listTodos("2026-07-15", "2026-07-15").map((todo) => todo.text)).toEqual([
      "Write the report",
      "Call the vendor"
    ]);
    expect(first.completed).toBe(false);
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);

    const completed = database.updateTodo(first.id, { completed: true });
    expect(completed.completed).toBe(true);
    expect(completed.text).toBe("Write the report");

    const renamed = database.updateTodo(second.id, { text: "Call the vendor back" });
    expect(renamed.text).toBe("Call the vendor back");

    database.deleteTodo(first.id);
    expect(database.listTodos("2026-07-15", "2026-07-15").map((todo) => todo.id)).toEqual([second.id]);
    expect(() => database.updateTodo("missing-id", { completed: true })).toThrow("To-do item not found");

    database.close();
  });

  it("creates, runs, and reports on AI schedules scoped to a folder and read state", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Schedule mail",
      sourceType: "mbox",
      fingerprint: "ai-schedule",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const otherFolder = database.ensureFolder(archive.id, "Archived", "Archived", null);
    database.completeArchive(archive.id, 0);

    const readId = insertDatedMessage(database, archive.id, inbox.id, "read-message", "2026-07-01T00:00:00.000Z");
    database.updateMessageState(readId, { isRead: true });
    const unreadId = insertDatedMessage(database, archive.id, inbox.id, "unread-message", "2026-07-02T00:00:00.000Z");
    insertDatedMessage(database, archive.id, otherFolder.id, "other-folder-message", "2026-07-03T00:00:00.000Z");

    const schedule = database.createAiSchedule({
      name: "Inbox sweep",
      folderId: inbox.id,
      mode: "unread",
      intervalMinutes: 30,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on commitments and due dates.",
      enabled: true
    });
    expect(schedule).toMatchObject({
      name: "Inbox sweep",
      folderId: inbox.id,
      folderPath: "Inbox",
      archiveId: archive.id,
      archiveName: "Schedule mail",
      mode: "unread",
      intervalMinutes: 30,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on commitments and due dates.",
      enabled: true,
      lastRunAt: null
    });

    expect(database.listMessageIdsForSchedule(inbox.id, "unread")).toEqual([unreadId]);
    expect(database.listMessageIdsForSchedule(inbox.id, "all").sort()).toEqual([readId, unreadId].sort());

    expect(() => database.createAiSchedule({
      name: "Bad folder",
      folderId: "00000000-0000-0000-0000-000000000000",
      mode: "all",
      intervalMinutes: 60,
      provider: "openai",
      model: "gpt-test",
      skills: ["summarize"],
      prompt: "",
      enabled: true
    })).toThrow("Mailbox not found");

    expect(database.dueAiSchedules(new Date().toISOString()).map((entry) => entry.id)).toEqual([schedule.id]);

    database.recordAiScheduleRun(schedule.id, "2026-07-10T00:00:00.000Z", "Queued 1 of 1 message");
    const afterRun = database.getAiSchedule(schedule.id)!;
    expect(afterRun).toMatchObject({ lastRunAt: "2026-07-10T00:00:00.000Z", lastRunSummary: "Queued 1 of 1 message" });

    expect(database.dueAiSchedules("2026-07-10T00:10:00.000Z")).toEqual([]);
    expect(database.dueAiSchedules("2026-07-10T00:31:00.000Z").map((entry) => entry.id)).toEqual([schedule.id]);

    const disabled = database.updateAiSchedule(schedule.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(database.dueAiSchedules("2026-07-10T01:00:00.000Z")).toEqual([]);

    database.deleteAiSchedule(schedule.id);
    expect(database.listAiSchedules()).toEqual([]);

    database.close();
  });

  it("aggregates mailbox insights: endpoints, top contacts, and AI analysis breakdown", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Insights mail",
      sourceType: "mbox",
      fingerprint: "insights",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);

    const empty = database.getAdminInsights();
    expect(empty).toMatchObject({ totalMessages: 0, totalAttachments: 0, analysis: null });
    expect(empty.endpoints).toEqual({ oldest: null, newest: null });

    const oldestId = database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "oldest",
      internetMessageId: null,
      subject: "First contact",
      sender: { name: "Vendor A", address: "vendor-a@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2020-01-01T00:00:00.000Z",
      receivedAt: "2020-01-01T00:00:00.000Z",
      bodyText: "oldest",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });
    database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "middle",
      internetMessageId: null,
      subject: "Second contact",
      sender: { name: "Vendor A", address: "vendor-a@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2021-01-01T00:00:00.000Z",
      receivedAt: "2021-01-01T00:00:00.000Z",
      bodyText: "middle",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });
    const newestId = database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "newest",
      internetMessageId: null,
      subject: "Third contact",
      sender: { name: "Vendor B", address: "vendor-b@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2022-01-01T00:00:00.000Z",
      receivedAt: "2022-01-01T00:00:00.000Z",
      bodyText: "newest",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });

    database.upsertMessageAnalysis({
      messageId: oldestId,
      summary: "Needs review",
      categories: ["Finance", "Vendor"],
      priority: "high",
      actionRequired: true,
      actionSummary: "Pay invoice",
      spamProbability: 0.1,
      phishingProbability: 0.05,
      draftRecommended: false,
      confidence: 0.9,
      signals: [],
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "hash-1"
    });
    database.upsertMessageAnalysis({
      messageId: newestId,
      summary: "Likely spam",
      categories: ["Finance"],
      priority: "low",
      actionRequired: false,
      actionSummary: null,
      spamProbability: 0.9,
      phishingProbability: 0.8,
      draftRecommended: true,
      confidence: 0.6,
      signals: [],
      model: "test-model",
      promptVersion: "test-v1",
      contentHash: "hash-2"
    });

    const insights = database.getAdminInsights();
    expect(insights.totalMessages).toBe(3);
    expect(insights.endpoints.oldest).toMatchObject({ id: oldestId, subject: "First contact", date: "2020-01-01T00:00:00.000Z" });
    expect(insights.endpoints.newest).toMatchObject({ id: newestId, subject: "Third contact", date: "2022-01-01T00:00:00.000Z" });
    expect(insights.topSenders).toEqual([
      { address: "vendor-a@example.test", name: "Vendor A", count: 2 },
      { address: "vendor-b@example.test", name: "Vendor B", count: 1 }
    ]);
    expect(insights.topRecipients).toEqual([
      { address: "owner@example.test", name: "Owner", count: 3 }
    ]);
    expect(insights.analysis).toMatchObject({
      analyzedCount: 2,
      priorityBreakdown: { low: 1, normal: 0, high: 1, urgent: 0 },
      actionRequiredCount: 1,
      draftRecommendedCount: 1,
      flaggedSpamCount: 1,
      flaggedPhishingCount: 1
    });
    expect(insights.analysis?.topCategories).toEqual(expect.arrayContaining([
      { category: "Finance", count: 2 },
      { category: "Vendor", count: 1 }
    ]));
    expect(insights.analysis?.averageSpamProbability).toBeCloseTo(0.5, 5);

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

function insertSenderMessage(
  database: EmailDatabase,
  archiveId: string,
  folderId: string,
  sourceKey: string,
  senderName: string,
  senderAddress: string
): string {
  return database.insertMessage({
    archiveId,
    folderId,
    sourceKey,
    internetMessageId: null,
    subject: sourceKey,
    sender: { name: senderName, address: senderAddress },
    to: [],
    cc: [],
    bcc: [],
    sentAt: "2026-07-15T12:00:00.000Z",
    receivedAt: "2026-07-15T12:00:00.000Z",
    bodyText: "sender-rule-marker",
    bodyHtml: null,
    headers: {},
    sizeBytes: 25,
    attachments: []
  });
}
