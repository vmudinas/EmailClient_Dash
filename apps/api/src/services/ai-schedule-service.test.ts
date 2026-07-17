import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDatabase } from "../storage/database.js";
import { AiScheduleService } from "./ai-schedule-service.js";
import { AiService } from "./ai-service.js";
import { AiSettingsManager } from "./ai-settings.js";
import { DraftSettingsManager } from "./draft-settings.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AiScheduleService", () => {
  it("runs a due schedule against its folder, respects unread-only mode, and records the summary", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Schedule mail",
      sourceType: "mbox",
      fingerprint: "ai-schedule-service",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const otherFolder = database.ensureFolder(archive.id, "Archived", "Archived", null);
    database.completeArchive(archive.id, 0);

    const unreadId = insertMessage(database, archive.id, inbox.id, "unread-message");
    const readId = insertMessage(database, archive.id, inbox.id, "read-message");
    database.updateMessageState(readId, { isRead: true });
    insertMessage(database, archive.id, otherFolder.id, "other-folder-message");

    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-test-secret", clearApiKey: false, enabled: true });
    const analyze = vi.fn().mockResolvedValue({
      analysis: {
        summary: "Automated summary",
        categories: ["General"],
        priority: "normal",
        actionRequired: false,
        actionSummary: null,
        spamProbability: 0.01,
        phishingProbability: 0.01,
        draftRecommended: false,
        confidence: 0.8,
        signals: []
      },
      usage: { inputTokens: 50, outputTokens: 20 }
    });
    const ai = new AiService(database, settings, () => ({ analyze, testConnection: vi.fn() }));
    const scheduler = new AiScheduleService(database, ai);

    const schedule = database.createAiSchedule({
      name: "Inbox unread sweep",
      folderId: inbox.id,
      mode: "unread",
      intervalMinutes: 30,
      provider: "openai",
      model: "schedule-model",
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on deadlines and explicit commitments.",
      enabled: true
    });

    await scheduler.runDueSchedules("2026-07-10T00:00:00.000Z");
    await waitForAnalysis(database, unreadId);

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({ id: unreadId }),
      expect.any(AbortSignal),
      { skills: ["summarize", "extract-actions"], prompt: "Focus on deadlines and explicit commitments." },
      expect.objectContaining({ messages: [expect.objectContaining({ id: unreadId })] })
    );
    expect(database.getMessageAnalysis(unreadId)).toMatchObject({ summary: "Automated summary" });
    expect(database.getMessageAnalysis(readId)).toBeNull();

    const afterRun = database.getAiSchedule(schedule.id)!;
    expect(afterRun.lastRunAt).toBe("2026-07-10T00:00:00.000Z");
    expect(afterRun.lastRunSummary).toBe("Completed 1 of 1 jobs");
    expect(afterRun.progress).toMatchObject({
      status: "completed",
      totalMessages: 1,
      queuedJobs: 1,
      completed: 1,
      processedJobs: 1,
      percent: 100
    });
    expect(database.listDiagnostics({ category: "ai" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "info", message: expect.stringContaining("Inbox unread sweep") })
    ]));

    await ai.close();
    scheduler.close();
    database.close();
  });

  it("reports live queued, running, completed, and percent counts for a schedule run", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Progress mail",
      sourceType: "mbox",
      fingerprint: "ai-schedule-progress",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    insertMessage(database, archive.id, inbox.id, "message-1");
    insertMessage(database, archive.id, inbox.id, "message-2");

    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-test-secret", clearApiKey: false, enabled: true });
    let releaseAnalysis!: (value: {
      analysis: {
        summary: string; categories: string[]; priority: "normal"; actionRequired: boolean;
        actionSummary: null; spamProbability: number; phishingProbability: number;
        draftRecommended: boolean; confidence: number; signals: string[];
      };
      usage: { inputTokens: number; outputTokens: number };
    }) => void;
    const pendingAnalysis = new Promise<Parameters<typeof releaseAnalysis>[0]>((resolve) => {
      releaseAnalysis = resolve;
    });
    const analyze = vi.fn().mockReturnValue(pendingAnalysis);
    const ai = new AiService(database, settings, () => ({ analyze, testConnection: vi.fn() }));
    const scheduler = new AiScheduleService(database, ai);
    const schedule = database.createAiSchedule({
      name: "Progress sweep",
      folderId: inbox.id,
      mode: "all",
      intervalMinutes: 60,
      provider: "openai",
      model: "schedule-model",
      skills: ["summarize"],
      prompt: "",
      enabled: true
    });

    await scheduler.runNow(schedule.id);

    expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      status: "processing",
      totalMessages: 2,
      queuedJobs: 2,
      queued: 1,
      running: 1,
      completed: 0,
      processedJobs: 0,
      percent: 0
    });
    await expect(scheduler.runNow(schedule.id)).rejects.toThrow("already has a run in progress");
    expect(database.dueAiSchedules("2099-01-01T00:00:00.000Z")).toEqual([]);

    releaseAnalysis({
      analysis: {
        summary: "done", categories: [], priority: "normal", actionRequired: false,
        actionSummary: null, spamProbability: 0, phishingProbability: 0,
        draftRecommended: false, confidence: 1, signals: []
      },
      usage: { inputTokens: 1, outputTokens: 1 }
    });
    await vi.waitFor(() => expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      status: "completed",
      queued: 0,
      running: 0,
      completed: 2,
      processedJobs: 2,
      percent: 100
    }));

    await ai.close();
    scheduler.close();
    database.close();
  });

  it("does not re-run a schedule before its interval elapses, but runNow forces it regardless", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Schedule mail",
      sourceType: "mbox",
      fingerprint: "ai-schedule-service-interval",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    insertMessage(database, archive.id, inbox.id, "message-1");

    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-test-secret", clearApiKey: false, enabled: true });
    const analyze = vi.fn().mockResolvedValue({
      analysis: {
        summary: "s", categories: [], priority: "normal", actionRequired: false, actionSummary: null,
        spamProbability: 0, phishingProbability: 0, draftRecommended: false, confidence: 0.5, signals: []
      },
      usage: { inputTokens: 1, outputTokens: 1 }
    });
    const ai = new AiService(database, settings, () => ({ analyze, testConnection: vi.fn() }));
    const scheduler = new AiScheduleService(database, ai);

    const schedule = database.createAiSchedule({
      name: "Rarely",
      folderId: inbox.id,
      mode: "all",
      intervalMinutes: 60,
      provider: "openai",
      model: "schedule-model",
      skills: ["summarize"],
      prompt: "",
      enabled: true
    });
    await scheduler.runDueSchedules("2026-07-10T00:00:00.000Z");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));

    // 10 minutes later — well inside the 60-minute interval, should not run again.
    await scheduler.runDueSchedules("2026-07-10T00:10:00.000Z");
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(database.getAiSchedule(schedule.id)?.lastRunAt).toBe("2026-07-10T00:00:00.000Z");

    await scheduler.runNow(schedule.id);
    expect(database.getAiSchedule(schedule.id)?.lastRunAt).not.toBe("2026-07-10T00:00:00.000Z");

    await ai.close();
    scheduler.close();
    database.close();
  });

  it("stops a run early and records why when AI analysis is disabled, without erroring", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Schedule mail",
      sourceType: "mbox",
      fingerprint: "ai-schedule-service-disabled",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    insertMessage(database, archive.id, inbox.id, "message-1");

    const settings = new AiSettingsManager(dataDir, {});
    const analyze = vi.fn();
    const ai = new AiService(database, settings, () => ({ analyze, testConnection: vi.fn() }));
    const scheduler = new AiScheduleService(database, ai);

    database.createAiSchedule({
      name: "Disabled AI",
      folderId: inbox.id,
      mode: "all",
      intervalMinutes: 30,
      provider: "openai",
      model: "schedule-model",
      skills: ["summarize"],
      prompt: "",
      enabled: true
    });

    await scheduler.runDueSchedules("2026-07-10T00:00:00.000Z");

    expect(analyze).not.toHaveBeenCalled();
    const schedule = database.listAiSchedules()[0]!;
    expect(schedule.lastRunSummary).toContain("Failed:");
    expect(schedule.progress).toMatchObject({ status: "failed", queuedJobs: 0 });
    expect(database.listDiagnostics({ category: "ai" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "warning", message: expect.stringContaining("Failed:") })
    ]));

    await ai.close();
    scheduler.close();
    database.close();
  });

  it("creates one reviewable draft for a specific development email and selects the configured resume", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Development opportunities",
      sourceType: "gmail",
      fingerprint: "ai-draft-schedule",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    const messageId = insertMessage(database, archive.id, inbox.id, "Senior TypeScript contract");
    const connection = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    const resume = database.createResumeAsset({
      name: "Engineering resume",
      filename: "resume.pdf",
      contentType: "application/pdf",
      blob: { sha256: "a".repeat(64), relativePath: "aa/aa/fake-resume", sizeBytes: 100 }
    });

    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-test-secret", clearApiKey: false, enabled: true });
    const draftSettings = new DraftSettingsManager(dataDir);
    draftSettings.update({
      defaultFromAddress: "automation@vitas.work",
      senderName: "Vitas Mudinas"
    });
    const draftReply = vi.fn().mockResolvedValue({
      draft: {
        workRelated: true,
        developmentOpportunity: true,
        reason: "A recruiter is offering a software development contract.",
        subject: "Senior TypeScript contract",
        bodyText: "Thank you for reaching out. I would be glad to discuss the role.\n\nBest,\n[Name ]",
        confidence: 0.97
      },
      usage: { inputTokens: 40, outputTokens: 25 }
    });
    const ai = new AiService(
      database,
      settings,
      () => ({
        analyze: vi.fn(),
        draftReply,
        testConnection: vi.fn()
      }),
      undefined,
      draftSettings
    );
    const scheduler = new AiScheduleService(database, ai);
    const schedule = database.createAiSchedule({
      name: "Development reply drafts",
      task: "draft_reply",
      folderId: inbox.id,
      messageId,
      gmailConnectionId: connection.id,
      resumeId: resume.id,
      mode: "all",
      intervalMinutes: 30,
      provider: "openai",
      model: "draft-model",
      skills: ["recommend-draft", "prioritize"],
      prompt: "Keep replies brief and professional.",
      enabled: true
    });

    await scheduler.runNow(schedule.id);
    await vi.waitFor(() => expect(database.listEmailDrafts()).toHaveLength(1));

    expect(draftReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: messageId }),
      expect.any(AbortSignal),
      { skills: ["recommend-draft", "prioritize"], prompt: "Keep replies brief and professional." },
      expect.objectContaining({ messages: [expect.objectContaining({ id: messageId })] })
    );
    expect(database.listEmailDrafts()[0]).toMatchObject({
      source: "ai",
      fromAddress: "automation@vitas.work",
      sourceMessageId: messageId,
      connectionId: connection.id,
      to: ["sender@example.test"],
      subject: "Re: Senior TypeScript contract",
      bodyText: expect.stringContaining("Vitas Mudinas"),
      developmentOpportunity: true,
      resumeId: resume.id,
      resumeFilename: "resume.pdf"
    });

    await scheduler.runNow(schedule.id);
    expect(draftReply).toHaveBeenCalledTimes(1);
    expect(database.listEmailDrafts()).toHaveLength(1);

    await ai.close();
    scheduler.close();
    database.close();
  });

  it("queues only one draft per conversation and reports duplicate chain messages as skipped", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Conversation schedule",
      sourceType: "gmail",
      fingerprint: "conversation-schedule",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    database.completeArchive(archive.id, 0);
    const firstMessageId = database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "conversation-schedule-first",
      internetMessageId: "<schedule-first@example.test>",
      subject: "Remote engineering role",
      sender: { name: "Recruiter", address: "recruiter@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2026-07-15T12:00:00.000Z",
      receivedAt: "2026-07-15T12:00:00.000Z",
      bodyText: "Initial role message",
      bodyHtml: null,
      headers: { "message-id": "<schedule-first@example.test>" },
      sizeBytes: 20,
      attachments: []
    });
    const secondMessageId = database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "conversation-schedule-second",
      internetMessageId: "<schedule-second@example.test>",
      subject: "Re: Remote engineering role",
      sender: { name: "Recruiter", address: "recruiter@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2026-07-15T13:00:00.000Z",
      receivedAt: "2026-07-15T13:00:00.000Z",
      bodyText: "Following up on the same role",
      bodyHtml: null,
      headers: {
        "message-id": "<schedule-second@example.test>",
        "in-reply-to": "<schedule-first@example.test>"
      },
      sizeBytes: 20,
      attachments: []
    });
    const connection = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: archive.id,
      folderId: inbox.id,
      query: "",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-test-secret", clearApiKey: false, enabled: true });
    const draftReply = vi.fn().mockResolvedValue({
      draft: {
        workRelated: true,
        developmentOpportunity: true,
        reason: "Recruiter conversation",
        subject: "Remote engineering role",
        bodyText: "Thank you for reaching out.",
        confidence: 0.96
      },
      usage: { inputTokens: 20, outputTokens: 10 }
    });
    const ai = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      draftReply,
      testConnection: vi.fn()
    }));
    const scheduler = new AiScheduleService(database, ai);
    const schedule = database.createAiSchedule({
      name: "Conversation draft sweep",
      task: "draft_reply",
      folderId: inbox.id,
      gmailConnectionId: connection.id,
      mode: "all",
      intervalMinutes: 30,
      provider: "openai",
      model: "draft-model",
      skills: ["recommend-draft"],
      prompt: "",
      enabled: true
    });

    await scheduler.runNow(schedule.id);
    await vi.waitFor(() => expect(database.listEmailDrafts()).toHaveLength(1));
    expect(draftReply).toHaveBeenCalledTimes(1);
    expect([firstMessageId, secondMessageId]).toContain(database.listEmailDrafts()[0]?.sourceMessageId);
    expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      totalMessages: 2,
      queuedJobs: 1,
      skippedMessages: 1,
      completed: 1
    });
    expect(database.listDiagnostics().some((entry) => entry.context.operation === "draft_skip")).toBe(true);

    await scheduler.runNow(schedule.id);
    expect(draftReply).toHaveBeenCalledTimes(1);
    expect(database.getAiSchedule(schedule.id)?.progress).toMatchObject({
      totalMessages: 2,
      queuedJobs: 0,
      skippedMessages: 2
    });

    await ai.close();
    scheduler.close();
    database.close();
  });
});

async function waitForAnalysis(database: EmailDatabase, messageId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (database.getMessageAnalysis(messageId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Analysis for ${messageId} did not complete in time`);
}

function insertMessage(database: EmailDatabase, archiveId: string, folderId: string, sourceKey: string): string {
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
    sentAt: "2026-07-01T00:00:00.000Z",
    receivedAt: "2026-07-01T00:00:00.000Z",
    bodyText: sourceKey,
    bodyHtml: null,
    headers: {},
    sizeBytes: 20,
    attachments: []
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-ai-schedule-"));
  directories.push(directory);
  return directory;
}
