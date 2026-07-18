import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INBOX_TABS } from "@email-client/shared";
import { EmailDatabase } from "../storage/database.js";
import { AiProviderError, type AiConversationContext, type AiProvider } from "./ai-provider.js";
import { AiConfigurationError, AiService } from "./ai-service.js";
import { AiSettingsManager } from "./ai-settings.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AiService", () => {
  it("retries transient failures, persists structured output, and reuses a current result", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "test-analysis-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const analyze = vi.fn()
      .mockRejectedValueOnce(new AiProviderError("Temporary provider outage", true))
      .mockResolvedValue({
        analysis: {
          summary: "A customer is requesting a contract review.",
          categories: ["Customer", "Legal"],
          priority: "high",
          actionRequired: true,
          actionSummary: "Review and respond to the contract request",
          spamProbability: 0.01,
          phishingProbability: 0.02,
          draftRecommended: true,
          confidence: 0.94,
          signals: ["Direct request from a known customer"]
        },
        usage: { inputTokens: 140, outputTokens: 55 }
      });
    const provider: AiProvider = { analyze, testConnection: vi.fn().mockResolvedValue(undefined) };
    const service = new AiService(database, settings, () => provider);

    const started = service.startAnalysis(messageId);
    expect(started.job.status).toBe("queued");
    const completed = await waitForJob(database, started.job.id, "completed");
    expect(completed).toMatchObject({ attempts: 2, model: "test-analysis-model" });
    expect(database.getMessageAnalysis(messageId)).toMatchObject({
      categories: ["Customer", "Legal"],
      priority: "high",
      draftRecommended: true
    });
    expect(database.getAiUsageSummary()).toMatchObject({
      todayRequests: 2,
      todayInputTokens: 140,
      todayOutputTokens: 55
    });
    expect(database.listDiagnostics({ category: "ai" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "warning", message: "Temporary provider outage" }),
      expect.objectContaining({ level: "info", message: "Email analysis completed" })
    ]));
    expect(JSON.stringify(database.listDiagnostics({ category: "ai" }))).not.toContain("private contract body");

    const cached = service.startAnalysis(messageId);
    expect(cached.job.id).toBe(started.job.id);
    expect(cached.analysis?.summary).toContain("contract review");
    expect(analyze).toHaveBeenCalledTimes(2);
    await service.close();
    database.close();
  });

  it("groups prior thread and sender analyses and refreshes when that context changes", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const archive = database.createArchive({
      name: "Related analysis context",
      sourceType: "mbox",
      fingerprint: "related-analysis-context",
      sizeBytes: 100
    });
    const inbox = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const insertContextMessage = (
      sourceKey: string,
      subject: string,
      receivedAt: string,
      headers: Record<string, string> = {}
    ) => database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey,
      internetMessageId: `<${sourceKey}@example.test>`,
      subject,
      sender: { name: "Customer", address: "customer@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: receivedAt,
      receivedAt,
      bodyText: `${subject} body`,
      bodyHtml: null,
      headers: { "message-id": `<${sourceKey}@example.test>`, ...headers },
      sizeBytes: 40,
      attachments: []
    });
    const senderHistoryId = insertContextMessage(
      "sender-history",
      "Earlier contract request",
      "2026-07-10T12:00:00.000Z"
    );
    const threadRootId = insertContextMessage(
      "thread-root",
      "Project status",
      "2026-07-11T12:00:00.000Z"
    );
    const selectedMessageId = insertContextMessage(
      "thread-reply",
      "Re: Project status",
      "2026-07-12T12:00:00.000Z",
      { "in-reply-to": "<thread-root@example.test>" }
    );
    database.completeArchive(archive.id, 0);
    saveAnalysis(database, senderHistoryId, "The customer previously requested a contract review.");
    saveAnalysis(database, threadRootId, "The customer opened the project status conversation.");

    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "context-analysis-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const analyze = vi.fn().mockResolvedValue({
      analysis: {
        summary: "The customer is following up on project status.",
        categories: ["Customer", "Project"],
        priority: "normal",
        actionRequired: true,
        actionSummary: "Reply with the current project status",
        spamProbability: 0.01,
        phishingProbability: 0.01,
        draftRecommended: true,
        confidence: 0.95,
        signals: ["Continuation of an existing customer conversation"]
      },
      usage: { inputTokens: 180, outputTokens: 60 }
    });
    const provider: AiProvider = { analyze, testConnection: vi.fn().mockResolvedValue(undefined) };
    const service = new AiService(database, settings, () => provider);

    const started = service.startAnalysis(selectedMessageId);
    await waitForJob(database, started.job.id, "completed");
    const firstContext = analyze.mock.calls[0]?.[3] as AiConversationContext;
    expect(firstContext.messages.map((message) => message.id)).toEqual([threadRootId, selectedMessageId]);
    expect(firstContext.relatedAnalyses?.sameThread).toEqual([
      expect.objectContaining({ messageId: threadRootId, summary: expect.stringContaining("opened") })
    ]);
    expect(firstContext.relatedAnalyses?.sameSender).toEqual([
      expect.objectContaining({ messageId: senderHistoryId, summary: expect.stringContaining("contract review") })
    ]);
    const firstAnalysis = database.getMessageAnalysis(selectedMessageId)!;
    expect(firstAnalysis.contextHash).toMatch(/^[a-f0-9]{64}$/);

    const cached = service.startAnalysis(selectedMessageId);
    expect(cached.job.id).toBe(started.job.id);
    expect(analyze).toHaveBeenCalledOnce();

    saveAnalysis(database, senderHistoryId, "The customer's earlier contract review is now urgent.");
    const refreshed = service.startAnalysis(selectedMessageId);
    expect(refreshed.job.id).not.toBe(started.job.id);
    await waitForJob(database, refreshed.job.id, "completed");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(database.getMessageAnalysis(selectedMessageId)?.contextHash).not.toBe(firstAnalysis.contextHash);

    await service.close();
    database.close();
  });

  it("adds configured Inbox tabs to categorization prompts and applies confident assignments", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const message = database.getMessage(messageId)!;
    database.updateInboxTabSettings(message.archiveId, {
      tabs: DEFAULT_INBOX_TABS.map((tab) => ({ ...tab, keywords: [], senderDomains: [] })),
      aiEnabled: true,
      aiConfidenceThreshold: 0.9
    });
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "tab-analysis-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const analyze = vi.fn().mockResolvedValue({
      analysis: {
        summary: "A billing notice needs attention.",
        categories: ["bills"],
        priority: "normal",
        actionRequired: false,
        actionSummary: null,
        spamProbability: 0.01,
        phishingProbability: 0.01,
        draftRecommended: false,
        confidence: 0.95,
        signals: ["Billing language"]
      },
      usage: { inputTokens: 100, outputTokens: 30 }
    });
    const service = new AiService(database, settings, () => ({ analyze, testConnection: vi.fn() }));

    const started = service.startAnalysis(messageId);
    await waitForJob(database, started.job.id, "completed");
    expect((analyze.mock.calls[0]?.[2] as { prompt: string }).prompt).toContain("Inbox tab assignment is enabled");
    expect(database.getMessage(messageId)?.inboxCategory).toBe("bills");

    const currentTabs = database.getInboxTabSettings(message.archiveId);
    database.updateInboxTabSettings(message.archiveId, {
      tabs: currentTabs.tabs,
      aiEnabled: true,
      aiConfidenceThreshold: 0.96
    });
    const refreshed = service.startAnalysis(messageId);
    expect(refreshed.job.id).not.toBe(started.job.id);
    await waitForJob(database, refreshed.job.id, "completed");
    expect(analyze).toHaveBeenCalledTimes(2);
    await service.close();
    database.close();
  });

  it("refuses to queue analysis until AI is configured and enabled", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const settings = new AiSettingsManager(dataDir, {});
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      testConnection: vi.fn()
    }));

    expect(() => service.startAnalysis(messageId)).toThrow(AiConfigurationError);
    expect(database.listAiJobs()).toEqual([]);
    await service.close();
    database.close();
  });

  it("creates a review-only calendar or to-do suggestion and records usage", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "action-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const suggestAction = vi.fn().mockResolvedValue({
      suggestion: {
        recommendedAction: "todo",
        reason: "The contract review is due on a specific date.",
        confidence: 0.91,
        dateEvidence: ["Review by July 18"],
        calendarEvent: null,
        todo: { date: "2026-07-18", text: "Review the contract" }
      },
      usage: { inputTokens: 90, outputTokens: 35 }
    });
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      suggestAction,
      testConnection: vi.fn()
    }));

    const suggestion = await service.suggestMessageAction(messageId, {
      now: "2026-07-16T12:00:00.000Z",
      timeZone: "America/New_York"
    });

    expect(suggestAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: messageId }),
      { now: "2026-07-16T12:00:00.000Z", timeZone: "America/New_York" },
      expect.any(AbortSignal),
      expect.objectContaining({ messages: [expect.objectContaining({ id: messageId })] })
    );
    expect(suggestion).toMatchObject({
      recommendedAction: "todo",
      todo: { date: "2026-07-18", text: "Review the contract" },
      provider: "openai",
      model: "action-model"
    });
    expect(database.getAiUsageSummary()).toMatchObject({
      todayRequests: 1,
      todayInputTokens: 90,
      todayOutputTokens: 35
    });
    expect(database.listDiagnostics({ category: "ai" })).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "AI calendar/to-do suggestion created for review" })
    ]));

    await service.close();
    database.close();
  });

  it("suggests one existing folder for a selected message group using saved analyses", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const firstMessageId = insertMessage(database);
    const firstMessage = database.getMessage(firstMessageId)!;
    const jobsFolder = database.createFolder(firstMessage.archiveId, "Jobs");
    const secondMessageId = database.insertMessage({
      archiveId: firstMessage.archiveId,
      folderId: firstMessage.folderId,
      sourceKey: "message-2",
      internetMessageId: "<ai-service-2@example.test>",
      subject: "Java AWS role",
      sender: { name: "Recruiter", address: "recruiter@example.test" },
      to: [{ name: "Owner", address: "owner@example.test" }],
      cc: [],
      bcc: [],
      sentAt: "2026-07-14T13:00:00.000Z",
      receivedAt: "2026-07-14T13:00:00.000Z",
      bodyText: "A recruiter is sharing a software engineering opportunity.",
      bodyHtml: null,
      headers: { "message-id": "<ai-service-2@example.test>" },
      sizeBytes: 80,
      attachments: []
    });
    saveAnalysis(database, firstMessageId, "A recruiter requested a contract review.");
    saveAnalysis(database, secondMessageId, "A recruiter shared a Java and AWS role.");
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "filing-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const suggestFilingFolder = vi.fn().mockResolvedValue({
      suggestion: {
        targetFolderPath: jobsFolder.path,
        reason: "Both messages concern recruiting and software jobs.",
        confidence: 0.94
      },
      usage: { inputTokens: 120, outputTokens: 25 }
    });
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      suggestFilingFolder,
      testConnection: vi.fn()
    }));

    const suggestion = await service.suggestFilingFolder([firstMessageId, secondMessageId]);

    expect(suggestFilingFolder).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: firstMessageId, analysis: expect.objectContaining({ summary: expect.stringContaining("recruiter") }) }),
        expect.objectContaining({ id: secondMessageId, analysis: expect.objectContaining({ summary: expect.stringContaining("Java") }) })
      ]),
      expect.arrayContaining([jobsFolder.path]),
      expect.any(AbortSignal)
    );
    expect(suggestion).toMatchObject({
      folderId: jobsFolder.id,
      folderPath: jobsFolder.path,
      messageCount: 2,
      confidence: 0.94,
      provider: "openai",
      model: "filing-model"
    });
    expect(database.getAiUsageSummary()).toMatchObject({ todayRequests: 1, todayInputTokens: 120, todayOutputTokens: 25 });
    await service.close();
    database.close();
  });

  it("creates an on-demand reviewable reply draft and reuses it for the conversation", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const message = database.getMessage(messageId)!;
    const connection = database.createGmailConnection({
      email: "owner@example.test",
      archiveId: message.archiveId,
      folderId: message.folderId,
      query: "",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
      refreshToken: "refresh-token"
    });
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "draft-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const replyStyle = database.createReplyStyle({
      name: "Warm concise",
      tone: "Warm and direct",
      instructions: "Use two short paragraphs.",
      isDefault: true
    });
    const draftReply = vi.fn().mockResolvedValue({
      draft: {
        workRelated: false,
        developmentOpportunity: false,
        reason: "The user explicitly requested a reply draft.",
        subject: "Contract review",
        bodyText: "Thanks for sending this. I will review the contract.",
        confidence: 0.91
      },
      usage: { inputTokens: 80, outputTokens: 30 }
    });
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      draftReply,
      testConnection: vi.fn()
    }));

    const started = service.startMessageDraftReply(messageId, {
      gmailConnectionId: connection.id,
      resumeId: null,
      replyStyleId: replyStyle.id
    });
    expect(started).toMatchObject({ job: { task: "draft_reply", scheduleId: null }, draft: null });
    await waitForJob(database, started.job!.id, "completed");

    const drafts = database.listEmailDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      source: "ai",
      sourceMessageId: messageId,
      scheduleId: null,
      connectionId: connection.id,
      subject: "Re: Contract review",
      workRelated: false,
      replyStyleId: replyStyle.id,
      replyStyleName: "Warm concise"
    });
    expect(draftReply).toHaveBeenCalledWith(
      expect.objectContaining({ id: messageId }),
      expect.any(AbortSignal),
      expect.objectContaining({ prompt: expect.stringContaining("Warm concise") }),
      expect.objectContaining({ messages: [expect.objectContaining({ id: messageId })] })
    );

    const reused = service.startMessageDraftReply(messageId, {
      gmailConnectionId: connection.id,
      resumeId: null,
      replyStyleId: replyStyle.id
    });
    expect(reused).toEqual({ job: null, draft: drafts[0] });
    expect(draftReply).toHaveBeenCalledTimes(1);

    database.deleteEmailDraft(drafts[0]!.id);
    const redrafted = service.startMessageDraftReply(messageId, {
      gmailConnectionId: connection.id,
      resumeId: null,
      replyStyleId: replyStyle.id
    });
    expect(redrafted.job).not.toBeNull();
    expect(redrafted.job!.id).not.toBe(started.job!.id);
    await waitForJob(database, redrafted.job!.id, "completed");
    expect(draftReply).toHaveBeenCalledTimes(2);
    expect(database.listEmailDrafts()).toHaveLength(1);

    await service.close();
    database.close();
  });

  it("turns natural language into a reviewed rule using only existing folder paths", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const messageId = insertMessage(database);
    const message = database.getMessage(messageId)!;
    const finance = database.ensureFolder(message.archiveId, "Finance", "Finance", null);
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({
      apiKey: "sk-proj-test-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "rule-model",
      dailyRequestLimit: 10,
      monthlyRequestLimit: 100
    });
    const suggestMailRule = vi.fn().mockResolvedValue({
      suggestion: {
        name: "Stripe invoices",
        match: "all",
        senderContains: ["stripe.com"],
        subjectContains: ["invoice"],
        bodyContains: [],
        hasAttachments: null,
        targetFolderPath: "Finance",
        markRead: true,
        star: false,
        explanation: "Matches Stripe invoice messages.",
        confidence: 0.93
      },
      usage: { inputTokens: 60, outputTokens: 30 }
    });
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      suggestMailRule,
      testConnection: vi.fn()
    }));

    const suggestion = await service.suggestSmartMailRule(
      message.archiveId,
      "Move Stripe invoices to Finance and mark them read"
    );

    expect(suggestMailRule).toHaveBeenCalledWith(
      "Move Stripe invoices to Finance and mark them read",
      expect.arrayContaining(["Inbox", "Finance"]),
      expect.any(AbortSignal)
    );
    expect(suggestion).toMatchObject({
      targetFolderId: finance.id,
      targetFolderPath: "Finance",
      conditions: { senderContains: ["stripe.com"], subjectContains: ["invoice"] },
      markRead: true
    });
    expect(database.getAiUsageSummary()).toMatchObject({ todayRequests: 1, todayInputTokens: 60, todayOutputTokens: 30 });
    await service.close();
    database.close();
  });

  it("tests a specific provider's connection without switching which one is active", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ apiKey: "sk-openai-secret", clearApiKey: false });
    settings.update({ provider: "deepseek", apiKey: "sk-deepseek-secret", clearApiKey: false });

    const calls: Array<{ provider: string; apiKey: string }> = [];
    const testConnection = vi.fn().mockResolvedValue(undefined);
    const service = new AiService(database, settings, (provider, apiKey) => {
      calls.push({ provider, apiKey });
      return { analyze: vi.fn(), testConnection };
    });

    await service.testConnection("deepseek");
    expect(calls).toEqual([{ provider: "deepseek", apiKey: "sk-deepseek-secret" }]);
    expect(settings.current().provider).toBe("openai");

    await service.close();
    database.close();
  });

  it("lists live DeepSeek models merged with pricing metadata, but refuses to for OpenAI", async () => {
    const dataDir = await temporaryDirectory();
    const database = new EmailDatabase(dataDir);
    const settings = new AiSettingsManager(dataDir, {});
    settings.update({ provider: "deepseek", apiKey: "sk-deepseek-secret", clearApiKey: false });
    settings.update({ provider: "openai", apiKey: "sk-openai-secret", clearApiKey: false });

    const fetcher: typeof fetch = async (input) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/models");
      return new Response(JSON.stringify({
        object: "list",
        data: [{ id: "deepseek-v4-flash", object: "model" }, { id: "some-future-model", object: "model" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const service = new AiService(database, settings, undefined, fetcher);

    const models = await service.listModels("deepseek");
    expect(models).toEqual([
      expect.objectContaining({ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", pricing: expect.stringContaining("per 1M") }),
      expect.objectContaining({ id: "some-future-model", label: "some-future-model", pricing: null })
    ]);

    await expect(service.listModels("openai")).rejects.toThrow(AiConfigurationError);

    await service.close();
    database.close();
  });
});

async function waitForJob(
  database: EmailDatabase,
  jobId: string,
  status: "completed" | "failed"
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const job = database.getAiJob(jobId);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`AI job ${jobId} did not reach ${status}`);
}

function insertMessage(database: EmailDatabase): string {
  const archive = database.createArchive({
    name: "AI service test",
    sourceType: "mbox",
    fingerprint: "ai-service-test",
    sizeBytes: 100
  });
  const folder = database.ensureFolder(archive.id, "Inbox", "Inbox", null);
  const messageId = database.insertMessage({
    archiveId: archive.id,
    folderId: folder.id,
    sourceKey: "message-1",
    internetMessageId: "<ai-service@example.test>",
    subject: "Contract review",
    sender: { name: "Customer", address: "customer@example.test" },
    to: [{ name: "Owner", address: "owner@example.test" }],
    cc: [],
    bcc: [],
    sentAt: "2026-07-14T12:00:00.000Z",
    receivedAt: "2026-07-14T12:00:00.000Z",
    bodyText: "private contract body",
    bodyHtml: null,
    headers: { "message-id": "<ai-service@example.test>" },
    sizeBytes: 80,
    attachments: []
  });
  database.completeArchive(archive.id, 0);
  return messageId;
}

function saveAnalysis(database: EmailDatabase, messageId: string, summary: string): void {
  database.upsertMessageAnalysis({
    messageId,
    summary,
    categories: ["Customer"],
    priority: "normal",
    actionRequired: true,
    actionSummary: "Review and respond",
    spamProbability: 0.01,
    phishingProbability: 0.01,
    draftRecommended: true,
    confidence: 0.9,
    signals: ["Previously analyzed customer email"],
    model: "history-model",
    promptVersion: "history-v1",
    contentHash: `history-${messageId}`
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-ai-service-"));
  directories.push(directory);
  return directory;
}
