import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, extname, resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  AI_PROVIDER_IDS,
  INBOX_CATEGORIES,
  aiActiveProviderSchema,
  aiScheduleCreateSchema,
  aiScheduleUpdateSchema,
  aiSettingsPatchSchema,
  appleCalendarAccountCreateSchema,
  archiveMergeSchema,
  authLoginSchema,
  bulkMessageReadSchema,
  bulkMoveMessagesSchema,
  bulkFilingSuggestionRequestSchema,
  bulkFolderMoveSchema,
  calendarEventInputSchema,
  clientDiagnosticSchema,
  databaseSettingsPatchSchema,
  displayNamePatchSchema,
  draftSettingsPatchSchema,
  emailDraftCreateSchema,
  emailDraftUpdateSchema,
  gmailAuthRequestSchema,
  gmailSettingsPatchSchema,
  gmailSendRequestSchema,
  gmailSyncRequestSchema,
  importOptionsSchema,
  inboxTabSettingsUpdateSchema,
  localMessageStatePatchSchema,
  mailboxCreateSchema,
  mailboxMergeSchema,
  mailboxMoveSchema,
  messageActionSuggestionRequestSchema,
  messageCalendarEventCreateSchema,
  messageDraftReplyRequestSchema,
  messageFollowUpCreateSchema,
  messageFollowUpPatchSchema,
  messageMoveSchema,
  newsSettingsPatchSchema,
  pinChangeSchema,
  senderFilingArchiveSchema,
  replyStyleCreateSchema,
  replyStylePatchSchema,
  smartMailRuleCreateSchema,
  smartMailRuleBatchRunSchema,
  smartMailRulePatchSchema,
  smartMailRuleRunSchema,
  smartMailRuleSuggestionRequestSchema,
  stockSettingsPatchSchema,
  todoCreateSchema,
  todoPatchSchema,
  uploadSessionCreateSchema,
  userCreateSchema,
  userUpdateSchema,
  type AdminSettings,
  type AiJob,
  type AiProviderId,
  type BulkMoveDestination,
  type BulkMessageReadResult,
  type BulkFolderMoveResult,
  type BulkMoveResult,
  type DiagnosticCategory,
  type DiagnosticLevel,
  type ImportOptions,
  type InboxCategory,
  type SessionRole,
  type SharingState
} from "@email-client/shared";
import type { ApiConfig } from "./config.js";
import { loadConfig } from "./config.js";
import { BlobStore } from "./storage/blob-store.js";
import type { AuthSessionRecord, EmailStore } from "./storage/database.js";
import {
  DATABASE_PROVIDERS,
  StorageSettingsManager,
  UnsupportedDatabaseProviderError,
  createEmailStore,
  type CreatedEmailStore
} from "./storage/store-factory.js";
import { ImportService } from "./services/import-service.js";
import {
  AuthConflictError,
  AuthError,
  AuthRateLimitError,
  AuthService
} from "./services/auth-service.js";
import { DraftSettingsManager } from "./services/draft-settings.js";
import {
  GmailAuthorizationError,
  GmailConfigurationError,
  GmailPermissionError,
  GmailService
} from "./services/gmail-service.js";
import { CalendarService } from "./services/calendar-service.js";
import {
  DraftNotFoundError,
  DraftService,
  DraftValidationError
} from "./services/draft-service.js";
import {
  GmailSettingsManagedError,
  GmailSettingsManager
} from "./services/gmail-settings.js";
import {
  AiConfigurationError,
  AiBudgetError,
  AiDraftSkippedError,
  AiDraftTargetError,
  AiJobNotFoundError,
  AiMessageNotFoundError,
  AiService
} from "./services/ai-service.js";
import { AiScheduleService } from "./services/ai-schedule-service.js";
import {
  ResumeNotFoundError,
  ResumeService,
  ResumeValidationError
} from "./services/resume-service.js";
import {
  AI_PROVIDER_INFO,
  AiSettingsManager
} from "./services/ai-settings.js";
import {
  UploadConflictError,
  UploadService,
  UploadValidationError
} from "./services/upload-service.js";
import { NewsService } from "./services/news-service.js";
import { StockService } from "./services/stock-service.js";
import { MailboxTaskService } from "./services/mailbox-task-service.js";

type Role = "viewer" | "local" | "admin";

// The API and its served UI are same-origin in every real launch mode (npm start,
// production Electron, LAN-shared pages), so browsers never send an Origin header for
// them. The one legitimate cross-origin caller is the Electron renderer in `npm run
// dev:desktop`, which loads the Vite dev server (127.0.0.1:5173) while talking to this
// API directly. Reflecting every Origin (the previous behavior) would let any website
// open in the same browser call /api/auth/login and steal the bearer token, which is
// especially dangerous while the first-run admin/2332 PIN is still active.
const ALLOWED_CORS_ORIGINS = ["http://127.0.0.1:5173", "http://localhost:5173"];

const BULK_DESTINATION_MATCH_NAMES: Record<BulkMoveDestination, string[]> = {
  trash: ["trash", "deleted items", "deleted"],
  archived: ["archive", "archived"],
  spam: ["spam", "junk"]
};

const BULK_DESTINATION_CREATE_NAME: Record<BulkMoveDestination, string> = {
  trash: "Trash",
  archived: "Archived",
  spam: "Spam"
};

export interface StartedApi {
  runtime: EmailApiRuntime;
  url: string;
  port: number;
}

export class EmailApiRuntime {
  readonly config: ApiConfig;
  readonly app: FastifyInstance;
  readonly database: EmailStore;
  readonly auth: AuthService;
  readonly storageSettings: StorageSettingsManager;
  readonly activeStorage: CreatedEmailStore;
  readonly blobStore: BlobStore;
  readonly imports: ImportService;
  readonly gmail: GmailService;
  readonly gmailSettings: GmailSettingsManager;
  readonly calendar: CalendarService;
  readonly resumes: ResumeService;
  readonly draftSettings: DraftSettingsManager;
  readonly drafts: DraftService;
  readonly ai: AiService;
  readonly aiSettings: AiSettingsManager;
  readonly aiSchedules: AiScheduleService;
  readonly mailboxTasks: MailboxTaskService;
  readonly stocks: StockService;
  readonly news: NewsService;
  readonly uploads: UploadService;
  readonly adminToken = randomToken();
  readonly localToken = randomToken();
  private shareToken: string | null = null;
  private shareExpiresAt: Date | null = null;
  private listeningPort: number;
  private readonly requestSessions = new WeakMap<FastifyRequest, AuthSessionRecord | null>();

  constructor(config: ApiConfig) {
    this.config = config;
    this.listeningPort = config.port;
    this.app = Fastify({
      logger: config.logger,
      bodyLimit: 5 * 1024 * 1024,
      trustProxy: config.trustProxy,
      routerOptions: { maxParamLength: 2 * 1024 }
    });
    this.storageSettings = new StorageSettingsManager(config.dataDir);
    this.activeStorage = createEmailStore(config.dataDir, this.storageSettings.current());
    this.database = this.activeStorage.store;
    this.auth = new AuthService(this.database, config.sessionLifetimeMinutes);
    this.blobStore = new BlobStore(config.dataDir);
    this.imports = new ImportService(this.database, this.blobStore);
    this.gmailSettings = new GmailSettingsManager(config.dataDir, {
      clientId: config.gmailClientId,
      clientSecret: config.gmailClientSecret,
      syncIntervalMinutes: config.gmailSyncIntervalMinutes,
      syncMailboxActions: config.gmailSyncMailboxActions
    });
    const gmailCredentials = this.gmailSettings.credentials();
    this.gmail = new GmailService(this.database, this.imports, {
      clientId: gmailCredentials.clientId,
      clientSecret: gmailCredentials.clientSecret,
      redirectUri: () => this.config.publicUrl
        ? `${this.config.publicUrl}/api/gmail/oauth/callback`
        : `http://127.0.0.1:${this.listeningPort}/api/gmail/oauth/callback`,
      syncIntervalMinutes: this.gmailSettings.syncIntervalMinutes(),
      syncMailboxActions: this.gmailSettings.syncMailboxActions()
    });
    this.calendar = new CalendarService(this.gmail, this.database);
    this.resumes = new ResumeService(this.database, this.blobStore);
    this.draftSettings = new DraftSettingsManager(config.dataDir);
    this.drafts = new DraftService(this.database, this.gmail, this.resumes, this.draftSettings);
    this.aiSettings = new AiSettingsManager(config.dataDir, {
      openai: config.openAiApiKey,
      deepseek: config.deepSeekApiKey
    });
    this.ai = new AiService(this.database, this.aiSettings, undefined, undefined, this.draftSettings);
    this.aiSchedules = new AiScheduleService(this.database, this.ai);
    this.mailboxTasks = new MailboxTaskService(this.database);
    this.stocks = new StockService(config.dataDir);
    this.news = new NewsService(config.dataDir);
    this.uploads = new UploadService(config.dataDir, this.database, this.imports);
  }

  async initialize(): Promise<void> {
    this.auth.initialize();
    const gmailConfigurationError = this.gmailSettings.view().configurationError;
    if (gmailConfigurationError) {
      this.database.recordDiagnostic({
        level: "error",
        category: "gmail",
        message: gmailConfigurationError,
        context: { operation: "oauth_configuration_load" }
      });
    }
    const aiConfigurationError = this.aiSettings.view(this.database.getAiUsageSummary()).configurationError;
    if (aiConfigurationError) {
      this.database.recordDiagnostic({
        level: "error",
        category: "ai",
        message: aiConfigurationError,
        context: { operation: "configuration_load" }
      });
    }
    this.ai.initialize();
    this.aiSchedules.start();
    await this.imports.initialize();
    await this.registerPlugins();
    this.registerRoutes();
    this.registerErrorHandler();
    await this.registerStaticFiles();
    this.database.recordDiagnostic({
      level: "info",
      category: "system",
      message: "Local email service initialized",
      context: { databasePath: this.database.path }
    });
  }

  async listen(): Promise<StartedApi> {
    const address = await this.app.listen({
      host: this.config.host,
      port: this.config.port
    });
    const parsed = new URL(address.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1"));
    this.listeningPort = Number(parsed.port);
    return { runtime: this, url: parsed.origin, port: this.listeningPort };
  }

  async close(): Promise<void> {
    this.database.recordDiagnostic({
      level: "info",
      category: "system",
      message: "Local email service shutting down"
    });
    await this.aiSchedules.close();
    await this.mailboxTasks.close();
    await this.ai.close();
    await this.gmail.close();
    await this.imports.close();
    await this.app.close();
    this.database.close();
  }

  async removeArchive(archiveId: string): Promise<void> {
    await this.gmail.removeForArchive(archiveId);
    await this.imports.removeArchive(archiveId);
  }

  async removeFolder(folderId: string): Promise<void> {
    await this.gmail.removeForFolderTree(folderId);
    await this.imports.removeFolder(folderId);
  }

  async runDesktopAction<T>(
    accessToken: string,
    action: string,
    operation: (session: AuthSessionRecord) => Promise<T> | T,
    adminOnly = false
  ): Promise<T> {
    const session = this.auth.authenticate(accessToken, "127.0.0.1");
    if (!session) throw new Error("Login required");
    if (session.role === "viewer" || (adminOnly && session.role !== "admin")) {
      throw new Error(adminOnly ? "Administrator access required" : "This viewer is read-only");
    }
    try {
      const result = await operation(session);
      this.database.recordAudit({
        sessionId: session.id,
        userId: session.user.id,
        username: session.user.username,
        displayName: session.user.displayName,
        role: session.role,
        action,
        method: "IPC",
        path: action,
        statusCode: 200,
        success: true,
        ipAddress: "127.0.0.1",
        userAgent: "Electron desktop bridge"
      });
      return result;
    } catch (error) {
      this.database.recordAudit({
        sessionId: session.id,
        userId: session.user.id,
        username: session.user.username,
        displayName: session.user.displayName,
        role: session.role,
        action,
        method: "IPC",
        path: action,
        statusCode: 500,
        success: false,
        ipAddress: "127.0.0.1",
        userAgent: "Electron desktop bridge",
        details: { error: error instanceof Error ? error.message : "Desktop operation failed" }
      });
      throw error;
    }
  }

  setSharingEnabled(enabled: boolean): SharingState {
    if (!enabled) {
      this.shareToken = null;
      this.shareExpiresAt = null;
      this.auth.revokeViewerSessions();
      return { enabled: false, url: null, expiresAt: null };
    }
    this.shareToken = randomToken();
    this.shareExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const host = findLanAddress() ?? "127.0.0.1";
    return {
      enabled: true,
      url: `http://${host}:${this.listeningPort}/?share=${encodeURIComponent(this.shareToken)}`,
      expiresAt: this.shareExpiresAt.toISOString()
    };
  }

  getSharingState(): SharingState {
    if (!this.isSharingActive()) return { enabled: false, url: null, expiresAt: null };
    const host = findLanAddress() ?? "127.0.0.1";
    return {
      enabled: true,
      url: `http://${host}:${this.listeningPort}/?share=${encodeURIComponent(this.shareToken!)}`,
      expiresAt: this.shareExpiresAt!.toISOString()
    };
  }

  private async registerPlugins(): Promise<void> {
    await this.app.register(cors, {
      origin: ALLOWED_CORS_ORIGINS,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Upload-Offset"]
    });
    this.app.addContentTypeParser("application/octet-stream", {
      parseAs: "buffer",
      bodyLimit: 5 * 1024 * 1024
    }, (_request, body, done) => {
      done(null, body);
    });
    this.app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith("/api/")
        || request.url.startsWith("/api/auth/")
        || request.url.startsWith("/api/health")) return;
      const userId = this.currentUserId(request);
      if (!userId) return;
      const route = request.routeOptions.url || request.url.split("?", 1)[0]!;
      if (route.startsWith("/api/admin/users/")) return;
      const params = (request.params ?? {}) as Record<string, unknown>;
      const checks: Array<[Parameters<EmailStore["ownsResource"]>[1], unknown]> = [
        ["archive", params.archiveId],
        ["folder", params.folderId],
        ["message", params.messageId],
        ["attachment", params.attachmentId],
        ["gmail-connection", params.connectionId],
        ["calendar-account", params.accountId],
        ["todo", params.todoId],
        ["upload", params.uploadId],
        ["draft", params.draftId],
        ["resume", params.resumeId],
        ["reply-style", params.styleId],
        ["ai-schedule", params.scheduleId],
        ["follow-up", params.followUpId]
      ];
      if (typeof params.jobId === "string") {
        checks.push([route.startsWith("/api/ai/jobs/") ? "ai-job" : "import-job", params.jobId]);
      }
      if (typeof params.ruleId === "string") {
        checks.push([route.includes("smart-mail-rules") ? "smart-rule" : "sender-rule", params.ruleId]);
      }
      const query = request.query && typeof request.query === "object"
        ? request.query as Record<string, unknown>
        : null;
      if (query) {
        checks.push(["archive", query.archiveId], ["folder", query.folderId]);
      }
      const body = request.body && typeof request.body === "object"
        ? request.body as Record<string, unknown>
        : null;
      if (body) {
        checks.push(
          ["archive", body.archiveId],
          ["archive", body.targetArchiveId],
          ["archive", body.replaceArchiveId],
          ["folder", body.folderId],
          ["folder", body.parentId],
          ["folder", body.targetFolderId],
          ["folder", body.destinationFolderId],
          ["message", body.messageId],
          ["message", body.sourceMessageId],
          ["gmail-connection", body.connectionId],
          ["gmail-connection", body.gmailConnectionId],
          ["resume", body.resumeId],
          ["reply-style", body.replyStyleId]
        );
        if (Array.isArray(body.messageIds)) {
          const messageIds = body.messageIds.filter((id): id is string => typeof id === "string");
          if (!this.database.ownsAllResources(userId, "message", messageIds)) {
            return reply.code(404).send({ error: "Resource not found" });
          }
        }
        if (Array.isArray(body.ruleIds)) {
          const ruleIds = body.ruleIds.filter((id): id is string => typeof id === "string");
          if (ruleIds.some((id) => this.database.resourceExists("smart-rule", id)
            && !this.database.ownsResource(userId, "smart-rule", id))) {
            return reply.code(404).send({ error: "Resource not found" });
          }
        }
      }
      for (const [resource, id] of checks) {
        if (typeof id === "string" && id
          && this.database.resourceExists(resource, id)
          && !this.database.ownsResource(userId, resource, id)) {
          return reply.code(404).send({ error: "Resource not found" });
        }
      }
    });
    this.app.addHook("onResponse", async (request, reply) => {
      if (!request.url.startsWith("/api/")
        || request.url.startsWith("/api/auth/")
        || request.url.startsWith("/api/health")) return;
      this.recordRequestAudit(request, reply.statusCode);
    });
  }

  private registerRoutes(): void {
    this.app.get("/api/health", async () => ({ status: "ok" }));

    this.app.post<{ Body: unknown }>("/api/auth/login", async (request, reply) => {
      const parsed = authLoginSchema.safeParse(request.body);
      if (!parsed.success) {
        this.recordAuthAudit(request, null, "auth.login", 400, false, { reason: "invalid_request" });
        return reply.code(400).send({ error: "Enter a valid username and 4 to 12 digit PIN" });
      }
      const remote = !isLoopback(request.ip);
      const pairedViewer = remote && this.isValidPairingToken(parsed.data.pairingToken);
      if (remote && !pairedViewer && !this.config.allowRemoteLogin) {
        this.recordAuthAudit(request, null, "auth.login", 403, false, { reason: "pairing_required" });
        return reply.code(403).send({ error: "A valid desktop pairing link is required" });
      }
      try {
        const result = this.auth.login({
          username: parsed.data.username,
          pin: parsed.data.pin,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          roleCap: pairedViewer ? "viewer" : undefined,
          expiresAtCap: pairedViewer ? this.shareExpiresAt : null
        });
        const session = this.auth.authenticate(result.accessToken, request.ip);
        this.recordAuthAudit(request, session, "auth.login", 200, true);
        return result;
      } catch (error) {
        const statusCode = error instanceof AuthRateLimitError ? 429 : 401;
        this.recordAuthAudit(request, null, "auth.login", statusCode, false, {
          reason: error instanceof AuthRateLimitError ? "rate_limited" : "invalid_credentials",
          username: parsed.data.username
        });
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "Login failed"
        });
      }
    });

    this.app.get("/api/auth/session", async (request, reply) => {
      const session = this.resolveSession(request);
      if (!session) return reply.code(401).send({ error: "Login required" });
      return this.auth.toSessionInfo(session);
    });

    this.app.post("/api/auth/logout", async (request, reply) => {
      const session = this.resolveSession(request);
      if (!session) return reply.code(401).send({ error: "Login required" });
      this.recordAuthAudit(request, session, "auth.logout", 204, true);
      this.auth.logout(session.id);
      return reply.code(204).send();
    });

    this.app.patch<{ Body: unknown }>("/api/auth/pin", async (request, reply) => {
      const session = this.resolveSession(request);
      if (!session) return reply.code(401).send({ error: "Login required" });
      const parsed = pinChangeSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Enter valid current and new PINs" });
      try {
        this.auth.changePin(session, parsed.data.currentPin, parsed.data.newPin);
        this.recordAuthAudit(request, session, "auth.pin_changed", 204, true);
        return reply.code(204).send();
      } catch (error) {
        this.recordAuthAudit(request, session, "auth.pin_change_failed", 400, false);
        return reply.code(400).send({ error: error instanceof Error ? error.message : "PIN could not be changed" });
      }
    });

    this.app.get("/api/archives", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.database.listArchives(this.currentUserId(request) ?? undefined);
    });

    this.app.delete<{ Params: { archiveId: string } }>(
      "/api/archives/:archiveId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        if (!this.database.getArchive(request.params.archiveId)) {
          return reply.code(404).send({ error: "Archive not found" });
        }
        await this.removeArchive(request.params.archiveId);
        return reply.code(204).send();
      }
    );

    this.app.post<{ Params: { archiveId: string }; Body: unknown }>(
      "/api/archives/:archiveId/combine",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = archiveMergeSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Choose a valid destination archive" });
        try {
          const source = this.database.getArchive(request.params.archiveId);
          const target = this.database.getArchive(parsed.data.targetArchiveId);
          const result = this.database.mergeArchives(request.params.archiveId, parsed.data.targetArchiveId);
          this.imports.invalidateFolderCache(request.params.archiveId);
          this.imports.invalidateFolderCache(parsed.data.targetArchiveId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Archives combined into ${result.archive.name}`,
            archiveId: result.archive.id,
            sourceName: result.archive.name,
            context: {
              sourceArchiveId: request.params.archiveId,
              sourceArchiveName: source?.name ?? null,
              targetArchiveId: result.archive.id,
              targetArchiveName: target?.name ?? result.archive.name,
              movedMessages: result.movedMessages,
              movedFolders: result.movedFolders,
              movedAttachments: result.movedAttachments
            }
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Archives could not be combined";
          const status = message.includes("not found") ? 404 : 409;
          return reply.code(status).send({ error: message });
        }
      }
    );

    this.app.patch<{ Params: { archiveId: string }; Body: unknown }>(
      "/api/archives/:archiveId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = displayNamePatchSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid name" });
        try {
          const previous = this.database.getArchive(request.params.archiveId);
          const archive = this.database.renameArchive(request.params.archiveId, parsed.data.name);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Archive renamed to ${archive.name}`,
            archiveId: archive.id,
            sourceName: archive.name,
            context: { previousName: previous?.name ?? null }
          });
          return archive;
        } catch {
          return reply.code(404).send({ error: "Archive not found" });
        }
      }
    );

    this.app.get<{ Params: { archiveId: string } }>(
      "/api/archives/:archiveId/folders",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
        return this.database.listFolders(request.params.archiveId);
      }
    );

    this.app.post<{ Params: { archiveId: string }; Body: unknown }>(
      "/api/archives/:archiveId/folders",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = mailboxCreateSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid mailbox" });
        }
        try {
          const folder = this.database.createFolder(
            request.params.archiveId,
            parsed.data.name,
            parsed.data.parentId ?? null
          );
          this.imports.invalidateFolderCache(request.params.archiveId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Mailbox created: ${folder.path}`,
            archiveId: folder.archiveId,
            sourceName: folder.name,
            context: { folderId: folder.id, path: folder.path }
          });
          return reply.code(201).send(folder);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mailbox could not be created";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.patch<{ Params: { folderId: string }; Body: unknown }>(
      "/api/folders/:folderId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = displayNamePatchSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid name" });
        try {
          const previous = this.database.getFolder(request.params.folderId);
          const folder = this.database.renameFolder(request.params.folderId, parsed.data.name);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Mailbox renamed to ${folder.name}`,
            archiveId: folder.archiveId,
            sourceName: folder.name,
            context: { previousPath: previous?.path ?? null, path: folder.path }
          });
          return folder;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mailbox could not be renamed";
          return reply.code(
            message.includes("already exists") || message.includes("import to finish") ? 409 : 404
          ).send({ error: message });
        }
      }
    );

    this.app.post<{ Params: { folderId: string }; Body: unknown }>(
      "/api/folders/:folderId/combine",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = mailboxMergeSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Choose a valid destination mailbox" });
        try {
          const source = this.database.getFolder(request.params.folderId);
          const destination = this.database.getFolder(parsed.data.targetFolderId);
          const result = this.database.mergeFolders(request.params.folderId, parsed.data.targetFolderId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Mailbox combined: ${source?.path ?? request.params.folderId}`,
            archiveId: result.mailbox.archiveId,
            sourceName: source?.name ?? null,
            context: {
              destinationPath: destination?.path ?? result.mailbox.path,
              movedMessages: result.movedMessages,
              removedMailboxes: result.removedMailboxes,
              movedAttachments: result.movedAttachments
            }
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mailboxes could not be combined";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.post<{ Params: { folderId: string }; Body: unknown }>(
      "/api/folders/:folderId/move",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = mailboxMoveSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Choose a valid parent mailbox" });
        try {
          const source = this.database.getFolder(request.params.folderId);
          const destination = parsed.data.targetParentId
            ? this.database.getFolder(parsed.data.targetParentId)
            : null;
          const result = this.database.moveFolder(request.params.folderId, parsed.data.targetParentId);
          this.imports.invalidateFolderCache(result.mailbox.archiveId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Mailbox moved: ${source?.path ?? request.params.folderId}`,
            archiveId: result.mailbox.archiveId,
            sourceName: source?.name ?? null,
            context: {
              destinationPath: destination?.path ?? null,
              path: result.mailbox.path,
              movedMailboxes: result.movedMailboxes
            }
          });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mailbox could not be moved";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.delete<{ Params: { folderId: string } }>(
      "/api/folders/:folderId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          await this.removeFolder(request.params.folderId);
          return reply.code(204).send();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Mailbox could not be deleted";
          return reply.code(message.includes("import to finish") ? 409 : 404).send({ error: message });
        }
      }
    );

    this.app.get<{
      Querystring: {
        archiveId?: string;
        folderId?: string;
        isRead?: string;
        starred?: string;
        inboxCategory?: string;
        from?: string;
        to?: string;
        after?: string;
        before?: string;
        hasAttachment?: string;
        cursor?: string;
        limit?: string;
      };
    }>("/api/messages", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      const inboxCategory = parseInboxCategory(request.query.inboxCategory);
      if (request.query.inboxCategory && !inboxCategory) {
        return reply.code(400).send({ error: "Invalid inbox category" });
      }
      return this.database.listMessages({
        ownerUserId: this.currentUserId(request) ?? undefined,
        archiveId: request.query.archiveId,
        folderId: request.query.folderId,
        isRead: optionalBoolean(request.query.isRead),
        starred: optionalBoolean(request.query.starred),
        inboxCategory,
        from: request.query.from,
        to: request.query.to,
        after: request.query.after,
        before: request.query.before,
        hasAttachment: optionalBoolean(request.query.hasAttachment),
        cursor: request.query.cursor,
        limit: optionalNumber(request.query.limit)
      });
    });

    this.app.get<{
      Querystring: { archiveId?: string; folderId?: string; isRead?: string };
    }>("/api/messages/category-counts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.database.countInboxCategories({
        ownerUserId: this.currentUserId(request) ?? undefined,
        archiveId: request.query.archiveId,
        folderId: request.query.folderId,
        isRead: optionalBoolean(request.query.isRead)
      });
    });

    this.app.get<{ Querystring: { archiveId?: string } }>("/api/inbox-tabs", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      const archiveId = request.query.archiveId?.trim();
      if (!archiveId) return reply.code(400).send({ error: "archiveId is required" });
      try {
        return this.database.getInboxTabSettings(archiveId);
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Archive not found" });
      }
    });

    this.app.patch<{ Params: { archiveId: string }; Body: unknown }>(
      "/api/admin/inbox-tabs/:archiveId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = inboxTabSettingsUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid Inbox tab settings" });
        }
        try {
          const settings = this.database.updateInboxTabSettings(request.params.archiveId, parsed.data);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: "Inbox tab configuration saved",
            archiveId: request.params.archiveId,
            context: {
              enabledTabs: settings.tabs.filter((tab) => tab.enabled).map((tab) => tab.id),
              aiEnabled: settings.aiEnabled,
              aiConfidenceThreshold: settings.aiConfidenceThreshold
            }
          });
          return settings;
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Archive not found" });
        }
      }
    );

    this.app.post<{ Params: { archiveId: string } }>(
      "/api/admin/inbox-tabs/:archiveId/reclassify",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          const result = this.database.reclassifyInboxMessages(request.params.archiveId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: "Inbox messages reclassified",
            archiveId: request.params.archiveId,
            context: {
              scannedMessages: result.scannedMessages,
              changedMessages: result.changedMessages
            }
          });
          return result;
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Archive not found" });
        }
      }
    );

    this.app.get<{
      Querystring: {
        q?: string;
        archiveId?: string;
        folderId?: string;
        isRead?: string;
        starred?: string;
        inboxCategory?: string;
        from?: string;
        to?: string;
        after?: string;
        before?: string;
        hasAttachment?: string;
        sort?: "relevance" | "newest";
        cursor?: string;
        limit?: string;
      };
    }>("/api/search", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      const query = request.query.q?.trim() ?? "";
      if (!query) return { items: [], nextCursor: null };
      if (query.length > 500) {
        return reply.code(400).send({ error: "Search query is too long" });
      }
      const inboxCategory = parseInboxCategory(request.query.inboxCategory);
      if (request.query.inboxCategory && !inboxCategory) {
        return reply.code(400).send({ error: "Invalid inbox category" });
      }
      return this.database.search({
        q: query,
        ownerUserId: this.currentUserId(request) ?? undefined,
        archiveId: request.query.archiveId,
        folderId: request.query.folderId,
        isRead: optionalBoolean(request.query.isRead),
        starred: optionalBoolean(request.query.starred),
        inboxCategory,
        from: request.query.from,
        to: request.query.to,
        after: request.query.after,
        before: request.query.before,
        hasAttachment: optionalBoolean(request.query.hasAttachment),
        sort: request.query.sort,
        cursor: request.query.cursor,
        limit: optionalNumber(request.query.limit)
      });
    });

    this.app.get<{ Params: { messageId: string } }>(
      "/api/messages/:messageId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
        const message = this.database.getMessage(request.params.messageId);
        if (!message) return reply.code(404).send({ error: "Message not found" });
        return message;
      }
    );

    this.app.get<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/thread",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
        try {
          return this.database.getMessageThread(request.params.messageId);
        } catch {
          return reply.code(404).send({ error: "Message not found" });
        }
      }
    );

    this.app.post<{ Params: { messageId: string }; Body: unknown }>(
      "/api/messages/:messageId/follow-up",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageFollowUpCreateSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid follow-up" });
        try {
          return this.database.createMessageFollowUp(request.params.messageId, parsed.data);
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Message not found" });
        }
      }
    );

    this.app.get<{ Querystring: { status?: string } }>("/api/follow-ups", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      const status = request.query.status;
      if (status && !["pending", "completed", "dismissed"].includes(status)) {
        return reply.code(400).send({ error: "Choose a valid follow-up status" });
      }
      return this.database.listMessageFollowUps(
        status as "pending" | "completed" | "dismissed" | undefined,
        this.currentUserId(request) ?? undefined
      );
    });

    this.app.patch<{ Params: { followUpId: string }; Body: unknown }>(
      "/api/follow-ups/:followUpId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageFollowUpPatchSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid follow-up update" });
        try {
          return this.database.updateMessageFollowUp(request.params.followUpId, parsed.data);
        } catch {
          return reply.code(404).send({ error: "Follow-up not found" });
        }
      }
    );

    this.app.delete<{ Params: { followUpId: string } }>(
      "/api/follow-ups/:followUpId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        return this.database.deleteMessageFollowUp(request.params.followUpId)
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Follow-up not found" });
      }
    );

    this.app.patch<{
      Params: { messageId: string };
      Body: unknown;
    }>("/api/messages/:messageId/state", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = localMessageStatePatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid message-state update" });
      }
      try {
        await this.gmail.syncMessageState(request.params.messageId, parsed.data);
        return this.database.updateMessageState(request.params.messageId, parsed.data);
      } catch (error) {
        return this.mailboxActionErrorReply(reply, error, "Message state could not be updated");
      }
    });

    this.app.post<{ Body: unknown }>("/api/messages/bulk-read", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = bulkMessageReadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose one or more messages" });
      }
      const pendingMessageIds: string[] = [];
      let alreadyRead = 0;
      let failed = 0;
      for (const messageId of parsed.data.messageIds) {
        const existing = this.database.getMessage(messageId);
        if (!existing) {
          failed += 1;
        } else if (existing.state.isRead) {
          alreadyRead += 1;
        } else {
          pendingMessageIds.push(messageId);
        }
      }
      try {
        await this.gmail.syncMessagesState(pendingMessageIds, { isRead: true });
      } catch (error) {
        return this.mailboxActionErrorReply(reply, error, "Selected messages could not be marked read");
      }
      let updated = 0;
      for (const messageId of pendingMessageIds) {
        try {
          this.database.updateMessageState(messageId, { isRead: true });
          updated += 1;
        } catch {
          failed += 1;
        }
      }
      const result: BulkMessageReadResult = { updated, alreadyRead, failed };
      this.database.recordDiagnostic({
        level: failed > 0 ? "warning" : "info",
        category: "system",
        message: `Bulk read updated ${updated} message${updated === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
        context: {
          operation: "bulk_mark_read",
          requested: parsed.data.messageIds.length,
          updated,
          alreadyRead,
          failed
        }
      });
      return result;
    });

    this.app.post<{
      Params: { messageId: string };
      Body: unknown;
    }>("/api/messages/:messageId/move", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = messageMoveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Choose a destination mailbox" });
      }
      try {
        await this.gmail.syncMessageMove(request.params.messageId, parsed.data.folderId);
        this.database.moveMessage(request.params.messageId, parsed.data.folderId);
        return this.database.getMessage(request.params.messageId);
      } catch (error) {
        return this.mailboxActionErrorReply(reply, error, "Message could not be moved");
      }
    });

    // Delete resolves to a local "Trash" mailbox rather than a hard delete, so a bulk
    // Delete/Archive/Spam action is always reversible the same way a single-message
    // Archive move already is (see BULK_DESTINATION_NAMES below).
    this.app.post<{ Body: unknown }>("/api/messages/bulk-move", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = bulkMoveMessagesSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose messages and a destination" });
      }
      const { messageIds, destination } = parsed.data;
      if (destination === "spam") {
        try {
          const result = await this.markSelectedSendersAsSpam(messageIds);
          this.database.recordDiagnostic({
            level: result.failed > 0 ? "warning" : "info",
            category: "system",
            message: `Bulk spam moved ${result.moved} message${result.moved === 1 ? "" : "s"} and enabled ${result.senderRules} sender rule${result.senderRules === 1 ? "" : "s"}`,
            context: {
              operation: "bulk_spam_senders",
              requested: messageIds.length,
              moved: result.moved,
              alreadyThere: result.alreadyThere,
              failed: result.failed,
              senderRules: result.senderRules
            }
          });
          return result;
        } catch (error) {
          return this.mailboxActionErrorReply(reply, error, "Selected senders could not be marked as spam");
        }
      }
      const matchNames = BULK_DESTINATION_MATCH_NAMES[destination];
      const createName = BULK_DESTINATION_CREATE_NAME[destination];
      const folderCache = new Map<string, { id: string; path: string }>();
      const folderPaths = new Set<string>();
      const pendingMoves: Array<{ messageId: string; targetFolderId: string }> = [];
      let moved = 0;
      let alreadyThere = 0;
      let failed = 0;
      for (const messageId of messageIds) {
        const existing = this.database.getMessage(messageId);
        if (!existing) {
          failed += 1;
          continue;
        }
        const cacheKey = `${existing.archiveId}:${existing.folderId}`;
        let folder = folderCache.get(cacheKey);
        if (!folder) {
          try {
            folder = this.resolveNamedFolder(existing.archiveId, existing.folderId, matchNames, createName);
            folderCache.set(cacheKey, folder);
          } catch {
            failed += 1;
            continue;
          }
        }
        folderPaths.add(folder.path);
        if (folder.id === existing.folderId) {
          alreadyThere += 1;
          continue;
        }
        pendingMoves.push({ messageId, targetFolderId: folder.id });
      }
      const remoteGroups = new Map<string, string[]>();
      for (const move of pendingMoves) {
        const ids = remoteGroups.get(move.targetFolderId) ?? [];
        ids.push(move.messageId);
        remoteGroups.set(move.targetFolderId, ids);
      }
      try {
        for (const [targetFolderId, ids] of remoteGroups) {
          await this.gmail.syncMessagesMove(ids, targetFolderId);
        }
      } catch (error) {
        return this.mailboxActionErrorReply(reply, error, "Selected messages could not be moved");
      }
      for (const move of pendingMoves) {
        try {
          this.database.moveMessage(move.messageId, move.targetFolderId);
          moved += 1;
        } catch {
          failed += 1;
        }
      }
      const result: BulkMoveResult = {
        destination,
        folderPaths: [...folderPaths],
        moved,
        alreadyThere,
        failed,
        senderRules: 0
      };
      this.database.recordDiagnostic({
        level: failed > 0 ? "warning" : "info",
        category: "system",
        message: `Bulk ${destination} moved ${moved} message${moved === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`,
        context: { operation: "bulk_move", destination, requested: messageIds.length, moved, alreadyThere, failed }
      });
      return result;
    });

    this.app.post<{ Body: unknown }>("/api/messages/bulk-move-to-folder", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = bulkFolderMoveSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose messages and a destination mailbox" });
      }
      const folder = this.database.getFolder(parsed.data.folderId);
      if (!folder) return reply.code(404).send({ error: "Destination mailbox not found" });
      const pendingMessageIds: string[] = [];
      let alreadyThere = 0;
      let failed = 0;
      for (const messageId of parsed.data.messageIds) {
        const message = this.database.getMessage(messageId);
        if (!message || message.archiveId !== folder.archiveId) {
          failed += 1;
        } else if (message.folderId === folder.id) {
          alreadyThere += 1;
        } else {
          pendingMessageIds.push(messageId);
        }
      }
      try {
        await this.gmail.syncMessagesMove(pendingMessageIds, folder.id);
      } catch (error) {
        return this.mailboxActionErrorReply(reply, error, "Selected messages could not be moved");
      }
      let moved = 0;
      for (const messageId of pendingMessageIds) {
        try {
          this.database.moveMessage(messageId, folder.id);
          moved += 1;
        } catch {
          failed += 1;
        }
      }
      const result: BulkFolderMoveResult = {
        folderId: folder.id,
        folderPath: folder.path,
        moved,
        alreadyThere,
        failed
      };
      this.database.recordDiagnostic({
        level: failed > 0 ? "warning" : "info",
        category: "system",
        message: `Bulk move filed ${moved} message${moved === 1 ? "" : "s"} in ${folder.path}`,
        archiveId: folder.archiveId,
        context: {
          operation: "bulk_move_to_folder",
          folderId: folder.id,
          folderPath: folder.path,
          requested: parsed.data.messageIds.length,
          moved,
          alreadyThere,
          failed
        }
      });
      return result;
    });

    this.app.post<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/sender-folder",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageMoveSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Choose a destination mailbox" });
        try {
          const messageIds = this.database.listSenderMessageIds(request.params.messageId);
          await this.gmail.syncMessagesMove(messageIds, parsed.data.folderId);
          const result = this.database.moveSenderMessagesToFolder(request.params.messageId, parsed.data.folderId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Sender filed to ${result.folderPath}: ${result.senderAddress}`,
            archiveId: result.message.archiveId,
            context: {
              operation: "sender_filed_to_folder",
              movedMessages: result.movedMessages,
              folderId: result.folderId,
              folderPath: result.folderPath
            }
          });
          return result;
        } catch (error) {
          return this.mailboxActionErrorReply(reply, error, "Sender messages could not be moved");
        }
      }
    );

    this.app.post<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/spam-sender",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          const message = this.database.getMessage(request.params.messageId);
          if (!message) throw new Error("Message not found");
          const spamFolder = this.resolveNamedFolder(
            message.archiveId,
            message.folderId,
            ["spam"],
            "Spam"
          );
          const messageIds = this.database.listSenderMessageIds(request.params.messageId, true);
          await this.gmail.syncMessagesMove(messageIds, spamFolder.id);
          const result = this.database.markSenderAsSpam(request.params.messageId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Sender marked as spam: ${result.senderAddress}`,
            archiveId: result.message.archiveId,
            context: {
              operation: "sender_marked_spam",
              movedMessages: result.movedMessages,
              spamFolderPath: result.spamFolderPath
            }
          });
          return result;
        } catch (error) {
          return this.mailboxActionErrorReply(reply, error, "Sender could not be marked as spam");
        }
      }
    );

    this.app.get<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/ai",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
        try {
          return this.ai.getMessageState(request.params.messageId);
        } catch (error) {
          if (error instanceof AiMessageNotFoundError) {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.post<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/ai/analyze",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          const result = this.ai.startAnalysis(request.params.messageId);
          return reply.code(result.job.status === "completed" ? 200 : 202).send(result);
        } catch (error) {
          if (error instanceof AiMessageNotFoundError) {
            return reply.code(404).send({ error: error.message });
          }
          if (error instanceof AiConfigurationError) {
            return reply.code(503).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.post<{ Params: { messageId: string }; Body: unknown }>(
      "/api/messages/:messageId/ai/action-suggestion",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageActionSuggestionRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Provide a valid time and time zone" });
        }
        try {
          return await this.ai.suggestMessageAction(request.params.messageId, parsed.data);
        } catch (error) {
          if (error instanceof AiMessageNotFoundError) return reply.code(404).send({ error: error.message });
          if (error instanceof AiConfigurationError) return reply.code(503).send({ error: error.message });
          if (error instanceof AiBudgetError) return reply.code(429).send({ error: error.message });
          return reply.code(502).send({ error: error instanceof Error ? error.message : "AI action suggestion failed" });
        }
      }
    );

    this.app.post<{ Body: unknown }>("/api/messages/ai/filing-suggestion", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = bulkFilingSuggestionRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose messages to file" });
      }
      try {
        return await this.ai.suggestFilingFolder(parsed.data.messageIds);
      } catch (error) {
        if (error instanceof AiMessageNotFoundError) return reply.code(404).send({ error: error.message });
        if (error instanceof AiConfigurationError) return reply.code(503).send({ error: error.message });
        if (error instanceof AiBudgetError) return reply.code(429).send({ error: error.message });
        return reply.code(502).send({ error: error instanceof Error ? error.message : "AI mailbox suggestion failed" });
      }
    });

    this.app.post<{ Params: { messageId: string }; Body: unknown }>(
      "/api/messages/:messageId/ai/draft-reply",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageDraftReplyRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose a sending account" });
        }
        try {
          const result = this.ai.startMessageDraftReply(request.params.messageId, {
            gmailConnectionId: parsed.data.gmailConnectionId,
            resumeId: parsed.data.resumeId ?? null,
            replyStyleId: parsed.data.replyStyleId ?? null,
            instructions: parsed.data.instructions ?? null
          });
          return reply.code(result.draft ? 200 : 202).send(result);
        } catch (error) {
          if (error instanceof AiMessageNotFoundError) return reply.code(404).send({ error: error.message });
          if (error instanceof AiDraftSkippedError) return reply.code(409).send({ error: error.message });
          if (error instanceof AiDraftTargetError) return reply.code(400).send({ error: error.message });
          if (error instanceof AiConfigurationError) return reply.code(503).send({ error: error.message });
          throw error;
        }
      }
    );

    this.app.get<{ Params: { jobId: string } }>(
      "/api/ai/jobs/:jobId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.ai.getJob(request.params.jobId);
        } catch (error) {
          if (error instanceof AiJobNotFoundError) {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.get("/api/ai/review-queue", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.database.getAiReviewQueue(100, this.currentUserId(request) ?? undefined);
    });

    this.app.post("/api/ai/review-queue/review-all", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.database.markAllMessageAnalysesReviewed(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Params: { messageId: string } }>(
      "/api/messages/:messageId/ai/review",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.database.markMessageAnalysisReviewed(request.params.messageId);
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Message analysis not found" });
        }
      }
    );

    this.app.get("/api/reply-styles", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.database.listReplyStyles(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Params: { jobId: string } }>(
      "/api/ai/jobs/:jobId/cancel",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.ai.cancel(request.params.jobId);
        } catch (error) {
          if (error instanceof AiJobNotFoundError) {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.get<{ Params: { attachmentId: string } }>(
      "/api/attachments/:attachmentId/content",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
        const result = this.database.getAttachmentBlob(request.params.attachmentId);
        if (!result) return reply.code(404).send({ error: "Attachment not found" });
        reply.header("Content-Type", attachmentContentType(result.attachment.contentType, result.attachment.filename));
        reply.header("Content-Length", result.attachment.sizeBytes);
        reply.header(
          "Content-Disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(safeFilename(result.attachment.filename))}`
        );
        reply.header("Cache-Control", "private, no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(createReadStream(this.blobStore.resolve(result.relativePath)));
      }
    );

    this.app.get("/api/gmail/connections", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.gmail.listConnections(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Body: unknown }>("/api/gmail/oauth/start", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = gmailAuthRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid Gmail destination" });
      }
      try {
        return this.gmail.startAuthorization(parsed.data, this.currentUserId(request));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gmail authorization could not start";
        this.database.recordDiagnostic({
          ownerUserId: this.currentUserId(request),
          level: "error",
          category: "gmail",
          message,
          stack: error instanceof Error ? error.stack : null,
          archiveId: parsed.data.archiveId ?? null,
          context: { operation: "oauth_start" }
        });
        return reply.code(error instanceof GmailConfigurationError ? 503 : 409).send({ error: message });
      }
    });

    this.app.get<{
      Querystring: { code?: string; state?: string; error?: string; error_description?: string };
    }>("/api/gmail/oauth/callback", async (request, reply) => {
      const oauthError = request.query.error_description ?? request.query.error;
      if (oauthError) {
        return reply.code(400).type("text/html; charset=utf-8")
          .send(oauthResultPage("Gmail was not connected", oauthError));
      }
      if (!request.query.code || !request.query.state) {
        return reply.code(400).type("text/html; charset=utf-8")
          .send(oauthResultPage("Gmail was not connected", "The authorization response was incomplete."));
      }
      try {
        const connection = await this.gmail.finishAuthorization(request.query.state, request.query.code);
        return reply.type("text/html; charset=utf-8").send(oauthResultPage(
          "Gmail connected",
          `${connection.email} is syncing into ${connection.archiveName} / ${connection.folderPath}. You can return to Archive Mail.`
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gmail authorization failed";
        this.database.recordDiagnostic({
          level: "error",
          category: "gmail",
          message: `Gmail authorization failed: ${message}`,
          stack: error instanceof Error ? error.stack : null,
          context: { operation: "oauth_callback" }
        });
        return reply.code(error instanceof GmailAuthorizationError ? 400 : 502)
          .type("text/html; charset=utf-8")
          .send(oauthResultPage("Gmail was not connected", message));
      }
    });

    this.app.post<{ Params: { connectionId: string }; Body: unknown }>(
      "/api/gmail/connections/:connectionId/sync",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = gmailSyncRequestSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid sync request" });
        }
        try {
          return this.gmail.startSync(request.params.connectionId, { full: parsed.data.full });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Gmail sync could not start";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.post<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId/reconcile",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.gmail.startMailboxReconciliation(request.params.connectionId);
        } catch (error) {
          return this.mailboxActionErrorReply(reply, error, "Gmail mailbox reconciliation could not start");
        }
      }
    );

    this.app.post<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId/cancel",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.gmail.cancelSync(request.params.connectionId);
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Gmail connection not found" });
        }
      }
    );

    this.app.post<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId/reorganize",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.gmail.reorganizeFolders(request.params.connectionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Gmail folder reorganize could not start";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.post<{ Params: { connectionId: string }; Body: unknown }>(
      "/api/gmail/connections/:connectionId/send",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = gmailSendRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: parsed.error.issues[0]?.message ?? "Invalid email"
          });
        }
        try {
          return await this.gmail.sendMessage(request.params.connectionId, parsed.data);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Email could not be sent";
          if (message.includes("not found")) return reply.code(404).send({ error: message });
          if (error instanceof GmailPermissionError) return reply.code(409).send({ error: message });
          return reply.code(502).send({ error: message });
        }
      }
    );

    this.app.delete<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          await this.gmail.removeConnection(request.params.connectionId);
          return reply.code(204).send();
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Gmail connection not found" });
        }
      }
    );

    this.app.get<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId/send-as",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return await this.gmail.listSendAsAliases(request.params.connectionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Send-as addresses could not be loaded";
          if (message.includes("not found")) return reply.code(404).send({ error: message });
          if (error instanceof GmailPermissionError) return reply.code(409).send({ error: message });
          return reply.code(502).send({ error: message });
        }
      }
    );

    this.app.get("/api/drafts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.drafts.list(this.currentUserId(request) ?? undefined);
    });

    this.app.get("/api/resumes", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.resumes.list(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Body: unknown }>("/api/drafts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = emailDraftCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid draft" });
      }
      try {
        return this.drafts.create(parsed.data, this.currentUserId(request));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Draft could not be saved" });
      }
    });

    this.app.patch<{ Params: { draftId: string }; Body: unknown }>(
      "/api/drafts/:draftId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = emailDraftUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid draft" });
        }
        try {
          return this.drafts.update(request.params.draftId, parsed.data);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Draft could not be updated";
          return reply.code(error instanceof DraftNotFoundError ? 404 : 400).send({ error: message });
        }
      }
    );

    this.app.delete<{ Params: { draftId: string } }>("/api/drafts/:draftId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      try {
        this.drafts.remove(request.params.draftId);
        return reply.code(204).send();
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Draft not found" });
      }
    });

    this.app.post<{ Params: { draftId: string } }>("/api/drafts/:draftId/send", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      try {
        return await this.drafts.send(request.params.draftId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Draft could not be sent";
        if (error instanceof DraftNotFoundError || error instanceof ResumeNotFoundError) {
          return reply.code(404).send({ error: message });
        }
        if (error instanceof DraftValidationError) return reply.code(400).send({ error: message });
        if (error instanceof GmailPermissionError) return reply.code(409).send({ error: message });
        return reply.code(502).send({ error: message });
      }
    });

    this.app.get<{ Params: { connectionId: string }; Querystring: { timeMin?: string; timeMax?: string } }>(
      "/api/calendar/connections/:connectionId/events",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const timeMin = request.query.timeMin;
        const timeMax = request.query.timeMax;
        if (!timeMin || !timeMax) {
          return reply.code(400).send({ error: "timeMin and timeMax query parameters are required" });
        }
        try {
          return await this.calendar.listEvents(
            request.params.connectionId,
            timeMin,
            timeMax,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.get("/api/calendar/sources", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      try {
        return await this.calendar.listSources(this.currentUserId(request) ?? undefined);
      } catch (error) {
        return this.calendarErrorReply(reply, error);
      }
    });

    this.app.get<{ Params: { sourceId: string }; Querystring: { timeMin?: string; timeMax?: string } }>(
      "/api/calendar/sources/:sourceId/events",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const timeMin = request.query.timeMin;
        const timeMax = request.query.timeMax;
        if (!timeMin || !timeMax) {
          return reply.code(400).send({ error: "timeMin and timeMax query parameters are required" });
        }
        try {
          return await this.calendar.listSourceEvents(
            request.params.sourceId,
            timeMin,
            timeMax,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.post<{ Params: { sourceId: string }; Body: unknown }>(
      "/api/calendar/sources/:sourceId/events",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = calendarEventInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid calendar event" });
        }
        try {
          return await this.calendar.createSourceEvent(
            request.params.sourceId,
            parsed.data,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.patch<{ Params: { sourceId: string; eventId: string }; Body: unknown }>(
      "/api/calendar/sources/:sourceId/events/:eventId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = calendarEventInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid calendar event" });
        }
        try {
          return await this.calendar.updateSourceEvent(
            request.params.sourceId,
            request.params.eventId,
            parsed.data,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.delete<{ Params: { sourceId: string; eventId: string } }>(
      "/api/calendar/sources/:sourceId/events/:eventId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          await this.calendar.deleteSourceEvent(
            request.params.sourceId,
            request.params.eventId,
            this.currentUserId(request) ?? undefined
          );
          return reply.code(204).send();
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.post<{ Params: { messageId: string }; Body: unknown }>(
      "/api/messages/:messageId/calendar-events",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageCalendarEventCreateSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid calendar event" });
        }
        if (!this.database.getMessage(request.params.messageId)) {
          return reply.code(404).send({ error: "Message not found" });
        }
        try {
          const created = await this.calendar.createEvent(
            parsed.data.connectionId,
            parsed.data.event,
            this.currentUserId(request) ?? undefined
          );
          this.database.linkMessageCalendarEvent(request.params.messageId, parsed.data.connectionId, created);
          return created;
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.post<{ Params: { connectionId: string }; Body: unknown }>(
      "/api/calendar/connections/:connectionId/events",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = calendarEventInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid calendar event" });
        }
        try {
          return await this.calendar.createEvent(
            request.params.connectionId,
            parsed.data,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.patch<{ Params: { connectionId: string; eventId: string }; Body: unknown }>(
      "/api/calendar/connections/:connectionId/events/:eventId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = calendarEventInputSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid calendar event" });
        }
        try {
          return await this.calendar.updateEvent(
            request.params.connectionId,
            request.params.eventId,
            parsed.data,
            this.currentUserId(request) ?? undefined
          );
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.delete<{ Params: { connectionId: string; eventId: string } }>(
      "/api/calendar/connections/:connectionId/events/:eventId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          await this.calendar.deleteEvent(
            request.params.connectionId,
            request.params.eventId,
            this.currentUserId(request) ?? undefined
          );
          this.database.unlinkMessageCalendarEvent(request.params.connectionId, request.params.eventId);
          return reply.code(204).send();
        } catch (error) {
          return this.calendarErrorReply(reply, error);
        }
      }
    );

    this.app.get<{ Querystring: { start?: string; end?: string } }>("/api/todos", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const start = request.query.start;
      const end = request.query.end;
      if (!start || !end) {
        return reply.code(400).send({ error: "start and end query parameters are required" });
      }
      return this.database.listTodos(start, end, this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Body: unknown }>("/api/todos", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = todoCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid to-do item" });
      }
      return reply.code(201).send(this.database.createTodo(parsed.data, this.currentUserId(request)));
    });

    this.app.patch<{ Params: { todoId: string }; Body: unknown }>(
      "/api/todos/:todoId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = todoPatchSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid to-do update" });
        }
        try {
          return this.database.updateTodo(request.params.todoId, parsed.data);
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "To-do item not found" });
        }
      }
    );

    this.app.delete<{ Params: { todoId: string } }>("/api/todos/:todoId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      this.database.deleteTodo(request.params.todoId);
      return reply.code(204).send();
    });

    this.app.get("/api/import-jobs", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.database.listImportJobs(this.currentUserId(request) ?? undefined);
    });

    this.app.get<{ Params: { jobId: string } }>(
      "/api/import-jobs/:jobId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const job = this.database.getImportJob(request.params.jobId);
        if (!job) return reply.code(404).send({ error: "Import job not found" });
        return job;
      }
    );

    this.app.post<{ Params: { jobId: string } }>(
      "/api/import-jobs/:jobId/cancel",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return await this.imports.cancelImport(request.params.jobId);
        } catch {
          return reply.code(404).send({ error: "Import job not found" });
        }
      }
    );

    this.app.post<{ Params: { jobId: string } }>(
      "/api/import-jobs/:jobId/resume",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return await this.imports.resumeImport(request.params.jobId);
        } catch (error) {
          return reply.code(409).send({
            error: error instanceof Error ? error.message : "Import cannot be resumed"
          });
        }
      }
    );

    this.app.delete<{ Params: { jobId: string } }>(
      "/api/import-jobs/:jobId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          await this.imports.clearImport(request.params.jobId);
          return reply.code(204).send();
        } catch (error) {
          const message = error instanceof Error ? error.message : "Import could not be cleared";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
        }
      }
    );

    this.app.post<{
      Body: { sourcePath?: string; options?: ImportOptions };
    }>("/api/admin/import", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      if (!request.body?.sourcePath) {
        return reply.code(400).send({ error: "sourcePath is required" });
      }
      const options = importOptionsSchema.safeParse(request.body.options ?? {});
      if (!options.success) return reply.code(400).send({ error: "Invalid import options" });
      try {
        return await this.imports.startImport(
          request.body.sourcePath,
          options.data,
          false,
          basename(request.body.sourcePath),
          this.currentUserId(request)
        );
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Import could not be started"
        });
      }
    });

    this.app.post<{ Body: unknown }>("/api/uploads", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = uploadSessionCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid upload" });
      }
      try {
        return await this.uploads.createOrResume(parsed.data, this.currentUserId(request));
      } catch (error) {
        if (error instanceof UploadValidationError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    });

    this.app.get("/api/uploads", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.uploads.list(this.currentUserId(request) ?? undefined);
    });

    this.app.get<{ Params: { uploadId: string } }>(
      "/api/uploads/:uploadId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const upload = this.uploads.get(request.params.uploadId);
        if (!upload) return reply.code(404).send({ error: "Upload session not found" });
        return upload;
      }
    );

    this.app.put<{ Params: { uploadId: string }; Body: Buffer }>(
      "/api/uploads/:uploadId/chunk",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const offsetValue = request.headers["x-upload-offset"];
        const offset = Number(Array.isArray(offsetValue) ? offsetValue[0] : offsetValue);
        if (!Buffer.isBuffer(request.body)) {
          return reply.code(400).send({ error: "Upload chunk must be binary data" });
        }
        try {
          return await this.uploads.append(request.params.uploadId, offset, request.body);
        } catch (error) {
          if (error instanceof UploadConflictError) {
            return reply.code(409).send({ error: error.message });
          }
          if (error instanceof UploadValidationError) {
            return reply.code(error.message.includes("not found") ? 404 : 400).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.post<{ Params: { uploadId: string } }>(
      "/api/uploads/:uploadId/complete",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return await this.uploads.complete(request.params.uploadId);
        } catch (error) {
          if (error instanceof UploadConflictError) {
            return reply.code(409).send({ error: error.message });
          }
          if (error instanceof UploadValidationError) {
            return reply.code(error.message.includes("not found") ? 404 : 400).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.delete<{ Params: { uploadId: string } }>(
      "/api/uploads/:uploadId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return await this.uploads.cancel(request.params.uploadId);
        } catch (error) {
          if (error instanceof UploadConflictError) {
            return reply.code(409).send({ error: error.message });
          }
          if (error instanceof UploadValidationError) {
            return reply.code(404).send({ error: error.message });
          }
          throw error;
        }
      }
    );

    this.app.get<{
      Querystring: { level?: string; category?: string; jobId?: string; limit?: string };
    }>("/api/diagnostics", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const userId = this.currentUserId(request) ?? undefined;
      const includeGlobal = Boolean(userId && userId === this.database.primaryAdminUserId());
      return {
        events: this.database.listDiagnostics({
          level: diagnosticLevel(request.query.level),
          category: diagnosticCategory(request.query.category),
          jobId: request.query.jobId,
          limit: optionalNumber(request.query.limit),
          ownerUserId: userId,
          includeGlobal
        }),
        importJobs: this.database.listImportJobs(userId),
        uploads: this.database.listUploadSessions(100, userId),
        gmailConnections: this.gmail.listConnections(userId),
        aiJobs: this.database.listAiJobs(300, userId).map(redactAiJobPrompt)
      };
    });

    this.app.get("/api/diagnostics/export", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const exportedAt = new Date().toISOString();
      const userId = this.currentUserId(request) ?? undefined;
      const includeGlobal = Boolean(userId && userId === this.database.primaryAdminUserId());
      const payload = {
        exportedAt,
        databasePath: this.database.path,
        events: this.database.listAllDiagnostics(userId, includeGlobal),
        importJobs: this.database.listImportJobs(userId),
        uploads: this.database.listUploadSessions(200, userId),
        gmailConnections: this.gmail.listConnections(userId),
        aiJobs: this.database.listAiJobs(1_000, userId).map(redactAiJobPrompt)
      };
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="email-client-diagnostics-${exportedAt.slice(0, 10)}.json"`);
      return reply.send(JSON.stringify(payload, null, 2));
    });

    this.app.delete("/api/diagnostics", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const userId = this.currentUserId(request) ?? undefined;
      const includeGlobal = Boolean(userId && userId === this.database.primaryAdminUserId());
      this.database.clearDiagnostics(userId, includeGlobal);
      return reply.code(204).send();
    });

    this.app.post<{ Body: unknown }>("/api/diagnostics/client", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = clientDiagnosticSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid diagnostic event" });
      return this.database.recordDiagnostic({
        ownerUserId: this.currentUserId(request),
        level: parsed.data.level,
        category: "client",
        message: parsed.data.message,
        stack: parsed.data.stack,
        context: {
          ...(parsed.data.context ?? {}),
          userAgent: request.headers["user-agent"] ?? null
        }
      });
    });

    this.app.get("/api/admin/settings", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.getAdminSettings();
    });

    this.app.get("/api/stocks/quotes", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.stocks.quotes();
    });

    // Display-only setting every session role needs for the ticker, unlike the full
    // admin-only /api/admin/settings/stocks payload (symbol list, settings file path, etc).
    this.app.get("/api/stocks/display-settings", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return { secondsPerSymbol: this.stocks.view().secondsPerSymbol };
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/stocks", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = stockSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Enter valid ticker symbols"
        });
      }
      try {
        const updated = this.stocks.update(parsed.data);
        this.database.recordDiagnostic({
          level: "info",
          category: "system",
          message: "Stock ticker configuration saved",
          context: {
            operation: "stock_ticker_update",
            symbols: updated.symbols,
            secondsPerSymbol: updated.secondsPerSymbol
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Stock ticker settings could not be saved"
        });
      }
    });

    this.app.get("/api/news/headlines", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.news.headlines();
    });

    // Display-only setting every session role needs for the ticker, unlike the full
    // admin-only /api/admin/settings/news payload (source list, settings file path, etc).
    this.app.get("/api/news/display-settings", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return { secondsPerHeadline: this.news.view().secondsPerHeadline };
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/news", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = newsSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Enter valid news sources"
        });
      }
      try {
        const updated = this.news.update(parsed.data);
        this.database.recordDiagnostic({
          level: "info",
          category: "system",
          message: "News ticker configuration saved",
          context: {
            operation: "news_ticker_update",
            enabledSources: updated.enabledSources,
            secondsPerHeadline: updated.secondsPerHeadline
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "News ticker settings could not be saved"
        });
      }
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/database", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = databaseSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Enter a valid database provider and connection string" });
      try {
        this.storageSettings.update(parsed.data);
        return this.getAdminSettings();
      } catch (error) {
        const statusCode = error instanceof UnsupportedDatabaseProviderError ? 409 : 400;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "Database settings could not be saved"
        });
      }
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/gmail", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = gmailSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Enter valid Gmail OAuth settings"
        });
      }
      try {
        const credentials = this.gmailSettings.update(parsed.data);
        this.gmail.configureCredentials(credentials.clientId, credentials.clientSecret);
        this.gmail.configureSyncInterval(this.gmailSettings.syncIntervalMinutes());
        this.gmail.configureMailboxActionSync(this.gmailSettings.syncMailboxActions());
        this.database.recordDiagnostic({
          level: "info",
          category: "gmail",
          message: "Gmail OAuth configuration saved",
          context: {
            operation: "oauth_configuration_update",
            clientSecretConfigured: Boolean(credentials.clientSecret),
            syncMailboxActions: this.gmailSettings.syncMailboxActions()
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        const statusCode = error instanceof GmailSettingsManagedError ? 409 : 400;
        const message = error instanceof Error ? error.message : "Gmail OAuth settings could not be saved";
        this.database.recordDiagnostic({
          level: "error",
          category: "gmail",
          message,
          stack: error instanceof Error ? error.stack : null,
          context: { operation: "oauth_configuration_update" }
        });
        return reply.code(statusCode).send({ error: message });
      }
    });

    this.app.delete("/api/admin/settings/gmail", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      try {
        const credentials = this.gmailSettings.clear();
        this.gmail.configureCredentials(credentials.clientId, credentials.clientSecret);
        this.gmail.configureSyncInterval(this.gmailSettings.syncIntervalMinutes());
        this.gmail.configureMailboxActionSync(this.gmailSettings.syncMailboxActions());
        this.database.recordDiagnostic({
          level: "info",
          category: "gmail",
          message: "Gmail OAuth configuration cleared",
          context: { operation: "oauth_configuration_clear" }
        });
        return this.getAdminSettings();
      } catch (error) {
        const statusCode = error instanceof GmailSettingsManagedError ? 409 : 400;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "Gmail OAuth settings could not be cleared"
        });
      }
    });

    this.app.get("/api/admin/calendar/accounts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.calendar.listAppleAccounts(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Body: unknown }>("/api/admin/calendar/accounts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = appleCalendarAccountCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter valid Apple Calendar credentials" });
      }
      try {
        return reply.code(201).send(await this.calendar.connectAppleAccount(
          parsed.data,
          this.currentUserId(request)
        ));
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Apple Calendar authorization failed"
        });
      }
    });

    this.app.delete<{ Params: { accountId: string } }>("/api/admin/calendar/accounts/:accountId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const removed = this.calendar.disconnectAppleAccount(request.params.accountId);
      if (!removed) return reply.code(404).send({ error: "Apple Calendar account not found" });
      return reply.code(204).send();
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/drafts", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = draftSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Enter valid draft identity settings"
        });
      }
      try {
        const updated = this.draftSettings.update(parsed.data);
        this.database.recordDiagnostic({
          level: "info",
          category: "system",
          message: "Draft identity configuration saved",
          context: {
            operation: "draft_identity_update",
            defaultFromAddress: updated.defaultFromAddress,
            senderName: updated.senderName
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Draft identity settings could not be saved"
        });
      }
    });

    this.app.patch<{ Body: unknown }>("/api/admin/settings/ai", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = aiSettingsPatchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "Enter valid AI settings"
        });
      }
      try {
        const updated = this.aiSettings.update(parsed.data);
        this.ai.configurationChanged();
        this.database.recordDiagnostic({
          level: "info",
          category: "ai",
          message: "AI configuration saved",
          context: {
            operation: "configuration_update",
            provider: updated.provider,
            enabled: updated.enabled,
            model: updated.model,
            apiKeyConfigured: Boolean(updated.apiKey),
            dailyRequestLimit: updated.dailyRequestLimit,
            monthlyRequestLimit: updated.monthlyRequestLimit
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        const message = error instanceof Error ? error.message : "AI settings could not be saved";
        this.database.recordDiagnostic({
          level: "error",
          category: "ai",
          message,
          stack: error instanceof Error ? error.stack : null,
          context: { operation: "configuration_update" }
        });
        return reply.code(400).send({ error: message });
      }
    });

    this.app.post<{ Body: unknown }>("/api/admin/settings/ai/active", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = aiActiveProviderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose a provider" });
      }
      const updated = this.aiSettings.setActiveProvider(parsed.data.provider);
      this.ai.configurationChanged();
      this.database.recordDiagnostic({
        level: "info",
        category: "ai",
        message: `Active AI provider switched to ${AI_PROVIDER_INFO[updated.provider].label}`,
        context: { operation: "configuration_active_provider", provider: updated.provider }
      });
      return this.getAdminSettings();
    });

    this.app.delete<{ Querystring: { provider?: string } }>("/api/admin/settings/ai/key", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const provider = parseAiProvider(request.query.provider) ?? this.aiSettings.current().provider;
      const providerLabel = AI_PROVIDER_INFO[provider].label;
      try {
        this.aiSettings.clearApiKey(provider);
        this.database.recordDiagnostic({
          level: "info",
          category: "ai",
          message: `Saved ${providerLabel} API key cleared`,
          context: { operation: "configuration_key_clear", provider }
        });
        return this.getAdminSettings();
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : `${providerLabel} API key could not be cleared`
        });
      }
    });

    this.app.post<{ Querystring: { provider?: string } }>("/api/admin/settings/ai/test", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const provider = parseAiProvider(request.query.provider) ?? this.aiSettings.current().provider;
      try {
        await this.ai.testConnection(provider);
        return { ok: true };
      } catch (error) {
        const statusCode = error instanceof AiConfigurationError ? 503 : 502;
        const providerLabel = AI_PROVIDER_INFO[provider].label;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : `${providerLabel} connection test failed`
        });
      }
    });

    this.app.get<{ Querystring: { provider?: string } }>("/api/admin/settings/ai/models", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const provider = parseAiProvider(request.query.provider);
      if (!provider) return reply.code(400).send({ error: "Provide a valid provider" });
      try {
        return await this.ai.listModels(provider);
      } catch (error) {
        const statusCode = error instanceof AiConfigurationError ? 503 : 502;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "Model list could not be loaded"
        });
      }
    });

    this.app.get("/api/admin/ai-schedules", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.database.listAiSchedules(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Body: unknown }>("/api/admin/reply-styles", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = replyStyleCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid reply style" });
      try {
        return this.database.createReplyStyle(parsed.data, this.currentUserId(request));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "Reply style could not be created" });
      }
    });

    this.app.patch<{ Params: { styleId: string }; Body: unknown }>(
      "/api/admin/reply-styles/:styleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = replyStylePatchSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid reply style update" });
        try {
          return this.database.updateReplyStyle(request.params.styleId, parsed.data);
        } catch (error) {
          return reply.code(404).send({ error: error instanceof Error ? error.message : "Reply style not found" });
        }
      }
    );

    this.app.delete<{ Params: { styleId: string } }>(
      "/api/admin/reply-styles/:styleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        return this.database.deleteReplyStyle(request.params.styleId)
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Reply style not found" });
      }
    );

    this.app.get<{ Querystring: { archiveId?: string } }>("/api/admin/smart-mail-rules", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.database.listSmartMailRules(
        request.query.archiveId,
        this.currentUserId(request) ?? undefined
      );
    });

    this.app.post<{ Body: unknown }>("/api/admin/smart-mail-rules/suggest", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = smartMailRuleSuggestionRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Describe a valid mail rule" });
      try {
        return await this.ai.suggestSmartMailRule(parsed.data.archiveId, parsed.data.instruction);
      } catch (error) {
        if (error instanceof AiBudgetError) return reply.code(429).send({ error: error.message });
        if (error instanceof AiConfigurationError) return reply.code(503).send({ error: error.message });
        return reply.code(502).send({ error: error instanceof Error ? error.message : "Mail rule suggestion failed" });
      }
    });

    this.app.post<{ Body: unknown }>("/api/admin/smart-mail-rules", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = smartMailRuleCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid mail rule" });
      try {
        return this.database.createSmartMailRule(parsed.data);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Mail rule could not be created" });
      }
    });

    this.app.patch<{ Params: { ruleId: string }; Body: unknown }>(
      "/api/admin/smart-mail-rules/:ruleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = smartMailRulePatchSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid mail rule update" });
        try {
          return this.database.updateSmartMailRule(request.params.ruleId, parsed.data);
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : "Mail rule could not be updated" });
        }
      }
    );

    this.app.post<{ Params: { ruleId: string }; Body: unknown }>(
      "/api/admin/smart-mail-rules/:ruleId/run",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = smartMailRuleRunSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose a valid rule scope" });
        }
        try {
          const rule = this.database.getSmartMailRule(request.params.ruleId);
          if (!rule) return reply.code(404).send({ error: "Mail rule not found" });
          const task = this.mailboxTasks.enqueueSmartRuleRun({
            archiveId: rule.archiveId,
            ruleIds: [rule.id],
            scope: parsed.data.scope
          });
          return reply.code(202).send(task);
        } catch (error) {
          return reply.code(400).send({ error: error instanceof Error ? error.message : "Mail rule could not run" });
        }
      }
    );

    this.app.post<{ Body: unknown }>("/api/admin/smart-mail-rules/run", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = smartMailRuleBatchRunSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Choose valid mail rules and scope" });
      }
      try {
        return reply.code(202).send(this.mailboxTasks.enqueueSmartRuleRun(parsed.data));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "Mail rules could not run" });
      }
    });

    this.app.get<{ Params: { taskId: string } }>("/api/admin/mailbox-tasks/:taskId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const task = this.mailboxTasks.getTask(request.params.taskId);
      const userId = this.currentUserId(request);
      if (task && userId && !this.database.ownsResource(userId, "archive", task.archiveId)) {
        return reply.code(404).send({ error: "Mailbox task not found" });
      }
      return task ?? reply.code(404).send({ error: "Mailbox task not found" });
    });

    this.app.post<{ Params: { taskId: string } }>("/api/admin/mailbox-tasks/:taskId/cancel", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      try {
        const task = this.mailboxTasks.getTask(request.params.taskId);
        const userId = this.currentUserId(request);
        if (!task || (userId && !this.database.ownsResource(userId, "archive", task.archiveId))) {
          return reply.code(404).send({ error: "Mailbox task not found" });
        }
        return this.mailboxTasks.cancelTask(request.params.taskId);
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Mailbox task not found" });
      }
    });

    this.app.delete<{ Params: { ruleId: string } }>(
      "/api/admin/smart-mail-rules/:ruleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        return this.database.deleteSmartMailRule(request.params.ruleId)
          ? reply.code(204).send()
          : reply.code(404).send({ error: "Mail rule not found" });
      }
    );

    this.app.get("/api/admin/resumes", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.resumes.list(this.currentUserId(request) ?? undefined);
    });

    this.app.post<{ Querystring: { filename?: string; name?: string }; Body: unknown }>(
      "/api/admin/resumes",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        if (!request.query.filename || !Buffer.isBuffer(request.body)) {
          return reply.code(400).send({ error: "Choose a resume file" });
        }
        try {
          return await this.resumes.upload(
            request.query.filename,
            request.body,
            request.query.name,
            this.currentUserId(request)
          );
        } catch (error) {
          const status = error instanceof ResumeValidationError ? 400 : 500;
          return reply.code(status).send({
            error: error instanceof Error ? error.message : "Resume could not be uploaded"
          });
        }
      }
    );

    this.app.get<{ Params: { resumeId: string } }>(
      "/api/admin/resumes/:resumeId/download",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          const { asset, content } = await this.resumes.read(request.params.resumeId);
          reply.header("Content-Type", asset.contentType);
          reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
          return reply.send(content);
        } catch (error) {
          return reply.code(error instanceof ResumeNotFoundError ? 404 : 500).send({
            error: error instanceof Error ? error.message : "Resume could not be downloaded"
          });
        }
      }
    );

    this.app.delete<{ Params: { resumeId: string } }>("/api/admin/resumes/:resumeId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      try {
        await this.resumes.remove(request.params.resumeId);
        return reply.code(204).send();
      } catch (error) {
        return reply.code(error instanceof ResumeNotFoundError ? 404 : 500).send({
          error: error instanceof Error ? error.message : "Resume could not be removed"
        });
      }
    });

    this.app.post<{ Body: unknown }>("/api/admin/ai-schedules", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = aiScheduleCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid AI schedule" });
      }
      try {
        const schedule = this.database.createAiSchedule(parsed.data, this.currentUserId(request));
        this.database.recordDiagnostic({
          level: "info",
          category: "ai",
          message: `AI schedule "${schedule.name}" created`,
          context: { operation: "schedule_create", scheduleId: schedule.id, folderId: schedule.folderId, mode: schedule.mode }
        });
        return schedule;
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "AI schedule could not be created" });
      }
    });

    this.app.patch<{ Params: { scheduleId: string }; Body: unknown }>(
      "/api/admin/ai-schedules/:scheduleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["admin"])) return;
        const parsed = aiScheduleUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Enter a valid AI schedule" });
        }
        try {
          return this.database.updateAiSchedule(request.params.scheduleId, parsed.data);
        } catch (error) {
          const message = error instanceof Error ? error.message : "AI schedule could not be updated";
          return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
        }
      }
    );

    this.app.delete<{ Params: { scheduleId: string } }>("/api/admin/ai-schedules/:scheduleId", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      this.database.deleteAiSchedule(request.params.scheduleId);
      return reply.code(204).send();
    });

    this.app.post<{ Params: { scheduleId: string } }>(
      "/api/admin/ai-schedules/:scheduleId/run",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["admin"])) return;
        try {
          return await this.aiSchedules.runNow(request.params.scheduleId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "AI schedule could not run";
          return reply.code(message.includes("not found") ? 404 : 500).send({ error: message });
        }
      }
    );

    this.app.get<{ Querystring: { archiveId?: string } }>("/api/admin/sender-filing", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = senderFilingArchiveSchema.safeParse({ archiveId: request.query.archiveId });
      if (!parsed.success) return reply.code(400).send({ error: "Choose a valid archive" });
      try {
        return this.database.getSenderFilingStatus(parsed.data.archiveId);
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Archive not found" });
      }
    });

    this.app.post<{ Body: unknown }>("/api/admin/sender-filing/organize", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = senderFilingArchiveSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Choose a valid archive" });
      try {
        const status = this.database.organizeTopSenderFolders(parsed.data.archiveId);
        this.database.recordDiagnostic({
          level: "info",
          category: "system",
          message: `Top sender organization completed for ${status.archiveName}`,
          archiveId: status.archiveId,
          context: {
            operation: "sender_filing_organize",
            ruleCount: status.rules.length,
            movedMessages: status.lastRunMovedMessages,
            createdFolders: status.lastRunCreatedFolders
          }
        });
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Top senders could not be organized";
        return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
      }
    });

    this.app.patch<{ Params: { ruleId: string }; Body: unknown }>(
      "/api/admin/sender-filing/rules/:ruleId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        const parsed = messageMoveSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Choose a valid destination mailbox" });
        try {
          const result = this.database.updateSenderFilingRuleFolder(request.params.ruleId, parsed.data.folderId);
          this.database.recordDiagnostic({
            level: "info",
            category: "system",
            message: `Sender rule moved to ${result.folderPath}: ${result.senderAddress}`,
            archiveId: result.status.archiveId,
            context: {
              operation: "sender_filing_destination_updated",
              ruleId: request.params.ruleId,
              folderId: parsed.data.folderId,
              folderPath: result.folderPath,
              movedMessages: result.movedMessages
            }
          });
          return result.status;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sender rule could not be updated";
          return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
        }
      }
    );

    this.app.delete<{ Querystring: { archiveId?: string } }>("/api/admin/sender-filing", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = senderFilingArchiveSchema.safeParse({ archiveId: request.query.archiveId });
      if (!parsed.success) return reply.code(400).send({ error: "Choose a valid archive" });
      try {
        const status = this.database.clearSenderFilingRules(parsed.data.archiveId);
        this.database.recordDiagnostic({
          level: "info",
          category: "system",
          message: `Automatic sender filing disabled for ${status.archiveName}`,
          archiveId: status.archiveId,
          context: { operation: "sender_filing_disable" }
        });
        return status;
      } catch (error) {
        return reply.code(404).send({ error: error instanceof Error ? error.message : "Archive not found" });
      }
    });

    this.app.get("/api/admin/insights", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.database.getAdminInsights(this.currentUserId(request) ?? undefined);
    });

    this.app.get("/api/admin/users", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.auth.listUsers();
    });

    this.app.post<{ Body: unknown }>("/api/admin/users", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const parsed = userCreateSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Enter a valid username, name, role, and PIN" });
      try {
        return this.auth.createUser(parsed.data);
      } catch (error) {
        const statusCode = error instanceof AuthConflictError ? 409 : 400;
        return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "User could not be created" });
      }
    });

    this.app.patch<{ Params: { userId: string }; Body: unknown }>(
      "/api/admin/users/:userId",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["admin"])) return;
        const parsed = userUpdateSchema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: "Enter at least one valid user setting" });
        try {
          return this.auth.updateUser(request.params.userId, parsed.data);
        } catch (error) {
          const statusCode = error instanceof AuthConflictError ? 409
            : error instanceof AuthError ? 404
              : 400;
          return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "User could not be updated" });
        }
      }
    );

    this.app.get<{
      Querystring: {
        username?: string;
        action?: string;
        ipAddress?: string;
        success?: string;
        cursor?: string;
        limit?: string;
      };
    }>("/api/admin/audit", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.database.listAudit({
        username: request.query.username,
        action: request.query.action,
        ipAddress: request.query.ipAddress,
        success: optionalBoolean(request.query.success),
        cursor: request.query.cursor,
        limit: optionalNumber(request.query.limit)
      });
    });

    this.app.get("/api/admin/audit/export", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      const exportedAt = new Date().toISOString();
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="archive-mail-audit-${exportedAt.slice(0, 10)}.json"`);
      return reply.send(JSON.stringify({
        exportedAt,
        events: this.database.listAllAudit()
      }, null, 2));
    });

    this.app.get("/api/sharing", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      return this.getSharingState();
    });

    this.app.post<{ Body: { enabled?: boolean } }>(
      "/api/admin/sharing",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["admin"])) return;
        return this.setSharingEnabled(Boolean(request.body?.enabled));
      }
    );
  }

  private async registerStaticFiles(): Promise<void> {
    if (!this.config.staticDir || !existsSync(resolve(this.config.staticDir, "index.html"))) return;
    await this.app.register(fastifyStatic, {
      root: this.config.staticDir,
      wildcard: false,
      decorateReply: true
    });
    this.app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  private registerErrorHandler(): void {
    this.app.setErrorHandler((error, request, reply) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const errorWithStatus = error as { statusCode?: number };
      const statusCode = errorWithStatus.statusCode && errorWithStatus.statusCode >= 400
        ? errorWithStatus.statusCode
        : 500;
      if (statusCode >= 500) {
        try {
          this.database.recordDiagnostic({
            level: "error",
            category: "api",
            message: normalized.message || "Unexpected local API error",
            stack: normalized.stack,
            context: { method: request.method, url: request.url, statusCode }
          });
        } catch (diagnosticError) {
          request.log.error(diagnosticError, "Could not persist API diagnostic");
        }
        request.log.error(normalized);
      }
      return reply.code(statusCode).send({
        error: statusCode >= 500
          ? "The local email service encountered an unexpected error. Open Diagnostics for details."
          : normalized.message
      });
    });
  }

  private requireRole(
    request: FastifyRequest,
    reply: FastifyReply,
    roles: Role[]
  ): Role | null {
    const role = this.resolveRole(request);
    if (role && roles.includes(role)) return role;
    reply.code(role ? 403 : 401).send({
      error: role ? "This viewer is read-only" : "Authorization required"
    });
    return null;
  }

  private calendarErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
    const message = error instanceof Error ? error.message : "Calendar request failed";
    if (message.includes("not found")) return reply.code(404).send({ error: message });
    if (error instanceof GmailPermissionError) return reply.code(409).send({ error: message });
    return reply.code(502).send({ error: message });
  }

  private mailboxActionErrorReply(reply: FastifyReply, error: unknown, fallback: string): FastifyReply {
    const message = error instanceof Error ? error.message : fallback;
    if (message.toLowerCase().includes("not found")) return reply.code(404).send({ error: message });
    if (error instanceof GmailPermissionError) return reply.code(409).send({ error: message });
    if (/^(Gmail|Google)\b/.test(message)) return reply.code(502).send({ error: message });
    return reply.code(400).send({ error: message });
  }

  private resolveRole(request: FastifyRequest): Role | null {
    const loopback = isLoopback(request.ip);
    if (this.config.devAuthBypass && loopback) return "admin";
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const session = this.resolveSession(request);
    if (session) return session.role === "user" ? "local" : session.role;
    if (loopback && bearer === this.adminToken) return "admin";
    if (loopback && bearer === this.localToken) return "local";
    return null;
  }

  private currentUserId(request: FastifyRequest): string | null {
    const session = this.resolveSession(request);
    if (session) return session.user.id;
    return this.resolveRole(request) ? this.database.primaryAdminUserId() : null;
  }

  private resolveSession(request: FastifyRequest): AuthSessionRecord | null {
    const cached = this.requestSessions.get(request);
    if (cached !== undefined) return cached;
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const session = this.auth.authenticate(bearer, request.ip);
    this.requestSessions.set(request, session);
    return session;
  }

  private recordRequestAudit(request: FastifyRequest, statusCode: number): void {
    const session = this.resolveSession(request);
    const route = request.routeOptions.url || request.url.split("?", 1)[0]!;
    const path = request.url.split("?", 1)[0]!;
    this.database.recordAudit({
      sessionId: session?.id ?? null,
      userId: session?.user.id ?? null,
      username: session?.user.username ?? null,
      displayName: session?.user.displayName ?? null,
      role: session?.role ?? null,
      action: `${request.method} ${route}`,
      method: request.method,
      path,
      statusCode,
      success: statusCode < 400,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null
    });
  }

  private recordAuthAudit(
    request: FastifyRequest,
    session: AuthSessionRecord | null,
    action: string,
    statusCode: number,
    success: boolean,
    details?: Record<string, unknown>
  ): void {
    this.database.recordAudit({
      sessionId: session?.id ?? null,
      userId: session?.user.id ?? null,
      username: session?.user.username ?? null,
      displayName: session?.user.displayName ?? null,
      role: session?.role ?? null,
      action,
      method: request.method,
      path: request.url.split("?", 1)[0]!,
      statusCode,
      success,
      ipAddress: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
      details
    });
  }

  // Finds a same-mailbox sibling folder by name (preferring one under the message's
  // current parent, matching how a single-message Archive move already resolves its
  // destination), creating it if none exists. Reused by the bulk Delete/Archive/Spam action.
  private resolveNamedFolder(
    archiveId: string,
    currentFolderId: string,
    matchNames: string[],
    createName: string
  ): { id: string; path: string } {
    const currentFolder = this.database.getFolder(currentFolderId);
    const availableFolders = this.database.listFolders(archiveId);
    const nameSet = new Set(matchNames.map((name) => name.toLowerCase()));
    const parentId = currentFolder?.parentId ?? null;
    return availableFolders.find((folder) => folder.parentId === parentId && nameSet.has(folder.name.trim().toLowerCase()))
      ?? availableFolders.find((folder) => nameSet.has(folder.name.trim().toLowerCase()))
      ?? this.database.createFolder(archiveId, createName, parentId);
  }

  private async markSelectedSendersAsSpam(messageIds: string[]): Promise<BulkMoveResult> {
    const selected = [...new Set(messageIds)];
    const folderCache = new Map<string, { id: string; path: string }>();
    const folderPaths = new Set<string>();
    const remoteGroups = new Map<string, Set<string>>();
    const pending: Array<{
      messageId: string;
      archiveId: string;
      senderAddress: string;
    }> = [];
    let failed = 0;
    let alreadyThere = 0;

    for (const messageId of selected) {
      const message = this.database.getMessage(messageId);
      if (!message) {
        failed += 1;
        continue;
      }
      let spamFolder = folderCache.get(message.archiveId);
      if (!spamFolder) {
        spamFolder = this.resolveNamedFolder(message.archiveId, message.folderId, ["spam", "junk"], "Spam");
        folderCache.set(message.archiveId, spamFolder);
      }
      folderPaths.add(spamFolder.path);
      const isAlreadyThere = message.folderId === spamFolder.id;
      if (isAlreadyThere) alreadyThere += 1;
      const senderAddress = message.sender.address.trim().toLowerCase();
      if (!senderAddress) {
        failed += 1;
        continue;
      }
      const remoteMessageIds = remoteGroups.get(spamFolder.id) ?? new Set<string>();
      for (const relatedMessageId of this.database.listSenderMessageIds(messageId, true)) {
        remoteMessageIds.add(relatedMessageId);
      }
      remoteGroups.set(spamFolder.id, remoteMessageIds);
      pending.push({
        messageId,
        archiveId: message.archiveId,
        senderAddress
      });
    }

    for (const [spamFolderId, relatedMessageIds] of remoteGroups) {
      await this.gmail.syncMessagesMove([...relatedMessageIds], spamFolderId);
    }

    let moved = 0;
    const senderRules = new Set<string>();
    for (const item of pending) {
      try {
        const result = this.database.markSenderAsSpam(item.messageId);
        moved += result.movedMessages;
        senderRules.add(`${item.archiveId}:${item.senderAddress}`);
      } catch {
        failed += 1;
      }
    }

    return {
      destination: "spam",
      folderPaths: [...folderPaths],
      moved,
      alreadyThere,
      failed,
      senderRules: senderRules.size
    };
  }

  private getAdminSettings(): AdminSettings {
    const configured = this.storageSettings.current();
    return {
      database: {
        activeProvider: this.activeStorage.provider,
        activeConnectionString: this.activeStorage.connectionString,
        configuredProvider: configured.provider,
        configuredConnectionString: configured.connectionString,
        restartRequired: configured.provider !== this.activeStorage.provider
          || configured.connectionString !== this.activeStorage.connectionString,
        providers: DATABASE_PROVIDERS,
        structuredDataPath: this.database.path,
        attachmentBlobPath: this.blobStore.rootDir
      },
      security: {
        sessionLifetimeMinutes: this.auth.sessionLifetimeMinutes,
        defaultPinWarning: this.auth.hasDefaultPinWarning()
      },
      gmail: this.gmailSettings.view(),
      drafts: this.draftSettings.view(),
      stocks: this.stocks.view(),
      news: this.news.view(),
      ai: this.aiSettings.view(this.database.getAiUsageSummary())
    };
  }

  private isValidPairingToken(token: string | undefined): boolean {
    return Boolean(token && token === this.shareToken && this.isSharingActive());
  }

  private isSharingActive(): boolean {
    if (!this.shareToken || !this.shareExpiresAt) return false;
    if (this.shareExpiresAt.getTime() <= Date.now()) {
      this.shareToken = null;
      this.shareExpiresAt = null;
      return false;
    }
    return true;
  }
}

export async function startServer(
  overrides: Partial<ApiConfig> = {}
): Promise<StartedApi> {
  const runtime = new EmailApiRuntime(loadConfig(overrides));
  await runtime.initialize();
  return runtime.listen();
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function redactAiJobPrompt(job: AiJob): AiJob {
  return { ...job, prompt: job.prompt ? "[configured prompt omitted]" : "" };
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

function parseInboxCategory(value: string | undefined): InboxCategory | undefined {
  return INBOX_CATEGORIES.includes(value as InboxCategory) ? value as InboxCategory : undefined;
}

function diagnosticLevel(value: string | undefined): DiagnosticLevel | undefined {
  return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function diagnosticCategory(value: string | undefined): DiagnosticCategory | undefined {
  return value === "upload" || value === "import" || value === "parser"
    || value === "attachment" || value === "gmail" || value === "ai" || value === "api" || value === "client"
    || value === "system"
    ? value
    : undefined;
}

function parseAiProvider(value: string | undefined): AiProviderId | undefined {
  return AI_PROVIDER_IDS.includes(value as AiProviderId) ? value as AiProviderId : undefined;
}

function safeFilename(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 240) || "archive";
}

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".text": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8"
};

function attachmentContentType(contentType: string, filename: string): string {
  const declared = contentType.trim();
  const mediaType = declared.split(";", 1)[0]?.toLowerCase();
  if (mediaType && mediaType !== "application/octet-stream" && mediaType !== "binary/octet-stream") {
    return declared;
  }
  return ATTACHMENT_CONTENT_TYPES[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

function oauthResultPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px system-ui, sans-serif; color: #26332b; background: #f3f5f2; }
    main { width: min(440px, calc(100% - 40px)); padding: 28px; border: 1px solid #ccd4ce; border-radius: 8px; background: #fff; box-shadow: 0 16px 48px rgba(25, 37, 29, .12); }
    h1 { margin: 0 0 10px; font-size: 20px; }
    p { margin: 0; color: #5d6a61; line-height: 1.5; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function findLanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}
