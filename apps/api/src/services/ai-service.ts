import { createHash } from "node:crypto";
import type {
  AiAgentConfig,
  AiAnalysisStart,
  EmailDraft,
  AiJob,
  AiMessageState,
  AiModelOption,
  AiProviderId,
  AiRelatedAnalysisContext,
  MessageDraftReplyStart,
  MessageActionSuggestion,
  MessageActionSuggestionRequest,
  MessageDetail,
  SmartMailRuleSuggestion
} from "@email-client/shared";
import { AI_AGENT_SKILL_IDS } from "@email-client/shared";
import type { EmailStore } from "../storage/database.js";
import {
  AI_PROMPT_VERSION,
  AiProviderError,
  createAiProvider,
  DeepSeekProvider,
  type AiProviderFactory
} from "./ai-provider.js";
import { AI_PROVIDER_INFO, type AiSettingsManager } from "./ai-settings.js";
import {
  applyDraftSenderName,
  DEFAULT_DRAFT_IDENTITY,
  type DraftSettingsManager
} from "./draft-settings.js";

export class AiService {
  private processing: Promise<void> | null = null;
  private closing = false;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly database: EmailStore,
    private readonly settings: AiSettingsManager,
    private readonly providerFactory: AiProviderFactory = createAiProvider,
    private readonly fetcher: typeof fetch = fetch,
    private readonly draftSettings?: Pick<DraftSettingsManager, "current">
  ) {}

  initialize(): void {
    const current = this.settings.current();
    if (current.enabled) this.kick();
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.processing;
  }

  startAnalysis(
    messageId: string,
    requestedAgent?: AiAgentConfig,
    schedule?: { scheduleId: string; scheduleRunId: string }
  ): AiAnalysisStart {
    const active = this.settings.current();
    const agent: AiAgentConfig = requestedAgent
      ? {
          provider: requestedAgent.provider,
          model: requestedAgent.model.trim(),
          skills: [...new Set(requestedAgent.skills)],
          prompt: requestedAgent.prompt.trim()
        }
      : {
          provider: active.provider,
          model: active.model,
          skills: [...AI_AGENT_SKILL_IDS],
          prompt: ""
        };
    this.requireConfiguredFor(agent.provider, true);
    const message = this.database.getMessage(messageId);
    if (!message) throw new AiMessageNotFoundError("Message not found");
    const conversation = this.database.listConversationMessages(messageId);
    const contentHash = conversationContentHash(conversation);
    const relatedAnalyses = this.database.listRelatedMessageAnalyses(messageId);
    const contextHash = relatedAnalysisContextHash(relatedAnalyses);
    const analysis = this.database.getMessageAnalysis(messageId);
    const latest = this.database.getLatestAiJob(messageId);

    const promptVersion = requestedAgent ? configuredPromptVersion(agent) : AI_PROMPT_VERSION;
    if (analysis
      && latest?.status === "completed"
      && analysis.contentHash === contentHash
      && analysis.contextHash === contextHash
      && analysis.model === agent.model
      && analysis.promptVersion === promptVersion) {
      return { job: latest, analysis };
    }

    const activeJob = this.database.getActiveAiJob(messageId);
    if (activeJob) return { job: activeJob, analysis };

    let job: AiJob;
    try {
      job = this.database.createAiJob({
        messageId,
        scheduleId: schedule?.scheduleId ?? null,
        scheduleRunId: schedule?.scheduleRunId ?? null,
        provider: agent.provider,
        model: agent.model,
        skills: agent.skills,
        prompt: agent.prompt,
        promptVersion,
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
      context: {
        operation: "analysis_queue",
        jobId: job.id,
        messageId,
        scheduleId: schedule?.scheduleId ?? null,
        scheduleRunId: schedule?.scheduleRunId ?? null,
        provider: agent.provider,
        model: agent.model,
        skills: agent.skills
      }
    });
    this.kick();
    return { job, analysis };
  }

  startDraftReply(messageId: string, options: {
    scheduleId: string | null;
    scheduleRunId: string | null;
    gmailConnectionId: string;
    resumeId: string | null;
    replyStyleId?: string | null;
    agent: AiAgentConfig;
  }): AiDraftStart {
    const agent: AiAgentConfig = {
      provider: options.agent.provider,
      model: options.agent.model.trim(),
      skills: [...new Set(options.agent.skills)],
      prompt: options.agent.prompt.trim()
    };
    const message = this.database.getMessage(messageId);
    if (!message) throw new AiMessageNotFoundError("Message not found");
    if (!message.sender.address.includes("@")) {
      throw new AiConfigurationError("The source email does not have a replyable sender address");
    }
    const blocker = this.database.getDraftReplyBlocker(messageId);
    if (blocker) throw new AiDraftSkippedError(draftBlockerMessage(blocker.reason));
    this.requireConfiguredFor(agent.provider, true);
    if (options.replyStyleId && !this.database.getReplyStyle(options.replyStyleId)) {
      throw new AiDraftTargetError("Reply style not found");
    }
    const contentHash = conversationContentHash(this.database.listConversationMessages(messageId));
    const promptVersion = configuredPromptVersion(agent, "draft-reply-v1");
    const existingDraft = options.scheduleId
      ? this.database.getAutomatedDraft(options.scheduleId, messageId)
      : null;
    const latest = this.database.getLatestAiJob(
      messageId,
      "draft_reply",
      options.scheduleId ?? undefined
    );
    // Scheduled jobs may legitimately complete without a draft (message judged not
    // work-related), and reusing that cached result avoids re-spending AI budget on
    // unchanged content every run. On-demand requests have no such suppression — a
    // draft is always attempted — so a completed job with no draft here only means
    // the user deleted it; skip the cache and regenerate instead of reporting a
    // false "AI finished" with nothing to show.
    if (options.scheduleId
      && latest?.status === "completed"
      && latest.contentHash === contentHash
      && latest.model === agent.model
      && latest.promptVersion === promptVersion) {
      return { job: latest, draft: existingDraft };
    }
    const activeJob = this.database.getActiveAiJob(messageId, "draft_reply");
    if (activeJob) return { job: activeJob, draft: existingDraft };

    let job: AiJob;
    try {
      job = this.database.createAiJob({
        messageId,
        task: "draft_reply",
        scheduleId: options.scheduleId,
        scheduleRunId: options.scheduleRunId,
        gmailConnectionId: options.gmailConnectionId,
        resumeId: options.resumeId,
        replyStyleId: options.replyStyleId ?? null,
        provider: agent.provider,
        model: agent.model,
        skills: agent.skills,
        prompt: agent.prompt,
        promptVersion,
        contentHash
      });
    } catch (error) {
      const conversationBlocker = this.database.getDraftReplyBlocker(messageId);
      if (conversationBlocker?.reason !== "active_conversation_job" || !conversationBlocker.jobId) {
        if (conversationBlocker) {
          throw new AiDraftSkippedError(draftBlockerMessage(conversationBlocker.reason));
        }
      }
      const raced = conversationBlocker?.jobId
        ? this.database.getAiJob(conversationBlocker.jobId)
        : this.database.getActiveAiJob(messageId, "draft_reply");
      if (!raced) throw error;
      job = raced;
    }
    this.database.recordDiagnostic({
      level: "info",
      category: "ai",
      message: "AI draft review queued",
      context: {
        operation: "draft_queue",
        jobId: job.id,
        messageId,
        scheduleId: options.scheduleId,
        scheduleRunId: options.scheduleRunId,
        provider: agent.provider,
        model: agent.model,
        skills: agent.skills
      }
    });
    this.kick();
    return { job, draft: existingDraft };
  }

  startMessageDraftReply(messageId: string, input: {
    gmailConnectionId: string;
    resumeId: string | null;
    replyStyleId?: string | null;
  }): MessageDraftReplyStart {
    const message = this.database.getMessage(messageId);
    if (!message) throw new AiMessageNotFoundError("Message not found");
    const blocker = this.database.getDraftReplyBlocker(messageId);
    if (blocker?.reason === "existing_draft" && blocker.draftId) {
      return { job: null, draft: this.database.getEmailDraft(blocker.draftId) };
    }
    if (blocker?.reason === "active_conversation_job" && blocker.jobId) {
      return { job: this.database.getAiJob(blocker.jobId), draft: null };
    }
    if (blocker) throw new AiDraftSkippedError(draftBlockerMessage(blocker.reason));

    const connection = this.database.getGmailConnection(input.gmailConnectionId);
    if (!connection) throw new AiDraftTargetError("Gmail connection not found");
    if (!connection.canSend) throw new AiDraftTargetError("The selected Gmail account cannot send email");
    if (input.resumeId && !this.database.getResumeAsset(input.resumeId)) {
      throw new AiDraftTargetError("Resume not found");
    }
    if (input.replyStyleId && !this.database.getReplyStyle(input.replyStyleId)) {
      throw new AiDraftTargetError("Reply style not found");
    }

    const current = this.settings.current();
    return this.startDraftReply(messageId, {
      scheduleId: null,
      scheduleRunId: null,
      gmailConnectionId: input.gmailConnectionId,
      resumeId: input.resumeId,
      replyStyleId: input.replyStyleId ?? null,
      agent: {
        provider: current.provider,
        model: current.model,
        skills: [...AI_AGENT_SKILL_IDS],
        prompt: ""
      }
    });
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

  async suggestMessageAction(
    messageId: string,
    context: MessageActionSuggestionRequest
  ): Promise<MessageActionSuggestion> {
    const target = this.requireConfiguredFor(this.settings.current().provider, true);
    const message = this.database.getMessage(messageId);
    if (!message) throw new AiMessageNotFoundError("Message not found");
    if (!this.database.consumeAiRequest(target.dailyRequestLimit, target.monthlyRequestLimit)) {
      throw new AiBudgetError(
        `AI request limit reached (${target.dailyRequestLimit}/day or ${target.monthlyRequestLimit}/month)`
      );
    }
    const provider = this.providerFactory(target.provider, target.apiKey!, target.model);
    if (!provider.suggestAction) {
      throw new AiConfigurationError("The selected AI provider does not support calendar and to-do suggestions");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const conversation = this.database.listConversationMessages(messageId);
      const relatedAnalyses = this.database.listRelatedMessageAnalyses(messageId);
      const result = await provider.suggestAction(
        message,
        context,
        controller.signal,
        { messages: conversation, relatedAnalyses }
      );
      this.database.recordAiTokenUsage(result.usage.inputTokens, result.usage.outputTokens);
      this.database.recordDiagnostic({
        level: "info",
        category: "ai",
        message: "AI calendar/to-do suggestion created for review",
        context: {
          operation: "action_suggestion",
          messageId,
          recommendedAction: result.suggestion.recommendedAction,
          provider: target.provider,
          model: target.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens
        }
      });
      return {
        ...result.suggestion,
        provider: target.provider,
        model: target.model
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async suggestSmartMailRule(archiveId: string, instruction: string): Promise<SmartMailRuleSuggestion> {
    const target = this.requireConfiguredFor(this.settings.current().provider, true);
    const folders = this.database.listFolders(archiveId);
    if (folders.length === 0) throw new AiConfigurationError("The selected archive has no mailboxes");
    if (!this.database.consumeAiRequest(target.dailyRequestLimit, target.monthlyRequestLimit)) {
      throw new AiBudgetError(
        `AI request limit reached (${target.dailyRequestLimit}/day or ${target.monthlyRequestLimit}/month)`
      );
    }
    const provider = this.providerFactory(target.provider, target.apiKey!, target.model);
    if (!provider.suggestMailRule) {
      throw new AiConfigurationError("The selected AI provider does not support mail rule suggestions");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const result = await provider.suggestMailRule(
        instruction,
        folders.map((folder) => folder.path),
        controller.signal
      );
      this.database.recordAiTokenUsage(result.usage.inputTokens, result.usage.outputTokens);
      const requestedPath = result.suggestion.targetFolderPath?.trim().toLowerCase() ?? null;
      const targetFolder = requestedPath
        ? folders.find((folder) => folder.path.trim().toLowerCase() === requestedPath) ?? null
        : null;
      return {
        name: result.suggestion.name,
        instruction,
        conditions: {
          match: result.suggestion.match,
          senderContains: result.suggestion.senderContains,
          subjectContains: result.suggestion.subjectContains,
          bodyContains: result.suggestion.bodyContains,
          hasAttachments: result.suggestion.hasAttachments
        },
        targetFolderId: targetFolder?.id ?? null,
        targetFolderPath: targetFolder?.path ?? null,
        markRead: result.suggestion.markRead,
        star: result.suggestion.star,
        explanation: result.suggestion.explanation,
        confidence: result.suggestion.confidence
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(provider?: AiProviderId): Promise<void> {
    const target = this.requireConfiguredFor(provider ?? this.settings.current().provider, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      await this.providerFactory(target.provider, target.apiKey!, target.model).testConnection(controller.signal);
      this.database.recordDiagnostic({
        level: "info",
        category: "ai",
        message: `${AI_PROVIDER_INFO[target.provider].label} connection test succeeded`,
        context: { operation: "connection_test", provider: target.provider, model: target.model }
      });
    } catch (error) {
      const message = errorText(error);
      this.database.recordDiagnostic({
        level: "error",
        category: "ai",
        message,
        stack: error instanceof Error ? error.stack : null,
        context: { operation: "connection_test", provider: target.provider, model: target.model }
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(provider: AiProviderId): Promise<AiModelOption[]> {
    if (provider !== "deepseek") {
      throw new AiConfigurationError(`Live model listing is only available for DeepSeek, not ${AI_PROVIDER_INFO[provider].label}.`);
    }
    const target = this.requireConfiguredFor(provider, false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await new DeepSeekProvider(target.apiKey!, target.model, this.fetcher).listModels(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  configurationChanged(): void {
    const current = this.settings.current();
    if (current.enabled) this.kick();
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
      const current = this.requireConfiguredFor(job.provider, true);
      const message = this.database.getMessage(job.messageId);
      if (!message) throw new AiMessageNotFoundError("Message no longer exists");
      const conversation = this.database.listConversationMessages(job.messageId);
      if (conversationContentHash(conversation) !== job.contentHash) {
        throw new AiConfigurationError("Email conversation changed; start a new analysis");
      }
      const relatedAnalyses = this.database.listRelatedMessageAnalyses(job.messageId);
      const contextHash = relatedAnalysisContextHash(relatedAnalyses);
      const conversationContext = { messages: conversation, relatedAnalyses };
      const allowed = this.database.consumeAiRequest(
        current.dailyRequestLimit,
        current.monthlyRequestLimit
      );
      if (!allowed) {
        throw new AiBudgetError(
          `AI request limit reached (${current.dailyRequestLimit}/day or ${current.monthlyRequestLimit}/month)`
        );
      }
      const provider = this.providerFactory(job.provider, current.apiKey!, job.model);
      if (job.task === "draft_reply") {
        if (!job.gmailConnectionId) {
          throw new AiConfigurationError("Draft job is missing its Gmail account");
        }
        if (!provider.draftReply) throw new AiConfigurationError("The AI provider does not support draft tasks");
        const replyStyle = job.replyStyleId ? this.database.getReplyStyle(job.replyStyleId) : null;
        const stylePrompt = replyStyle
          ? [
              job.prompt,
              `Reply style "${replyStyle.name}" (${replyStyle.tone}): ${replyStyle.instructions}`
            ].filter(Boolean).join("\n\n")
          : job.prompt;
        const result = await provider.draftReply(
          message,
          controller.signal,
          { skills: job.skills, prompt: stylePrompt },
          conversationContext
        );
        if (this.database.getAiJob(job.id)?.status === "cancelled") return;
        this.database.recordAiTokenUsage(result.usage.inputTokens, result.usage.outputTokens);
        let draft: EmailDraft | null = null;
        if (result.draft.workRelated || !job.scheduleId) {
          const completionBlocker = this.database.getDraftReplyBlocker(job.messageId, job.id);
          if (completionBlocker) {
            this.database.recordDiagnostic({
              level: "info",
              category: "ai",
              message: `AI reply draft suppressed: ${draftBlockerMessage(completionBlocker.reason)}`,
              jobId: job.id,
              archiveId: message.archiveId,
              context: {
                operation: "draft_suppressed",
                messageId: job.messageId,
                scheduleId: job.scheduleId,
                conversationKey: completionBlocker.conversationKey,
                reason: completionBlocker.reason
              }
            });
          } else {
            const identity = this.draftSettings?.current() ?? DEFAULT_DRAFT_IDENTITY;
            draft = this.database.createAutomatedDraft({
              connectionId: job.gmailConnectionId,
              sourceMessageId: job.messageId,
              scheduleId: job.scheduleId,
              fromAddress: identity.defaultFromAddress,
              to: [message.sender.address],
              cc: [],
              bcc: [],
              subject: applyDraftSenderName(
                replySubject(result.draft.subject || message.subject),
                identity.senderName
              ),
              bodyText: applyDraftSenderName(result.draft.bodyText, identity.senderName),
              resumeId: result.draft.developmentOpportunity ? job.resumeId : null,
              replyStyleId: replyStyle?.id ?? null,
              workRelated: result.draft.workRelated,
              developmentOpportunity: result.draft.developmentOpportunity,
              aiReason: result.draft.reason,
              aiConfidence: result.draft.confidence
            });
          }
        }
        this.database.completeAiJob(job.id);
        this.database.recordDiagnostic({
          level: "info",
          category: "ai",
          message: draft ? "AI reply draft created for review" : "AI review completed without creating a draft",
          context: {
            operation: "draft_complete",
            jobId: job.id,
            messageId: job.messageId,
            scheduleId: job.scheduleId,
            draftId: draft?.id ?? null,
            workRelated: result.draft.workRelated,
            developmentOpportunity: result.draft.developmentOpportunity,
            resumeAttached: Boolean(draft?.resumeId),
            provider: job.provider,
            model: job.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens
          }
        });
        return;
      }
      const result = await provider.analyze(
        message,
        controller.signal,
        { skills: job.skills, prompt: job.prompt },
        conversationContext
      );
      if (this.database.getAiJob(job.id)?.status === "cancelled") return;
      this.database.recordAiTokenUsage(result.usage.inputTokens, result.usage.outputTokens);
      this.database.upsertMessageAnalysis({
        messageId: job.messageId,
        model: job.model,
        promptVersion: job.promptVersion,
        contentHash: job.contentHash,
        contextHash,
        threadMessageCount: conversation.length,
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
          provider: job.provider,
          model: job.model,
          threadMessages: conversation.length,
          priorThreadAnalyses: relatedAnalyses.sameThread.length,
          priorSenderAnalyses: relatedAnalyses.sameSender.length,
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

  private requireConfiguredFor(provider: AiProviderId, requireEnabled: boolean) {
    const snapshot = this.settings.forProvider(provider);
    if (!snapshot.apiKey) {
      throw new AiConfigurationError(
        `${AI_PROVIDER_INFO[provider].label} is not configured. Add an API key in Admin settings > AI.`
      );
    }
    if (requireEnabled && !snapshot.enabled) {
      throw new AiConfigurationError("AI features are disabled in Admin settings > AI.");
    }
    return snapshot;
  }
}

export class AiConfigurationError extends Error {}
export class AiBudgetError extends Error {}
export class AiMessageNotFoundError extends Error {}
export class AiDraftSkippedError extends Error {}
export class AiDraftTargetError extends Error {}
export class AiJobNotFoundError extends Error {}

function conversationContentHash(messages: MessageDetail[]): string {
  return createHash("sha256").update(JSON.stringify(messages.map((message) => ({
    id: message.id,
    subject: message.subject,
    sender: message.sender,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    sentAt: message.sentAt,
    receivedAt: message.receivedAt,
    bodyText: message.bodyText,
    attachmentNames: message.attachments.map((attachment) => attachment.filename)
  })))).digest("hex");
}

function relatedAnalysisContextHash(context: AiRelatedAnalysisContext): string {
  const semanticContext = {
    sameThread: context.sameThread.map(({ analyzedAt: _analyzedAt, ...analysis }) => analysis),
    sameSender: context.sameSender.map(({ analyzedAt: _analyzedAt, ...analysis }) => analysis)
  };
  return createHash("sha256").update(JSON.stringify(semanticContext)).digest("hex");
}

function configuredPromptVersion(agent: AiAgentConfig, base = AI_PROMPT_VERSION): string {
  const fingerprint = createHash("sha256").update(JSON.stringify({
    provider: agent.provider,
    model: agent.model,
    skills: [...agent.skills].sort(),
    prompt: agent.prompt
  })).digest("hex").slice(0, 16);
  return `${base}:${fingerprint}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "AI task failed";
}

function replySubject(subject: string): string {
  const value = subject.trim();
  if (!value) return "Re: Your email";
  return /^re:/i.test(value) ? value : `Re: ${value}`;
}

export interface AiDraftStart {
  job: AiJob;
  draft: EmailDraft | null;
}

function draftBlockerMessage(reason: "existing_draft" | "already_replied" | "active_conversation_job"): string {
  if (reason === "existing_draft") return "a reviewable draft already exists for this email conversation";
  if (reason === "already_replied") return "this email conversation already has a sent reply";
  return "another AI draft job is already active for this email conversation";
}
