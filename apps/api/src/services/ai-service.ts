import { createHash } from "node:crypto";
import type {
  AiAnalysisStart,
  AiJob,
  AiMessageState,
  MessageDetail
} from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import {
  AI_PROMPT_VERSION,
  AiProviderError,
  OpenAiProvider,
  type AiProviderFactory
} from "./ai-provider.js";
import type { AiSettingsManager } from "./ai-settings.js";

export class AiService {
  private processing: Promise<void> | null = null;
  private closing = false;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: EmailStore,
    private readonly settings: AiSettingsManager,
    private readonly providerFactory: AiProviderFactory = (apiKey, model) => new OpenAiProvider(apiKey, model)
  ) {}

  initialize(): void {
    const current = this.settings.current();
    if (current.enabled && current.apiKey) this.kick();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.processing;
  }

  startAnalysis(messageId: string): AiAnalysisStart {
    const current = this.requireConfigured(true);
    const message = this.database.getMessage(messageId);
    if (!message) throw new AiMessageNotFoundError("Message not found");
    const contentHash = messageContentHash(message);
    const analysis = this.database.getMessageAnalysis(messageId);
    const latest = this.database.getLatestAiJob(messageId);

    if (analysis
      && latest?.status === "completed"
      && analysis.contentHash === contentHash
      && analysis.model === current.model
      && analysis.promptVersion === AI_PROMPT_VERSION) {
      return { job: latest, analysis };
    }

    const active = this.database.getActiveAiJob(messageId);
    if (active) return { job: active, analysis };

    let job: AiJob;
    try {
      job = this.database.createAiJob({
        messageId,
        model: current.model,
        promptVersion: AI_PROMPT_VERSION,
        contentHash
      });
    } catch (error) {
      const raced = this.database.getActiveAiJob(messageId);
      if (!raced) throw error;
      job = raced;
    }
    this.database.recordDiagnostic({
      level: "info",
      category: "ai",
      message: "Email analysis queued",
      context: { operation: "analysis_queue", jobId: job.id, messageId, model: current.model }
    });
    this.kick();
    return { job, analysis };
  }

  getMessageState(messageId: string): AiMessageState {
    if (!this.database.getMessage(messageId)) throw new AiMessageNotFoundError("Message not found");
    return {
      job: this.database.getActiveAiJob(messageId) ?? this.database.getLatestAiJob(messageId),
      analysis: this.database.getMessageAnalysis(messageId)
    };
  }

  getJob(jobId: string): AiJob {
    const job = this.database.getAiJob(jobId);
    if (!job) throw new AiJobNotFoundError("AI job not found");
    return job;
  }

  cancel(jobId: string): AiJob {
    const job = this.database.getAiJob(jobId);
    if (!job) throw new AiJobNotFoundError("AI job not found");
    this.controllers.get(jobId)?.abort();
    const cancelled = this.database.cancelAiJob(jobId);
    this.database.recordDiagnostic({
      level: "info",
      category: "ai",
      message: "Email analysis cancelled",
      context: { operation: "analysis_cancel", jobId, messageId: job.messageId }
    });
    return cancelled;
  }

  async testConnection(): Promise<void> {
    const current = this.requireConfigured(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      await this.providerFactory(current.apiKey!, current.model).testConnection(controller.signal);
      this.database.recordDiagnostic({
        level: "info",
        category: "ai",
        message: "OpenAI connection test succeeded",
        context: { operation: "connection_test", model: current.model }
      });
    } catch (error) {
      const message = errorText(error);
      this.database.recordDiagnostic({
        level: "error",
        category: "ai",
        message,
        stack: error instanceof Error ? error.stack : null,
        context: { operation: "connection_test", model: current.model }
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  configurationChanged(): void {
    const current = this.settings.current();
    if (current.enabled && current.apiKey) this.kick();
  }

  private kick(): void {
    if (this.closing || this.processing) return;
    this.processing = this.processQueue().finally(() => {
      this.processing = null;
      if (!this.closing && this.database.hasQueuedAiJobs()) this.kick();
    });
  }

  private async processQueue(): Promise<void> {
    while (!this.closing) {
      const job = this.database.claimNextAiJob();
      if (!job) return;
      await this.processJob(job);
    }
  }

  private async processJob(job: AiJob): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    try {
      const current = this.requireConfigured(true);
      const message = this.database.getMessage(job.messageId);
      if (!message) throw new AiMessageNotFoundError("Message no longer exists");
      if (messageContentHash(message) !== job.contentHash) {
        throw new AiConfigurationError("Message content changed; start a new analysis");
      }
      const allowed = this.database.consumeAiRequest(
        current.dailyRequestLimit,
        current.monthlyRequestLimit
      );
      if (!allowed) {
        throw new AiBudgetError(
          `AI request limit reached (${current.dailyRequestLimit}/day or ${current.monthlyRequestLimit}/month)`
        );
      }
      const result = await this.providerFactory(current.apiKey!, job.model)
        .analyze(message, controller.signal);
      if (this.database.getAiJob(job.id)?.status === "cancelled") return;
      this.database.recordAiTokenUsage(result.usage.inputTokens, result.usage.outputTokens);
      this.database.upsertMessageAnalysis({
        messageId: job.messageId,
        model: job.model,
        promptVersion: job.promptVersion,
        contentHash: job.contentHash,
        ...result.analysis
      });
      this.database.completeAiJob(job.id);
      this.database.recordDiagnostic({
        level: "info",
        category: "ai",
        message: "Email analysis completed",
        context: {
          operation: "analysis_complete",
          jobId: job.id,
          messageId: job.messageId,
          model: job.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens
        }
      });
    } catch (error) {
      const currentJob = this.database.getAiJob(job.id);
      if (currentJob?.status === "cancelled") return;
      const message = errorText(error);
      const retry = error instanceof AiProviderError && error.retryable;
      const updated = this.database.failAiJob(job.id, message, retry);
      this.database.recordDiagnostic({
        level: updated.status === "queued" ? "warning" : "error",
        category: "ai",
        message,
        stack: error instanceof Error ? error.stack : null,
        context: {
          operation: updated.status === "queued" ? "analysis_retry" : "analysis_failed",
          jobId: job.id,
          messageId: job.messageId,
          model: job.model,
          attempt: updated.attempts,
          maxAttempts: updated.maxAttempts
        }
      });
    } finally {
      this.controllers.delete(job.id);
    }
  }

  private requireConfigured(requireEnabled: boolean) {
    const current = this.settings.current();
    if (!current.apiKey) {
      throw new AiConfigurationError(
        "OpenAI is not configured. Add an API key in Admin settings > AI."
      );
    }
    if (requireEnabled && !current.enabled) {
      throw new AiConfigurationError("AI features are disabled in Admin settings > AI.");
    }
    return current;
  }
}

export class AiConfigurationError extends Error {}
export class AiBudgetError extends Error {}
export class AiMessageNotFoundError extends Error {}
export class AiJobNotFoundError extends Error {}

function messageContentHash(message: MessageDetail): string {
  return createHash("sha256").update(JSON.stringify({
    subject: message.subject,
    sender: message.sender,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    bodyText: message.bodyText,
    attachmentNames: message.attachments.map((attachment) => attachment.filename)
  })).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "AI analysis failed";
}
