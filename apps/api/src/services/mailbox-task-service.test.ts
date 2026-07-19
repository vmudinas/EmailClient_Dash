import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmailDatabase } from "../storage/database.js";
import { MailboxTaskService } from "./mailbox-task-service.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("MailboxTaskService", () => {
  it("runs smart rules in chunks and yields between batches", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const service = new MailboxTaskService(database);
    const archive = database.createArchive({
      name: "Queued rules",
      sourceType: "mbox",
      fingerprint: "queued-rules",
      sizeBytes: 0
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const finance = database.ensureFolder(archive.id, "Finance", "Finance", null);
    for (let index = 0; index < 510; index += 1) {
      insertMessage(database, archive.id, inbox.id, index);
    }
    database.completeArchive(archive.id, 0);
    const rule = database.createSmartMailRule({
      archiveId: archive.id,
      name: "Move invoices",
      instruction: "Move invoices to Finance.",
      conditions: {
        match: "any",
        senderContains: [],
        subjectContains: ["invoice"],
        bodyContains: [],
        hasAttachments: null
      },
      targetFolderId: finance.id,
      markRead: true,
      star: false,
      enabled: true,
      applyExisting: false
    });

    const queued = service.enqueueSmartRuleRun({ archiveId: archive.id, ruleIds: [rule.id], scope: "inbox" });
    expect(queued.status).toBe("queued");
    expect(queued.totalMessages).toBe(510);

    const running = await waitForTaskProgress(service, queued.id, 500);
    expect(running.processedMessages).toBeGreaterThanOrEqual(500);
    expect(running.movedMessages).toBeGreaterThanOrEqual(500);

    const completed = await waitForTask(service, queued.id);
    expect(completed).toMatchObject({
      status: "completed",
      totalRules: 1,
      completedRules: 1,
      totalMessages: 510,
      processedMessages: 510,
      matchedMessages: 510,
      movedMessages: 510,
      markedReadMessages: 510
    });
    expect(database.getFolder(inbox.id)?.messageCount).toBe(0);
    expect(database.getFolder(finance.id)?.messageCount).toBe(510);

    await service.close();
    database.close();
  });

  it("cancels a queued smart-rule task before it starts", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const service = new MailboxTaskService(database);
    const archive = database.createArchive({
      name: "Cancelled rules",
      sourceType: "mbox",
      fingerprint: "cancelled-rules",
      sizeBytes: 0
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    insertMessage(database, archive.id, inbox.id, 0);
    database.completeArchive(archive.id, 0);
    const rule = database.createSmartMailRule({
      archiveId: archive.id,
      name: "Mark invoice read",
      instruction: "Mark invoices read.",
      conditions: {
        match: "any",
        senderContains: [],
        subjectContains: ["invoice"],
        bodyContains: [],
        hasAttachments: null
      },
      targetFolderId: null,
      markRead: true,
      star: false,
      enabled: true,
      applyExisting: false
    });

    const queued = service.enqueueSmartRuleRun({ archiveId: archive.id, ruleIds: [rule.id], scope: "inbox" });
    expect(service.cancelTask(queued.id)).toMatchObject({ status: "cancelled", cancelRequested: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.getTask(queued.id)).toMatchObject({ status: "cancelled", processedMessages: 0 });

    await service.close();
    database.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mailbox-task-service-"));
  directories.push(directory);
  return directory;
}

async function waitForTask(service: MailboxTaskService, taskId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = service.getTask(taskId);
    if (task && !["queued", "running"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Mailbox task did not finish");
}

async function waitForTaskProgress(service: MailboxTaskService, taskId: string, processedMessages: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const task = service.getTask(taskId);
    if (task && task.processedMessages >= processedMessages) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Mailbox task did not report progress");
}

function insertMessage(
  database: EmailDatabase,
  archiveId: string,
  folderId: string,
  index: number
): void {
  database.insertMessage({
    archiveId,
    folderId,
    sourceKey: `invoice-${index}`,
    internetMessageId: `<invoice-${index}@example.test>`,
    subject: `Invoice ${index}`,
    sender: { name: "Billing", address: "billing@example.test" },
    to: [{ name: "Owner", address: "owner@example.test" }],
    cc: [],
    bcc: [],
    sentAt: "2026-07-18T12:00:00.000Z",
    receivedAt: "2026-07-18T12:00:00.000Z",
    bodyText: "An invoice is ready.",
    bodyHtml: null,
    headers: { "message-id": `<invoice-${index}@example.test>` },
    sizeBytes: 20,
    attachments: []
  });
}
