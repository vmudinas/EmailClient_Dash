import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDatabase } from "../storage/database.js";
import { AiProviderError, type AiProvider } from "./ai-provider.js";
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
      expect.any(AbortSignal)
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
      resumeId: null
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
      workRelated: false
    });

    const reused = service.startMessageDraftReply(messageId, {
      gmailConnectionId: connection.id,
      resumeId: null
    });
    expect(reused).toEqual({ job: null, draft: drafts[0] });
    expect(draftReply).toHaveBeenCalledTimes(1);

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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-ai-service-"));
  directories.push(directory);
  return directory;
}
