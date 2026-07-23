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
export type AccountRole = "admin" | "user" | "renter";
export type SessionRole = AccountRole | "viewer";
export type DatabaseProvider = "postgresql" | "mssql";

export interface Archive {
  id: string;
  name: string;
  sourceType: ArchiveSourceType;
  status: ArchiveStatus;
  sizeBytes: number;
  messageCount: number;
  unreadCount: number;
  starredCount?: number;
  starredUnreadCount?: number;
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

export const INBOX_CATEGORIES = [
  "primary",
  "promotions",
  "social",
  "updates",
  "bills",
  "medical",
  "mail_tracking"
] as const;
export type InboxCategory = typeof INBOX_CATEGORIES[number];

export interface InboxCategoryCounts {
  primary: number;
  promotions: number;
  social: number;
  updates: number;
  bills: number;
  medical: number;
  mail_tracking: number;
}

export interface InboxTabDefinition {
  id: InboxCategory;
  label: string;
  description: string;
  enabled: boolean;
  position: number;
  color: string;
  keywords: string[];
  senderDomains: string[];
  keywordOnly: boolean;
}

export interface InboxTabSettings {
  archiveId: string;
  tabs: InboxTabDefinition[];
  aiEnabled: boolean;
  aiConfidenceThreshold: number;
  updatedAt: string | null;
}

export interface InboxTabReclassifyResult {
  settings: InboxTabSettings;
  scannedMessages: number;
  changedMessages: number;
}

export type ShipmentCarrier = "amazon" | "ups" | "fedex" | "usps" | "dhl" | "unknown";
export type ShipmentStatus = "order_confirmed" | "shipped" | "in_transit" | "out_for_delivery" | "delivered" | "delayed" | "unknown";

export interface ShipmentSummary {
  carrier: ShipmentCarrier;
  merchant: string;
  trackingNumber: string | null;
  orderNumber: string | null;
  status: ShipmentStatus;
  estimatedDeliveryDate: string | null;
  trackingUrl: string | null;
}

export const DEFAULT_INBOX_TABS: ReadonlyArray<InboxTabDefinition> = [
  { id: "primary", label: "Primary", description: "Personal and important conversations.", enabled: true, position: 0, color: "#1a73e8", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "promotions", label: "Promotions", description: "Deals, offers, newsletters, and marketing.", enabled: true, position: 1, color: "#188038", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "social", label: "Social", description: "Social network activity and community updates.", enabled: true, position: 2, color: "#9334e6", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "updates", label: "Updates", description: "Automated confirmations, alerts, and account updates.", enabled: true, position: 3, color: "#b06000", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "bills", label: "Bills", description: "Invoices, statements, balances, and payment notices.", enabled: true, position: 4, color: "#137333", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "medical", label: "Medical", description: "Health care, pharmacy, and appointment messages.", enabled: true, position: 5, color: "#c5221f", keywords: [], senderDomains: [], keywordOnly: false },
  { id: "mail_tracking", label: "Mail/Tracking", description: "Shipping, delivery, and package tracking.", enabled: true, position: 6, color: "#1967d2", keywords: [], senderDomains: [], keywordOnly: false }
];

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
  inboxCategory?: InboxCategory;
  hasAiAnalysis?: boolean;
  hasCalendarEvent?: boolean;
  hasPendingFollowUp?: boolean;
  hasReply?: boolean;
  shipment?: ShipmentSummary;
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
  scheduleRunId: string | null;
  gmailConnectionId: string | null;
  resumeId: string | null;
  replyStyleId?: string | null;
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
  threadMessageCount?: number;
  model: string;
  promptVersion: string;
  contentHash: string;
  contextHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiRelatedAnalysis {
  messageId: string;
  subject: string;
  sender: EmailAddress;
  sentAt: string | null;
  receivedAt: string | null;
  summary: string;
  categories: string[];
  priority: AiPriority;
  actionRequired: boolean;
  actionSummary: string | null;
  spamProbability: number;
  phishingProbability: number;
  draftRecommended: boolean;
  confidence: number;
  analyzedAt: string;
}

export interface AiRelatedAnalysisContext {
  sameThread: AiRelatedAnalysis[];
  sameSender: AiRelatedAnalysis[];
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
export type AiScheduleRunStatus = "queueing" | "processing" | "completed" | "completed_with_errors" | "failed";

export interface AiScheduleRunProgress {
  runId: string;
  status: AiScheduleRunStatus;
  totalMessages: number;
  queuedJobs: number;
  skippedMessages: number;
  enqueueErrors: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  processedJobs: number;
  percent: number;
  draftsCreated: number;
  startedAt: string;
  enqueueCompletedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

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
  replyStyleId?: string | null;
  replyStyleName?: string | null;
  mode: AiScheduleMode;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  progress: AiScheduleRunProgress | null;
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
  replyStyleId: z.string().uuid().nullable().optional(),
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
  replyStyleId: z.string().uuid().nullable().optional(),
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
  replyStyleId?: string | null;
  replyStyleName?: string | null;
  workRelated: boolean | null;
  developmentOpportunity: boolean | null;
  aiReason: string | null;
  aiConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface MessageDraftReplyStart {
  job: AiJob | null;
  draft: EmailDraft | null;
}

export interface MessageThread {
  messageId: string;
  totalMessages: number;
  messages: MessageSummary[];
}

export type MessageFollowUpStatus = "pending" | "completed" | "dismissed";

export interface MessageFollowUp {
  id: string;
  messageId: string;
  subject: string;
  sender: EmailAddress;
  dueAt: string;
  note: string;
  status: MessageFollowUpStatus;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const messageFollowUpCreateSchema = z.object({
  dueAt: z.string().datetime({ offset: true }),
  note: z.string().trim().max(2_000).default("")
}).strict();

export type MessageFollowUpCreate = z.infer<typeof messageFollowUpCreateSchema>;

export const messageFollowUpPatchSchema = z.object({
  dueAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().trim().max(2_000).optional(),
  status: z.enum(["pending", "completed", "dismissed"]).optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one follow-up field is required"
);

export type MessageFollowUpPatch = z.infer<typeof messageFollowUpPatchSchema>;

export interface ReplyStyle {
  id: string;
  name: string;
  tone: string;
  instructions: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export const replyStyleCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  tone: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(4_000),
  isDefault: z.boolean().default(false)
}).strict();

export type ReplyStyleCreate = z.infer<typeof replyStyleCreateSchema>;

export const replyStylePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tone: z.string().trim().min(1).max(120).optional(),
  instructions: z.string().trim().min(1).max(4_000).optional(),
  isDefault: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one reply style field is required"
);

export type ReplyStylePatch = z.infer<typeof replyStylePatchSchema>;

export interface AiReviewAnalysisItem {
  message: MessageSummary;
  analysis: MessageAnalysis;
}

export interface AiAnalysisReview {
  messageId: string;
  reviewedAt: string;
}

export interface AiAnalysisReviewAllResult {
  reviewedCount: number;
  reviewedAt: string;
}

export interface AiReviewQueue {
  drafts: EmailDraft[];
  analyses: AiReviewAnalysisItem[];
  followUps: MessageFollowUp[];
  totalItems: number;
}

export interface SmartMailRuleConditions {
  match: "all" | "any";
  senderContains: string[];
  subjectContains: string[];
  bodyContains: string[];
  hasAttachments: boolean | null;
}

export interface SmartMailRule {
  id: string;
  archiveId: string;
  archiveName: string;
  name: string;
  instruction: string;
  conditions: SmartMailRuleConditions;
  targetFolderId: string | null;
  targetFolderPath: string | null;
  markRead: boolean;
  star: boolean;
  enabled: boolean;
  matchedMessages: number;
  createdAt: string;
  updatedAt: string;
}

export interface SmartMailRuleSuggestion {
  name: string;
  instruction: string;
  conditions: SmartMailRuleConditions;
  targetFolderId: string | null;
  targetFolderPath: string | null;
  markRead: boolean;
  star: boolean;
  explanation: string;
  confidence: number;
}

export const SMART_MAIL_RULE_RUN_SCOPES = ["inbox", "all"] as const;
export type SmartMailRuleRunScope = typeof SMART_MAIL_RULE_RUN_SCOPES[number];

export interface SmartMailRuleRunResult {
  rule: SmartMailRule;
  scope: SmartMailRuleRunScope;
  scannedMessages: number;
  matchedMessages: number;
  movedMessages: number;
  markedReadMessages: number;
  starredMessages: number;
}

export const MAILBOX_TASK_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type MailboxTaskStatus = typeof MAILBOX_TASK_STATUSES[number];

export interface SmartMailRuleRunTask {
  id: string;
  type: "smart_rule_run";
  status: MailboxTaskStatus;
  archiveId: string;
  scope: SmartMailRuleRunScope;
  ruleIds: string[];
  totalRules: number;
  completedRules: number;
  currentRuleId: string | null;
  currentRuleName: string | null;
  totalMessages: number;
  processedMessages: number;
  matchedMessages: number;
  movedMessages: number;
  markedReadMessages: number;
  starredMessages: number;
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const smartMailRuleConditionsSchema = z.object({
  match: z.enum(["all", "any"]),
  senderContains: z.array(z.string().trim().min(1).max(320)).max(20),
  subjectContains: z.array(z.string().trim().min(1).max(240)).max(20),
  bodyContains: z.array(z.string().trim().min(1).max(240)).max(20),
  hasAttachments: z.boolean().nullable()
}).strict().refine(
  (value) => value.senderContains.length > 0
    || value.subjectContains.length > 0
    || value.bodyContains.length > 0
    || value.hasAttachments !== null,
  "Add at least one rule condition"
);

export const smartMailRuleSuggestionRequestSchema = z.object({
  archiveId: z.string().uuid(),
  instruction: z.string().trim().min(3).max(4_000)
}).strict();

export type SmartMailRuleSuggestionRequest = z.infer<typeof smartMailRuleSuggestionRequestSchema>;

export const smartMailRuleCreateSchema = z.object({
  archiveId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  instruction: z.string().trim().min(3).max(4_000),
  conditions: smartMailRuleConditionsSchema,
  targetFolderId: z.string().uuid().nullable(),
  markRead: z.boolean(),
  star: z.boolean(),
  enabled: z.boolean().default(true),
  applyExisting: z.boolean().default(false)
}).strict().refine(
  (value) => Boolean(value.targetFolderId) || value.markRead || value.star,
  "Choose at least one rule action"
);

export type SmartMailRuleCreate = z.infer<typeof smartMailRuleCreateSchema>;

export const smartMailRulePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  instruction: z.string().trim().min(3).max(4_000).optional(),
  conditions: smartMailRuleConditionsSchema.optional(),
  targetFolderId: z.string().uuid().nullable().optional(),
  markRead: z.boolean().optional(),
  star: z.boolean().optional(),
  enabled: z.boolean().optional(),
  applyExisting: z.boolean().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one rule field is required"
);

export type SmartMailRulePatch = z.infer<typeof smartMailRulePatchSchema>;

export const smartMailRuleRunSchema = z.object({
  scope: z.enum(SMART_MAIL_RULE_RUN_SCOPES).default("inbox")
}).strict();

export type SmartMailRuleRun = z.infer<typeof smartMailRuleRunSchema>;

export const smartMailRuleBatchRunSchema = z.object({
  archiveId: z.string().uuid(),
  ruleIds: z.array(z.string().uuid()).min(1).max(100),
  scope: z.enum(SMART_MAIL_RULE_RUN_SCOPES).default("inbox")
}).strict();

export type SmartMailRuleBatchRun = z.infer<typeof smartMailRuleBatchRunSchema>;

export interface DraftIdentitySettings {
  defaultFromAddress: string;
  senderName: string;
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
  matchField: "from" | "to";
  matchAddress: string;
  senderAddress: string;
  senderName: string | null;
  ruleType: "folder" | "spam";
  sourceScope: "inbox" | "folder" | "all";
  sourceFolderId: string | null;
  sourceFolderPath: string | null;
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

export interface SenderFilingRuleCreateResult {
  statuses: SenderFilingStatus[];
  createdRules: number;
  createdFolders: number;
  movedMessages: number;
}

export interface SenderSpamRuleResult {
  senderAddress: string;
  spamFolderId: string;
  spamFolderPath: string;
  movedMessages: number;
  message: MessageDetail;
}

export interface SenderFolderRuleResult {
  senderAddress: string;
  folderId: string;
  folderPath: string;
  movedMessages: number;
  message: MessageDetail;
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
  canModifyMailbox?: boolean;
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
  sourceMessageId?: string;
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

export type CalendarProvider = "google" | "apple";

export interface CalendarAccount {
  id: string;
  provider: "apple";
  label: string;
  username: string;
  serverUrl: string;
  status: "connected" | "error";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CalendarSource {
  id: string;
  provider: CalendarProvider;
  accountId: string;
  accountLabel: string;
  externalId: string;
  name: string;
  color: string;
  readOnly: boolean;
  primary: boolean;
  selectedByDefault: boolean;
}

export interface CalendarEvent {
  id: string;
  connectionId: string;
  sourceId?: string;
  provider?: CalendarProvider;
  calendarName?: string;
  calendarColor?: string;
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

export type MessageActionSuggestionKind = "calendar_event" | "todo" | "none";

export interface MessageCalendarSuggestion {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
}

export interface MessageTodoSuggestion {
  date: string;
  text: string;
}

export interface MessageActionSuggestion {
  recommendedAction: MessageActionSuggestionKind;
  reason: string;
  confidence: number;
  dateEvidence: string[];
  calendarEvent: MessageCalendarSuggestion | null;
  todo: MessageTodoSuggestion | null;
  provider: AiProviderId;
  model: string;
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

export const appleCalendarAccountCreateSchema = z.object({
  label: z.string().trim().min(1).max(100),
  username: z.string().trim().email().max(320),
  appSpecificPassword: z.string().trim().min(4).max(200),
  serverUrl: z.string().trim().url().default("https://caldav.icloud.com")
}).strict();

export type AppleCalendarAccountCreate = z.infer<typeof appleCalendarAccountCreateSchema>;

export const messageActionSuggestionRequestSchema = z.object({
  now: z.string().datetime({ offset: true }),
  timeZone: z.string().trim().min(1).max(100)
}).strict();

export type MessageActionSuggestionRequest = z.infer<typeof messageActionSuggestionRequestSchema>;

export const messageDraftReplyRequestSchema = z.object({
  gmailConnectionId: z.string().uuid(),
  resumeId: z.string().uuid().nullable().optional(),
  replyStyleId: z.string().uuid().nullable().optional(),
  instructions: z.string().trim().max(2000).nullable().optional()
}).strict();

export type MessageDraftReplyRequest = z.infer<typeof messageDraftReplyRequestSchema>;

export const messageCalendarEventCreateSchema = z.object({
  connectionId: z.string().uuid(),
  event: calendarEventInputSchema
}).strict();

export type MessageCalendarEventCreate = z.infer<typeof messageCalendarEventCreateSchema>;

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

export interface MailboxMoveResult {
  mailbox: Folder;
  movedMailboxes: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SearchFilters {
  archiveId?: string;
  folderId?: string;
  isRead?: boolean;
  starred?: boolean;
  inboxCategory?: InboxCategory;
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

export const USER_SCREEN_IDS = ["calendar", "properties", "compose", "ai", "import", "settings"] as const;
export type UserScreenId = typeof USER_SCREEN_IDS[number];

export const USER_SCREENS: ReadonlyArray<{
  id: UserScreenId;
  label: string;
  description: string;
}> = [
  { id: "calendar", label: "Calendar", description: "Calendar view, events, and to-dos." },
  { id: "properties", label: "Properties", description: "Properties, tenants, leases, service requests, rent, and payments." },
  { id: "compose", label: "Compose & Drafts", description: "Write, save, and send email." },
  { id: "ai", label: "AI tools", description: "AI review queue, analysis, and reply drafts." },
  { id: "import", label: "Import", description: "Import PST and MBOX archives." },
  { id: "settings", label: "Personal settings", description: "Rules, reply styles, inbox tabs, résumés, and calendar accounts." }
];

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  role: AccountRole;
  isActive: boolean;
  mustChangePin: boolean;
  /** Screens a non-admin account may open. null grants every screen; Mail is always available. */
  allowedScreens: UserScreenId[] | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function userCanAccessScreen(
  user: Pick<UserSummary, "role" | "allowedScreens">,
  screen: UserScreenId
): boolean {
  if (user.role === "admin") return true;
  if (user.role === "renter") return screen === "properties";
  return !user.allowedScreens || user.allowedScreens.includes(screen);
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
  canTest?: boolean;
  description: string;
}

export interface DatabaseConnectionTestResult {
  success: boolean;
  provider: DatabaseProvider;
  latencyMs: number;
  serverVersion: string;
  message: string;
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
    postgresMigrationTargetConfigured?: boolean;
    importRuntime?: {
      activeJobs: number;
      queuedJobs: number;
      concurrency: number;
      batchSize: number;
      throttleMs: number;
      latencyThresholdMs: number;
      throttledForApiLatency: boolean;
    };
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
    oauthCallbackUrl?: string | null;
    syncIntervalMinutes: number;
    syncIntervalEnvManaged: boolean;
    syncMailboxActions: boolean;
    syncMailboxActionsEnvManaged: boolean;
  };
  drafts: DraftIdentitySettings & {
    settingsPath: string;
    configurationError: string | null;
  };
  stocks: {
    symbols: string[];
    secondsPerSymbol: number;
    settingsPath: string;
    configurationError: string | null;
  };
  news: {
    enabledSources: NewsSourceId[];
    secondsPerHeadline: number;
    settingsPath: string;
    configurationError: string | null;
  };
  ai: {
    activeProvider: AiProviderId;
    enabled: boolean;
    concurrency: number;
    dailyRequestLimit: number;
    monthlyRequestLimit: number;
    settingsPath: string;
    configurationError: string | null;
    usage: AiUsageSummary;
    providers: Record<AiProviderId, AiProviderSettings>;
  };
}

export interface StockQuote {
  symbol: string;
  name: string | null;
  price: number | null;
  currency: string | null;
  change: number | null;
  changePercent: number | null;
  marketState: string | null;
  quotedAt: string;
  error: string | null;
}

export const NEWS_SOURCE_IDS = ["cnn", "bbc", "aljazeera", "foxnews"] as const;
export type NewsSourceId = typeof NEWS_SOURCE_IDS[number];

export const NEWS_SOURCE_LABELS: Record<NewsSourceId, string> = {
  cnn: "CNN",
  bbc: "BBC News",
  aljazeera: "Al Jazeera",
  foxnews: "Fox News"
};

export interface NewsHeadline {
  id: string;
  sourceId: NewsSourceId;
  sourceName: string;
  title: string;
  link: string;
  publishedAt: string | null;
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

export const PROPERTY_STATUS_IDS = ["setup", "vacant", "occupied", "maintenance"] as const;
export type PropertyStatus = typeof PROPERTY_STATUS_IDS[number];
export const PROPERTY_SERVICE_REQUEST_STATUS_IDS = [
  "submitted",
  "triaged",
  "scheduled",
  "in_progress",
  "waiting",
  "completed",
  "cancelled"
] as const;
export type PropertyServiceRequestStatus = typeof PROPERTY_SERVICE_REQUEST_STATUS_IDS[number];
export const PROPERTY_SERVICE_REQUEST_PRIORITY_IDS = ["low", "normal", "high", "urgent"] as const;
export type PropertyServiceRequestPriority = typeof PROPERTY_SERVICE_REQUEST_PRIORITY_IDS[number];
export const PROPERTY_LEASE_STATUS_IDS = ["draft", "upcoming", "active", "expired", "terminated"] as const;
export type PropertyLeaseStatus = typeof PROPERTY_LEASE_STATUS_IDS[number];
export const RENT_CHARGE_STATUS_IDS = ["open", "partially_paid", "paid", "overdue", "void"] as const;
export type RentChargeStatus = typeof RENT_CHARGE_STATUS_IDS[number];
export const PROPERTY_PAYMENT_PROVIDER_IDS = ["stripe", "paypal", "zelle", "manual"] as const;
export type PropertyPaymentProvider = typeof PROPERTY_PAYMENT_PROVIDER_IDS[number];
export const PROPERTY_PAYMENT_METHOD_IDS = [
  "card",
  "apple_pay",
  "google_pay",
  "ach",
  "paypal",
  "venmo",
  "zelle",
  "cash",
  "check",
  "other"
] as const;
export type PropertyPaymentMethod = typeof PROPERTY_PAYMENT_METHOD_IDS[number];
export const PROPERTY_PAYMENT_STATUS_IDS = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "refunded",
  "cancelled"
] as const;
export type PropertyPaymentStatus = typeof PROPERTY_PAYMENT_STATUS_IDS[number];

export interface ManagedProperty {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  propertyType: "single_family" | "townhouse" | "condo" | "multi_unit" | "other";
  status: PropertyStatus;
  imageUrl: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  monthlyRentCents: number | null;
  tenantName: string | null;
  leaseEndDate: string | null;
  openRequestCount: number;
  outstandingBalanceCents: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyTenant {
  id: string;
  linkedUserId: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string;
  phone: string;
  status: "prospect" | "active" | "former";
  createdAt: string;
  updatedAt: string;
}

export interface PropertyLease {
  id: string;
  propertyId: string;
  unitId: string | null;
  tenantId: string;
  tenantName: string;
  propertyName: string;
  startDate: string;
  endDate: string;
  monthlyRentCents: number;
  securityDepositCents: number;
  dueDay: number;
  status: PropertyLeaseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyServiceRequest {
  id: string;
  propertyId: string;
  tenantId: string | null;
  propertyName: string;
  tenantName: string | null;
  title: string;
  description: string;
  category: string;
  priority: PropertyServiceRequestPriority;
  status: PropertyServiceRequestStatus;
  preferredEntryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyRentCharge {
  id: string;
  propertyId: string;
  leaseId: string | null;
  propertyName: string;
  description: string;
  amountCents: number;
  paidCents: number;
  balanceCents: number;
  dueDate: string;
  status: RentChargeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyPayment {
  id: string;
  propertyId: string;
  leaseId: string | null;
  chargeId: string | null;
  propertyName: string;
  provider: PropertyPaymentProvider;
  method: PropertyPaymentMethod;
  amountCents: number;
  currency: string;
  status: PropertyPaymentStatus;
  externalId: string | null;
  providerTransactionId: string | null;
  checkoutUrl: string | null;
  reference: string | null;
  paidAt: string | null;
  failureReason: string | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyPaymentConfiguration {
  stripe: {
    configured: boolean;
    methods: PropertyPaymentMethod[];
  };
  paypal: {
    configured: boolean;
    environment: "sandbox" | "live";
    methods: PropertyPaymentMethod[];
  };
  zelle: {
    configured: boolean;
    recipient: string | null;
    note: string;
  };
  manual: {
    configured: true;
    methods: PropertyPaymentMethod[];
  };
}

export interface PropertyPortfolioOverview {
  mode: "manager" | "tenant";
  generatedAt: string;
  stats: {
    propertyCount: number;
    occupiedCount: number;
    openRequestCount: number;
    outstandingBalanceCents: number;
    paidThisMonthCents: number;
  };
  properties: ManagedProperty[];
  tenants: PropertyTenant[];
  leases: PropertyLease[];
  serviceRequests: PropertyServiceRequest[];
  rentCharges: PropertyRentCharge[];
  payments: PropertyPayment[];
  paymentConfiguration: PropertyPaymentConfiguration;
}

export const PROPERTY_MEMBERSHIP_ROLE_IDS = ["owner", "manager", "tenant", "maintenance"] as const;
export type PropertyMembershipRole = typeof PROPERTY_MEMBERSHIP_ROLE_IDS[number];
export const PROPERTY_DOCUMENT_VISIBILITY_IDS = ["manager", "tenant"] as const;
export type PropertyDocumentVisibility = typeof PROPERTY_DOCUMENT_VISIBILITY_IDS[number];
export const PROPERTY_NOTIFICATION_CHANNEL_IDS = ["in_app", "email", "sms"] as const;
export type PropertyNotificationChannel = typeof PROPERTY_NOTIFICATION_CHANNEL_IDS[number];
export const PROPERTY_AUTOMATION_JOB_STATUS_IDS = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type PropertyAutomationJobStatus = typeof PROPERTY_AUTOMATION_JOB_STATUS_IDS[number];

export interface PropertyOrganization {
  id: string;
  name: string;
  ownerUserId: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyOrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  displayName: string;
  role: PropertyMembershipRole;
  createdAt: string;
}

export interface PropertyUnit {
  id: string;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  name: string;
  bedrooms: number | null;
  bathrooms: number | null;
  monthlyRentCents: number | null;
  status: "available" | "occupied" | "maintenance" | "inactive";
  createdAt: string;
  updatedAt: string;
}

export interface PropertyTenantInvitation {
  id: string;
  organizationId: string;
  tenantId: string;
  tenantName: string;
  email: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  invitationUrl: string | null;
}

export interface PropertyInvitationPreview {
  token: string;
  tenantName: string;
  email: string;
  organizationName: string;
  expiresAt: string;
}

export interface PropertyDocumentVersion {
  id: string;
  documentId: string;
  version: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface PropertyDocument {
  id: string;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  leaseId: string | null;
  tenantId: string | null;
  title: string;
  category: string;
  visibility: PropertyDocumentVisibility;
  requiresAcknowledgement: boolean;
  acknowledgedAt: string | null;
  latestVersion: PropertyDocumentVersion;
  createdAt: string;
  updatedAt: string;
}

export interface PropertyRequestComment {
  id: string;
  requestId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  tenantVisible: boolean;
  createdAt: string;
}

export interface PropertyRequestStatusEvent {
  id: string;
  requestId: string;
  fromStatus: PropertyServiceRequestStatus | null;
  toStatus: PropertyServiceRequestStatus;
  actorUserId: string;
  createdAt: string;
}

export interface PropertyRequestAttachment {
  id: string;
  requestId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface PropertyRentSchedule {
  id: string;
  organizationId: string;
  propertyId: string;
  propertyName: string;
  leaseId: string;
  amountCents: number;
  dueDay: number;
  descriptionTemplate: string;
  nextChargeDate: string;
  reminderDays: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PropertyLedgerEntryType = "charge" | "payment" | "adjustment" | "refund" | "deposit";
export interface PropertyLedgerEntry {
  id: string;
  organizationId: string;
  propertyId: string;
  leaseId: string | null;
  chargeId: string | null;
  paymentId: string | null;
  entryType: PropertyLedgerEntryType;
  amountCents: number;
  description: string;
  effectiveAt: string;
  createdAt: string;
}

export interface PropertyReceipt {
  id: string;
  paymentId: string;
  receiptNumber: string;
  amountCents: number;
  currency: string;
  paidAt: string;
  createdAt: string;
}

export interface PropertyNotificationJob {
  id: string;
  organizationId: string;
  tenantId: string | null;
  chargeId: string | null;
  channel: PropertyNotificationChannel;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  status: PropertyAutomationJobStatus;
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface PropertyDeliveryAttempt {
  id: string;
  jobId: string;
  provider: string;
  providerId: string | null;
  status: "succeeded" | "failed" | "suppressed";
  error: string | null;
  createdAt: string;
}

export interface PropertyCommunicationConsent {
  id: string;
  tenantId: string;
  channel: "email" | "sms";
  destination: string;
  status: "opted_in" | "opted_out";
  source: string;
  consentedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
}

export interface PropertyIntegrationSettings {
  stripeConfigured: boolean;
  stripeSource: "admin" | "environment" | "none";
  stripeWebhookConfigured: boolean;
  paypalConfigured: boolean;
  paypalSource: "admin" | "environment" | "none";
  paypalEnvironment: "sandbox" | "live";
  paypalWebhookConfigured: boolean;
  zelleRecipient: string | null;
  twilioConfigured: boolean;
  twilioSource: "admin" | "environment" | "none";
  gmailConnectionId: string | null;
}

export interface PropertyOperationsReport {
  generatedAt: string;
  totalChargesCents: number;
  totalPaymentsCents: number;
  totalAdjustmentsCents: number;
  outstandingCents: number;
  overdueCharges: number;
  openRequests: number;
  expiringLeases: number;
  queuedNotifications: number;
}

export interface PropertyPlatformOverview {
  organizations: PropertyOrganization[];
  memberships: PropertyOrganizationMember[];
  units: PropertyUnit[];
  invitations: PropertyTenantInvitation[];
  documents: PropertyDocument[];
  requestComments: PropertyRequestComment[];
  requestStatusHistory: PropertyRequestStatusEvent[];
  requestAttachments: PropertyRequestAttachment[];
  rentSchedules: PropertyRentSchedule[];
  ledgerEntries: PropertyLedgerEntry[];
  receipts: PropertyReceipt[];
  notificationJobs: PropertyNotificationJob[];
  deliveryAttempts: PropertyDeliveryAttempt[];
  consents: PropertyCommunicationConsent[];
  integrations: PropertyIntegrationSettings;
  report: PropertyOperationsReport;
}

export interface PropertyAutomationRunResult {
  startedAt: string;
  completedAt: string;
  chargesCreated: number;
  providerEventsProcessed: number;
  notificationsCompleted: number;
  notificationsFailed: number;
  alreadyRunning: boolean;
}

export interface PropertyBackupSummary {
  id: string;
  createdAt: string;
  sizeBytes: number;
  databaseBytes: number;
  fileCount: number;
}

const propertyDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const propertyMoneySchema = z.number().int().min(0).max(100_000_000);

export const managedPropertyCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  addressLine1: z.string().trim().min(1).max(240),
  addressLine2: z.string().trim().max(120).default(""),
  city: z.string().trim().min(1).max(120),
  state: z.string().trim().min(2).max(64),
  postalCode: z.string().trim().min(3).max(20),
  propertyType: z.enum(["single_family", "townhouse", "condo", "multi_unit", "other"]).default("single_family"),
  status: z.enum(PROPERTY_STATUS_IDS).default("setup"),
  bedrooms: z.number().min(0).max(100).nullable().default(null),
  bathrooms: z.number().min(0).max(100).nullable().default(null),
  monthlyRentCents: propertyMoneySchema.nullable().default(null),
  notes: z.string().max(20_000).default("")
}).strict();
export type ManagedPropertyCreate = z.infer<typeof managedPropertyCreateSchema>;

export const managedPropertyPatchSchema = managedPropertyCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one property field is required"
);
export type ManagedPropertyPatch = z.infer<typeof managedPropertyPatchSchema>;

export const propertyTenantCreateSchema = z.object({
  linkedUserId: z.string().uuid().nullable().default(null),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().max(40).default(""),
  status: z.enum(["prospect", "active", "former"]).default("active")
}).strict();
export type PropertyTenantCreate = z.infer<typeof propertyTenantCreateSchema>;

export const propertyLeaseCreateSchema = z.object({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid().nullable().optional(),
  tenantId: z.string().uuid(),
  startDate: propertyDateSchema,
  endDate: propertyDateSchema,
  monthlyRentCents: propertyMoneySchema.min(1),
  securityDepositCents: propertyMoneySchema.default(0),
  dueDay: z.number().int().min(1).max(28).default(1),
  status: z.enum(PROPERTY_LEASE_STATUS_IDS).default("active")
}).strict().refine((value) => value.endDate >= value.startDate, {
  message: "Lease end date must be on or after its start date",
  path: ["endDate"]
});
export type PropertyLeaseCreate = z.infer<typeof propertyLeaseCreateSchema>;

export const propertyServiceRequestCreateSchema = z.object({
  propertyId: z.string().uuid(),
  tenantId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().min(1).max(20_000),
  category: z.string().trim().min(1).max(80).default("General"),
  priority: z.enum(PROPERTY_SERVICE_REQUEST_PRIORITY_IDS).default("normal"),
  preferredEntryAt: z.string().datetime().nullable().default(null)
}).strict();
export type PropertyServiceRequestCreate = z.infer<typeof propertyServiceRequestCreateSchema>;

export const propertyServiceRequestPatchSchema = z.object({
  priority: z.enum(PROPERTY_SERVICE_REQUEST_PRIORITY_IDS).optional(),
  status: z.enum(PROPERTY_SERVICE_REQUEST_STATUS_IDS).optional(),
  preferredEntryAt: z.string().datetime().nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, "At least one request field is required");
export type PropertyServiceRequestPatch = z.infer<typeof propertyServiceRequestPatchSchema>;

export const propertyRentChargeCreateSchema = z.object({
  propertyId: z.string().uuid(),
  leaseId: z.string().uuid().nullable().default(null),
  description: z.string().trim().min(1).max(240),
  amountCents: propertyMoneySchema.min(1),
  dueDate: propertyDateSchema
}).strict();
export type PropertyRentChargeCreate = z.infer<typeof propertyRentChargeCreateSchema>;

export const propertyPaymentCreateSchema = z.object({
  propertyId: z.string().uuid(),
  leaseId: z.string().uuid().nullable().default(null),
  chargeId: z.string().uuid().nullable().default(null),
  provider: z.enum(PROPERTY_PAYMENT_PROVIDER_IDS),
  method: z.enum(PROPERTY_PAYMENT_METHOD_IDS),
  amountCents: propertyMoneySchema.min(1),
  currency: z.string().trim().length(3).default("USD"),
  status: z.enum(PROPERTY_PAYMENT_STATUS_IDS).default("pending"),
  reference: z.string().trim().max(240).nullable().default(null),
  paidAt: z.string().datetime().nullable().default(null),
  notes: z.string().max(5_000).default("")
}).strict();
export type PropertyPaymentCreate = z.infer<typeof propertyPaymentCreateSchema>;

export const propertyPaymentPatchSchema = z.object({
  status: z.enum(PROPERTY_PAYMENT_STATUS_IDS),
  reference: z.string().trim().max(240).nullable().optional(),
  paidAt: z.string().datetime().nullable().optional(),
  failureReason: z.string().trim().max(1_000).nullable().optional(),
  notes: z.string().max(5_000).optional()
}).strict();
export type PropertyPaymentPatch = z.infer<typeof propertyPaymentPatchSchema>;

export interface PropertyPaymentCheckoutResult {
  payment: PropertyPayment;
  action: "redirect" | "instructions";
  url: string | null;
  instructions: string | null;
}

export interface PropertyRefundResult {
  payment: PropertyPayment;
  amountCents: number;
  providerRefundId: string | null;
}

export const propertyOrganizationCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: z.string().trim().min(1).max(120).default("America/New_York")
}).strict();
export type PropertyOrganizationCreate = z.infer<typeof propertyOrganizationCreateSchema>;

export const propertyUnitCreateSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  bedrooms: z.number().min(0).max(100).nullable().default(null),
  bathrooms: z.number().min(0).max(100).nullable().default(null),
  monthlyRentCents: propertyMoneySchema.nullable().default(null),
  status: z.enum(["available", "occupied", "maintenance", "inactive"]).default("available")
}).strict();
export type PropertyUnitCreate = z.infer<typeof propertyUnitCreateSchema>;

export const propertyTenantInvitationCreateSchema = z.object({
  tenantId: z.string().uuid(),
  expiresHours: z.number().int().min(1).max(168).default(48)
}).strict();
export type PropertyTenantInvitationCreate = z.infer<typeof propertyTenantInvitationCreateSchema>;

const tenantPasswordSchema = z.string().min(12).max(128)
  .regex(/[a-z]/, "Password needs a lowercase letter")
  .regex(/[A-Z]/, "Password needs an uppercase letter")
  .regex(/[0-9]/, "Password needs a number")
  .regex(/[^A-Za-z0-9]/, "Password needs a symbol");

export const propertyTenantInvitationAcceptSchema = z.object({
  token: z.string().min(32).max(256),
  username: z.string().trim().toLowerCase().min(3).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/),
  password: tenantPasswordSchema
}).strict();
export type PropertyTenantInvitationAccept = z.infer<typeof propertyTenantInvitationAcceptSchema>;

export const propertyDocumentMetadataSchema = z.object({
  propertyId: z.string().uuid(),
  leaseId: z.string().uuid().nullable().default(null),
  tenantId: z.string().uuid().nullable().default(null),
  title: z.string().trim().min(1).max(240),
  category: z.string().trim().min(1).max(80).default("Agreement"),
  visibility: z.enum(PROPERTY_DOCUMENT_VISIBILITY_IDS).default("tenant"),
  requiresAcknowledgement: z.boolean().default(false)
}).strict();
export type PropertyDocumentMetadata = z.infer<typeof propertyDocumentMetadataSchema>;

export const propertyRequestCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
  tenantVisible: z.boolean().default(true)
}).strict();
export type PropertyRequestCommentCreate = z.infer<typeof propertyRequestCommentCreateSchema>;

export const propertyRequestAssignmentSchema = z.object({
  assigneeUserId: z.string().uuid().nullable(),
  targetDate: propertyDateSchema.nullable().default(null)
}).strict();
export type PropertyRequestAssignment = z.infer<typeof propertyRequestAssignmentSchema>;

export const propertyRentScheduleCreateSchema = z.object({
  propertyId: z.string().uuid(),
  leaseId: z.string().uuid(),
  amountCents: propertyMoneySchema.min(1),
  dueDay: z.number().int().min(1).max(28),
  descriptionTemplate: z.string().trim().min(1).max(240).default("{{month}} rent"),
  nextChargeDate: propertyDateSchema,
  reminderDays: z.array(z.number().int().min(-30).max(30)).max(12).default([-7, -3, 0, 3]),
  enabled: z.boolean().default(true)
}).strict();
export type PropertyRentScheduleCreate = z.infer<typeof propertyRentScheduleCreateSchema>;

export const propertyLedgerAdjustmentSchema = z.object({
  propertyId: z.string().uuid(),
  leaseId: z.string().uuid().nullable().default(null),
  chargeId: z.string().uuid().nullable().default(null),
  amountCents: z.number().int().min(-100_000_000).max(100_000_000).refine((value) => value !== 0),
  description: z.string().trim().min(1).max(500),
  effectiveAt: z.string().datetime().default(() => new Date().toISOString())
}).strict();
export type PropertyLedgerAdjustment = z.infer<typeof propertyLedgerAdjustmentSchema>;

export const propertyConsentPatchSchema = z.object({
  tenantId: z.string().uuid(),
  channel: z.enum(["email", "sms"]),
  destination: z.string().trim().min(3).max(320),
  status: z.enum(["opted_in", "opted_out"]),
  source: z.string().trim().min(1).max(240)
}).strict();
export type PropertyConsentPatch = z.infer<typeof propertyConsentPatchSchema>;

export const propertyIntegrationSettingsPatchSchema = z.object({
  stripeSecretKey: z.string().trim().min(1).max(1_000).optional(),
  stripeWebhookSecret: z.string().trim().min(1).max(1_000).optional(),
  clearStripeSecretKey: z.boolean().default(false),
  clearStripeWebhookSecret: z.boolean().default(false),
  paypalClientId: z.string().trim().min(1).max(1_000).optional(),
  paypalClientSecret: z.string().trim().min(1).max(1_000).optional(),
  paypalWebhookId: z.string().trim().min(1).max(240).optional(),
  paypalEnvironment: z.enum(["sandbox", "live"]).optional(),
  clearPaypalClientSecret: z.boolean().default(false),
  zelleRecipient: z.string().trim().max(320).nullable().optional(),
  zelleNote: z.string().max(1_000).optional(),
  twilioAccountSid: z.string().trim().min(1).max(240).optional(),
  twilioAuthToken: z.string().trim().min(1).max(1_000).optional(),
  twilioMessagingServiceSid: z.string().trim().min(1).max(240).optional(),
  clearTwilioAuthToken: z.boolean().default(false),
  gmailConnectionId: z.string().uuid().nullable().optional()
}).strict();
export type PropertyIntegrationSettingsPatch = z.infer<typeof propertyIntegrationSettingsPatchSchema>;

export const propertyRefundSchema = z.object({
  amountCents: propertyMoneySchema.min(1).optional(),
  reason: z.string().trim().min(1).max(500)
}).strict();
export type PropertyRefundRequest = z.infer<typeof propertyRefundSchema>;

export const localMessageStatePatchSchema = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(48)).max(20).optional(),
  note: z.string().max(20_000).optional()
}).strict();

export type LocalMessageStatePatch = z.infer<typeof localMessageStatePatchSchema>;

export const bulkMessageReadSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(500)
    .transform((messageIds) => [...new Set(messageIds)])
}).strict();

export type BulkMessageReadRequest = z.infer<typeof bulkMessageReadSchema>;

export interface BulkMessageReadResult {
  updated: number;
  alreadyRead: number;
  failed: number;
}

export const messageMoveSchema = z.object({
  folderId: z.string().uuid()
}).strict();

export type MessageMove = z.infer<typeof messageMoveSchema>;

export const BULK_MOVE_DESTINATIONS = ["trash", "archived", "spam"] as const;
export type BulkMoveDestination = typeof BULK_MOVE_DESTINATIONS[number];

export const bulkMoveMessagesSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(500),
  destination: z.enum(BULK_MOVE_DESTINATIONS)
}).strict();

export type BulkMoveMessagesRequest = z.infer<typeof bulkMoveMessagesSchema>;

export interface BulkMoveResult {
  destination: BulkMoveDestination;
  folderPaths: string[];
  moved: number;
  alreadyThere: number;
  failed: number;
  senderRules: number;
}

export const bulkFolderMoveSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(500),
  folderId: z.string().uuid()
}).strict();

export type BulkFolderMoveRequest = z.infer<typeof bulkFolderMoveSchema>;

export interface BulkFolderMoveResult {
  folderId: string;
  folderPath: string;
  moved: number;
  alreadyThere: number;
  failed: number;
}

export const bulkFilingSuggestionRequestSchema = z.object({
  messageIds: z.array(z.string().uuid()).min(1).max(500)
    .transform((messageIds) => [...new Set(messageIds)])
}).strict();

export type BulkFilingSuggestionRequest = z.infer<typeof bulkFilingSuggestionRequestSchema>;

export interface MessageFilingSuggestion {
  folderId: string | null;
  folderPath: string | null;
  reason: string;
  confidence: number;
  messageCount: number;
  provider: AiProviderId;
  model: string;
}

export const senderFilingArchiveSchema = z.object({
  archiveId: z.string().uuid()
}).strict();

export type SenderFilingArchive = z.infer<typeof senderFilingArchiveSchema>;

export const senderFilingRuleCreateSchema = z.object({
  archiveId: z.string().uuid(),
  archiveScope: z.enum(["archive", "all"]).default("archive"),
  matchField: z.enum(["from", "to"]),
  matchAddress: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  sourceScope: z.enum(["inbox", "folder", "all"]),
  sourceFolderId: z.string().uuid().nullable().optional(),
  destinationFolderId: z.string().uuid().nullable().optional(),
  destinationFolderName: z.string().trim().min(1).max(120).refine(
    (name) => !/[\/\\\u0000-\u001f\u007f]/.test(name),
    "Name cannot contain slashes or control characters"
  ).optional(),
  applyExisting: z.boolean().default(true)
}).strict().superRefine((value, context) => {
  if (value.sourceScope === "folder" && !value.sourceFolderId) {
    context.addIssue({ code: "custom", path: ["sourceFolderId"], message: "Choose the folder to apply this rule to" });
  }
  if (value.archiveScope === "all" && value.sourceScope === "folder") {
    context.addIssue({ code: "custom", path: ["sourceScope"], message: "A specific source folder can only be used with one archive" });
  }
  const destinations = Number(Boolean(value.destinationFolderId)) + Number(Boolean(value.destinationFolderName));
  if (destinations !== 1) {
    context.addIssue({ code: "custom", path: ["destinationFolderId"], message: "Choose an existing destination or enter a new folder name" });
  }
  if (value.archiveScope === "all" && value.destinationFolderId) {
    context.addIssue({ code: "custom", path: ["destinationFolderId"], message: "Use a new folder name when applying a rule to all archives" });
  }
});

export type SenderFilingRuleCreate = z.infer<typeof senderFilingRuleCreateSchema>;

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

export const mailboxMoveSchema = z.object({
  targetParentId: z.string().uuid().nullable()
}).strict();

export type MailboxMove = z.infer<typeof mailboxMoveSchema>;

export const gmailAuthRequestSchema = z.object({
  connectionId: z.string().uuid().nullable().optional(),
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
  fromAddress: gmailRecipientSchema.optional(),
  sourceMessageId: z.string().uuid().optional()
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

export const draftSettingsPatchSchema = z.object({
  defaultFromAddress: gmailRecipientSchema,
  senderName: z.string().trim().min(1).max(120)
}).strict();

export type DraftSettingsPatch = z.infer<typeof draftSettingsPatchSchema>;

const stockSymbolSchema = z.string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9.^=_-]+$/, "Use a valid ticker symbol");

export const stockSettingsPatchSchema = z.object({
  symbols: z.array(stockSymbolSchema).max(20).transform((symbols) => [...new Set(symbols)]),
  secondsPerSymbol: z.number().int().min(2).max(60).default(8)
}).strict();

export type StockSettingsPatch = z.infer<typeof stockSettingsPatchSchema>;

const inboxTabDefinitionSchema = z.object({
  id: z.enum(INBOX_CATEGORIES),
  label: z.string().trim().min(1).max(40),
  description: z.string().trim().max(240),
  enabled: z.boolean(),
  position: z.number().int().min(0).max(INBOX_CATEGORIES.length - 1),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex color"),
  keywords: z.array(z.string().trim().min(1).max(80)).max(40)
    .transform((values) => [...new Set(values.map((value) => value.toLowerCase()))]),
  senderDomains: z.array(z.string().trim().toLowerCase().min(1).max(253)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, "Use a domain such as example.com"))
    .max(40)
    .transform((values) => [...new Set(values)]),
  keywordOnly: z.boolean().default(false)
}).strict();

export const inboxTabSettingsUpdateSchema = z.object({
  tabs: z.array(inboxTabDefinitionSchema).length(INBOX_CATEGORIES.length),
  aiEnabled: z.boolean(),
  aiConfidenceThreshold: z.number().min(0).max(1)
}).strict().superRefine((value, context) => {
  const ids = new Set(value.tabs.map((tab) => tab.id));
  const positions = new Set(value.tabs.map((tab) => tab.position));
  if (ids.size !== INBOX_CATEGORIES.length || INBOX_CATEGORIES.some((id) => !ids.has(id))) {
    context.addIssue({ code: "custom", path: ["tabs"], message: "Configure every built-in Inbox tab exactly once" });
  }
  if (positions.size !== INBOX_CATEGORIES.length) {
    context.addIssue({ code: "custom", path: ["tabs"], message: "Each Inbox tab needs a unique position" });
  }
  if (!value.tabs.find((tab) => tab.id === "primary")?.enabled) {
    context.addIssue({ code: "custom", path: ["tabs"], message: "Primary must remain enabled" });
  }
});

export type InboxTabSettingsUpdate = z.infer<typeof inboxTabSettingsUpdateSchema>;

export const newsSettingsPatchSchema = z.object({
  enabledSources: z.array(z.enum(NEWS_SOURCE_IDS)).max(NEWS_SOURCE_IDS.length).transform((sources) => [...new Set(sources)]),
  secondsPerHeadline: z.number().int().min(2).max(60).default(8)
}).strict();

export type NewsSettingsPatch = z.infer<typeof newsSettingsPatchSchema>;

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
const loginSecretSchema = z.string().min(4).max(128);

export const authLoginSchema = z.object({
  username: usernameSchema,
  pin: loginSecretSchema,
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

const allowedScreensSchema = z.array(z.enum(USER_SCREEN_IDS))
  .max(USER_SCREEN_IDS.length)
  .transform((screens) => [...new Set(screens)]);

export const userCreateSchema = z.object({
  username: usernameSchema,
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["admin", "user", "renter"]),
  pin: pinSchema,
  allowedScreens: allowedScreensSchema.nullable().optional()
}).strict();

export type UserCreate = z.infer<typeof userCreateSchema>;

export const userUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(["admin", "user", "renter"]).optional(),
  isActive: z.boolean().optional(),
  pin: pinSchema.optional(),
  allowedScreens: allowedScreensSchema.nullable().optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one user setting is required"
);

export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const databaseSettingsPatchSchema = z.object({
  provider: z.enum(["postgresql", "mssql"]),
  connectionString: z.string().trim().min(1).max(2_000)
}).strict();

export type DatabaseSettingsPatch = z.infer<typeof databaseSettingsPatchSchema>;

export const gmailSettingsPatchSchema = z.object({
  clientId: z.string().trim().min(1).max(1_000),
  clientSecret: z.string().trim().min(1).max(1_000).optional(),
  clearClientSecret: z.boolean().default(false),
  syncIntervalMinutes: z.number().int().min(0).max(1_440).optional(),
  syncMailboxActions: z.boolean().optional()
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
  concurrency: z.number().int().min(1).max(8).optional(),
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

export const messageFilingSuggestionOutputSchema = z.object({
  targetFolderPath: z.string().trim().min(1).max(500).nullable(),
  reason: z.string().trim().min(1).max(800),
  confidence: z.number().min(0).max(1)
}).strict();

export type MessageFilingSuggestionOutput = z.infer<typeof messageFilingSuggestionOutputSchema>;

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

const suggestedDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const suggestedTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable();

export const messageActionSuggestionOutputSchema = z.object({
  recommendedAction: z.enum(["calendar_event", "todo", "none"]),
  reason: z.string().trim().min(1).max(800),
  confidence: z.number().min(0).max(1),
  dateEvidence: z.array(z.string().trim().min(1).max(240)).max(10),
  calendarEvent: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(10_000),
    location: z.string().max(500),
    allDay: z.boolean(),
    startDate: suggestedDateSchema,
    endDate: suggestedDateSchema,
    startTime: suggestedTimeSchema,
    endTime: suggestedTimeSchema
  }).strict().nullable(),
  todo: z.object({
    date: suggestedDateSchema,
    text: z.string().trim().min(1).max(2_000)
  }).strict().nullable()
}).strict().superRefine((value, context) => {
  if (value.recommendedAction === "calendar_event" && !value.calendarEvent) {
    context.addIssue({ code: "custom", path: ["calendarEvent"], message: "Calendar recommendation requires event details" });
  }
  if (value.recommendedAction === "todo" && !value.todo) {
    context.addIssue({ code: "custom", path: ["todo"], message: "To-do recommendation requires to-do details" });
  }
  if (value.calendarEvent && !value.calendarEvent.allDay
    && (!value.calendarEvent.startTime || !value.calendarEvent.endTime)) {
    context.addIssue({ code: "custom", path: ["calendarEvent"], message: "Timed events require start and end times" });
  }
});

export type MessageActionSuggestionOutput = z.infer<typeof messageActionSuggestionOutputSchema>;

export const smartMailRuleSuggestionOutputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  match: z.enum(["all", "any"]),
  senderContains: z.array(z.string().trim().min(1).max(320)).max(20),
  subjectContains: z.array(z.string().trim().min(1).max(240)).max(20),
  bodyContains: z.array(z.string().trim().min(1).max(240)).max(20),
  hasAttachments: z.boolean().nullable(),
  targetFolderPath: z.string().trim().max(500).nullable(),
  markRead: z.boolean(),
  star: z.boolean(),
  explanation: z.string().trim().min(1).max(1_000),
  confidence: z.number().min(0).max(1)
}).strict().refine(
  (value) => value.senderContains.length > 0
    || value.subjectContains.length > 0
    || value.bodyContains.length > 0
    || value.hasAttachments !== null,
  "A suggested rule needs at least one condition"
).refine(
  (value) => Boolean(value.targetFolderPath) || value.markRead || value.star,
  "A suggested rule needs at least one action"
);

export type SmartMailRuleSuggestionOutput = z.infer<typeof smartMailRuleSuggestionOutputSchema>;

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
