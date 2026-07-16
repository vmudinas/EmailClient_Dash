import { z } from "zod";

export type ArchiveSourceType = "pst" | "mbox" | "gmail";
export type ImportSourceType = Exclude<ArchiveSourceType, "gmail">;
export type ArchiveStatus = "importing" | "ready" | "ready_with_errors" | "failed";
export type ImportPhase = "queued" | "fingerprinting" | "parsing" | "attachments" | "indexing" | "finalizing";
export type ImportJobStatus = "queued" | "running" | "paused" | "completed" | "completed_with_errors" | "cancelled" | "failed";
export type UploadStatus = "uploading" | "ready" | "completed" | "failed" | "cancelled";
export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticCategory = "upload" | "import" | "parser" | "attachment" | "gmail" | "ai" | "api" | "client" | "system";
export type GmailConnectionStatus = "connected" | "syncing" | "error";
export type GmailConfigurationSource = "admin" | "environment" | "none";
export type AiConfigurationSource = "admin" | "environment" | "none";
export const AI_PROVIDER_IDS = ["openai", "deepseek"] as const;
export type AiProviderId = typeof AI_PROVIDER_IDS[number];
export const AI_AGENT_SKILL_IDS = [
  "summarize",
  "categorize",
  "prioritize",
  "extract-actions",
  "detect-spam",
  "detect-phishing",
  "recommend-draft"
] as const;
export type AiAgentSkillId = typeof AI_AGENT_SKILL_IDS[number];
export const AI_AGENT_SKILLS: ReadonlyArray<{
  id: AiAgentSkillId;
  label: string;
  description: string;
}> = [
  { id: "summarize", label: "Summarize", description: "Produce a concise factual summary." },
  { id: "categorize", label: "Categorize", description: "Assign short, useful categories." },
  { id: "prioritize", label: "Prioritize", description: "Estimate urgency and business priority." },
  { id: "extract-actions", label: "Extract actions", description: "Find requested actions and next steps." },
  { id: "detect-spam", label: "Detect spam", description: "Estimate whether the message is unwanted bulk mail." },
  { id: "detect-phishing", label: "Detect phishing", description: "Identify impersonation and credential-theft signals." },
  { id: "recommend-draft", label: "Recommend reply", description: "Decide whether a response draft would help." }
];
export type AiJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AiJobTask = "analyze" | "draft_reply";
export type AiPriority = "low" | "normal" | "high" | "urgent";
export type AccountRole = "admin" | "user";
export type SessionRole = AccountRole | "viewer";
export type DatabaseProvider = "sqlite" | "postgresql" | "mysql" | "mssql";

export interface Archive {
  id: string;
  name: string;
  sourceType: ArchiveSourceType;
  status: ArchiveStatus;
  sizeBytes: number;
  messageCount: number;
  unreadCount: number;
  folderCount: number;
  attachmentCount: number;
  errorCount: number;
  importedAt: string | null;
  createdAt: string;
}

export interface Folder {
  id: string;
  archiveId: string;
  parentId: string | null;
  name: string;
  path: string;
  messageCount: number;
  unreadCount: number;
}

export interface EmailAddress {
  name: string | null;
  address: string;
}

export interface LocalMessageState {
  isRead: boolean;
  isStarred: boolean;
  tags: string[];
  note: string;
  updatedAt: string | null;
}

export interface MessageSummary {
  id: string;
  archiveId: string;
  folderId: string;
  folderPath: string;
  subject: string;
  sender: EmailAddress;
  recipients: EmailAddress[];
  sentAt: string | null;
  receivedAt: string | null;
  preview: string;
  hasAttachments: boolean;
  attachmentCount: number;
  state: LocalMessageState;
}

export interface Attachment {
  id: string;
  messageId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  disposition: "inline" | "attachment";
  textStatus: "pending" | "indexed" | "unsupported" | "failed" | "ocr_indexed";
}

export interface MessageDetail extends MessageSummary {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, string>;
  attachments: Attachment[];
}

export interface SearchHit {
  message: MessageSummary;
  score: number;
  matchedIn: "message" | "attachment";
  matchedAttachmentId: string | null;
  matchedAttachmentName: string | null;
  snippet: string;
}

export interface ImportJob {
  id: string;
  archiveId: string | null;
  sourceName: string;
  sourceType: ImportSourceType;
  status: ImportJobStatus;
  phase: ImportPhase;
  processedItems: number;
  totalItems: number | null;
  processedBytes: number;
  totalBytes: number;
  errorCount: number;
  ocrEnabled: boolean;
  canResume: boolean;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSession {
  id: string;
  filename: string;
  sizeBytes: number;
  receivedBytes: number;
  status: UploadStatus;
  ocrEnabled: boolean;
  jobId: string | null;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiagnosticEvent {
  id: string;
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  message: string;
  stack: string | null;
  jobId: string | null;
  archiveId: string | null;
  sourceName: string | null;
  context: Record<string, unknown>;
  createdAt: string;
}

export interface DiagnosticsSnapshot {
  events: DiagnosticEvent[];
  importJobs: ImportJob[];
  uploads: UploadSession[];
  gmailConnections: GmailConnection[];
  aiJobs: AiJob[];
}

export interface AiUsageSummary {
  todayRequests: number;
  monthRequests: number;
  todayInputTokens: number;
  todayOutputTokens: number;
  monthInputTokens: number;
  monthOutputTokens: number;
}

export interface AiAgentConfig {
  provider: AiProviderId;
  model: string;
  skills: AiAgentSkillId[];
  prompt: string;
}

export interface AiJob extends AiAgentConfig {
  id: string;
  messageId: string;
  task: AiJobTask;
  scheduleId: string | null;
  gmailConnectionId: string | null;
  resumeId: string | null;
  status: AiJobStatus;
  promptVersion: string;
  contentHash: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MessageAnalysis {
  id: string;
  messageId: string;
  summary: string;
  categories: string[];
  priority: AiPriority;
  actionRequired: boolean;
  actionSummary: string | null;
  spamProbability: number;
  phishingProbability: number;
  draftRecommended: boolean;
  confidence: number;
  signals: string[];
  model: string;
  promptVersion: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiAnalysisStart {
  job: AiJob;
  analysis: MessageAnalysis | null;
}

export interface AiMessageState {
  job: AiJob | null;
  analysis: MessageAnalysis | null;
}

export type AiScheduleMode = "all" | "unread";
export type AiScheduleTask = "analyze" | "draft_reply";

export interface AiSchedule extends AiAgentConfig {
  id: string;
  name: string;
  task: AiScheduleTask;
  folderId: string;
  folderPath: string;
  archiveId: string;
  archiveName: string;
  messageId: string | null;
  messageSubject: string | null;
  gmailConnectionId: string | null;
  gmailConnectionEmail: string | null;
  resumeId: string | null;
  resumeName: string | null;
  mode: AiScheduleMode;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  createdAt: string;
  updatedAt: string;
}

export const aiScheduleCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  task: z.enum(["analyze", "draft_reply"]).optional(),
  folderId: z.string().uuid(),
  messageId: z.string().uuid().nullable().optional(),
  gmailConnectionId: z.string().uuid().nullable().optional(),
  resumeId: z.string().uuid().nullable().optional(),
  mode: z.enum(["all", "unread"]),
  intervalMinutes: z.number().int().min(5).max(43_200),
  provider: z.enum(AI_PROVIDER_IDS),
  model: z.string().trim().min(1).max(120),
  skills: z.array(z.enum(AI_AGENT_SKILL_IDS)).min(1).max(AI_AGENT_SKILL_IDS.length),
  prompt: z.string().trim().max(12_000),
  enabled: z.boolean().default(true)
}).strict().refine(
  (value) => value.task !== "draft_reply" || Boolean(value.gmailConnectionId),
  { message: "Choose a Gmail sending account for draft tasks", path: ["gmailConnectionId"] }
);

export type AiScheduleCreate = z.infer<typeof aiScheduleCreateSchema>;

export const aiScheduleUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  task: z.enum(["analyze", "draft_reply"]).optional(),
  folderId: z.string().uuid().optional(),
  messageId: z.string().uuid().nullable().optional(),
  gmailConnectionId: z.string().uuid().nullable().optional(),
  resumeId: z.string().uuid().nullable().optional(),
  mode: z.enum(["all", "unread"]).optional(),
  intervalMinutes: z.number().int().min(5).max(43_200).optional(),
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  skills: z.array(z.enum(AI_AGENT_SKILL_IDS)).min(1).max(AI_AGENT_SKILL_IDS.length).optional(),
  prompt: z.string().trim().max(12_000).optional(),
  enabled: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one schedule setting is required"
);

export type AiScheduleUpdate = z.infer<typeof aiScheduleUpdateSchema>;

export type EmailDraftSource = "manual" | "ai";

export interface ResumeAsset {
  id: string;
  name: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface EmailDraft {
  id: string;
  connectionId: string;
  connectionEmail: string;
  sourceMessageId: string | null;
  sourceMessageSubject: string | null;
  scheduleId: string | null;
  scheduleName: string | null;
  source: EmailDraftSource;
  fromAddress: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  resumeId: string | null;
  resumeName: string | null;
  resumeFilename: string | null;
  workRelated: boolean | null;
  developmentOpportunity: boolean | null;
  aiReason: string | null;
  aiConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MailboxEndpoints {
  oldest: { id: string; subject: string; senderName: string | null; senderAddress: string; date: string } | null;
  newest: { id: string; subject: string; senderName: string | null; senderAddress: string; date: string } | null;
}

export interface TopContact {
  address: string;
  name: string | null;
  count: number;
}

export interface AdminInsights {
  generatedAt: string;
  totalMessages: number;
  totalAttachments: number;
  endpoints: MailboxEndpoints;
  topSenders: TopContact[];
  topRecipients: TopContact[];
  analysis: {
    analyzedCount: number;
    priorityBreakdown: Record<AiPriority, number>;
    topCategories: { category: string; count: number }[];
    actionRequiredCount: number;
    draftRecommendedCount: number;
    flaggedSpamCount: number;
    flaggedPhishingCount: number;
    averageSpamProbability: number;
    averagePhishingProbability: number;
  } | null;
}

export interface SenderFilingRule {
  id: string;
  archiveId: string;
  senderAddress: string;
  senderName: string | null;
  folderId: string;
  folderPath: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SenderFilingStatus {
  archiveId: string;
  archiveName: string;
  enabled: boolean;
  rules: SenderFilingRule[];
  lastRunAt: string | null;
  lastRunMovedMessages: number;
  lastRunCreatedFolders: number;
}

export interface GmailConnection {
  id: string;
  email: string;
  archiveId: string;
  archiveName: string;
  folderId: string;
  folderPath: string;
  query: string;
  ocrEnabled: boolean;
  canSend: boolean;
  canManageCalendar: boolean;
  status: GmailConnectionStatus;
  processedItems: number;
  totalItems: number | null;
  importedItems: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GmailAuthStart {
  authorizationUrl: string;
  expiresAt: string;
}

export interface GmailSendRequest {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  fromAddress?: string;
}

export interface GmailSendResult {
  id: string;
  threadId: string | null;
  localCopyImported: boolean;
}

export interface GmailSendAsAlias {
  email: string;
  displayName: string;
  isPrimary: boolean;
  isDefault: boolean;
}

export interface CalendarEventAttendee {
  email: string;
  displayName: string | null;
  responseStatus: "accepted" | "declined" | "tentative" | "needsAction";
  organizer: boolean;
  self: boolean;
}

export interface CalendarEventOrganizer {
  email: string;
  displayName: string | null;
}

export interface CalendarEvent {
  id: string;
  connectionId: string;
  title: string;
  description: string;
  location: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  htmlLink: string | null;
  meetingLink: string | null;
  organizer: CalendarEventOrganizer | null;
  attendees: CalendarEventAttendee[];
}

export const calendarEventInputSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).default(""),
  location: z.string().max(500).default(""),
  startAt: z.string().min(1),
  endAt: z.string().min(1),
  allDay: z.boolean().default(false)
}).strict();

export type CalendarEventInput = z.infer<typeof calendarEventInputSchema>;

export interface TodoItem {
  id: string;
  date: string;
  text: string;
  completed: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export const todoCreateSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  text: z.string().trim().min(1).max(2_000)
}).strict();

export type TodoCreate = z.infer<typeof todoCreateSchema>;

export const todoPatchSchema = z.object({
  text: z.string().trim().min(1).max(2_000).optional(),
  completed: z.boolean().optional(),
  position: z.number().int().min(0).optional()
}).strict();

export type TodoPatch = z.infer<typeof todoPatchSchema>;

export interface ArchiveMergeResult {
  archive: Archive;
  movedMessages: number;
  movedFolders: number;
  movedAttachments: number;
}

export interface MailboxMergeResult {
  mailbox: Folder;
  movedMessages: number;
  removedMailboxes: number;
  movedAttachments: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SearchFilters {
  archiveId?: string;
  folderId?: string;
  from?: string;
  to?: string;
  after?: string;
  before?: string;
  hasAttachment?: boolean;
  sort?: "relevance" | "newest";
  cursor?: string;
  limit?: number;
}

export interface SharingState {
  enabled: boolean;
  url: string | null;
  expiresAt: string | null;
}

export interface RuntimeConfig {
  apiBaseUrl: string;
  accessToken: string;
  pairingToken?: string;
  platform: "desktop" | "browser" | "mobile";
}

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  isActive: boolean;
  mustChangePin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionInfo {
  id: string;
  user: UserSummary;
  role: SessionRole;
  expiresAt: string;
}

export interface AuthLoginResult {
  accessToken: string;
  session: AuthSessionInfo;
}

export interface AuditEvent {
  id: string;
  sessionId: string | null;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  role: SessionRole | null;
  action: string;
  method: string | null;
  path: string | null;
  statusCode: number;
  success: boolean;
  ipAddress: string;
  userAgent: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditPage {
  items: AuditEvent[];
  nextCursor: string | null;
}

export interface DatabaseProviderOption {
  id: DatabaseProvider;
  label: string;
  available: boolean;
  description: string;
}

export interface AdminSettings {
  database: {
    activeProvider: DatabaseProvider;
    activeConnectionString: string;
    configuredProvider: DatabaseProvider;
    configuredConnectionString: string;
    restartRequired: boolean;
    providers: DatabaseProviderOption[];
    structuredDataPath: string;
    attachmentBlobPath: string;
  };
  security: {
    sessionLifetimeMinutes: number;
    defaultPinWarning: boolean;
  };
  gmail: {
    configured: boolean;
    clientId: string;
    clientSecretConfigured: boolean;
    source: GmailConfigurationSource;
    settingsPath: string;
    configurationError: string | null;
    syncIntervalMinutes: number;
    syncIntervalEnvManaged: boolean;
  };
  ai: {
    activeProvider: AiProviderId;
    enabled: boolean;
    dailyRequestLimit: number;
    monthlyRequestLimit: number;
    settingsPath: string;
    configurationError: string | null;
    usage: AiUsageSummary;
    providers: Record<AiProviderId, AiProviderSettings>;
  };
}

export interface AiProviderSettings {
  configured: boolean;
  apiKeyConfigured: boolean;
  savedApiKeyConfigured: boolean;
  environmentApiKeyConfigured: boolean;
  source: AiConfigurationSource;
  model: string;
}

export interface AiModelOption {
  id: string;
  label: string;
  description: string | null;
  pricing: string | null;
}

export const localMessageStatePatchSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  note: z.string().max(20_000).optional()
}).strict();

export type LocalMessageStatePatch = z.infer<typeof localMessageStatePatchSchema>;

export const messageMoveSchema = z.object({
  folderId: z.string().uuid()
}).strict();

export type MessageMove = z.infer<typeof messageMoveSchema>;

export const senderFilingArchiveSchema = z.object({
  archiveId: z.string().uuid()
}).strict();

export type SenderFilingArchive = z.infer<typeof senderFilingArchiveSchema>;

export const importOptionsSchema = z.object({
  ocrEnabled: z.boolean().default(false),
  replaceArchiveId: z.string().uuid().optional()
}).strict();

export type ImportOptions = z.infer<typeof importOptionsSchema>;

const displayNameSchema = z.string().trim().min(1).max(120).refine(
  (name) => !/[\/\\\u0000-\u001f\u007f]/.test(name),
  "Name cannot contain slashes or control characters"
);

export const displayNamePatchSchema = z.object({
  name: displayNameSchema
}).strict();

export type DisplayNamePatch = z.infer<typeof displayNamePatchSchema>;

export const mailboxCreateSchema = z.object({
  name: displayNameSchema,
  parentId: z.string().uuid().nullable().optional()
}).strict();

export type MailboxCreate = z.infer<typeof mailboxCreateSchema>;

export const archiveMergeSchema = z.object({
  targetArchiveId: z.string().uuid()
}).strict();

export type ArchiveMerge = z.infer<typeof archiveMergeSchema>;

export const mailboxMergeSchema = z.object({
  targetFolderId: z.string().uuid()
}).strict();

export type MailboxMerge = z.infer<typeof mailboxMergeSchema>;

export const gmailAuthRequestSchema = z.object({
  archiveId: z.string().uuid().nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  archiveName: displayNameSchema.default("Gmail"),
  folderName: displayNameSchema.default("Gmail"),
  query: z.string().trim().max(500).default("newer_than:30d"),
  ocrEnabled: z.boolean().default(false)
}).strict().refine(
  (value) => !value.folderId || Boolean(value.archiveId),
  { message: "A destination archive is required for an existing mailbox", path: ["archiveId"] }
);

export type GmailAuthRequest = z.infer<typeof gmailAuthRequestSchema>;

export const gmailSyncRequestSchema = z.object({
  full: z.boolean().default(false)
}).strict();

export type GmailSyncRequest = z.infer<typeof gmailSyncRequestSchema>;

const gmailRecipientSchema = z.string().trim().email().max(320);

export const gmailSendRequestSchema = z.object({
  to: z.array(gmailRecipientSchema).min(1).max(100),
  cc: z.array(gmailRecipientSchema).max(100).default([]),
  bcc: z.array(gmailRecipientSchema).max(100).default([]),
  subject: z.string().max(998).default(""),
  bodyText: z.string().max(1_000_000).default(""),
  fromAddress: gmailRecipientSchema.optional()
}).strict().refine(
  (value) => value.subject.trim().length > 0 || value.bodyText.trim().length > 0,
  { message: "Add a subject or message body", path: ["bodyText"] }
);

const emailDraftFields = {
  connectionId: z.string().uuid(),
  to: z.array(gmailRecipientSchema).max(100).default([]),
  cc: z.array(gmailRecipientSchema).max(100).default([]),
  bcc: z.array(gmailRecipientSchema).max(100).default([]),
  subject: z.string().max(998).default(""),
  bodyText: z.string().max(1_000_000).default(""),
  fromAddress: gmailRecipientSchema.nullable().optional(),
  sourceMessageId: z.string().uuid().nullable().optional(),
  resumeId: z.string().uuid().nullable().optional()
};

export const emailDraftCreateSchema = z.object(emailDraftFields).strict();
export type EmailDraftCreate = z.infer<typeof emailDraftCreateSchema>;

export const emailDraftUpdateSchema = z.object({
  connectionId: emailDraftFields.connectionId.optional(),
  to: emailDraftFields.to.optional(),
  cc: emailDraftFields.cc.optional(),
  bcc: emailDraftFields.bcc.optional(),
  subject: emailDraftFields.subject.optional(),
  bodyText: emailDraftFields.bodyText.optional(),
  fromAddress: emailDraftFields.fromAddress,
  resumeId: emailDraftFields.resumeId
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one draft field is required"
);
export type EmailDraftUpdate = z.infer<typeof emailDraftUpdateSchema>;

export const uploadSessionCreateSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  sizeBytes: z.number().int().nonnegative().max(200 * 1024 * 1024 * 1024),
  lastModified: z.number().int().nonnegative(),
  ocrEnabled: z.boolean().default(false)
}).strict();

export type UploadSessionCreate = z.infer<typeof uploadSessionCreateSchema>;

export const clientDiagnosticSchema = z.object({
  level: z.enum(["warning", "error"]).default("error"),
  message: z.string().trim().min(1).max(4_000),
  stack: z.string().max(12_000).nullable().optional(),
  context: z.record(z.string(), z.unknown()).optional()
}).strict();

export type ClientDiagnostic = z.infer<typeof clientDiagnosticSchema>;

const usernameSchema = z.string().trim().toLowerCase().min(3).max(64).regex(
  /^[a-z0-9][a-z0-9._-]*$/,
  "Use letters, numbers, periods, underscores, or hyphens"
);

const pinSchema = z.string().regex(/^\d{4,12}$/, "PIN must contain 4 to 12 digits");

export const authLoginSchema = z.object({
  username: usernameSchema,
  pin: pinSchema,
  pairingToken: z.string().min(20).max(256).optional()
}).strict();

export type AuthLogin = z.infer<typeof authLoginSchema>;

export const pinChangeSchema = z.object({
  currentPin: pinSchema,
  newPin: pinSchema
}).strict().refine(
  (value) => value.currentPin !== value.newPin,
  { message: "Choose a different PIN", path: ["newPin"] }
);

export type PinChange = z.infer<typeof pinChangeSchema>;

export const userCreateSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["admin", "user"]),
  pin: pinSchema
}).strict();

export type UserCreate = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["admin", "user"]).optional(),
  isActive: z.boolean().optional(),
  pin: pinSchema.optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one user setting is required"
);

export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const databaseSettingsPatchSchema = z.object({
  provider: z.enum(["sqlite", "postgresql", "mysql", "mssql"]),
  connectionString: z.string().trim().min(1).max(2_000)
}).strict();

export type DatabaseSettingsPatch = z.infer<typeof databaseSettingsPatchSchema>;

export const gmailSettingsPatchSchema = z.object({
  clientId: z.string().trim().min(1).max(1_000),
  clientSecret: z.string().trim().min(1).max(1_000).optional(),
  clearClientSecret: z.boolean().default(false),
  syncIntervalMinutes: z.number().int().min(0).max(1_440).optional()
}).strict().refine(
  (value) => !(value.clientSecret && value.clearClientSecret),
  { message: "Provide a client secret or clear the saved one, not both", path: ["clientSecret"] }
);

export type GmailSettingsPatch = z.infer<typeof gmailSettingsPatchSchema>;

export const aiSettingsPatchSchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  apiKey: z.string().trim().min(20).max(2_000).optional(),
  clearApiKey: z.boolean().default(false),
  enabled: z.boolean().optional(),
  model: z.string().trim().min(1).max(120).optional(),
  dailyRequestLimit: z.number().int().min(1).max(100_000).optional(),
  monthlyRequestLimit: z.number().int().min(1).max(1_000_000).optional()
}).strict().refine(
  (value) => !(value.apiKey && value.clearApiKey),
  { message: "Provide an API key or clear the saved one, not both", path: ["apiKey"] }
).refine(
  (value) => Object.keys(value).some((key) => key !== "clearApiKey") || value.clearApiKey,
  "At least one AI setting is required"
);

export type AiSettingsPatch = z.infer<typeof aiSettingsPatchSchema>;

export const aiActiveProviderSchema = z.object({
  provider: z.enum(AI_PROVIDER_IDS)
}).strict();

export type AiActiveProviderPatch = z.infer<typeof aiActiveProviderSchema>;

export const messageAnalysisOutputSchema = z.object({
  summary: z.string().trim().min(1).max(1_200),
  categories: z.array(z.string().trim().min(1).max(48)).max(6),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  actionRequired: z.boolean(),
  actionSummary: z.string().trim().max(500).nullable(),
  spamProbability: z.number().min(0).max(1),
  phishingProbability: z.number().min(0).max(1),
  draftRecommended: z.boolean(),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.string().trim().min(1).max(240)).max(8)
}).strict();

export type MessageAnalysisOutput = z.infer<typeof messageAnalysisOutputSchema>;

export const aiDraftReplyOutputSchema = z.object({
  workRelated: z.boolean(),
  developmentOpportunity: z.boolean(),
  reason: z.string().trim().max(500),
  subject: z.string().max(998),
  bodyText: z.string().max(20_000),
  confidence: z.number().min(0).max(1)
}).strict().refine(
  (value) => !value.workRelated || value.bodyText.trim().length > 0,
  { message: "A work-related reply needs a message body", path: ["bodyText"] }
);

export type AiDraftReplyOutput = z.infer<typeof aiDraftReplyOutputSchema>;

export interface DesktopBridge {
  getRuntimeConfig(): Promise<RuntimeConfig>;
  selectAndImport(options: ImportOptions, accessToken: string): Promise<ImportJob | null>;
  cancelImport(jobId: string, accessToken: string): Promise<ImportJob>;
  resumeImport(jobId: string, accessToken: string): Promise<ImportJob>;
  removeArchive(archiveId: string, accessToken: string): Promise<void>;
  setSharingEnabled(enabled: boolean, accessToken: string): Promise<SharingState>;
}

declare global {
  interface Window {
    emailClient?: DesktopBridge;
  }
}
