import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { basename, resolve } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import {
  aiSettingsPatchSchema,
  archiveMergeSchema,
  authLoginSchema,
  clientDiagnosticSchema,
  databaseSettingsPatchSchema,
  displayNamePatchSchema,
  gmailAuthRequestSchema,
  gmailSettingsPatchSchema,
  gmailSendRequestSchema,
  importOptionsSchema,
  localMessageStatePatchSchema,
  mailboxCreateSchema,
  mailboxMergeSchema,
  pinChangeSchema,
  uploadSessionCreateSchema,
  userCreateSchema,
  userUpdateSchema,
  type AdminSettings,
  type DiagnosticCategory,
  type DiagnosticLevel,
  type ImportOptions,
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
import {
  GmailAuthorizationError,
  GmailConfigurationError,
  GmailPermissionError,
  GmailService
} from "./services/gmail-service.js";
import {
  GmailSettingsManagedError,
  GmailSettingsManager
} from "./services/gmail-settings.js";
import {
  AiConfigurationError,
  AiJobNotFoundError,
  AiMessageNotFoundError,
  AiService
} from "./services/ai-service.js";
import {
  AiSettingsManagedError,
  AiSettingsManager
} from "./services/ai-settings.js";
import {
  UploadConflictError,
  UploadService,
  UploadValidationError
} from "./services/upload-service.js";

type Role = "viewer" | "local" | "admin";

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
  readonly ai: AiService;
  readonly aiSettings: AiSettingsManager;
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
      bodyLimit: 5 * 1024 * 1024
    });
    this.storageSettings = new StorageSettingsManager(config.dataDir);
    this.activeStorage = createEmailStore(config.dataDir, this.storageSettings.current());
    this.database = this.activeStorage.store;
    this.auth = new AuthService(this.database, config.sessionLifetimeMinutes);
    this.blobStore = new BlobStore(config.dataDir);
    this.imports = new ImportService(this.database, this.blobStore);
    this.gmailSettings = new GmailSettingsManager(config.dataDir, {
      clientId: config.gmailClientId,
      clientSecret: config.gmailClientSecret
    });
    const gmailCredentials = this.gmailSettings.credentials();
    this.gmail = new GmailService(this.database, this.imports, {
      clientId: gmailCredentials.clientId,
      clientSecret: gmailCredentials.clientSecret,
      redirectUri: () => `http://127.0.0.1:${this.listeningPort}/api/gmail/oauth/callback`
    });
    this.aiSettings = new AiSettingsManager(config.dataDir, config.openAiApiKey);
    this.ai = new AiService(this.database, this.aiSettings);
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
      origin: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Upload-Offset"]
    });
    this.app.addContentTypeParser("application/octet-stream", {
      parseAs: "buffer",
      bodyLimit: 5 * 1024 * 1024
    }, (_request, body, done) => {
      done(null, body);
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
      if (remote && !this.isValidPairingToken(parsed.data.pairingToken)) {
        this.recordAuthAudit(request, null, "auth.login", 403, false, { reason: "pairing_required" });
        return reply.code(403).send({ error: "A valid desktop pairing link is required" });
      }
      try {
        const result = this.auth.login({
          username: parsed.data.username,
          pin: parsed.data.pin,
          ipAddress: request.ip,
          userAgent: request.headers["user-agent"] ?? null,
          roleCap: remote ? "viewer" : undefined,
          expiresAtCap: remote ? this.shareExpiresAt : null
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
      return this.database.listArchives();
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
        cursor?: string;
        limit?: string;
      };
    }>("/api/messages", async (request, reply) => {
      if (!this.requireRole(request, reply, ["viewer", "local", "admin"])) return;
      return this.database.listMessages({
        archiveId: request.query.archiveId,
        folderId: request.query.folderId,
        cursor: request.query.cursor,
        limit: optionalNumber(request.query.limit)
      });
    });

    this.app.get<{
      Querystring: {
        q?: string;
        archiveId?: string;
        folderId?: string;
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
      return this.database.search({
        q: query,
        archiveId: request.query.archiveId,
        folderId: request.query.folderId,
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
        return this.database.updateMessageState(request.params.messageId, parsed.data);
      } catch {
        return reply.code(404).send({ error: "Message not found" });
      }
    });

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
        reply.header("Content-Type", result.attachment.contentType);
        reply.header(
          "Content-Disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(safeFilename(result.attachment.filename))}`
        );
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(createReadStream(this.blobStore.resolve(result.relativePath)));
      }
    );

    this.app.get("/api/gmail/connections", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.gmail.listConnections();
    });

    this.app.post<{ Body: unknown }>("/api/gmail/oauth/start", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = gmailAuthRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid Gmail destination" });
      }
      try {
        return this.gmail.startAuthorization(parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Gmail authorization could not start";
        this.database.recordDiagnostic({
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

    this.app.post<{ Params: { connectionId: string } }>(
      "/api/gmail/connections/:connectionId/sync",
      async (request, reply) => {
        if (!this.requireRole(request, reply, ["local", "admin"])) return;
        try {
          return this.gmail.startSync(request.params.connectionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Gmail sync could not start";
          return reply.code(message.includes("not found") ? 404 : 409).send({ error: message });
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

    this.app.get("/api/import-jobs", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.database.listImportJobs();
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
        return await this.imports.startImport(request.body.sourcePath, options.data);
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
        return await this.uploads.createOrResume(parsed.data);
      } catch (error) {
        if (error instanceof UploadValidationError) {
          return reply.code(400).send({ error: error.message });
        }
        throw error;
      }
    });

    this.app.get("/api/uploads", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      return this.uploads.list();
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
      return {
        events: this.database.listDiagnostics({
          level: diagnosticLevel(request.query.level),
          category: diagnosticCategory(request.query.category),
          jobId: request.query.jobId,
          limit: optionalNumber(request.query.limit)
        }),
        importJobs: this.database.listImportJobs(),
        uploads: this.database.listUploadSessions(100),
        gmailConnections: this.gmail.listConnections(),
        aiJobs: this.database.listAiJobs(300)
      };
    });

    this.app.get("/api/diagnostics/export", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const exportedAt = new Date().toISOString();
      const payload = {
        exportedAt,
        databasePath: this.database.path,
        events: this.database.listAllDiagnostics(),
        importJobs: this.database.listImportJobs(),
        uploads: this.database.listUploadSessions(200),
        gmailConnections: this.gmail.listConnections(),
        aiJobs: this.database.listAiJobs(1_000)
      };
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="email-client-diagnostics-${exportedAt.slice(0, 10)}.json"`);
      return reply.send(JSON.stringify(payload, null, 2));
    });

    this.app.delete("/api/diagnostics", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      this.database.clearDiagnostics();
      return reply.code(204).send();
    });

    this.app.post<{ Body: unknown }>("/api/diagnostics/client", async (request, reply) => {
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
      const parsed = clientDiagnosticSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid diagnostic event" });
      return this.database.recordDiagnostic({
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
        this.database.recordDiagnostic({
          level: "info",
          category: "gmail",
          message: "Gmail OAuth configuration saved",
          context: {
            operation: "oauth_configuration_update",
            clientSecretConfigured: Boolean(credentials.clientSecret)
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
            enabled: updated.enabled,
            model: updated.model,
            apiKeyConfigured: Boolean(updated.apiKey),
            dailyRequestLimit: updated.dailyRequestLimit,
            monthlyRequestLimit: updated.monthlyRequestLimit
          }
        });
        return this.getAdminSettings();
      } catch (error) {
        const statusCode = error instanceof AiSettingsManagedError ? 409 : 400;
        const message = error instanceof Error ? error.message : "AI settings could not be saved";
        this.database.recordDiagnostic({
          level: "error",
          category: "ai",
          message,
          stack: error instanceof Error ? error.stack : null,
          context: { operation: "configuration_update" }
        });
        return reply.code(statusCode).send({ error: message });
      }
    });

    this.app.delete("/api/admin/settings/ai/key", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      try {
        this.aiSettings.clearApiKey();
        this.database.recordDiagnostic({
          level: "info",
          category: "ai",
          message: "Saved OpenAI API key cleared",
          context: { operation: "configuration_key_clear" }
        });
        return this.getAdminSettings();
      } catch (error) {
        const statusCode = error instanceof AiSettingsManagedError ? 409 : 400;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "OpenAI API key could not be cleared"
        });
      }
    });

    this.app.post("/api/admin/settings/ai/test", async (request, reply) => {
      if (!this.requireRole(request, reply, ["admin"])) return;
      try {
        await this.ai.testConnection();
        return { ok: true };
      } catch (error) {
        const statusCode = error instanceof AiConfigurationError ? 503 : 502;
        return reply.code(statusCode).send({
          error: error instanceof Error ? error.message : "OpenAI connection test failed"
        });
      }
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
      if (!this.requireRole(request, reply, ["local", "admin"])) return;
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

function safeFilename(value: string): string {
  return basename(value).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 240) || "archive";
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
