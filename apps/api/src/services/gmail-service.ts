import { createHash, randomBytes, randomUUID } from "node:crypto";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import type {
  GmailAuthRequest,
  GmailAuthStart,
  GmailConnection,
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
const GMAIL_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE];
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

export interface GmailServiceOptions {
  clientId: string | null;
  clientSecret: string | null;
  redirectUri(): string;
  fetcher?: typeof fetch;
}

export class GmailConfigurationError extends Error {}
export class GmailAuthorizationError extends Error {}
export class GmailPermissionError extends Error {}

export class GmailService {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly fetcher: typeof fetch;
  private clientId: string | null;
  private clientSecret: string | null;

  constructor(
    private readonly database: EmailStore,
    private readonly imports: ImportService,
    private readonly options: GmailServiceOptions
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
  }

  configureCredentials(clientId: string | null, clientSecret: string | null): void {
    if (clientId !== this.clientId || clientSecret !== this.clientSecret) {
      this.pending.clear();
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  listConnections(): GmailConnection[] {
    return this.database.listGmailConnections();
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

  startSync(connectionId: string): GmailConnection {
    const existing = this.database.getGmailConnection(connectionId);
    if (!existing) throw new Error("Gmail connection not found");
    if (this.runs.has(connectionId)) return existing;
    const connection = this.database.updateGmailSync(connectionId, {
      status: "syncing",
      processedItems: 0,
      totalItems: null,
      importedItems: 0,
      lastError: null
    });
    const run = this.runSync(connectionId);
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

  async sendMessage(connectionId: string, message: GmailSendRequest): Promise<GmailSendResult> {
    const connection = this.requireConnection(connectionId);
    if (!connection.canSend) {
      throw new GmailPermissionError(
        "Authorize this Gmail account again to grant send permission. Existing read-only connections cannot be upgraded silently."
      );
    }

    const signal = AbortSignal.timeout(60_000);
    try {
      const accessToken = await this.accessToken(connection, signal);
      const compiled = await nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix"
      }).sendMail({
        from: connection.email,
        to: message.to,
        cc: message.cc.length > 0 ? message.cc : undefined,
        bcc: message.bcc.length > 0 ? message.bcc : undefined,
        subject: message.subject,
        text: message.bodyText
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
          body: JSON.stringify({ raw: compiled.message.toString("base64url") })
        }
      );
      if (!sent.id) throw new Error("Gmail accepted the request without returning a message ID");

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
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.runs.values());
  }

  private async runSync(connectionId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(connectionId, controller);
    const startedAt = new Date().toISOString();
    let processed = 0;
    let imported = 0;
    let itemErrors = 0;
    let lastProgressWrite = 0;

    try {
      let connection = this.requireConnection(connectionId);
      this.database.recordDiagnostic({
        level: "info",
        category: "gmail",
        message: `Gmail sync started: ${connection.email}`,
        archiveId: connection.archiveId,
        sourceName: connection.email,
        context: { connectionId, query: buildIncrementalQuery(connection.query, connection.lastSyncedAt) }
      });
      const accessToken = await this.accessToken(connection, controller.signal);
      connection = this.requireConnection(connectionId);
      const messageIds = await this.listMessageIds(
        accessToken,
        buildIncrementalQuery(connection.query, connection.lastSyncedAt),
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
    onAttachmentError: (error: unknown, attachment: RawAttachment) => void
  ): Promise<boolean> {
    if (!rawMessage.raw) throw new Error("Gmail returned a message without raw MIME content");
    const sourceKey = gmailSourceKey(connection.email, rawMessage.id);
    const raw = Buffer.from(rawMessage.raw, "base64url");
    const parsed = await simpleParser(raw, {
      skipImageLinks: true,
      keepCidLinks: true
    });
    const normalized = normalizeRfc822Message(
      parsed,
      raw,
      sourceKey,
      connection.folderPath
    );
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
  const base = baseQuery.trim();
  if (!lastSyncedAt) return base;
  const overlap = new Date(new Date(lastSyncedAt).getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "/");
  return [base, `after:${overlap}`].filter(Boolean).join(" ");
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
