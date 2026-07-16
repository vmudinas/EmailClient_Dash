import { createHash, randomBytes, randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type {
  GmailAuthRequest,
  GmailAuthStart,
  GmailConnection,
  GmailSendAsAlias,
  GmailSendRequest,
  GmailSendResult
} from "@email-client/shared";
import { normalizeRfc822Message } from "../importers/mbox-importer.js";
import type { RawAttachment } from "../importers/types.js";
import {
  type EmailStore,
  type GmailConnectionRecord
} from "../storage/database.js";
import { ImportService } from "./import-service.js";

const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, GMAIL_SETTINGS_SCOPE, CALENDAR_EVENTS_SCOPE];
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

interface PendingAuthorization {
  request: GmailAuthRequest;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailRawMessage {
  id: string;
  threadId?: string;
  raw?: string;
  labelIds?: string[];
}

interface GmailSendResponse {
  id: string;
  threadId?: string;
}

interface GmailProfile {
  emailAddress: string;
}

interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

interface GmailLabelsResponse {
  labels?: GmailLabel[];
}

interface GmailSendAsEntry {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  verificationStatus?: string;
}

interface GmailSendAsResponse {
  sendAs?: GmailSendAsEntry[];
}

const SYSTEM_FOLDER_LABELS: Array<{ id: string; folder: string }> = [
  { id: "TRASH", folder: "Trash" },
  { id: "SPAM", folder: "Spam" },
  { id: "DRAFT", folder: "Drafts" },
  { id: "SENT", folder: "Sent" },
  { id: "INBOX", folder: "Inbox" }
];

export interface GmailServiceOptions {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri(): string;
  fetcher?: typeof fetch;
  syncIntervalMinutes?: number;
}

export class GmailConfigurationError extends Error {}
export class GmailAuthorizationError extends Error {}
export class GmailPermissionError extends Error {}

export interface GmailOutgoingAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export class GmailService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly fetcher: typeof fetch;
  private clientId: string | null;
  private clientSecret: string | null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncIntervalMinutes = 0;

  constructor(
    private readonly database: EmailStore,
    private readonly imports: ImportService,
    private readonly options: GmailServiceOptions
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.configureSyncInterval(options.syncIntervalMinutes ?? 0);
  }

  configureCredentials(clientId: string | null, clientSecret: string | null): void {
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      this.pending.clear();
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  configureSyncInterval(minutes: number): void {
    this.syncIntervalMinutes = Math.max(0, minutes);
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.syncIntervalMinutes <= 0) return;
    this.syncTimer = setInterval(() => this.runScheduledSyncs(), this.syncIntervalMinutes * 60_000);
    this.syncTimer.unref?.();
  }

  private runScheduledSyncs(): void {
    if (!this.clientId) return;
    for (const connection of this.database.listGmailConnections()) {
      if (connection.status === "syncing") continue;
      try {
        this.startSync(connection.id);
      } catch (error) {
        this.database.recordDiagnostic({
          level: "warning",
          category: "gmail",
          message: `Scheduled Gmail sync could not start: ${errorMessage(error)}`,
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId: connection.id, trigger: "scheduled" }
        });
      }
    }
  }

  listConnections(): GmailConnection[] {
    return this.database.listGmailConnections();
  }

  async accessTokenForConnection(connectionId: string, signal: AbortSignal): Promise<string> {
    const connection = this.requireConnection(connectionId);
    if (!connection.canManageCalendar) {
      throw new GmailPermissionError(
        "Reconnect this Gmail account to grant calendar access. Existing connections authorized before Calendar support was added do not have it."
      );
    }
    return this.accessToken(connection, signal);
  }

  startAuthorization(request: GmailAuthRequest): GmailAuthStart {
    if (!this.clientId) {
      throw new GmailConfigurationError(
        "Gmail is not configured. Open Admin settings, choose Gmail, and load a Google Desktop OAuth JSON file."
      );
    }
    this.validateDestination(request);
    this.removeExpiredAuthorizations();

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = this.options.redirectUri();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.pending.set(state, { request, verifier, redirectUri, expiresAt });

    const url = new URL(AUTHORIZATION_ENDPOINT);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GMAIL_SCOPES.join(" "));
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "select_account consent");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return {
      authorizationUrl: url.toString(),
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async finishAuthorization(state: string, code: string): Promise<GmailConnection> {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt <= Date.now()) {
      throw new GmailAuthorizationError("This Gmail authorization request expired. Return to Archive Mail and connect again.");
    }

    const token = await this.exchangeAuthorizationCode(code, pending);
    if (!token.refresh_token) {
      throw new GmailAuthorizationError(
        "Google did not return a refresh token. Remove Archive Mail from your Google account permissions and connect again."
      );
    }
    const profile = await this.gmailJson<GmailProfile>(
      `${GMAIL_API}/users/me/profile`,
      token.access_token
    );
    if (!profile.emailAddress) throw new GmailAuthorizationError("Gmail did not return an account email address");

    let createdArchiveId: string | null = null;
    try {
      const destination = this.resolveDestination(pending.request, profile.emailAddress);
      createdArchiveId = destination.createdArchiveId;
      const connection = this.database.createGmailConnection({
        email: profile.emailAddress,
        archiveId: destination.archiveId,
        folderId: destination.folderId,
        query: pending.request.query,
        ocrEnabled: pending.request.ocrEnabled,
        canSend: tokenGrantsScope(token, GMAIL_SEND_SCOPE),
        canManageCalendar: tokenGrantsScope(token, CALENDAR_EVENTS_SCOPE),
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        accessTokenExpiresAt: tokenExpiry(token.expires_in)
      });
      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: `Gmail connected: ${profile.emailAddress}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: {
          connectionId: connection.id,
          folderPath: connection.folderPath,
          query: connection.query,
          ocrEnabled: connection.ocrEnabled
        }
      });
      this.startSync(connection.id);
      return connection;
    } catch (error) {
      if (createdArchiveId) this.database.deleteArchive(createdArchiveId);
      throw error;
    }
  }

  startSync(connectionId: string, options: { full?: boolean } = {}): GmailConnection {
    const existing = this.database.getGmailConnection(connectionId);
    if (!existing) throw new Error("Gmail connection not found");
    if (this.runs.has(connectionId)) return existing;
    const full = options.full ?? false;
    const connection = this.database.updateGmailSync(connectionId, {
      status: "syncing",
      processedItems: 0,
      totalItems: null,
      importedItems: 0,
      lastError: null,
      // A full sync drops any date restriction from the original connect-time search,
      // both for this run and for every incremental sync afterward.
      ...(full ? { query: "" } : {})
    });
    const run = this.runSync(connectionId, full);
    this.runs.set(connectionId, run);
    void run.finally(() => {
      if (this.runs.get(connectionId) === run) this.runs.delete(connectionId);
    }).catch(() => undefined);
    return connection;
  }

  cancelSync(connectionId: string): GmailConnection {
    const connection = this.database.getGmailConnection(connectionId);
    if (!connection) throw new Error("Gmail connection not found");
    this.controllers.get(connectionId)?.abort();
    return this.database.updateGmailSync(connectionId, {
      status: "connected",
      lastError: null
    });
  }

  /**
   * Backfills messages imported before label mirroring existed (or before a given custom
   * label was created) into their correct local sub-folder, by re-checking each Gmail
   * label's current membership. Anything left in the connection's own root folder
   * afterward — messages with none of the scanned labels — is filed under Archived.
   */
  reorganizeFolders(connectionId: string): GmailConnection {
    const existing = this.database.getGmailConnection(connectionId);
    if (!existing) throw new Error("Gmail connection not found");
    if (this.runs.has(connectionId)) return existing;
    const connection = this.database.updateGmailSync(connectionId, {
      status: "syncing",
      processedItems: 0,
      totalItems: null,
      lastError: null
    });
    const run = this.runReorganize(connectionId);
    this.runs.set(connectionId, run);
    void run.finally(() => {
      if (this.runs.get(connectionId) === run) this.runs.delete(connectionId);
    }).catch(() => undefined);
    return connection;
  }

  private async runReorganize(connectionId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(connectionId, controller);
    let movedTotal = 0;
    try {
      const connection = this.requireConnection(connectionId);
      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: `Gmail folder reorganize started: ${connection.email}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId }
      });
      const accessToken = await this.accessToken(connection, controller.signal);
      const labelsById = await this.listLabels(connection, accessToken, controller.signal);
      const userLabels = [...labelsById.values()].filter((label) => label.type === "user");
      const orderedLabelIds = [
        ...SYSTEM_FOLDER_LABELS.map((entry) => entry.id),
        ...userLabels.map((label) => label.id)
      ];

      const processedGmailIds = new Set<string>();
      for (const [index, labelId] of orderedLabelIds.entries()) {
        throwIfAborted(controller.signal);
        this.database.updateGmailSync(connectionId, {
          processedItems: index + 1,
          totalItems: orderedLabelIds.length + 1
        });
        const gmailIds = await this.listMessageIdsForLabel(accessToken, labelId, controller.signal);
        const newIds = gmailIds.filter((id) => !processedGmailIds.has(id));
        if (newIds.length === 0) continue;
        newIds.forEach((id) => processedGmailIds.add(id));
        const targetPath = resolveMessageFolderPath(connection.folderPath, [labelId], labelsById);
        const targetFolderId = this.imports.ensureFolderPath(connection.archiveId, targetPath);
        const sourceKeys = newIds.map((id) => gmailSourceKey(connection.email, id));
        movedTotal += this.database.reassignMessagesToFolder(connection.archiveId, sourceKeys, targetFolderId);
      }

      throwIfAborted(controller.signal);
      const archivedFolderId = this.imports.ensureFolderPath(connection.archiveId, `${connection.folderPath}/Archived`);
      movedTotal += this.database.reassignAllMessagesInFolder(connection.folderId, archivedFolderId);

      this.database.refreshArchiveStatistics(connection.archiveId);
      this.database.updateGmailSync(connectionId, {
        status: "connected",
        processedItems: orderedLabelIds.length + 1,
        totalItems: orderedLabelIds.length + 1,
        lastError: null
      });
      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: `Gmail folder reorganize completed: ${movedTotal} message${movedTotal === 1 ? "" : "s"} moved`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId, movedMessages: movedTotal }
      });
    } catch (error) {
      const connection = this.database.getGmailConnection(connectionId);
      if (!connection) return;
      if (isAbortError(error)) {
        this.database.updateGmailSync(connectionId, { status: "connected", lastError: null });
        this.database.recordDiagnostic({
          level: "warning",
          category: "gmail",
          message: "Gmail folder reorganize cancelled",
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId, movedMessages: movedTotal }
        });
      } else {
        this.database.updateGmailSync(connectionId, { status: "error", lastError: errorMessage(error) });
        this.database.recordDiagnostic({
          level: "error",
          category: "gmail",
          message: `Gmail folder reorganize failed: ${errorMessage(error)}`,
          stack: error instanceof Error ? error.stack : null,
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId, movedMessages: movedTotal }
        });
      }
    } finally {
      this.controllers.delete(connectionId);
    }
  }

  private async listMessageIdsForLabel(
    accessToken: string,
    labelId: string,
    signal: AbortSignal
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      throwIfAborted(signal);
      const url = new URL(`${GMAIL_API}/users/me/messages`);
      url.searchParams.set("maxResults", "500");
      url.searchParams.set("labelIds", labelId);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.gmailJson<GmailListResponse>(url.toString(), accessToken, signal);
      ids.push(...(page.messages ?? []).map((message) => message.id));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return [...new Set(ids)];
  }

  async sendMessage(
    connectionId: string,
    message: GmailSendRequest,
    attachments: GmailOutgoingAttachment[] = []
  ): Promise<GmailSendResult> {
    const connection = this.requireConnection(connectionId);
    if (!connection.canSend) {
      throw new GmailPermissionError(
        "Authorize this Gmail account again to grant send permission. Existing read-only connections cannot be upgraded silently."
      );
    }

    const signal = AbortSignal.timeout(60_000);
    try {
      const accessToken = await this.accessToken(connection, signal);
      const fromAddress = await this.resolveSendFromAddress(connection, accessToken, signal, message.fromAddress);
      const replyContext = message.sourceMessageId
        ? this.database.getMessageReplyContext(message.sourceMessageId)
        : null;
      if (message.sourceMessageId && !replyContext) {
        throw new Error("The source email for this reply no longer exists");
      }
      const compiled = await nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix"
      }).sendMail({
        from: fromAddress,
        to: message.to,
        cc: message.cc.length > 0 ? message.cc : undefined,
        bcc: message.bcc.length > 0 ? message.bcc : undefined,
        subject: message.subject,
        text: message.bodyText,
        inReplyTo: replyContext?.internetMessageId ?? undefined,
        references: replyContext?.references.length ? replyContext.references : undefined,
        attachments: attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.contentType,
          content: attachment.content
        }))
      });
      if (!Buffer.isBuffer(compiled.message)) {
        throw new Error("Email MIME compiler did not return a message buffer");
      }
      const sent = await this.gmailJson<GmailSendResponse>(
        `${GMAIL_API}/users/me/messages/send`,
        accessToken,
        signal,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            raw: compiled.message.toString("base64url"),
            ...(replyContext?.gmailThreadId ? { threadId: replyContext.gmailThreadId } : {})
          })
        }
      );
      if (!sent.id) throw new Error("Gmail accepted the request without returning a message ID");
      if (message.sourceMessageId) {
        try {
          this.database.recordConversationReply(message.sourceMessageId, sent.id);
        } catch (error) {
          this.database.recordDiagnostic({
            level: "warning",
            category: "gmail",
            message: `Reply was sent, but its local conversation marker could not be saved: ${errorMessage(error)}`,
            stack: error instanceof Error ? error.stack : null,
            archiveId: connection.archiveId,
            sourceName: connection.email,
            context: {
              connectionId,
              operation: "reply_marker_save",
              sourceMessageId: message.sourceMessageId,
              gmailMessageId: sent.id
            }
          });
        }
      }

      let localCopyImported = false;
      try {
        const rawMessage = await this.gmailJson<GmailRawMessage>(
          `${GMAIL_API}/users/me/messages/${encodeURIComponent(sent.id)}?format=raw`,
          accessToken,
          signal
        );
        localCopyImported = await this.importRawMessage(
          connection,
          rawMessage,
          signal,
          new Map(),
          (error, attachment) => this.recordAttachmentError(connection, sent.id, attachment, error)
        );
        this.database.refreshArchiveStatistics(connection.archiveId);
      } catch (error) {
        this.database.recordDiagnostic({
          level: "warning",
          category: "gmail",
          message: `Email was sent, but its local copy could not be imported: ${errorMessage(error)}`,
          stack: error instanceof Error ? error.stack : null,
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId, gmailMessageId: sent.id }
        });
      }

      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: `Email sent from ${connection.email}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: {
          connectionId,
          gmailMessageId: sent.id,
          recipientCount: message.to.length + message.cc.length + message.bcc.length,
          localCopyImported
        }
      });
      return {
        id: sent.id,
        threadId: sent.threadId ?? null,
        localCopyImported
      };
    } catch (error) {
      this.database.recordDiagnostic({
        level: "error",
        category: "gmail",
        message: `Email could not be sent: ${errorMessage(error)}`,
        stack: error instanceof Error ? error.stack : null,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId, operation: "send" }
      });
      throw error;
    }
  }

  async listSendAsAliases(connectionId: string): Promise<GmailSendAsAlias[]> {
    const connection = this.requireConnection(connectionId);
    const signal = AbortSignal.timeout(15_000);
    const accessToken = await this.accessToken(connection, signal);
    try {
      return await this.fetchSendAsAliases(accessToken, signal);
    } catch (error) {
      throw new GmailPermissionError(
        `Custom send-as addresses are unavailable: ${errorMessage(error)}. Reconnect this Gmail account to grant access to its send-as settings.`
      );
    }
  }

  async removeConnection(connectionId: string): Promise<void> {
    this.controllers.get(connectionId)?.abort();
    const run = this.runs.get(connectionId);
    if (run) await Promise.allSettled([run]);
    const connection = this.database.deleteGmailConnection(connectionId);
    if (!connection) throw new Error("Gmail connection not found");
    try {
      await this.fetcher(REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: connection.refreshToken }),
        signal: AbortSignal.timeout(5_000)
      });
    } catch {
      // Local disconnection still succeeds if Google is temporarily unreachable.
    }
    this.database.recordDiagnostic({
      level: "info",
      category: "gmail",
      message: `Gmail disconnected: ${connection.email}`,
      archiveId: connection.archiveId,
      sourceName: connection.email,
      context: { connectionId }
    });
  }

  async cancelForArchive(archiveId: string): Promise<void> {
    await this.cancelWhere((connection) => connection.archiveId === archiveId);
  }

  async cancelForFolder(folderId: string): Promise<void> {
    await this.cancelWhere((connection) => connection.folderId === folderId);
  }

  async removeForArchive(archiveId: string): Promise<void> {
    const connections = this.database.listGmailConnections()
      .filter((connection) => connection.archiveId === archiveId);
    for (const connection of connections) await this.removeConnection(connection.id);
  }

  async removeForFolderTree(folderId: string): Promise<void> {
    const folder = this.database.getFolder(folderId);
    if (!folder) return;
    const connections = this.database.listGmailConnections().filter((connection) => (
      connection.archiveId === folder.archiveId
      && (connection.folderPath === folder.path || connection.folderPath.startsWith(`${folder.path}/`))
    ));
    for (const connection of connections) await this.removeConnection(connection.id);
  }

  async close(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.runs.values());
  }

  private async runSync(connectionId: string, full = false): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(connectionId, controller);
    const startedAt = new Date().toISOString();
    let processed = 0;
    let imported = 0;
    let itemErrors = 0;
    let lastProgressWrite = 0;

    try {
      let connection = this.requireConnection(connectionId);
      const effectiveLastSyncedAt = full ? null : connection.lastSyncedAt;
      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: full ? `Gmail full sync started: ${connection.email}` : `Gmail sync started: ${connection.email}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId, full, query: buildIncrementalQuery(connection.query, effectiveLastSyncedAt) }
      });
      const accessToken = await this.accessToken(connection, controller.signal);
      connection = this.requireConnection(connectionId);
      const labelsById = await this.listLabels(connection, accessToken, controller.signal);
      const messageIds = await this.listMessageIds(
        accessToken,
        buildIncrementalQuery(connection.query, effectiveLastSyncedAt),
        connectionId,
        controller.signal
      );
      this.database.updateGmailSync(connectionId, { totalItems: messageIds.length });

      for (const messageId of messageIds) {
        throwIfAborted(controller.signal);
        const sourceKey = gmailSourceKey(connection.email, messageId);
        try {
          if (!this.database.hasMessage(connection.archiveId, sourceKey)) {
            const rawMessage = await this.gmailJson<GmailRawMessage>(
              `${GMAIL_API}/users/me/messages/${encodeURIComponent(messageId)}?format=raw`,
              accessToken,
              controller.signal
            );
            if (!rawMessage.raw) throw new Error("Gmail returned a message without raw MIME content");
            const inserted = await this.importRawMessage(
              connection,
              rawMessage,
              controller.signal,
              labelsById,
              (error, attachment) => {
                itemErrors += 1;
                this.recordAttachmentError(connection, messageId, attachment, error);
              }
            );
            if (inserted) imported += 1;
          }
        } catch (error) {
          if (isAbortError(error)) throw error;
          itemErrors += 1;
          this.database.recordDiagnostic({
            level: "warning",
            category: "gmail",
            message: `Gmail message could not be imported: ${errorMessage(error)}`,
            archiveId: connection.archiveId,
            sourceName: connection.email,
            context: { connectionId, gmailMessageId: messageId }
          });
        }
        processed += 1;
        if (Date.now() - lastProgressWrite > 200 || processed === messageIds.length) {
          lastProgressWrite = Date.now();
          this.database.updateGmailSync(connectionId, {
            processedItems: processed,
            totalItems: messageIds.length,
            importedItems: imported
          });
        }
      }

      this.database.refreshArchiveStatistics(connection.archiveId);
      const status = itemErrors > 0 ? "error" : "connected";
      this.database.updateGmailSync(connectionId, {
        status,
        processedItems: processed,
        totalItems: messageIds.length,
        importedItems: imported,
        lastSyncedAt: startedAt,
        lastError: itemErrors > 0
          ? `${itemErrors} Gmail item${itemErrors === 1 ? "" : "s"} could not be fully imported. Open Diagnostics for details.`
          : null
      });
      this.database.recordDiagnostic({
        level: itemErrors > 0 ? "warning" : "info",
        category: "gmail",
        message: itemErrors > 0
          ? `Gmail sync finished with ${itemErrors} issue${itemErrors === 1 ? "" : "s"}`
          : "Gmail sync completed successfully",
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId, processedItems: processed, importedItems: imported, itemErrors }
      });
    } catch (error) {
      const connection = this.database.getGmailConnection(connectionId);
      if (!connection) return;
      if (isAbortError(error)) {
        this.database.updateGmailSync(connectionId, {
          status: "connected",
          processedItems: processed,
          importedItems: imported,
          lastError: null
        });
        this.database.recordDiagnostic({
          level: "warning",
          category: "gmail",
          message: "Gmail sync cancelled",
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId, processedItems: processed, importedItems: imported }
        });
      } else {
        this.database.updateGmailSync(connectionId, {
          status: "error",
          processedItems: processed,
          importedItems: imported,
          lastError: errorMessage(error)
        });
        this.database.recordDiagnostic({
          level: "error",
          category: "gmail",
          message: `Gmail sync failed: ${errorMessage(error)}`,
          stack: error instanceof Error ? error.stack : null,
          archiveId: connection.archiveId,
          sourceName: connection.email,
          context: { connectionId, processedItems: processed, importedItems: imported }
        });
      }
    } finally {
      this.controllers.delete(connectionId);
    }
  }

  private async listMessageIds(
    accessToken: string,
    query: string,
    connectionId: string,
    signal: AbortSignal
  ): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      throwIfAborted(signal);
      const url = new URL(`${GMAIL_API}/users/me/messages`);
      url.searchParams.set("maxResults", "500");
      if (query) url.searchParams.set("q", query);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const page = await this.gmailJson<GmailListResponse>(url.toString(), accessToken, signal);
      ids.push(...(page.messages ?? []).map((message) => message.id));
      pageToken = page.nextPageToken;
      this.database.updateGmailSync(connectionId, {
        totalItems: Math.max(ids.length, page.resultSizeEstimate ?? 0)
      });
    } while (pageToken);
    return [...new Set(ids)];
  }

  private async listLabels(
    connection: GmailConnection,
    accessToken: string,
    signal: AbortSignal
  ): Promise<Map<string, GmailLabel>> {
    try {
      const response = await this.gmailJson<GmailLabelsResponse>(
        `${GMAIL_API}/users/me/labels`,
        accessToken,
        signal
      );
      return new Map((response.labels ?? []).map((label) => [label.id, label]));
    } catch (error) {
      if (isAbortError(error)) throw error;
      this.database.recordDiagnostic({
        level: "warning",
        category: "gmail",
        message: `Gmail labels could not be loaded; custom labels will be filed under Archived: ${errorMessage(error)}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId: connection.id }
      });
      return new Map();
    }
  }

  private async fetchSendAsAliases(accessToken: string, signal: AbortSignal): Promise<GmailSendAsAlias[]> {
    const response = await this.gmailJson<GmailSendAsResponse>(
      `${GMAIL_API}/users/me/settings/sendAs`,
      accessToken,
      signal
    );
    return (response.sendAs ?? [])
      .filter((alias) => alias.isPrimary || alias.verificationStatus === "accepted")
      .map((alias) => ({
        email: alias.sendAsEmail,
        displayName: alias.displayName ?? "",
        isPrimary: Boolean(alias.isPrimary),
        isDefault: Boolean(alias.isDefault)
      }));
  }

  private async resolveSendFromAddress(
    connection: GmailConnectionRecord,
    accessToken: string,
    signal: AbortSignal,
    requested: string | undefined
  ): Promise<string> {
    const normalizedRequested = requested?.trim().toLowerCase();
    if (!normalizedRequested || normalizedRequested === connection.email.trim().toLowerCase()) {
      return connection.email;
    }
    let aliases: GmailSendAsAlias[];
    try {
      aliases = await this.fetchSendAsAliases(accessToken, signal);
    } catch (error) {
      throw new GmailPermissionError(
        `${requested} could not be verified as a send-as address: ${errorMessage(error)}. Reconnect this Gmail account to grant access to its send-as settings.`
      );
    }
    const match = aliases.find((alias) => alias.email.toLowerCase() === normalizedRequested);
    if (!match) {
      throw new GmailPermissionError(
        `${requested} is not a verified "Send mail as" address on ${connection.email}. Add and verify it in Gmail settings first.`
      );
    }
    return match.email;
  }

  private async accessToken(
    connection: GmailConnectionRecord,
    signal: AbortSignal
  ): Promise<string> {
    const expiresAt = connection.accessTokenExpiresAt
      ? new Date(connection.accessTokenExpiresAt).getTime()
      : 0;
    if (connection.accessToken && expiresAt > Date.now() + 60_000) {
      return connection.accessToken;
    }
    if (!this.clientId) throw new GmailConfigurationError("Gmail OAuth configuration is missing");
    const body = new URLSearchParams({
      client_id: this.clientId,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token"
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    const token = await this.fetchJson<TokenResponse>(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal
    }, "Google could not refresh Gmail access");
    this.database.updateGmailTokens(
      connection.id,
      token.access_token,
      tokenExpiry(token.expires_in),
      token.refresh_token
    );
    return token.access_token;
  }

  private async importRawMessage(
    connection: GmailConnection,
    rawMessage: GmailRawMessage,
    signal: AbortSignal,
    labelsById: ReadonlyMap<string, GmailLabel>,
    onAttachmentError: (error: unknown, attachment: RawAttachment) => void
  ): Promise<boolean> {
    if (!rawMessage.raw) throw new Error("Gmail returned a message without raw MIME content");
    const sourceKey = gmailSourceKey(connection.email, rawMessage.id);
    const raw = Buffer.from(rawMessage.raw, "base64url");
    const parsed = await simpleParser(raw, {
      skipImageLinks: true,
      keepCidLinks: true
    });
    const folderPath = resolveMessageFolderPath(connection.folderPath, rawMessage.labelIds ?? [], labelsById);
    const normalized = normalizeRfc822Message(
      parsed,
      raw,
      sourceKey,
      folderPath
    );
    if (rawMessage.threadId) {
      normalized.headers["x-archive-mail-gmail-thread-id"] = rawMessage.threadId;
    }
    const inserted = await this.imports.persistNormalizedMessage({
      archiveId: connection.archiveId,
      message: normalized,
      ocrEnabled: connection.ocrEnabled,
      signal,
      onAttachmentError
    });
    if (inserted) {
      this.database.setInitialMessageReadState(
        connection.archiveId,
        sourceKey,
        !(rawMessage.labelIds ?? []).includes("UNREAD")
      );
    }
    return inserted;
  }

  private async exchangeAuthorizationCode(
    code: string,
    pending: PendingAuthorization
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.clientId!,
      code,
      code_verifier: pending.verifier,
      redirect_uri: pending.redirectUri,
      grant_type: "authorization_code"
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);
    return this.fetchJson<TokenResponse>(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    }, "Google did not authorize Gmail access");
  }

  private async gmailJson<T>(
    url: string,
    accessToken: string,
    signal?: AbortSignal,
    init: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${accessToken}`);
    return this.fetchJson<T>(url, {
      ...init,
      headers,
      signal
    }, "Gmail API request failed");
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    fallback: string
  ): Promise<T> {
    const response = await this.fetcher(url, init);
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const remoteMessage = remoteErrorMessage(body);
      throw new Error(`${fallback} (${response.status})${remoteMessage ? `: ${remoteMessage}` : ""}`);
    }
    return body as T;
  }

  private resolveDestination(
    request: GmailAuthRequest,
    email: string
  ): { archiveId: string; folderId: string; createdArchiveId: string | null } {
    let archiveId = request.archiveId ?? null;
    let createdArchiveId: string | null = null;
    if (!archiveId) {
      const archive = this.database.createArchive({
        name: request.archiveName || `Gmail - ${email}`,
        sourceType: "gmail",
        fingerprint: `gmail:${randomUUID()}`,
        sizeBytes: 0
      });
      this.database.completeArchive(archive.id, 0);
      archiveId = archive.id;
      createdArchiveId = archive.id;
    }

    let folderId = request.folderId ?? null;
    if (folderId) {
      const folder = this.database.getFolder(folderId);
      if (!folder || folder.archiveId !== archiveId) {
        throw new Error("The selected Gmail destination mailbox no longer exists");
      }
    } else {
      const existing = this.database.listFolders(archiveId).find((folder) => (
        folder.parentId === null && folder.name.toLowerCase() === request.folderName.toLowerCase()
      ));
      folderId = existing?.id ?? this.database.createFolder(archiveId, request.folderName).id;
    }
    return { archiveId, folderId, createdArchiveId };
  }

  private validateDestination(request: GmailAuthRequest): void {
    if (!request.archiveId) return;
    const archive = this.database.getArchive(request.archiveId);
    if (!archive) throw new Error("The selected destination archive no longer exists");
    if (archive.status === "importing" || archive.status === "failed") {
      throw new Error("Choose an archive that has finished importing");
    }
    if (request.folderId) {
      const folder = this.database.getFolder(request.folderId);
      if (!folder || folder.archiveId !== archive.id) {
        throw new Error("The selected destination mailbox is not in this archive");
      }
    }
  }

  private requireConnection(id: string): GmailConnectionRecord {
    const connection = this.database.getGmailConnectionRecord(id);
    if (!connection) throw new Error("Gmail connection not found");
    return connection;
  }

  private recordAttachmentError(
    connection: GmailConnection,
    gmailMessageId: string,
    attachment: RawAttachment,
    error: unknown
  ): void {
    this.database.recordDiagnostic({
      level: "warning",
      category: "attachment",
      message: `Gmail attachment text extraction failed: ${attachment.filename}`,
      stack: error instanceof Error ? error.stack : null,
      archiveId: connection.archiveId,
      sourceName: connection.email,
      context: {
        connectionId: connection.id,
        gmailMessageId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        error: errorMessage(error)
      }
    });
  }

  private async cancelWhere(predicate: (connection: GmailConnection) => boolean): Promise<void> {
    const matches = this.database.listGmailConnections().filter(predicate);
    for (const connection of matches) this.controllers.get(connection.id)?.abort();
    await Promise.allSettled(
      matches.map((connection) => this.runs.get(connection.id)).filter((run): run is Promise<void> => Boolean(run))
    );
  }

  private removeExpiredAuthorizations(): void {
    const now = Date.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(state);
    }
  }
}

function gmailSourceKey(email: string, messageId: string): string {
  return `gmail:${email.trim().toLowerCase()}:${messageId}`;
}

function buildIncrementalQuery(baseQuery: string, lastSyncedAt: string | null): string {
  // "in:anywhere" widens Gmail's default message list, which otherwise excludes Spam and Trash,
  // so those labels can be mirrored into local folders alongside Inbox/Sent/Drafts.
  const base = [baseQuery.trim(), "in:anywhere"].filter(Boolean).join(" ");
  if (!lastSyncedAt) return base;
  const overlap = new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "/");
  return [base, `after:${overlap}`].filter(Boolean).join(" ");
}

function resolveMessageFolderPath(
  baseFolderPath: string,
  labelIds: string[],
  labelsById: ReadonlyMap<string, GmailLabel>
): string {
  for (const { id, folder } of SYSTEM_FOLDER_LABELS) {
    if (labelIds.includes(id)) return `${baseFolderPath}/${folder}`;
  }
  const userLabel = labelIds
    .map((id) => labelsById.get(id))
    .find((label): label is GmailLabel => label?.type === "user");
  if (userLabel) {
    const labelPath = userLabel.name.split("/").map((part) => part.trim()).filter(Boolean).join("/");
    if (labelPath) return `${baseFolderPath}/${labelPath}`;
  }
  return `${baseFolderPath}/Archived`;
}

function tokenExpiry(expiresIn: number): string {
  return new Date(Date.now() + Math.max(0, expiresIn) * 1000).toISOString();
}

function tokenGrantsScope(token: TokenResponse, scope: string): boolean {
  if (!token.scope) return true;
  return token.scope.split(/\s+/).includes(scope);
}

function remoteErrorMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.error_description === "string") return record.error_description;
  if (typeof record.error === "string") return record.error;
  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.message === "string") return nested.message;
  }
  return "";
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Gmail sync cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
