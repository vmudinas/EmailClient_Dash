import type {
  AdminInsights,
  AdminSettings,
  AiAnalysisStart,
  AiJob,
  AiMessageState,
  AiModelOption,
  AiProviderId,
  AiReviewQueue,
  AiAnalysisReview,
  AiSchedule,
  AiScheduleCreate,
  AiScheduleUpdate,
  AiSettingsPatch,
  Archive,
  ArchiveMergeResult,
  AuditPage,
  AuthLoginResult,
  AuthSessionInfo,
  CalendarEvent,
  CalendarEventInput,
  CursorPage,
  DiagnosticsSnapshot,
  DraftSettingsPatch,
  EmailDraft,
  EmailDraftCreate,
  EmailDraftUpdate,
  Folder,
  GmailAuthRequest,
  GmailAuthStart,
  GmailConnection,
  GmailSendAsAlias,
  GmailSendRequest,
  GmailSendResult,
  GmailSettingsPatch,
  ImportJob,
  LocalMessageState,
  LocalMessageStatePatch,
  MailboxMergeResult,
  MessageDetail,
  MessageFollowUp,
  MessageFollowUpCreate,
  MessageFollowUpPatch,
  MessageThread,
  MessageActionSuggestion,
  MessageActionSuggestionRequest,
  MessageDraftReplyRequest,
  MessageDraftReplyStart,
  MessageSummary,
  RuntimeConfig,
  ResumeAsset,
  ReplyStyle,
  ReplyStyleCreate,
  ReplyStylePatch,
  SearchFilters,
  SearchHit,
  SenderFilingStatus,
  SenderSpamRuleResult,
  SharingState,
  SmartMailRule,
  SmartMailRuleCreate,
  SmartMailRulePatch,
  SmartMailRuleSuggestion,
  SmartMailRuleSuggestionRequest,
  TodoCreate,
  TodoItem,
  TodoPatch,
  UploadSession,
  UserCreate,
  UserSummary,
  UserUpdate,
  DatabaseSettingsPatch
} from "@email-client/shared";

export interface UploadProgress {
  uploadId: string;
  stage: "uploading" | "starting";
  receivedBytes: number;
  totalBytes: number;
  percent: number;
  message: string;
}

interface PendingClientDiagnostic {
  level: "warning" | "error";
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  queuedAt: string;
  dedupeKey: string;
  occurrences: number;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const CLIENT_DIAGNOSTICS_KEY = "archive-mail-client-diagnostics";

export class ApiClient {
  private accessToken: string;
  private authorizationRequiredHandler: (() => void) | null = null;

  constructor(readonly config: RuntimeConfig) {
    this.accessToken = config.accessToken;
  }

  setAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  setAuthorizationRequiredHandler(handler: (() => void) | null): void {
    this.authorizationRequiredHandler = handler;
  }

  async login(username: string, pin: string): Promise<AuthLoginResult> {
    const result = await this.request<AuthLoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        pin,
        pairingToken: this.config.pairingToken || undefined
      })
    });
    this.setAccessToken(result.accessToken);
    return result;
  }

  currentSession(): Promise<AuthSessionInfo> {
    return this.request("/api/auth/session");
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } finally {
      this.setAccessToken("");
    }
  }

  changePin(currentPin: string, newPin: string): Promise<void> {
    return this.request("/api/auth/pin", {
      method: "PATCH",
      body: JSON.stringify({ currentPin, newPin })
    });
  }

  listArchives(): Promise<Archive[]> {
    return this.request("/api/archives");
  }

  listFolders(archiveId: string): Promise<Folder[]> {
    return this.request(`/api/archives/${encodeURIComponent(archiveId)}/folders`);
  }

  createFolder(archiveId: string, name: string, parentId?: string | null): Promise<Folder> {
    return this.request(`/api/archives/${encodeURIComponent(archiveId)}/folders`, {
      method: "POST",
      body: JSON.stringify({ name, parentId: parentId ?? null })
    });
  }

  renameArchive(archiveId: string, name: string): Promise<Archive> {
    return this.request(`/api/archives/${encodeURIComponent(archiveId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  renameFolder(folderId: string, name: string): Promise<Folder> {
    return this.request(`/api/folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name })
    });
  }

  removeFolder(folderId: string): Promise<void> {
    return this.request(`/api/folders/${encodeURIComponent(folderId)}`, {
      method: "DELETE"
    });
  }

  combineArchives(sourceArchiveId: string, targetArchiveId: string): Promise<ArchiveMergeResult> {
    return this.request(`/api/archives/${encodeURIComponent(sourceArchiveId)}/combine`, {
      method: "POST",
      body: JSON.stringify({ targetArchiveId })
    });
  }

  combineMailboxes(sourceFolderId: string, targetFolderId: string): Promise<MailboxMergeResult> {
    return this.request(`/api/folders/${encodeURIComponent(sourceFolderId)}/combine`, {
      method: "POST",
      body: JSON.stringify({ targetFolderId })
    });
  }

  listGmailConnections(): Promise<GmailConnection[]> {
    return this.request("/api/gmail/connections");
  }

  startGmailAuthorization(request: GmailAuthRequest): Promise<GmailAuthStart> {
    return this.request("/api/gmail/oauth/start", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  syncGmail(connectionId: string, options: { full?: boolean } = {}): Promise<GmailConnection> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/sync`, {
      method: "POST",
      body: JSON.stringify(options)
    });
  }

  cancelGmailSync(connectionId: string): Promise<GmailConnection> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/cancel`, {
      method: "POST"
    });
  }

  reorganizeGmailFolders(connectionId: string): Promise<GmailConnection> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/reorganize`, {
      method: "POST"
    });
  }

  removeGmailConnection(connectionId: string): Promise<void> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}`, {
      method: "DELETE"
    });
  }

  sendGmailMessage(connectionId: string, message: GmailSendRequest): Promise<GmailSendResult> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/send`, {
      method: "POST",
      body: JSON.stringify(message)
    });
  }

  listDrafts(): Promise<EmailDraft[]> {
    return this.request("/api/drafts");
  }

  createDraft(input: EmailDraftCreate): Promise<EmailDraft> {
    return this.request("/api/drafts", { method: "POST", body: JSON.stringify(input) });
  }

  updateDraft(id: string, input: EmailDraftUpdate): Promise<EmailDraft> {
    return this.request(`/api/drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  deleteDraft(id: string): Promise<void> {
    return this.request(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  sendDraft(id: string): Promise<GmailSendResult> {
    return this.request(`/api/drafts/${encodeURIComponent(id)}/send`, { method: "POST" });
  }

  listGmailSendAsAliases(connectionId: string): Promise<GmailSendAsAlias[]> {
    return this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/send-as`);
  }

  listCalendarEvents(connectionId: string, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({ timeMin: timeMinISO, timeMax: timeMaxISO });
    return this.request(`/api/calendar/connections/${encodeURIComponent(connectionId)}/events?${params}`);
  }

  createCalendarEvent(connectionId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.request(`/api/calendar/connections/${encodeURIComponent(connectionId)}/events`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  createCalendarEventFromMessage(
    messageId: string,
    connectionId: string,
    input: CalendarEventInput
  ): Promise<CalendarEvent> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/calendar-events`, {
      method: "POST",
      body: JSON.stringify({ connectionId, event: input })
    });
  }

  updateCalendarEvent(connectionId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.request(`/api/calendar/connections/${encodeURIComponent(connectionId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  deleteCalendarEvent(connectionId: string, eventId: string): Promise<void> {
    return this.request(`/api/calendar/connections/${encodeURIComponent(connectionId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE"
    });
  }

  listTodos(start: string, end: string): Promise<TodoItem[]> {
    const params = new URLSearchParams({ start, end });
    return this.request(`/api/todos?${params}`);
  }

  createTodo(input: TodoCreate): Promise<TodoItem> {
    return this.request("/api/todos", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateTodo(id: string, patch: TodoPatch): Promise<TodoItem> {
    return this.request(`/api/todos/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  deleteTodo(id: string): Promise<void> {
    return this.request(`/api/todos/${encodeURIComponent(id)}`, {
      method: "DELETE"
    });
  }

  listMessages(options: {
    archiveId?: string;
    folderId?: string;
    starred?: boolean;
    cursor?: string;
    limit?: number;
  }): Promise<CursorPage<MessageSummary>> {
    return this.request(`/api/messages?${queryString(options)}`);
  }

  search(
    q: string,
    filters: SearchFilters
  ): Promise<CursorPage<SearchHit>> {
    return this.request(`/api/search?${queryString({ q, ...filters })}`);
  }

  getMessage(messageId: string): Promise<MessageDetail> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}`);
  }

  getMessageThread(messageId: string): Promise<MessageThread> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/thread`);
  }

  createMessageFollowUp(messageId: string, input: MessageFollowUpCreate): Promise<MessageFollowUp> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/follow-up`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  listFollowUps(status?: MessageFollowUp["status"]): Promise<MessageFollowUp[]> {
    return this.request(`/api/follow-ups${status ? `?status=${encodeURIComponent(status)}` : ""}`);
  }

  updateFollowUp(id: string, patch: MessageFollowUpPatch): Promise<MessageFollowUp> {
    return this.request(`/api/follow-ups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  deleteFollowUp(id: string): Promise<void> {
    return this.request(`/api/follow-ups/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  getMessageAiState(messageId: string): Promise<AiMessageState> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/ai`);
  }

  analyzeMessage(messageId: string): Promise<AiAnalysisStart> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/ai/analyze`, {
      method: "POST"
    });
  }

  suggestMessageAction(
    messageId: string,
    context: MessageActionSuggestionRequest
  ): Promise<MessageActionSuggestion> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/ai/action-suggestion`, {
      method: "POST",
      body: JSON.stringify(context)
    });
  }

  startMessageDraftReply(
    messageId: string,
    input: MessageDraftReplyRequest
  ): Promise<MessageDraftReplyStart> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/ai/draft-reply`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  getAiJob(jobId: string): Promise<AiJob> {
    return this.request(`/api/ai/jobs/${encodeURIComponent(jobId)}`);
  }

  cancelAiJob(jobId: string): Promise<AiJob> {
    return this.request(`/api/ai/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    });
  }

  getAiReviewQueue(): Promise<AiReviewQueue> {
    return this.request("/api/ai/review-queue");
  }

  markMessageAnalysisReviewed(messageId: string): Promise<AiAnalysisReview> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/ai/review`, { method: "POST" });
  }

  listReplyStyles(): Promise<ReplyStyle[]> {
    return this.request("/api/reply-styles");
  }

  createReplyStyle(input: ReplyStyleCreate): Promise<ReplyStyle> {
    return this.request("/api/admin/reply-styles", { method: "POST", body: JSON.stringify(input) });
  }

  updateReplyStyle(id: string, patch: ReplyStylePatch): Promise<ReplyStyle> {
    return this.request(`/api/admin/reply-styles/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  deleteReplyStyle(id: string): Promise<void> {
    return this.request(`/api/admin/reply-styles/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  listSmartMailRules(archiveId?: string): Promise<SmartMailRule[]> {
    return this.request(`/api/admin/smart-mail-rules${archiveId ? `?archiveId=${encodeURIComponent(archiveId)}` : ""}`);
  }

  suggestSmartMailRule(input: SmartMailRuleSuggestionRequest): Promise<SmartMailRuleSuggestion> {
    return this.request("/api/admin/smart-mail-rules/suggest", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  createSmartMailRule(input: SmartMailRuleCreate): Promise<SmartMailRule> {
    return this.request("/api/admin/smart-mail-rules", { method: "POST", body: JSON.stringify(input) });
  }

  updateSmartMailRule(id: string, patch: SmartMailRulePatch): Promise<SmartMailRule> {
    return this.request(`/api/admin/smart-mail-rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  deleteSmartMailRule(id: string): Promise<void> {
    return this.request(`/api/admin/smart-mail-rules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  updateMessageState(
    messageId: string,
    patch: LocalMessageStatePatch
  ): Promise<LocalMessageState> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/state`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  moveMessage(messageId: string, folderId: string): Promise<MessageDetail> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: JSON.stringify({ folderId })
    });
  }

  markSenderAsSpam(messageId: string): Promise<SenderSpamRuleResult> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/spam-sender`, {
      method: "POST"
    });
  }

  listImportJobs(): Promise<ImportJob[]> {
    return this.request("/api/import-jobs");
  }

  getImportJob(jobId: string): Promise<ImportJob> {
    return this.request(`/api/import-jobs/${encodeURIComponent(jobId)}`);
  }

  cancelImport(jobId: string): Promise<ImportJob> {
    return this.request(`/api/import-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    });
  }

  resumeImport(jobId: string): Promise<ImportJob> {
    return this.request(`/api/import-jobs/${encodeURIComponent(jobId)}/resume`, {
      method: "POST"
    });
  }

  clearImport(jobId: string): Promise<void> {
    return this.request(`/api/import-jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE"
    });
  }

  async uploadArchive(
    file: File,
    ocrEnabled: boolean,
    onProgress?: (progress: UploadProgress) => void,
    signal?: AbortSignal
  ): Promise<ImportJob> {
    let session = await this.request<UploadSession>("/api/uploads", {
      method: "POST",
      signal,
      body: JSON.stringify({
        filename: file.name,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        ocrEnabled
      })
    }, { operation: "create_upload", filename: file.name, sizeBytes: file.size });

    if (session.status === "completed" && session.jobId) {
      return this.getImportJob(session.jobId);
    }

    let offset = session.receivedBytes;
    onProgress?.(uploadProgress(session.id, "uploading", offset, file.size));
    while (offset < file.size) {
      const end = Math.min(offset + CHUNK_BYTES, file.size);
      const chunk = await file.slice(offset, end).arrayBuffer();
      let uploaded = false;
      let lastError: unknown;

      for (let attempt = 1; attempt <= 4 && !uploaded; attempt += 1) {
        try {
          session = await this.request<UploadSession>(
            `/api/uploads/${encodeURIComponent(session.id)}/chunk`,
            {
              method: "PUT",
              signal,
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Upload-Offset": String(offset)
              },
              body: chunk
            },
            {
              operation: "upload_chunk",
              filename: file.name,
              uploadId: session.id,
              offset,
              chunkBytes: chunk.byteLength,
              attempt
            }
          );
          offset = session.receivedBytes;
          uploaded = true;
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastError = error;
          try {
            const latest = await this.request<UploadSession>(
              `/api/uploads/${encodeURIComponent(session.id)}`,
              { signal },
              { operation: "recover_upload_offset", uploadId: session.id }
            );
            session = latest;
            if (latest.receivedBytes > offset) {
              offset = latest.receivedBytes;
              uploaded = true;
              break;
            }
          } catch {
            // The original error contains the useful upload context.
          }
          if (attempt < 4) await delay(500 * 2 ** (attempt - 1));
        }
      }

      if (!uploaded) {
        throw new Error(
          `${errorText(lastError)} Upload paused at ${formatBytes(offset)} of ${formatBytes(file.size)}. Select the same file again to resume.`
        );
      }
      onProgress?.(uploadProgress(session.id, "uploading", offset, file.size));
    }

    onProgress?.({
      ...uploadProgress(session.id, "starting", file.size, file.size),
      message: "Upload complete. Creating the import job..."
    });
    session = await this.request<UploadSession>(
      `/api/uploads/${encodeURIComponent(session.id)}/complete`,
      { method: "POST", signal },
      { operation: "complete_upload", filename: file.name, uploadId: session.id }
    );
    if (!session.jobId) throw new Error("Upload completed, but no import job was created");
    return this.getImportJob(session.jobId);
  }

  removeArchive(archiveId: string): Promise<void> {
    return this.request(`/api/archives/${encodeURIComponent(archiveId)}`, {
      method: "DELETE"
    });
  }

  listUploads(): Promise<UploadSession[]> {
    return this.request("/api/uploads");
  }

  cancelUpload(uploadId: string): Promise<UploadSession> {
    return this.request(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      method: "DELETE"
    });
  }

  diagnostics(filters: {
    level?: string;
    category?: string;
    jobId?: string;
  } = {}): Promise<DiagnosticsSnapshot> {
    return this.request(`/api/diagnostics?${queryString(filters)}`);
  }

  async downloadDiagnostics(): Promise<void> {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/api/diagnostics/export`, {
        headers: this.headers(undefined, false)
      });
      if (!response.ok) throw await responseError(response);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `email-client-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      await this.reportClientIssue(error, { operation: "download_diagnostics" });
      throw error;
    }
  }

  clearDiagnostics(): Promise<void> {
    return this.request("/api/diagnostics", { method: "DELETE" });
  }

  pendingDiagnosticCount(): number {
    return readPendingDiagnostics().length;
  }

  async flushClientDiagnostics(): Promise<void> {
    const pending = readPendingDiagnostics();
    if (pending.length === 0) return;
    const remaining: PendingClientDiagnostic[] = [];
    for (const diagnostic of pending) {
      try {
        const response = await fetch(`${this.config.apiBaseUrl}/api/diagnostics/client`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            level: diagnostic.level,
            message: diagnostic.message,
            stack: diagnostic.stack,
            context: {
              ...diagnostic.context,
              queuedAt: diagnostic.queuedAt,
              occurrences: diagnostic.occurrences
            }
          })
        });
        if (!response.ok) remaining.push(diagnostic);
      } catch {
        remaining.push(diagnostic);
      }
    }
    writePendingDiagnostics(remaining);
  }

  async reportClientIssue(error: unknown, context: Record<string, unknown> = {}): Promise<void> {
    const normalized = normalizeError(error);
    const diagnostic: PendingClientDiagnostic = {
      level: "error",
      message: normalized.message,
      stack: normalized.stack,
      context,
      queuedAt: new Date().toISOString(),
      dedupeKey: `${normalized.message}\u0000${String(context.path ?? context.operation ?? "client")}`,
      occurrences: 1
    };
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/api/diagnostics/client`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          level: diagnostic.level,
          message: diagnostic.message,
          stack: diagnostic.stack,
          context: diagnostic.context
        })
      });
      if (response.ok) return;
    } catch {
      // Keep it in the browser until the local service is available again.
    }
    queuePendingDiagnostic(diagnostic);
  }

  getSharingState(): Promise<SharingState> {
    return this.request("/api/sharing");
  }

  adminSettings(): Promise<AdminSettings> {
    return this.request("/api/admin/settings");
  }

  updateDatabaseSettings(input: DatabaseSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/database", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  updateGmailSettings(input: GmailSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/gmail", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  clearGmailSettings(): Promise<AdminSettings> {
    return this.request("/api/admin/settings/gmail", { method: "DELETE" });
  }

  updateDraftSettings(input: DraftSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/drafts", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  updateAiSettings(input: AiSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/ai", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  setActiveAiProvider(provider: AiProviderId): Promise<AdminSettings> {
    return this.request("/api/admin/settings/ai/active", {
      method: "POST",
      body: JSON.stringify({ provider })
    });
  }

  clearAiApiKey(provider?: AiProviderId): Promise<AdminSettings> {
    return this.request(`/api/admin/settings/ai/key${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, {
      method: "DELETE"
    });
  }

  testAiConnection(provider?: AiProviderId): Promise<{ ok: true }> {
    return this.request(`/api/admin/settings/ai/test${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`, {
      method: "POST"
    });
  }

  listAiModels(provider: AiProviderId): Promise<AiModelOption[]> {
    return this.request(`/api/admin/settings/ai/models?provider=${encodeURIComponent(provider)}`);
  }

  listAiSchedules(): Promise<AiSchedule[]> {
    return this.request("/api/admin/ai-schedules");
  }

  listResumes(): Promise<ResumeAsset[]> {
    return this.request("/api/admin/resumes");
  }

  listAvailableResumes(): Promise<ResumeAsset[]> {
    return this.request("/api/resumes");
  }

  uploadResume(file: File, name?: string): Promise<ResumeAsset> {
    const params = new URLSearchParams({ filename: file.name });
    if (name?.trim()) params.set("name", name.trim());
    return this.request(`/api/admin/resumes?${params}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file
    });
  }

  deleteResume(id: string): Promise<void> {
    return this.request(`/api/admin/resumes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async downloadResume(asset: ResumeAsset): Promise<void> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/admin/resumes/${encodeURIComponent(asset.id)}/download`,
      { headers: this.headers(undefined, false) }
    );
    if (!response.ok) throw await responseError(response);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = asset.filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  createAiSchedule(input: AiScheduleCreate): Promise<AiSchedule> {
    return this.request("/api/admin/ai-schedules", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateAiSchedule(id: string, input: AiScheduleUpdate): Promise<AiSchedule> {
    return this.request(`/api/admin/ai-schedules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  deleteAiSchedule(id: string): Promise<void> {
    return this.request(`/api/admin/ai-schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  runAiScheduleNow(id: string): Promise<AiSchedule> {
    return this.request(`/api/admin/ai-schedules/${encodeURIComponent(id)}/run`, { method: "POST" });
  }

  senderFilingStatus(archiveId: string): Promise<SenderFilingStatus> {
    return this.request(`/api/admin/sender-filing?${queryString({ archiveId })}`);
  }

  organizeTopSenders(archiveId: string): Promise<SenderFilingStatus> {
    return this.request("/api/admin/sender-filing/organize", {
      method: "POST",
      body: JSON.stringify({ archiveId })
    });
  }

  disableSenderFiling(archiveId: string): Promise<SenderFilingStatus> {
    return this.request(`/api/admin/sender-filing?${queryString({ archiveId })}`, { method: "DELETE" });
  }

  adminInsights(): Promise<AdminInsights> {
    return this.request("/api/admin/insights");
  }

  listUsers(): Promise<UserSummary[]> {
    return this.request("/api/admin/users");
  }

  createUser(input: UserCreate): Promise<UserSummary> {
    return this.request("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateUser(userId: string, input: UserUpdate): Promise<UserSummary> {
    return this.request(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  audit(options: {
    username?: string;
    action?: string;
    ipAddress?: string;
    success?: boolean;
    cursor?: string;
    limit?: number;
  } = {}): Promise<AuditPage> {
    return this.request(`/api/admin/audit?${queryString(options)}`);
  }

  async downloadAudit(): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/admin/audit/export`, {
      headers: this.headers(undefined, false)
    });
    if (!response.ok) throw await responseError(response);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `archive-mail-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async attachmentBlob(attachmentId: string): Promise<Blob> {
    try {
      const response = await fetch(
        `${this.config.apiBaseUrl}/api/attachments/${encodeURIComponent(attachmentId)}/content`,
        { headers: this.headers(undefined, false) }
      );
      if (!response.ok) throw await responseError(response);
      return response.blob();
    } catch (error) {
      await this.reportClientIssue(error, { operation: "load_attachment", attachmentId });
      throw error;
    }
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    diagnosticContext: Record<string, unknown> = {}
  ): Promise<T> {
    return this.requestWithContext(path, init, diagnosticContext);
  }

  private async requestWithContext<T>(
    path: string,
    init: RequestInit = {},
    diagnosticContext: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        headers: this.headers(
          init.headers,
          init.body !== undefined && init.body !== null && !(init.body instanceof FormData)
        )
      });
      if (response.status === 401 && !path.startsWith("/api/auth/")) {
        this.accessToken = "";
        this.authorizationRequiredHandler?.();
      }
      if (!response.ok) throw await responseError(response);
      if (response.status === 204) return undefined as T;
      return response.json() as Promise<T>;
    } catch (error) {
      if (!path.startsWith("/api/diagnostics/client")
        && !path.startsWith("/api/auth/")
        && !(error instanceof ApiRequestError && error.status === 401)
        && !isAbortError(error)) {
        await this.reportClientIssue(error, {
          path,
          method: init.method ?? "GET",
          ...diagnosticContext
        });
      }
      throw error;
    }
  }

  private headers(
    provided?: HeadersInit,
    includeJson = true
  ): Headers {
    const headers = new Headers(provided);
    if (includeJson && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (this.accessToken) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }
    return headers;
  }
}

export async function resolveRuntimeConfig(): Promise<RuntimeConfig> {
  if (window.emailClient) return window.emailClient.getRuntimeConfig();

  const url = new URL(window.location.href);
  const shareFromUrl = url.searchParams.get("share");
  if (shareFromUrl) {
    sessionStorage.setItem("archive-mail-share-token", shareFromUrl);
    url.searchParams.delete("share");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  const shareToken = shareFromUrl ?? sessionStorage.getItem("archive-mail-share-token") ?? "";
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL
    ?? (window.location.port === "5173" ? "" : window.location.origin);
  const mobile = window.matchMedia("(max-width: 800px)").matches;
  return {
    apiBaseUrl,
    accessToken: "",
    pairingToken: shareToken || undefined,
    platform: mobile ? "mobile" : "browser"
  };
}

function queryString(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

async function responseError(response: Response): Promise<Error> {
  let message = `Request failed (${response.status})`;
  try {
    const body = await response.json() as { error?: string };
    message = body.error ?? message;
  } catch {
    // Use the status-based fallback when the response is not JSON.
  }
  return new ApiRequestError(message, response.status);
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function uploadProgress(
  uploadId: string,
  stage: UploadProgress["stage"],
  receivedBytes: number,
  totalBytes: number
): UploadProgress {
  const percent = totalBytes === 0 ? 0 : Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
  return {
    uploadId,
    stage,
    receivedBytes,
    totalBytes,
    percent,
    message: `Uploading ${formatBytes(receivedBytes)} of ${formatBytes(totalBytes)}`
  };
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index]!;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Upload failed.");
}

function normalizeError(error: unknown): { message: string; stack: string | null } {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack ?? null };
  }
  return { message: String(error), stack: null };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function readPendingDiagnostics(): PendingClientDiagnostic[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLIENT_DIAGNOSTICS_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.slice(-100) as PendingClientDiagnostic[] : [];
  } catch {
    return [];
  }
}

function writePendingDiagnostics(events: PendingClientDiagnostic[]): void {
  try {
    localStorage.setItem(CLIENT_DIAGNOSTICS_KEY, JSON.stringify(events.slice(-100)));
  } catch {
    // Local storage can be unavailable in hardened browser modes.
  }
}

function queuePendingDiagnostic(diagnostic: PendingClientDiagnostic): void {
  const pending = readPendingDiagnostics();
  const latest = pending[pending.length - 1];
  if (
    latest?.dedupeKey === diagnostic.dedupeKey
    && Date.now() - new Date(latest.queuedAt).getTime() < 30_000
  ) {
    latest.occurrences += 1;
    latest.queuedAt = diagnostic.queuedAt;
  } else {
    pending.push(diagnostic);
  }
  writePendingDiagnostics(pending);
}
