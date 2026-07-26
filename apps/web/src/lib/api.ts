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
  AiAnalysisReviewAllResult,
  AskAnswer,
  AskHistoryEntry,
  AskRequest,
  DuplicateGroupDetail,
  DuplicateGroupList,
  DuplicateGroupPatch,
  DuplicateReviewStatus,
  DuplicateScanResult,
  AiSchedule,
  AiScheduleCreate,
  AiScheduleUpdate,
  AiSettingsPatch,
  Archive,
  AuditPage,
  AuthLoginResult,
  AuthSessionInfo,
  AppleCalendarAccountCreate,
  BulkMoveDestination,
  BulkMessageReadResult,
  BulkMoveResult,
  BulkFolderMoveResult,
  CalendarAccount,
  CalendarEvent,
  CalendarEventInput,
  CalendarSource,
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
  InboxCategory,
  InboxCategoryCounts,
  InboxTabReclassifyResult,
  InboxTabSettings,
  InboxTabSettingsUpdate,
  LithuanianPractice,
  LithuanianRecording,
  LithuanianGameInput,
  LithuanianGameResult,
  LithuanianPhraseSuggestions,
  LithuanianSettingsPatch,
  LithuanianTranslateInput,
  LithuanianTranslation,
  LithuanianWord,
  LithuanianWordCreate,
  LocalMessageState,
  LocalMessageStatePatch,
  MailboxMoveResult,
  MessageDetail,
  MessageFollowUp,
  MessageFollowUpCreate,
  MessageFollowUpPatch,
  MessageFilingSuggestion,
  MessageThread,
  MessageActionSuggestion,
  MessageActionSuggestionRequest,
  MessageDraftReplyRequest,
  MessageDraftReplyStart,
  MessageSummary,
  ManagedProperty,
  ManagedPropertyCreate,
  ManagedPropertyPatch,
  NewsHeadline,
  NewsSettingsPatch,
  RuntimeConfig,
  ResumeAsset,
  ReplyStyle,
  ReplyStyleCreate,
  ReplyStylePatch,
  SearchFilters,
  SearchHit,
  SenderFilingRuleCreate,
  SenderFilingRuleCreateResult,
  SenderFilingStatus,
  SenderFolderRuleResult,
  SenderSpamRuleResult,
  SmartMailRule,
  SmartMailRuleCreate,
  SmartMailRulePatch,
  SmartMailRuleRunTask,
  SmartMailRuleRunScope,
  SmartMailRuleSuggestion,
  SmartMailRuleSuggestionRequest,
  StockQuote,
  StockSettingsPatch,
  PropertyLease,
  PropertyLeaseCreate,
  PropertyInvitationPreview,
  PropertyDocument,
  PropertyDocumentMetadata,
  PropertyIntegrationSettings,
  PropertyIntegrationSettingsPatch,
  PropertyLedgerAdjustment,
  PropertyLedgerEntry,
  PropertyPlatformOverview,
  PropertyRentSchedule,
  PropertyRentScheduleCreate,
  PropertyRefundRequest,
  PropertyRefundResult,
  PropertyRequestAttachment,
  PropertyRequestComment,
  PropertyRequestCommentCreate,
  PropertyTenantInvitation,
  PropertyTenantInvitationCreate,
  PropertyCommunicationConsent,
  PropertyConsentPatch,
  PropertyAutomationRunResult,
  PropertyBackupSummary,
  PropertyPayment,
  PropertyPaymentCheckoutResult,
  PropertyPaymentCreate,
  PropertyPaymentPatch,
  PropertyPortfolioOverview,
  PropertyRentCharge,
  PropertyRentChargeCreate,
  PropertyServiceRequest,
  PropertyServiceRequestCreate,
  PropertyServiceRequestPatch,
  PropertyTenant,
  PropertyTenantCreate,
  PropertyTenantInvitationAccept,
  PropertyUnit,
  PropertyUnitCreate,
  TodoCreate,
  TodoItem,
  TodoPatch,
  UploadSession,
  UserCreate,
  UserSummary,
  UserUpdate,
  DatabaseSettingsPatch,
  DatabaseConnectionTestResult
} from "@email-client/shared";
import {
  LITHUANIAN_MAX_PASS_MARK,
  LITHUANIAN_MIN_PASS_MARK,
  LITHUANIAN_PASS_MARK
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
const DEFAULT_QUERY_CACHE_MS = 15_000;

interface ClientCacheEntry {
  value: unknown;
  expiresAt: number;
  generation: number;
}

export class ApiClient {
  private accessToken: string;
  private authorizationRequiredHandler: (() => void) | null = null;
  private readonly queryCache = new Map<string, ClientCacheEntry>();
  private readonly pendingQueries = new Map<string, Promise<unknown>>();
  private cacheGeneration = 0;

  constructor(readonly config: RuntimeConfig) {
    this.accessToken = config.accessToken;
  }

  setAccessToken(accessToken: string): void {
    if (accessToken !== this.accessToken) this.invalidateCache();
    this.accessToken = accessToken;
  }

  getAccessToken(): string {
    return this.accessToken;
  }

  setAuthorizationRequiredHandler(handler: (() => void) | null): void {
    this.authorizationRequiredHandler = handler;
  }

  invalidateCache(pathPrefix?: string): void {
    this.cacheGeneration += 1;
    if (!pathPrefix) {
      this.queryCache.clear();
      this.pendingQueries.clear();
      return;
    }
    for (const key of this.queryCache.keys()) {
      if (key.startsWith(pathPrefix)) this.queryCache.delete(key);
    }
    for (const key of this.pendingQueries.keys()) {
      if (key.startsWith(pathPrefix)) this.pendingQueries.delete(key);
    }
  }

  async login(username: string, pin: string): Promise<AuthLoginResult> {
    const result = await this.request<AuthLoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username,
        pin
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

  previewPropertyInvitation(token: string): Promise<PropertyInvitationPreview> {
    return this.request(`/api/auth/property-invitations/preview?${queryString({ token })}`);
  }

  async acceptPropertyInvitation(input: PropertyTenantInvitationAccept): Promise<AuthLoginResult> {
    const result = await this.request<AuthLoginResult>("/api/auth/property-invitations/accept", {
      method: "POST",
      body: JSON.stringify(input)
    });
    this.setAccessToken(result.accessToken);
    return result;
  }

  async updateLithuanianSettings(input: LithuanianSettingsPatch): Promise<AdminSettings> {
    return normalizeAdminSettings(await this.request("/api/admin/settings/lithuanian", {
      method: "PATCH",
      body: JSON.stringify(input)
    }));
  }

  async clearLithuanianApiKey(): Promise<AdminSettings> {
    return normalizeAdminSettings(await this.request("/api/admin/settings/lithuanian/key", { method: "DELETE" }));
  }

  lithuanianPractice(): Promise<LithuanianPractice> {
    return this.request("/api/lithuanian/practice");
  }

  refreshLithuanianHints(wordId: string): Promise<LithuanianWord> {
    return this.request(`/api/lithuanian/words/${encodeURIComponent(wordId)}/hints`, { method: "POST" });
  }

  createLithuanianWord(input: LithuanianWordCreate): Promise<LithuanianWord> {
    return this.request("/api/lithuanian/words", { method: "POST", body: JSON.stringify(input) });
  }

  translateLithuanian(input: LithuanianTranslateInput, signal?: AbortSignal): Promise<LithuanianTranslation> {
    return this.request("/api/lithuanian/translate", { method: "POST", body: JSON.stringify(input), signal });
  }

  suggestLithuanianPhrases(english: string, signal?: AbortSignal): Promise<LithuanianPhraseSuggestions> {
    return this.request("/api/lithuanian/phrases", {
      method: "POST",
      body: JSON.stringify({ english }),
      signal
    });
  }

  saveLithuanianGame(input: LithuanianGameInput): Promise<LithuanianGameResult> {
    return this.request("/api/lithuanian/games", { method: "POST", body: JSON.stringify(input) });
  }

  lithuanianPronunciationBlob(wordId: string): Promise<Blob> {
    return this.blobRequest(`/api/lithuanian/words/${encodeURIComponent(wordId)}/pronunciation`);
  }

  refreshLithuanianPronunciation(wordId: string): Promise<LithuanianWord> {
    return this.request(`/api/lithuanian/words/${encodeURIComponent(wordId)}/pronunciation`, { method: "POST" });
  }

  deleteLithuanianWord(wordId: string): Promise<void> {
    return this.request(`/api/lithuanian/words/${encodeURIComponent(wordId)}`, { method: "DELETE" });
  }

  saveLithuanianRecording(
    wordId: string,
    audio: Blob,
    durationMs: number,
    transcript: string | null
  ): Promise<LithuanianRecording> {
    return this.request(
      `/api/lithuanian/words/${encodeURIComponent(wordId)}/recordings?${queryString({ durationMs, transcript })}`,
      {
        method: "POST",
        headers: { "Content-Type": audio.type || "audio/webm" },
        body: audio
      }
    );
  }

  lithuanianRecordingBlob(recordingId: string): Promise<Blob> {
    return this.blobRequest(`/api/lithuanian/recordings/${encodeURIComponent(recordingId)}/content`);
  }

  deleteLithuanianRecording(recordingId: string): Promise<void> {
    return this.request(`/api/lithuanian/recordings/${encodeURIComponent(recordingId)}`, { method: "DELETE" });
  }

  propertyOverview(): Promise<PropertyPortfolioOverview> {
    return this.request("/api/properties/overview");
  }

  propertyPlatformOverview(): Promise<PropertyPlatformOverview> {
    return this.request("/api/property-platform/overview");
  }

  createPropertyUnit(input: PropertyUnitCreate): Promise<PropertyUnit> {
    return this.request("/api/property-units", { method: "POST", body: JSON.stringify(input) });
  }

  createPropertyTenantInvitation(input: PropertyTenantInvitationCreate): Promise<PropertyTenantInvitation> {
    return this.request("/api/property-tenant-invitations", { method: "POST", body: JSON.stringify(input) });
  }

  uploadPropertyDocument(metadata: PropertyDocumentMetadata, file: File): Promise<PropertyDocument> {
    return this.request(`/api/property-documents?${queryString({ metadata: JSON.stringify(metadata), filename: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
  }

  uploadPropertyDocumentVersion(documentId: string, file: File): Promise<PropertyDocument> {
    return this.request(`/api/property-documents/${encodeURIComponent(documentId)}/versions?${queryString({ filename: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
  }

  acknowledgePropertyDocument(documentId: string): Promise<PropertyDocument> {
    return this.request(`/api/property-documents/${encodeURIComponent(documentId)}/acknowledge`, { method: "POST" });
  }

  propertyDocumentBlob(versionId: string, inline = false): Promise<Blob> {
    return this.blobRequest(`/api/property-document-versions/${encodeURIComponent(versionId)}/content?${queryString({ disposition: inline ? "inline" : "attachment" })}`);
  }

  addPropertyRequestComment(requestId: string, input: PropertyRequestCommentCreate): Promise<PropertyRequestComment> {
    return this.request(`/api/property-service-requests/${encodeURIComponent(requestId)}/comments`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  uploadPropertyRequestAttachment(requestId: string, file: File): Promise<PropertyRequestAttachment> {
    return this.request(`/api/property-service-requests/${encodeURIComponent(requestId)}/attachments?${queryString({ filename: file.name })}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file
    });
  }

  propertyRequestAttachmentBlob(attachmentId: string, inline = false): Promise<Blob> {
    return this.blobRequest(`/api/property-request-attachments/${encodeURIComponent(attachmentId)}/content?${queryString({ disposition: inline ? "inline" : "attachment" })}`);
  }

  createPropertyRentSchedule(input: PropertyRentScheduleCreate): Promise<PropertyRentSchedule> {
    return this.request("/api/property-rent-schedules", { method: "POST", body: JSON.stringify(input) });
  }

  createPropertyLedgerAdjustment(input: PropertyLedgerAdjustment): Promise<PropertyLedgerEntry> {
    return this.request("/api/property-ledger/adjustments", { method: "POST", body: JSON.stringify(input) });
  }

  updatePropertyConsent(input: PropertyConsentPatch): Promise<PropertyCommunicationConsent> {
    return this.request("/api/property-consents", { method: "PUT", body: JSON.stringify(input) });
  }

  updatePropertyIntegrations(input: PropertyIntegrationSettingsPatch): Promise<PropertyIntegrationSettings> {
    return this.request("/api/admin/property-integrations", { method: "PATCH", body: JSON.stringify(input) });
  }

  async downloadPropertyFinancialReport(): Promise<void> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/property-reports/financial.csv`, {
      credentials: "same-origin",
      headers: this.headers(undefined, false)
    });
    if (!response.ok) throw await responseError(response);
    downloadBlob(await response.blob(), `property-ledger-${new Date().toISOString().slice(0, 10)}.csv`);
  }

  runPropertyAutomation(): Promise<PropertyAutomationRunResult> {
    return this.request("/api/property-automation/run", { method: "POST" });
  }

  listPropertyBackups(): Promise<PropertyBackupSummary[]> {
    return this.request("/api/admin/property-backups");
  }

  createPropertyBackup(): Promise<PropertyBackupSummary> {
    return this.request("/api/admin/property-backups", { method: "POST" });
  }

  createProperty(input: ManagedPropertyCreate): Promise<ManagedProperty> {
    return this.request("/api/properties", { method: "POST", body: JSON.stringify(input) });
  }

  updateProperty(propertyId: string, input: ManagedPropertyPatch): Promise<ManagedProperty> {
    return this.request(`/api/properties/${encodeURIComponent(propertyId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  async propertyPhoto(propertyId: string): Promise<Blob> {
    const response = await fetch(
      `${this.config.apiBaseUrl}/api/properties/${encodeURIComponent(propertyId)}/photo`,
      { headers: this.headers(undefined, false) }
    );
    if (!response.ok) throw await responseError(response);
    return response.blob();
  }

  uploadPropertyPhoto(propertyId: string, image: File): Promise<ManagedProperty> {
    return this.request(`/api/properties/${encodeURIComponent(propertyId)}/photo`, {
      method: "PUT",
      headers: { "Content-Type": image.type },
      body: image
    });
  }

  createPropertyTenant(input: PropertyTenantCreate): Promise<PropertyTenant> {
    return this.request("/api/property-tenants", { method: "POST", body: JSON.stringify(input) });
  }

  createPropertyLease(input: PropertyLeaseCreate): Promise<PropertyLease> {
    return this.request("/api/property-leases", { method: "POST", body: JSON.stringify(input) });
  }

  createPropertyServiceRequest(input: PropertyServiceRequestCreate): Promise<PropertyServiceRequest> {
    return this.request("/api/property-service-requests", { method: "POST", body: JSON.stringify(input) });
  }

  updatePropertyServiceRequest(
    requestId: string,
    input: PropertyServiceRequestPatch
  ): Promise<PropertyServiceRequest> {
    return this.request(`/api/property-service-requests/${encodeURIComponent(requestId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  createPropertyRentCharge(input: PropertyRentChargeCreate): Promise<PropertyRentCharge> {
    return this.request("/api/property-rent-charges", { method: "POST", body: JSON.stringify(input) });
  }

  createPropertyPayment(input: PropertyPaymentCreate): Promise<PropertyPayment> {
    return this.request("/api/property-payments", { method: "POST", body: JSON.stringify(input) });
  }

  updatePropertyPayment(paymentId: string, input: PropertyPaymentPatch): Promise<PropertyPayment> {
    return this.request(`/api/property-payments/${encodeURIComponent(paymentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  createPropertyPaymentCheckout(paymentId: string): Promise<PropertyPaymentCheckoutResult> {
    return this.request(`/api/property-payments/${encodeURIComponent(paymentId)}/checkout`, { method: "POST" });
  }

  syncPropertyPayment(paymentId: string): Promise<PropertyPayment> {
    return this.request(`/api/property-payments/${encodeURIComponent(paymentId)}/sync`, { method: "POST" });
  }

  refundPropertyPayment(paymentId: string, input: PropertyRefundRequest): Promise<PropertyRefundResult> {
    return this.request(`/api/property-payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  async listArchives(): Promise<Archive[]> {
    return list(await this.request("/api/archives")).map(normalizeArchive);
  }

  async listFolders(archiveId: string): Promise<Folder[]> {
    return list(await this.request(`/api/archives/${encodeURIComponent(archiveId)}/folders`))
      .map(normalizeFolder);
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

  /**
   * Starts the merge and returns the job tracking it. The move itself runs on the server: a large
   * archive takes far longer than a request can stay open, and the disconnect that follows a
   * proxy timeout used to roll the whole merge back.
   */
  async combineArchives(sourceArchiveId: string, targetArchiveId: string): Promise<ImportJob> {
    return normalizeImportJob(await this.request(
      `/api/archives/${encodeURIComponent(sourceArchiveId)}/combine`,
      { method: "POST", body: JSON.stringify({ targetArchiveId }) }
    ));
  }

  async combineMailboxes(sourceFolderId: string, targetFolderId: string): Promise<ImportJob> {
    return normalizeImportJob(await this.request(
      `/api/folders/${encodeURIComponent(sourceFolderId)}/combine`,
      { method: "POST", body: JSON.stringify({ targetFolderId }) }
    ));
  }

  moveMailbox(folderId: string, targetParentId: string | null): Promise<MailboxMoveResult> {
    return this.request(`/api/folders/${encodeURIComponent(folderId)}/move`, {
      method: "POST",
      body: JSON.stringify({ targetParentId })
    });
  }

  async listGmailConnections(): Promise<GmailConnection[]> {
    return list(await this.request("/api/gmail/connections")).map(normalizeGmailConnection);
  }

  startGmailAuthorization(request: GmailAuthRequest): Promise<GmailAuthStart> {
    return this.request("/api/gmail/oauth/start", {
      method: "POST",
      body: JSON.stringify(request)
    });
  }

  async syncGmail(connectionId: string, options: { full?: boolean } = {}): Promise<GmailConnection> {
    return normalizeGmailConnection(await this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/sync`, {
      method: "POST",
      body: JSON.stringify(options)
    }));
  }

  async cancelGmailSync(connectionId: string): Promise<GmailConnection> {
    return normalizeGmailConnection(await this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/cancel`, {
      method: "POST"
    }));
  }

  async reconcileGmailMailbox(connectionId: string): Promise<GmailConnection> {
    return normalizeGmailConnection(await this.request(`/api/gmail/connections/${encodeURIComponent(connectionId)}/reconcile`, {
      method: "POST"
    }));
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

  listCalendarSources(): Promise<CalendarSource[]> {
    return this.request("/api/calendar/sources");
  }

  listCalendarSourceEvents(sourceId: string, timeMinISO: string, timeMaxISO: string): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({ timeMin: timeMinISO, timeMax: timeMaxISO });
    return this.request(`/api/calendar/sources/${encodeURIComponent(sourceId)}/events?${params}`);
  }

  createCalendarSourceEvent(sourceId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.request(`/api/calendar/sources/${encodeURIComponent(sourceId)}/events`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateCalendarSourceEvent(sourceId: string, eventId: string, input: CalendarEventInput): Promise<CalendarEvent> {
    return this.request(`/api/calendar/sources/${encodeURIComponent(sourceId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  deleteCalendarSourceEvent(sourceId: string, eventId: string): Promise<void> {
    return this.request(`/api/calendar/sources/${encodeURIComponent(sourceId)}/events/${encodeURIComponent(eventId)}`, {
      method: "DELETE"
    });
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

  listMessages(options: Omit<SearchFilters, "sort">): Promise<CursorPage<MessageSummary>> {
    return this.request(`/api/messages?${queryString(options)}`);
  }

  async inboxCategoryCounts(options: { archiveId?: string; folderId?: string; isRead?: boolean }): Promise<InboxCategoryCounts> {
    const counts = await this.request<InboxCategoryCounts & { mailTracking?: number }>(
      `/api/messages/category-counts?${queryString(options)}`
    );
    return {
      primary: counts.primary ?? 0,
      promotions: counts.promotions ?? 0,
      social: counts.social ?? 0,
      updates: counts.updates ?? 0,
      bills: counts.bills ?? 0,
      medical: counts.medical ?? 0,
      mail_tracking: counts.mail_tracking ?? counts.mailTracking ?? 0
    };
  }

  inboxTabSettings(archiveId: string): Promise<InboxTabSettings> {
    return this.request(`/api/inbox-tabs?${queryString({ archiveId })}`);
  }

  updateInboxTabSettings(archiveId: string, input: InboxTabSettingsUpdate): Promise<InboxTabSettings> {
    return this.request(`/api/admin/inbox-tabs/${encodeURIComponent(archiveId)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  reclassifyInboxTabs(archiveId: string): Promise<InboxTabReclassifyResult> {
    return this.request(`/api/admin/inbox-tabs/${encodeURIComponent(archiveId)}/reclassify`, {
      method: "POST"
    });
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

  askArchiveMail(input: AskRequest): Promise<AskAnswer> {
    return this.request("/api/ai/ask", { method: "POST", body: JSON.stringify(input) });
  }

  listAskHistory(): Promise<AskHistoryEntry[]> {
    return this.request("/api/ai/ask/history");
  }

  listDuplicateGroups(status?: DuplicateReviewStatus): Promise<DuplicateGroupList> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    return this.request(`/api/ai/duplicates${query}`);
  }

  getDuplicateGroup(groupId: string): Promise<DuplicateGroupDetail> {
    return this.request(`/api/ai/duplicates/${encodeURIComponent(groupId)}`);
  }

  updateDuplicateGroup(groupId: string, patch: DuplicateGroupPatch): Promise<DuplicateGroupDetail> {
    return this.request(`/api/ai/duplicates/${encodeURIComponent(groupId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }

  scanDuplicates(): Promise<DuplicateScanResult> {
    return this.request("/api/ai/duplicates/scan", { method: "POST" });
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

  markAllMessageAnalysesReviewed(): Promise<AiAnalysisReviewAllResult> {
    return this.request("/api/ai/review-queue/review-all", { method: "POST" });
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

  runSmartMailRule(id: string, scope: SmartMailRuleRunScope): Promise<SmartMailRuleRunTask> {
    return this.request(`/api/admin/smart-mail-rules/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify({ scope })
    });
  }

  startSmartMailRuleRun(
    archiveId: string,
    ruleIds: string[],
    scope: SmartMailRuleRunScope
  ): Promise<SmartMailRuleRunTask> {
    return this.request("/api/admin/smart-mail-rules/run", {
      method: "POST",
      body: JSON.stringify({ archiveId, ruleIds, scope })
    });
  }

  mailboxTask(id: string): Promise<SmartMailRuleRunTask> {
    return this.request(`/api/admin/mailbox-tasks/${encodeURIComponent(id)}`);
  }

  cancelMailboxTask(id: string): Promise<SmartMailRuleRunTask> {
    return this.request(`/api/admin/mailbox-tasks/${encodeURIComponent(id)}/cancel`, { method: "POST" });
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

  bulkMarkMessagesRead(messageIds: string[]): Promise<BulkMessageReadResult> {
    return this.request("/api/messages/bulk-read", {
      method: "POST",
      body: JSON.stringify({ messageIds })
    });
  }

  moveMessage(messageId: string, folderId: string): Promise<MessageDetail> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: JSON.stringify({ folderId })
    });
  }

  bulkMoveMessages(messageIds: string[], destination: BulkMoveDestination): Promise<BulkMoveResult> {
    return this.request("/api/messages/bulk-move", {
      method: "POST",
      body: JSON.stringify({ messageIds, destination })
    });
  }

  suggestBulkFilingFolder(messageIds: string[]): Promise<MessageFilingSuggestion> {
    return this.request("/api/messages/ai/filing-suggestion", {
      method: "POST",
      body: JSON.stringify({ messageIds })
    });
  }

  bulkMoveMessagesToFolder(messageIds: string[], folderId: string): Promise<BulkFolderMoveResult> {
    return this.request("/api/messages/bulk-move-to-folder", {
      method: "POST",
      body: JSON.stringify({ messageIds, folderId })
    });
  }

  moveSenderMessagesToFolder(messageId: string, folderId: string): Promise<SenderFolderRuleResult> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/sender-folder`, {
      method: "POST",
      body: JSON.stringify({ folderId })
    });
  }

  markSenderAsSpam(messageId: string): Promise<SenderSpamRuleResult> {
    return this.request(`/api/messages/${encodeURIComponent(messageId)}/spam-sender`, {
      method: "POST"
    });
  }

  async listImportJobs(): Promise<ImportJob[]> {
    return list(await this.request("/api/import-jobs")).map(normalizeImportJob);
  }

  async getImportJob(jobId: string): Promise<ImportJob> {
    return normalizeImportJob(await this.request(`/api/import-jobs/${encodeURIComponent(jobId)}`));
  }

  async cancelImport(jobId: string): Promise<ImportJob> {
    return normalizeImportJob(await this.request(`/api/import-jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST"
    }));
  }

  async resumeImport(jobId: string): Promise<ImportJob> {
    return normalizeImportJob(await this.request(`/api/import-jobs/${encodeURIComponent(jobId)}/resume`, {
      method: "POST"
    }));
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

  async adminSettings(): Promise<AdminSettings> {
    return normalizeAdminSettings(await this.request("/api/admin/settings"));
  }

  stockQuotes(): Promise<StockQuote[]> {
    return this.request("/api/stocks/quotes");
  }

  stockDisplaySettings(): Promise<{ secondsPerSymbol: number }> {
    return this.request("/api/stocks/display-settings");
  }

  newsHeadlines(): Promise<NewsHeadline[]> {
    return this.request("/api/news/headlines");
  }

  newsDisplaySettings(): Promise<{ secondsPerHeadline: number }> {
    return this.request("/api/news/display-settings");
  }

  updateDatabaseSettings(input: DatabaseSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/database", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  testDatabaseSettings(input: DatabaseSettingsPatch): Promise<DatabaseConnectionTestResult> {
    return this.request("/api/admin/settings/database/test", {
      method: "POST",
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

  listCalendarAccounts(): Promise<CalendarAccount[]> {
    return this.request("/api/admin/calendar/accounts");
  }

  connectAppleCalendar(input: AppleCalendarAccountCreate): Promise<CalendarAccount> {
    return this.request("/api/admin/calendar/accounts", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  reconnectAppleCalendar(accountId: string, input: AppleCalendarAccountCreate): Promise<CalendarAccount> {
    return this.request(`/api/admin/calendar/accounts/${encodeURIComponent(accountId)}`, {
      method: "PUT",
      body: JSON.stringify(input)
    });
  }

  disconnectAppleCalendar(accountId: string): Promise<void> {
    return this.request(`/api/admin/calendar/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
  }

  updateDraftSettings(input: DraftSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/drafts", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  updateStockSettings(input: StockSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/stocks", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  updateNewsSettings(input: NewsSettingsPatch): Promise<AdminSettings> {
    return this.request("/api/admin/settings/news", {
      method: "PATCH",
      body: JSON.stringify(input)
    });
  }

  updatePollingSettings(input: {
    key: string;
    enabled?: boolean;
    intervalMs?: number;
    activeIntervalMs?: number;
  }): Promise<AdminSettings> {
    return this.request("/api/admin/settings/polling", {
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

  createSenderFilingRule(input: SenderFilingRuleCreate): Promise<SenderFilingRuleCreateResult> {
    return this.request("/api/admin/sender-filing/rules", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  updateSenderFilingRuleFolder(ruleId: string, folderId: string): Promise<SenderFilingStatus> {
    return this.request(`/api/admin/sender-filing/rules/${encodeURIComponent(ruleId)}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId })
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

  deleteUser(userId: string): Promise<void> {
    return this.request(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
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

  private async blobRequest(path: string): Promise<Blob> {
    const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
      credentials: "same-origin",
      headers: this.headers(undefined, false)
    });
    if (!response.ok) throw await responseError(response);
    return response.blob();
  }

  private async requestWithContext<T>(
    path: string,
    init: RequestInit = {},
    diagnosticContext: Record<string, unknown> = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const cacheTtl = method === "GET" && !init.signal ? queryCacheDuration(path) : 0;
    if (cacheTtl > 0) {
      const cached = this.queryCache.get(path);
      if (cached && cached.expiresAt > Date.now()) return cached.value as T;
      const pending = this.pendingQueries.get(path);
      if (pending) return pending as Promise<T>;
    } else if (method !== "GET") {
      // A mutation can affect archives, folders, counts, messages, settings, and
      // provider state. Clear before dispatch so an older in-flight GET cannot
      // repopulate the cache after the mutation starts.
      this.invalidateCache();
    }
    const generation = this.cacheGeneration;
    const request = this.fetchJson<T>(path, init, diagnosticContext);
    if (cacheTtl <= 0) return request;
    this.pendingQueries.set(path, request);
    try {
      const value = await request;
      if (generation === this.cacheGeneration) {
        this.queryCache.set(path, {
          value,
          expiresAt: Date.now() + cacheTtl,
          generation
        });
      }
      return value;
    } finally {
      if (this.pendingQueries.get(path) === request) this.pendingQueries.delete(path);
    }
  }

  private async fetchJson<T>(
    path: string,
    init: RequestInit,
    diagnosticContext: Record<string, unknown>
  ): Promise<T> {
    try {
      const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        credentials: "same-origin",
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

function normalizeArchive(value: unknown): Archive {
  const item = record(value);
  return {
    id: text(item.id),
    name: text(item.name, "Archive"),
    sourceType: text(item.sourceType, "mbox") as Archive["sourceType"],
    status: text(item.status, "ready") as Archive["status"],
    sizeBytes: finiteNumber(item.sizeBytes),
    messageCount: finiteNumber(item.messageCount),
    unreadCount: finiteNumber(item.unreadCount),
    starredCount: finiteNumber(item.starredCount),
    starredUnreadCount: finiteNumber(item.starredUnreadCount),
    folderCount: finiteNumber(item.folderCount),
    attachmentCount: finiteNumber(item.attachmentCount),
    errorCount: finiteNumber(item.errorCount),
    importedAt: nullableText(item.importedAt),
    createdAt: text(item.createdAt)
  };
}

function normalizeFolder(value: unknown): Folder {
  const item = record(value);
  return {
    id: text(item.id),
    archiveId: text(item.archiveId),
    parentId: nullableText(item.parentId),
    name: text(item.name, "Folder"),
    path: text(item.path, text(item.name, "Folder")),
    messageCount: finiteNumber(item.messageCount),
    unreadCount: finiteNumber(item.unreadCount)
  };
}

function normalizeGmailConnection(value: unknown): GmailConnection {
  const item = record(value);
  return {
    id: text(item.id),
    email: text(item.email),
    archiveId: text(item.archiveId),
    archiveName: text(item.archiveName, "Gmail"),
    folderId: text(item.folderId),
    folderPath: text(item.folderPath, "Gmail"),
    query: text(item.query),
    ocrEnabled: Boolean(item.ocrEnabled),
    canSend: Boolean(item.canSend),
    canModifyMailbox: Boolean(item.canModifyMailbox),
    canManageCalendar: Boolean(item.canManageCalendar),
    status: text(item.status, "error") as GmailConnection["status"],
    processedItems: finiteNumber(item.processedItems),
    totalItems: item.totalItems === null || item.totalItems === undefined
      ? null
      : finiteNumber(item.totalItems),
    importedItems: finiteNumber(item.importedItems),
    lastSyncedAt: nullableText(item.lastSyncedAt),
    lastError: nullableText(item.lastError),
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt)
  };
}

function normalizeImportJob(value: unknown): ImportJob {
  const item = record(value);
  return {
    id: text(item.id),
    archiveId: nullableText(item.archiveId),
    sourceName: text(item.sourceName, "Import"),
    sourceType: text(item.sourceType, "mbox") as ImportJob["sourceType"],
    status: text(item.status, "failed") as ImportJob["status"],
    phase: text(item.phase, "parsing") as ImportJob["phase"],
    processedItems: finiteNumber(item.processedItems),
    totalItems: item.totalItems === null || item.totalItems === undefined
      ? null
      : finiteNumber(item.totalItems),
    processedBytes: finiteNumber(item.processedBytes),
    totalBytes: finiteNumber(item.totalBytes),
    errorCount: finiteNumber(item.errorCount),
    ocrEnabled: Boolean(item.ocrEnabled),
    canResume: Boolean(item.canResume),
    message: nullableText(item.message),
    createdAt: text(item.createdAt),
    updatedAt: text(item.updatedAt)
  };
}

function normalizeAdminSettings(value: unknown): AdminSettings {
  const root = record(value);
  const database = record(root.database);
  const importRuntime = record(database.importRuntime);
  const security = record(root.security);
  const gmail = record(root.gmail);
  const drafts = record(root.drafts);
  const stocks = record(root.stocks);
  const news = record(root.news);
  const ai = record(root.ai);
  const usage = record(ai.usage);
  const lithuanian = record(root.lithuanian);
  const polling = record(root.polling);

  return {
    // Absent on an older server; the UI falls back to built-in intervals rather than
    // rendering an empty admin panel.
    polling: root.polling === null || root.polling === undefined ? undefined : {
      minimumIntervalMs: finiteNumber(polling.minimumIntervalMs) || 1_000,
      maximumIntervalMs: finiteNumber(polling.maximumIntervalMs) || 3_600_000,
      loops: Array.isArray(polling.loops)
        ? (polling.loops as unknown[]).map((entry) => {
            const loop = record(entry);
            const activeInterval = finiteNumber(loop.activeIntervalMs);
            const defaultActiveInterval = finiteNumber(loop.defaultActiveIntervalMs);
            return {
              key: text(loop.key),
              label: text(loop.label),
              description: text(loop.description),
              enabled: loop.enabled === undefined ? true : Boolean(loop.enabled),
              intervalMs: finiteNumber(loop.intervalMs),
              defaultIntervalMs: finiteNumber(loop.defaultIntervalMs),
              activeIntervalMs: activeInterval > 0 ? activeInterval : null,
              defaultActiveIntervalMs: defaultActiveInterval > 0 ? defaultActiveInterval : null,
              activeLabel: loop.activeLabel === null || loop.activeLabel === undefined ? null : text(loop.activeLabel),
              customized: Boolean(loop.customized)
            };
          })
        : []
    },
    database: {
      ...database,
      activeProvider: text(database.activeProvider, "postgresql") as AdminSettings["database"]["activeProvider"],
      activeConnectionString: text(database.activeConnectionString),
      configuredProvider: text(database.configuredProvider, "postgresql") as AdminSettings["database"]["configuredProvider"],
      configuredConnectionString: text(database.configuredConnectionString),
      restartRequired: Boolean(database.restartRequired),
      providers: Array.isArray(database.providers) ? database.providers as AdminSettings["database"]["providers"] : [],
      structuredDataPath: text(database.structuredDataPath),
      attachmentBlobPath: text(database.attachmentBlobPath),
      importRuntime: database.importRuntime === null || database.importRuntime === undefined ? undefined : {
        activeJobs: finiteNumber(importRuntime.activeJobs),
        queuedJobs: finiteNumber(importRuntime.queuedJobs),
        concurrency: finiteNumber(importRuntime.concurrency),
        batchSize: finiteNumber(importRuntime.batchSize),
        throttleMs: finiteNumber(importRuntime.throttleMs),
        latencyThresholdMs: finiteNumber(importRuntime.latencyThresholdMs),
        throttledForApiLatency: Boolean(importRuntime.throttledForApiLatency)
      }
    },
    security: {
      sessionLifetimeMinutes: finiteNumber(security.sessionLifetimeMinutes),
      defaultPinWarning: Boolean(security.defaultPinWarning)
    },
    gmail: {
      ...gmail,
      configured: Boolean(gmail.configured),
      clientId: text(gmail.clientId),
      clientSecretConfigured: Boolean(gmail.clientSecretConfigured),
      source: text(gmail.source, "none") as AdminSettings["gmail"]["source"],
      settingsPath: text(gmail.settingsPath),
      configurationError: nullableText(gmail.configurationError),
      oauthCallbackUrl: nullableText(gmail.oauthCallbackUrl),
      syncIntervalMinutes: finiteNumber(gmail.syncIntervalMinutes),
      syncIntervalEnvManaged: Boolean(gmail.syncIntervalEnvManaged),
      syncMailboxActions: Boolean(gmail.syncMailboxActions),
      syncMailboxActionsEnvManaged: Boolean(gmail.syncMailboxActionsEnvManaged)
    },
    drafts: {
      defaultFromAddress: text(drafts.defaultFromAddress),
      senderName: text(drafts.senderName),
      settingsPath: text(drafts.settingsPath),
      configurationError: nullableText(drafts.configurationError)
    },
    stocks: {
      symbols: Array.isArray(stocks.symbols) ? stocks.symbols.filter((item): item is string => typeof item === "string") : [],
      secondsPerSymbol: finiteNumber(stocks.secondsPerSymbol, 8),
      settingsPath: text(stocks.settingsPath),
      configurationError: nullableText(stocks.configurationError)
    },
    news: {
      enabledSources: Array.isArray(news.enabledSources)
        ? news.enabledSources as AdminSettings["news"]["enabledSources"]
        : [],
      secondsPerHeadline: finiteNumber(news.secondsPerHeadline, 10),
      settingsPath: text(news.settingsPath),
      configurationError: nullableText(news.configurationError)
    },
    lithuanian: {
      apiKeyConfigured: Boolean(lithuanian.apiKeyConfigured),
      environmentManaged: Boolean(lithuanian.environmentManaged),
      source: text(lithuanian.source, "none") as AdminSettings["lithuanian"]["source"],
      model: text(lithuanian.model),
      defaultModel: text(lithuanian.defaultModel),
      hintModel: text(lithuanian.hintModel),
      defaultHintModel: text(lithuanian.defaultHintModel),
      translationModel: text(lithuanian.translationModel),
      defaultTranslationModel: text(lithuanian.defaultTranslationModel),
      speechModel: text(lithuanian.speechModel),
      defaultSpeechModel: text(lithuanian.defaultSpeechModel),
      speechVoice: text(lithuanian.speechVoice),
      defaultSpeechVoice: text(lithuanian.defaultSpeechVoice),
      passMark: finiteNumber(lithuanian.passMark, LITHUANIAN_PASS_MARK),
      defaultPassMark: finiteNumber(lithuanian.defaultPassMark, LITHUANIAN_PASS_MARK),
      minimumPassMark: finiteNumber(lithuanian.minimumPassMark, LITHUANIAN_MIN_PASS_MARK),
      maximumPassMark: finiteNumber(lithuanian.maximumPassMark, LITHUANIAN_MAX_PASS_MARK),
      learnerCount: finiteNumber(lithuanian.learnerCount),
      settingsPath: text(lithuanian.settingsPath),
      configurationError: nullableText(lithuanian.configurationError)
    },
    ai: {
      ...ai,
      activeProvider: text(ai.activeProvider, "openai") as AdminSettings["ai"]["activeProvider"],
      enabled: Boolean(ai.enabled),
      concurrency: finiteNumber(ai.concurrency, 1),
      dailyRequestLimit: finiteNumber(ai.dailyRequestLimit),
      monthlyRequestLimit: finiteNumber(ai.monthlyRequestLimit),
      settingsPath: text(ai.settingsPath),
      configurationError: nullableText(ai.configurationError),
      usage: {
        todayRequests: finiteNumber(usage.todayRequests),
        monthRequests: finiteNumber(usage.monthRequests),
        todayInputTokens: finiteNumber(usage.todayInputTokens),
        todayOutputTokens: finiteNumber(usage.todayOutputTokens),
        monthInputTokens: finiteNumber(usage.monthInputTokens),
        monthOutputTokens: finiteNumber(usage.monthOutputTokens)
      },
      providers: record(ai.providers) as AdminSettings["ai"]["providers"]
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function resolveRuntimeConfig(): Promise<RuntimeConfig> {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL
    ?? (window.location.port === "5173" ? "" : window.location.origin);
  const mobile = window.matchMedia("(max-width: 800px)").matches;
  return {
    apiBaseUrl,
    accessToken: "",
    platform: mobile ? "mobile" : "browser"
  };
}

function queryCacheDuration(path: string): number {
  // These endpoints are active-status feeds. Their existing polling cadence is
  // the source of truth and must never be hidden behind a response cache.
  if (
    path.startsWith("/api/auth/")
    || path.startsWith("/api/import-jobs")
    || path.startsWith("/api/uploads")
    || path === "/api/gmail/connections"
    || path.startsWith("/api/diagnostics")
    || path.startsWith("/api/ai/review-queue")
    || path.startsWith("/api/admin/ai-schedules")
    || path.startsWith("/api/stocks/quotes")
    || path.startsWith("/api/news/headlines")
  ) return 0;

  if (path.startsWith("/api/calendar/")) return 30_000;
  if (path.startsWith("/api/messages") || path.startsWith("/api/search")) return 20_000;
  if (path.startsWith("/api/archives") || path.startsWith("/api/folders")) return 10_000;
  if (path.startsWith("/api/todos")) return 10_000;
  if (path.startsWith("/api/admin/settings")) return 60_000;
  return DEFAULT_QUERY_CACHE_MS;
}

function queryString(values: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function responseError(response: Response): Promise<Error> {
  let message = `Request failed (${response.status})`;
  try {
    const body = await response.json() as { error?: string; detail?: string; title?: string };
    message = body.error ?? body.detail ?? body.title ?? message;
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
