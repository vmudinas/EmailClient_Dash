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
    const settings = new AiSettingsManager(dataDir, null);
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
    const settings = new AiSettingsManager(dataDir, null);
    const service = new AiService(database, settings, () => ({
      analyze: vi.fn(),
      testConnection: vi.fn()
    }));

    expect(() => service.startAnalysis(messageId)).toThrow(AiConfigurationError);
    expect(database.listAiJobs()).toEqual([]);
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
