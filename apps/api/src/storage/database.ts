import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import BetterSqlite3, { type Database as SqliteDatabase } from "better-sqlite3";
import type {
  AccountRole,
  AiJob,
  AiJobStatus,
  AiUsageSummary,
  Archive,
  ArchiveMergeResult,
  ArchiveSourceType,
  Attachment,
  AuditEvent,
  AuditPage,
  CursorPage,
  DiagnosticCategory,
  DiagnosticEvent,
  DiagnosticLevel,
  EmailAddress,
  Folder,
  GmailConnection,
  GmailConnectionStatus,
  ImportJob,
  ImportJobStatus,
  ImportPhase,
  ImportSourceType,
  LocalMessageState,
  LocalMessageStatePatch,
  MailboxMergeResult,
  MessageDetail,
  MessageAnalysis,
  MessageAnalysisOutput,
  MessageSummary,
  SearchFilters,
  SearchHit,
  SessionRole,
  UploadSession,
  UploadStatus,
  UserSummary
} from "@email-client/shared";
import type { StoredBlob } from "./blob-store.js";

const EMPTY_STATE: LocalMessageState = {
  isRead: false,
  isStarred: false,
  tags: [],
  note: "",
  updatedAt: null
};

export const UNKNOWN_DATE_FOLDER_NAME = "Unknown date";

export interface ArchiveCreateInput {
  id?: string;
  name: string;
  sourceType: ArchiveSourceType;
  fingerprint: string;
  sizeBytes: number;
  replaceArchiveId?: string;
}

export interface ImportJobCreateInput {
  id?: string;
  archiveId: string;
  sourcePath: string;
  sourceName: string;
  sourceType: ImportSourceType;
  sizeBytes: number;
  ocrEnabled: boolean;
  temporarySource: boolean;
}

export interface ImportJobRecord {
  id: string;
  archiveId: string;
  sourcePath: string;
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
  temporarySource: boolean;
  checkpoint: Record<string, unknown>;
  message: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadSessionRecord extends UploadSession {
  clientKey: string;
  tempPath: string;
}

export interface DiagnosticInput {
  level: DiagnosticLevel;
  category: DiagnosticCategory;
  message: string;
  stack?: string | null;
  jobId?: string | null;
  archiveId?: string | null;
  sourceName?: string | null;
  context?: Record<string, unknown>;
}

export interface GmailConnectionCreateInput {
  id?: string;
  email: string;
  archiveId: string;
  folderId: string;
  query: string;
  ocrEnabled: boolean;
  canSend: boolean;
  refreshToken: string;
  accessToken?: string | null;
  accessTokenExpiresAt?: string | null;
}

export interface GmailConnectionRecord extends GmailConnection {
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
}

export interface AttachmentInput {
  id?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  disposition: "inline" | "attachment";
  textStatus: Attachment["textStatus"];
  extractedText: string;
  blob: StoredBlob;
}

export interface MessageInput {
  id?: string;
  archiveId: string;
  folderId: string;
  sourceKey: string;
  internetMessageId: string | null;
  subject: string;
  sender: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  sentAt: string | null;
  receivedAt: string | null;
  bodyText: string;
  bodyHtml: string | null;
  headers: Record<string, string>;
  sizeBytes: number;
  attachments: AttachmentInput[];
}

export interface UserRecord extends UserSummary {
  pinHash: string;
  pinSalt: string;
}

export interface UserCreateRecordInput {
  id?: string;
  username: string;
  displayName: string;
  role: AccountRole;
  pinHash: string;
  pinSalt: string;
  mustChangePin?: boolean;
}

export interface UserUpdateRecordInput {
  displayName?: string;
  role?: AccountRole;
  isActive?: boolean;
  pinHash?: string;
  pinSalt?: string;
  mustChangePin?: boolean;
}

export interface AuthSessionRecord {
  id: string;
  user: UserSummary;
  role: SessionRole;
  tokenHash: string;
  ipAddress: string;
  userAgent: string | null;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface AuthSessionCreateInput {
  id?: string;
  userId: string;
  role: SessionRole;
  tokenHash: string;
  ipAddress: string;
  userAgent: string | null;
  expiresAt: string;
}

export interface AuditInput {
  sessionId?: string | null;
  userId?: string | null;
  username?: string | null;
  displayName?: string | null;
  role?: SessionRole | null;
  action: string;
  method?: string | null;
  path?: string | null;
  statusCode: number;
  success: boolean;
  ipAddress: string;
  userAgent?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  username?: string;
  action?: string;
  ipAddress?: string;
  success?: boolean;
  cursor?: string;
  limit?: number;
}

export interface AiJobCreateInput {
  id?: string;
  messageId: string;
  model: string;
  promptVersion: string;
  contentHash: string;
  maxAttempts?: number;
}

export interface MessageAnalysisUpsertInput extends MessageAnalysisOutput {
  messageId: string;
  model: string;
  promptVersion: string;
  contentHash: string;
}

interface SearchQuery extends SearchFilters {
  q: string;
}

type Row = Record<string, unknown>;

export class EmailDatabase {
  readonly path: string;
  private readonly db: SqliteDatabase;

  constructor(dataDir: string, filename = "archive-mail.sqlite") {
    this.path = resolve(dataDir, filename);
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new BetterSqlite3(this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.recoverInterruptedJobs();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version < 1) {
      this.db.exec(`
      CREATE TABLE archives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL CHECK(source_type IN ('pst', 'mbox', 'gmail')),
        fingerprint TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'importing',
        message_count INTEGER NOT NULL DEFAULT 0,
        folder_count INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        replace_archive_id TEXT,
        imported_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(replace_archive_id) REFERENCES archives(id) ON DELETE SET NULL
      );
      CREATE INDEX archives_fingerprint_idx ON archives(fingerprint);

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        processed_items INTEGER NOT NULL DEFAULT 0,
        total_items INTEGER,
        error_count INTEGER NOT NULL DEFAULT 0,
        ocr_enabled INTEGER NOT NULL DEFAULT 0,
        can_resume INTEGER NOT NULL DEFAULT 0,
        temporary_source INTEGER NOT NULL DEFAULT 0,
        checkpoint_json TEXT NOT NULL DEFAULT '{}',
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(archive_id) REFERENCES archives(id) ON DELETE CASCADE
      );
      CREATE INDEX import_jobs_updated_idx ON import_jobs(updated_at DESC);

      CREATE TABLE folders (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        parent_id TEXT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY(archive_id) REFERENCES archives(id) ON DELETE CASCADE,
        FOREIGN KEY(parent_id) REFERENCES folders(id) ON DELETE CASCADE,
        UNIQUE(archive_id, path)
      );
      CREATE INDEX folders_archive_idx ON folders(archive_id, parent_id);

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        archive_id TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        internet_message_id TEXT,
        subject TEXT NOT NULL DEFAULT '',
        sender_name TEXT,
        sender_address TEXT NOT NULL DEFAULT '',
        to_json TEXT NOT NULL DEFAULT '[]',
        cc_json TEXT NOT NULL DEFAULT '[]',
        bcc_json TEXT NOT NULL DEFAULT '[]',
        recipients_text TEXT NOT NULL DEFAULT '',
        sent_at TEXT,
        received_at TEXT,
        body_text TEXT NOT NULL DEFAULT '',
        body_html TEXT,
        headers_json TEXT NOT NULL DEFAULT '{}',
        has_attachments INTEGER NOT NULL DEFAULT 0,
        attachment_count INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(archive_id) REFERENCES archives(id) ON DELETE CASCADE,
        FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE,
        UNIQUE(archive_id, source_key)
      );
      CREATE INDEX messages_folder_date_idx ON messages(folder_id, received_at DESC, sent_at DESC);
      CREATE INDEX messages_archive_date_idx ON messages(archive_id, received_at DESC, sent_at DESC);
      CREATE INDEX messages_sender_idx ON messages(sender_address);

      CREATE TABLE message_state (
        message_id TEXT PRIMARY KEY,
        is_read INTEGER NOT NULL DEFAULT 0,
        is_starred INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL DEFAULT '[]',
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE blobs (
        sha256 TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL,
        ref_count INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        content_id TEXT,
        disposition TEXT NOT NULL,
        text_status TEXT NOT NULL,
        extracted_text TEXT NOT NULL DEFAULT '',
        blob_sha256 TEXT NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY(blob_sha256) REFERENCES blobs(sha256)
      );
      CREATE INDEX attachments_message_idx ON attachments(message_id);

      CREATE TABLE import_errors (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        source_key TEXT,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES import_jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX import_errors_job_idx ON import_errors(job_id);

      CREATE VIRTUAL TABLE message_fts USING fts5(
        message_id UNINDEXED,
        subject,
        sender,
        recipients,
        folder,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE VIRTUAL TABLE attachment_fts USING fts5(
        attachment_id UNINDEXED,
        message_id UNINDEXED,
        filename,
        content,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      PRAGMA user_version = 1;
      `);
    }

    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion < 2) {
      this.db.exec(`
        CREATE TABLE upload_sessions (
          id TEXT PRIMARY KEY,
          client_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          expected_size INTEGER NOT NULL,
          received_size INTEGER NOT NULL DEFAULT 0,
          temp_path TEXT NOT NULL,
          status TEXT NOT NULL,
          ocr_enabled INTEGER NOT NULL DEFAULT 0,
          job_id TEXT,
          message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(job_id) REFERENCES import_jobs(id) ON DELETE SET NULL
        );
        CREATE INDEX upload_sessions_client_idx
          ON upload_sessions(client_key, updated_at DESC);
        CREATE INDEX upload_sessions_updated_idx
          ON upload_sessions(updated_at DESC);
        CREATE UNIQUE INDEX upload_sessions_active_client_idx
          ON upload_sessions(client_key)
          WHERE status IN ('uploading', 'ready', 'failed');

        CREATE TABLE diagnostic_events (
          id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          category TEXT NOT NULL,
          message TEXT NOT NULL,
          stack TEXT,
          job_id TEXT,
          archive_id TEXT,
          source_name TEXT,
          context_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX diagnostic_events_created_idx
          ON diagnostic_events(created_at DESC);
        CREATE INDEX diagnostic_events_job_idx
          ON diagnostic_events(job_id, created_at DESC);
        CREATE INDEX diagnostic_events_archive_idx
          ON diagnostic_events(archive_id, created_at DESC);

        INSERT INTO diagnostic_events (
          id, level, category, message, job_id, archive_id, source_name,
          context_json, created_at
        )
        SELECT
          e.id,
          CASE WHEN e.stage = 'archive' THEN 'error' ELSE 'warning' END,
          CASE
            WHEN e.stage = 'attachment' THEN 'attachment'
            WHEN e.stage = 'archive' THEN 'import'
            ELSE 'parser'
          END,
          e.message,
          e.job_id,
          j.archive_id,
          j.source_name,
          json_object('stage', e.stage, 'sourceKey', e.source_key),
          e.created_at
        FROM import_errors e
        JOIN import_jobs j ON j.id = e.job_id;

        PRAGMA user_version = 2;
      `);
    }

    const diagnosticsVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (diagnosticsVersion < 3) {
      this.db.exec(`
        ALTER TABLE import_jobs ADD COLUMN processed_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE import_jobs ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;

        UPDATE import_jobs
        SET total_bytes = COALESCE((
          SELECT size_bytes FROM archives WHERE archives.id = import_jobs.archive_id
        ), 0);

        UPDATE import_jobs
        SET processed_bytes = CASE
          WHEN phase = 'fingerprinting' THEN MIN(processed_items, total_bytes)
          ELSE MIN(
            COALESCE(CAST(json_extract(checkpoint_json, '$.sourceOffset') AS INTEGER), 0),
            total_bytes
          )
        END;

        UPDATE import_jobs
        SET processed_items = 0, total_items = NULL
        WHERE phase = 'fingerprinting';

        PRAGMA user_version = 3;
      `);
    }

    const progressVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (progressVersion < 4) {
      this.db.exec(`
        UPDATE import_jobs
        SET total_items = processed_items
        WHERE total_items IS NULL
          AND status IN ('completed', 'completed_with_errors');

        PRAGMA user_version = 4;
      `);
    }

    const archiveTypeVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (archiveTypeVersion < 5) {
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.exec(`
          BEGIN;

          CREATE TABLE archives_v5 (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            source_type TEXT NOT NULL CHECK(source_type IN ('pst', 'mbox', 'gmail')),
            fingerprint TEXT NOT NULL,
            size_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'importing',
            message_count INTEGER NOT NULL DEFAULT 0,
            folder_count INTEGER NOT NULL DEFAULT 0,
            attachment_count INTEGER NOT NULL DEFAULT 0,
            error_count INTEGER NOT NULL DEFAULT 0,
            replace_archive_id TEXT,
            imported_at TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY(replace_archive_id) REFERENCES archives_v5(id) ON DELETE SET NULL
          );

          INSERT INTO archives_v5 (
            id, name, source_type, fingerprint, size_bytes, status,
            message_count, folder_count, attachment_count, error_count,
            replace_archive_id, imported_at, created_at
          )
          SELECT
            id, name, source_type, fingerprint, size_bytes, status,
            message_count, folder_count, attachment_count, error_count,
            replace_archive_id, imported_at, created_at
          FROM archives;

          DROP TABLE archives;
          ALTER TABLE archives_v5 RENAME TO archives;
          CREATE INDEX archives_fingerprint_idx ON archives(fingerprint);

          PRAGMA user_version = 5;
          COMMIT;
        `);
      } catch (error) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
    }

    const gmailVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (gmailVersion < 6) {
      this.db.exec(`
        CREATE TABLE gmail_connections (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          archive_id TEXT NOT NULL,
          folder_id TEXT NOT NULL,
          query TEXT NOT NULL DEFAULT '',
          ocr_enabled INTEGER NOT NULL DEFAULT 0,
          refresh_token TEXT NOT NULL,
          access_token TEXT,
          access_token_expires_at TEXT,
          status TEXT NOT NULL DEFAULT 'connected'
            CHECK(status IN ('connected', 'syncing', 'error')),
          processed_items INTEGER NOT NULL DEFAULT 0,
          total_items INTEGER,
          imported_items INTEGER NOT NULL DEFAULT 0,
          last_synced_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(archive_id) REFERENCES archives(id) ON DELETE CASCADE,
          FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
        );
        CREATE INDEX gmail_connections_archive_idx
          ON gmail_connections(archive_id, updated_at DESC);
        CREATE INDEX gmail_connections_folder_idx
          ON gmail_connections(folder_id);

        PRAGMA user_version = 6;
      `);
    }

    const gmailSendVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (gmailSendVersion < 7) {
      this.db.exec(`
        ALTER TABLE gmail_connections ADD COLUMN can_send INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 7;
      `);
    }

    const securityVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (securityVersion < 8) {
      this.db.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          must_change_pin INTEGER NOT NULL DEFAULT 0,
          last_login_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          effective_role TEXT NOT NULL CHECK(effective_role IN ('admin', 'user', 'viewer')),
          token_hash TEXT NOT NULL UNIQUE,
          ip_address TEXT NOT NULL,
          user_agent TEXT,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX auth_sessions_user_idx
          ON auth_sessions(user_id, created_at DESC);
        CREATE INDEX auth_sessions_expiry_idx
          ON auth_sessions(expires_at);

        CREATE TABLE audit_events (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          user_id TEXT,
          username TEXT,
          display_name TEXT,
          role TEXT,
          action TEXT NOT NULL,
          method TEXT,
          path TEXT,
          status_code INTEGER NOT NULL,
          success INTEGER NOT NULL,
          ip_address TEXT NOT NULL,
          user_agent TEXT,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX audit_events_created_idx
          ON audit_events(created_at DESC, id DESC);
        CREATE INDEX audit_events_user_idx
          ON audit_events(username, created_at DESC);
        CREATE INDEX audit_events_ip_idx
          ON audit_events(ip_address, created_at DESC);
        CREATE INDEX audit_events_action_idx
          ON audit_events(action, created_at DESC);

        PRAGMA user_version = 8;
      `);
    }

    const aiVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (aiVersion < 9) {
      this.db.exec(`
        CREATE TABLE ai_jobs (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          task TEXT NOT NULL DEFAULT 'analyze' CHECK(task = 'analyze'),
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 2,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX ai_jobs_message_idx ON ai_jobs(message_id, created_at DESC);
        CREATE INDEX ai_jobs_status_idx ON ai_jobs(status, created_at);
        CREATE UNIQUE INDEX ai_jobs_active_message_idx
          ON ai_jobs(message_id)
          WHERE status IN ('queued', 'running');

        CREATE TABLE ai_message_analysis (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE,
          summary TEXT NOT NULL,
          categories_json TEXT NOT NULL DEFAULT '[]',
          priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
          action_required INTEGER NOT NULL DEFAULT 0,
          action_summary TEXT,
          spam_probability REAL NOT NULL DEFAULT 0,
          phishing_probability REAL NOT NULL DEFAULT 0,
          draft_recommended INTEGER NOT NULL DEFAULT 0,
          confidence REAL NOT NULL DEFAULT 0,
          signals_json TEXT NOT NULL DEFAULT '[]',
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX ai_message_analysis_updated_idx
          ON ai_message_analysis(updated_at DESC);

        CREATE TABLE ai_usage_daily (
          usage_date TEXT PRIMARY KEY,
          request_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        PRAGMA user_version = 9;
      `);
    }

    const undatedFolderVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (undatedFolderVersion < 10) {
      const migrateUndatedMessages = this.db.transaction(() => {
        const movedMessages = this.moveUndatedMessagesToDedicatedFolders();
        this.db.pragma("user_version = 10");
        return movedMessages;
      });
      const movedMessages = migrateUndatedMessages();
      if (movedMessages > 0) {
        this.recordDiagnostic({
          level: "info",
          category: "system",
          message: `Moved ${movedMessages} undated message${movedMessages === 1 ? "" : "s"} into ${UNKNOWN_DATE_FOLDER_NAME} mailboxes`,
          context: { operation: "organize_undated_messages", movedMessages }
        });
      }
    }
  }

  private moveUndatedMessagesToDedicatedFolders(): number {
    const sourceFolders = this.db.prepare(`
      SELECT f.id, f.archive_id, f.path
      FROM folders f
      WHERE lower(f.name) != lower(?)
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.folder_id = f.id
            AND m.received_at IS NULL
            AND m.sent_at IS NULL
        )
    `).all(UNKNOWN_DATE_FOLDER_NAME) as Row[];
    const affectedArchives = new Set<string>();
    let movedMessages = 0;

    for (const source of sourceFolders) {
      const sourceFolderId = String(source.id);
      const archiveId = String(source.archive_id);
      const targetPath = `${String(source.path)}/${UNKNOWN_DATE_FOLDER_NAME}`;
      const existingTarget = this.db.prepare(`
        SELECT id FROM folders WHERE archive_id = ? AND path = ?
      `).get(archiveId, targetPath) as Row | undefined;
      const targetFolderId = existingTarget ? String(existingTarget.id) : randomUUID();

      if (!existingTarget) {
        this.db.prepare(`
          INSERT INTO folders (id, archive_id, parent_id, name, path)
          VALUES (?, ?, ?, ?, ?)
        `).run(targetFolderId, archiveId, sourceFolderId, UNKNOWN_DATE_FOLDER_NAME, targetPath);
      }

      const result = this.db.prepare(`
        UPDATE messages
        SET folder_id = ?
        WHERE folder_id = ?
          AND received_at IS NULL
          AND sent_at IS NULL
      `).run(targetFolderId, sourceFolderId);
      if (result.changes === 0) continue;

      this.db.prepare(`
        UPDATE message_fts
        SET folder = ?
        WHERE message_id IN (
          SELECT id FROM messages
          WHERE folder_id = ?
            AND received_at IS NULL
            AND sent_at IS NULL
        )
      `).run(targetPath, targetFolderId);
      movedMessages += result.changes;
      affectedArchives.add(archiveId);
    }

    for (const archiveId of affectedArchives) {
      this.db.prepare(`
        UPDATE folders SET message_count = (
          SELECT COUNT(*) FROM messages WHERE folder_id = folders.id
        ) WHERE archive_id = ?
      `).run(archiveId);
      this.db.prepare(`
        UPDATE archives SET folder_count = (
          SELECT COUNT(*) FROM folders WHERE archive_id = archives.id
        ) WHERE id = ?
      `).run(archiveId);
    }

    return movedMessages;
  }

  private recoverInterruptedJobs(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE import_jobs
      SET status = 'paused', can_resume = 1,
          message = 'Import interrupted; ready to resume', updated_at = ?
      WHERE status IN ('queued', 'running')
    `).run(now);
    this.db.prepare(`
      UPDATE gmail_connections
      SET status = 'error', last_error = 'Gmail sync was interrupted; run Sync now to continue',
          updated_at = ?
      WHERE status = 'syncing'
    `).run(now);
    this.db.prepare(`
      UPDATE ai_jobs
      SET status = 'queued', error = 'Analysis interrupted; restarted locally',
          updated_at = ?, started_at = NULL
      WHERE status = 'running'
    `).run(now);
  }

  createUser(input: UserCreateRecordInput): UserSummary {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO users (
        id, username, display_name, role, pin_hash, pin_salt,
        is_active, must_change_pin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      input.username.trim().toLowerCase(),
      input.displayName.trim(),
      input.role,
      input.pinHash,
      input.pinSalt,
      input.mustChangePin ? 1 : 0,
      now,
      now
    );
    return this.getUser(id)!;
  }

  getUser(id: string): UserSummary | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapUser(row) : null;
  }

  getUserRecord(id: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapUserRecord(row) : null;
  }

  getUserRecordByUsername(username: string): UserRecord | null {
    const row = this.db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE")
      .get(username.trim()) as Row | undefined;
    return row ? this.mapUserRecord(row) : null;
  }

  listUsers(): UserSummary[] {
    return (this.db.prepare(`
      SELECT * FROM users ORDER BY username COLLATE NOCASE
    `).all() as Row[]).map((row) => this.mapUser(row));
  }

  countActiveAdmins(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1
    `).get() as Row;
    return Number(row.count);
  }

  updateUser(id: string, update: UserUpdateRecordInput): UserSummary {
    const current = this.getUserRecord(id);
    if (!current) throw new Error("User not found");
    const fields: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (update.displayName !== undefined) set("display_name", update.displayName.trim());
    if (update.role !== undefined) set("role", update.role);
    if (update.isActive !== undefined) set("is_active", update.isActive ? 1 : 0);
    if (update.pinHash !== undefined) set("pin_hash", update.pinHash);
    if (update.pinSalt !== undefined) set("pin_salt", update.pinSalt);
    if (update.mustChangePin !== undefined) set("must_change_pin", update.mustChangePin ? 1 : 0);
    if (fields.length === 0) return current;
    set("updated_at", new Date().toISOString());
    this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values, id);
    return this.getUser(id)!;
  }

  markUserLogin(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  createAuthSession(input: AuthSessionCreateInput): AuthSessionRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO auth_sessions (
        id, user_id, effective_role, token_hash, ip_address,
        user_agent, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.userId,
      input.role,
      input.tokenHash,
      input.ipAddress,
      input.userAgent,
      input.expiresAt,
      now,
      now
    );
    return this.getAuthSessionByTokenHash(input.tokenHash)!;
  }

  getAuthSessionByTokenHash(tokenHash: string): AuthSessionRecord | null {
    const row = this.db.prepare(`
      SELECT
        s.id AS session_id,
        s.effective_role,
        s.token_hash,
        s.ip_address,
        s.user_agent,
        s.expires_at,
        s.created_at AS session_created_at,
        s.last_seen_at,
        u.*
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.is_active = 1
    `).get(tokenHash, new Date().toISOString()) as Row | undefined;
    return row ? this.mapAuthSession(row) : null;
  }

  touchAuthSession(id: string): void {
    this.db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  revokeAuthSession(id: string): boolean {
    return this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), id).changes > 0;
  }

  revokeUserSessions(userId: string, exceptSessionId?: string): number {
    const now = new Date().toISOString();
    if (exceptSessionId) {
      return this.db.prepare(`
        UPDATE auth_sessions SET revoked_at = ?
        WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
      `).run(now, userId, exceptSessionId).changes;
    }
    return this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
    `).run(now, userId).changes;
  }

  revokeAllSessions(): number {
    return this.db.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL
    `).run(new Date().toISOString()).changes;
  }

  purgeExpiredSessions(): number {
    const now = new Date().toISOString();
    return this.db.prepare(`
      DELETE FROM auth_sessions
      WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
    `).run(now, now).changes;
  }

  recordAudit(input: AuditInput): AuditEvent {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO audit_events (
        id, session_id, user_id, username, display_name, role,
        action, method, path, status_code, success, ip_address,
        user_agent, details_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sessionId ?? null,
      input.userId ?? null,
      input.username ?? null,
      input.displayName ?? null,
      input.role ?? null,
      input.action,
      input.method ?? null,
      input.path ?? null,
      input.statusCode,
      input.success ? 1 : 0,
      input.ipAddress,
      input.userAgent ?? null,
      serializeContext(input.details),
      createdAt
    );
    const row = this.db.prepare("SELECT * FROM audit_events WHERE id = ?").get(id) as Row;
    return this.mapAudit(row);
  }

  listAudit(options: AuditQuery = {}): AuditPage {
    const limit = clampLimit(options.limit);
    const offset = decodeOffset(options.cursor);
    const filters: string[] = [];
    const values: unknown[] = [];
    if (options.username?.trim()) {
      filters.push("lower(username) LIKE ?");
      values.push(`%${options.username.trim().toLowerCase()}%`);
    }
    if (options.action?.trim()) {
      filters.push("lower(action) LIKE ?");
      values.push(`%${options.action.trim().toLowerCase()}%`);
    }
    if (options.ipAddress?.trim()) {
      filters.push("ip_address LIKE ?");
      values.push(`%${options.ipAddress.trim()}%`);
    }
    if (options.success !== undefined) {
      filters.push("success = ?");
      values.push(options.success ? 1 : 0);
    }
    const rows = this.db.prepare(`
      SELECT * FROM audit_events
      ${filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...values, limit + 1, offset) as Row[];
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => this.mapAudit(row)),
      nextCursor: hasMore ? encodeOffset(offset + limit) : null
    };
  }

  listAllAudit(limit = 100_000): AuditEvent[] {
    const safeLimit = Math.min(1_000_000, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(safeLimit) as Row[]).map((row) => this.mapAudit(row));
  }

  findReadyArchiveByFingerprint(fingerprint: string): Archive | null {
    const row = this.db.prepare(`
      SELECT * FROM archives
      WHERE fingerprint = ? AND status IN ('ready', 'ready_with_errors')
      ORDER BY imported_at DESC LIMIT 1
    `).get(fingerprint) as Row | undefined;
    return row ? this.mapArchive(row) : null;
  }

  createArchive(input: ArchiveCreateInput): Archive {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO archives (
        id, name, source_type, fingerprint, size_bytes, status,
        replace_archive_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'importing', ?, ?)
    `).run(
      id,
      input.name,
      input.sourceType,
      input.fingerprint,
      input.sizeBytes,
      input.replaceArchiveId ?? null,
      now
    );
    return this.getArchive(id)!;
  }

  getArchive(id: string): Archive | null {
    const row = this.db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM messages m WHERE m.archive_id = a.id) AS live_message_count,
        (
          SELECT COUNT(*) FROM messages m
          JOIN message_state s ON s.message_id = m.id
          WHERE m.archive_id = a.id AND s.is_read = 0
        ) AS live_unread_count,
        (SELECT COUNT(*) FROM folders f WHERE f.archive_id = a.id) AS live_folder_count,
        (
          SELECT COUNT(*) FROM attachments att
          JOIN messages m ON m.id = att.message_id
          WHERE m.archive_id = a.id
        ) AS live_attachment_count
      FROM archives a WHERE a.id = ?
    `).get(id) as Row | undefined;
    return row ? this.mapArchive(row) : null;
  }

  getReplaceArchiveId(id: string): string | null {
    const row = this.db.prepare("SELECT replace_archive_id FROM archives WHERE id = ?").get(id) as Row | undefined;
    return row?.replace_archive_id ? String(row.replace_archive_id) : null;
  }

  updateArchiveFingerprint(id: string, fingerprint: string, sizeBytes: number): void {
    this.db.prepare(`
      UPDATE archives SET fingerprint = ?, size_bytes = ? WHERE id = ?
    `).run(fingerprint, sizeBytes, id);
  }

  listArchives(): Archive[] {
    return (this.db.prepare(`
      SELECT a.*,
        (SELECT COUNT(*) FROM messages m WHERE m.archive_id = a.id) AS live_message_count,
        (
          SELECT COUNT(*) FROM messages m
          JOIN message_state s ON s.message_id = m.id
          WHERE m.archive_id = a.id AND s.is_read = 0
        ) AS live_unread_count,
        (SELECT COUNT(*) FROM folders f WHERE f.archive_id = a.id) AS live_folder_count,
        (
          SELECT COUNT(*) FROM attachments att
          JOIN messages m ON m.id = att.message_id
          WHERE m.archive_id = a.id
        ) AS live_attachment_count
      FROM archives a
      WHERE a.status != 'failed'
      ORDER BY COALESCE(a.imported_at, a.created_at) DESC
    `).all() as Row[]).map((row) => this.mapArchive(row));
  }

  renameArchive(id: string, name: string): Archive {
    const result = this.db.prepare("UPDATE archives SET name = ? WHERE id = ?")
      .run(name.trim(), id);
    if (result.changes === 0) throw new Error("Archive not found");
    return this.getArchive(id)!;
  }

  completeArchive(id: string, errorCount: number): Archive {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE archives SET
        status = ?,
        message_count = (SELECT COUNT(*) FROM messages WHERE archive_id = archives.id),
        folder_count = (SELECT COUNT(*) FROM folders WHERE archive_id = archives.id),
        attachment_count = (
          SELECT COUNT(*) FROM attachments a
          JOIN messages m ON m.id = a.message_id
          WHERE m.archive_id = archives.id
        ),
        error_count = ?,
        imported_at = ?
      WHERE id = ?
    `).run(errorCount > 0 ? "ready_with_errors" : "ready", errorCount, now, id);
    return this.getArchive(id)!;
  }

  refreshArchiveStatistics(id: string): Archive {
    this.db.prepare(`
      UPDATE archives SET
        message_count = (SELECT COUNT(*) FROM messages WHERE archive_id = archives.id),
        folder_count = (SELECT COUNT(*) FROM folders WHERE archive_id = archives.id),
        attachment_count = (
          SELECT COUNT(*) FROM attachments a
          JOIN messages m ON m.id = a.message_id
          WHERE m.archive_id = archives.id
        )
      WHERE id = ?
    `).run(id);
    this.db.prepare(`
      UPDATE folders SET message_count = (
        SELECT COUNT(*) FROM messages WHERE folder_id = folders.id
      ) WHERE archive_id = ?
    `).run(id);
    const archive = this.getArchive(id);
    if (!archive) throw new Error("Archive not found");
    return archive;
  }

  failArchive(id: string): void {
    this.db.prepare("UPDATE archives SET status = 'failed' WHERE id = ?").run(id);
  }

  resumeArchive(id: string): void {
    this.db.prepare("UPDATE archives SET status = 'importing' WHERE id = ?").run(id);
  }

  createImportJob(input: ImportJobCreateInput): ImportJob {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO import_jobs (
        id, archive_id, source_path, source_name, source_type, status, phase,
        total_bytes, ocr_enabled, temporary_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?)
    `).run(
      id,
      input.archiveId,
      input.sourcePath,
      input.sourceName,
      input.sourceType,
      input.sizeBytes,
      input.ocrEnabled ? 1 : 0,
      input.temporarySource ? 1 : 0,
      now,
      now
    );
    return this.getImportJob(id)!;
  }

  getImportJob(id: string): ImportJob | null {
    const row = this.db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapImportJob(row) : null;
  }

  getImportJobRecord(id: string): ImportJobRecord | null {
    const row = this.db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      ...this.mapImportJob(row),
      archiveId: String(row.archive_id),
      sourcePath: String(row.source_path),
      temporarySource: Boolean(row.temporary_source),
      checkpoint: parseJson<Record<string, unknown>>(row.checkpoint_json, {})
    };
  }

  listImportJobRecordsForArchive(archiveId: string): ImportJobRecord[] {
    return (this.db.prepare(`
      SELECT * FROM import_jobs WHERE archive_id = ? ORDER BY updated_at DESC
    `).all(archiveId) as Row[]).map((row) => ({
      ...this.mapImportJob(row),
      archiveId: String(row.archive_id),
      sourcePath: String(row.source_path),
      temporarySource: Boolean(row.temporary_source),
      checkpoint: parseJson<Record<string, unknown>>(row.checkpoint_json, {})
    }));
  }

  listImportJobs(): ImportJob[] {
    return (this.db.prepare(`
      SELECT * FROM import_jobs ORDER BY updated_at DESC LIMIT 25
    `).all() as Row[]).map((row) => this.mapImportJob(row));
  }

  deleteImportJob(id: string): boolean {
    return this.db.prepare("DELETE FROM import_jobs WHERE id = ?").run(id).changes > 0;
  }

  updateImportJob(
    id: string,
    update: {
      status?: ImportJobStatus;
      phase?: ImportPhase;
      processedItems?: number;
      totalItems?: number | null;
      processedBytes?: number;
      totalBytes?: number;
      errorCount?: number;
      canResume?: boolean;
      checkpoint?: Record<string, unknown>;
      message?: string | null;
    }
  ): ImportJob {
    const current = this.db.prepare("SELECT * FROM import_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!current) throw new Error(`Import job ${id} not found`);
    this.db.prepare(`
      UPDATE import_jobs SET
        status = ?,
        phase = ?,
        processed_items = ?,
        total_items = ?,
        processed_bytes = ?,
        total_bytes = ?,
        error_count = ?,
        can_resume = ?,
        checkpoint_json = ?,
        message = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      update.status ?? current.status,
      update.phase ?? current.phase,
      update.processedItems ?? current.processed_items,
      update.totalItems === undefined ? current.total_items : update.totalItems,
      update.processedBytes ?? current.processed_bytes,
      update.totalBytes ?? current.total_bytes,
      update.errorCount ?? current.error_count,
      update.canResume === undefined ? current.can_resume : update.canResume ? 1 : 0,
      update.checkpoint ? JSON.stringify(update.checkpoint) : current.checkpoint_json,
      update.message === undefined ? current.message : update.message,
      new Date().toISOString(),
      id
    );
    return this.getImportJob(id)!;
  }

  addImportError(jobId: string, stage: string, message: string, sourceKey?: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO import_errors (id, job_id, source_key, stage, message, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), jobId, sourceKey ?? null, stage, message.slice(0, 4_000), now);
    this.db.prepare(`
      UPDATE import_jobs SET error_count = error_count + 1, updated_at = ? WHERE id = ?
    `).run(now, jobId);
    const job = this.db.prepare(`
      SELECT archive_id, source_name FROM import_jobs WHERE id = ?
    `).get(jobId) as Row | undefined;
    this.recordDiagnostic({
      level: stage === "archive" ? "error" : "warning",
      category: stage === "attachment" ? "attachment" : stage === "archive" ? "import" : "parser",
      message,
      jobId,
      archiveId: job?.archive_id ? String(job.archive_id) : null,
      sourceName: job?.source_name ? String(job.source_name) : null,
      context: { stage, sourceKey: sourceKey ?? null }
    });
  }

  createUploadSession(input: {
    id?: string;
    clientKey: string;
    filename: string;
    sizeBytes: number;
    tempPath: string;
    ocrEnabled: boolean;
  }): UploadSession {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO upload_sessions (
        id, client_key, filename, expected_size, temp_path, status,
        ocr_enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?)
    `).run(
      id,
      input.clientKey,
      input.filename,
      input.sizeBytes,
      input.tempPath,
      input.ocrEnabled ? 1 : 0,
      now,
      now
    );
    return this.getUploadSession(id)!;
  }

  getUploadSession(id: string): UploadSession | null {
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapUploadSession(row) : null;
  }

  getUploadSessionRecord(id: string): UploadSessionRecord | null {
    const row = this.db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id) as Row | undefined;
    if (!row) return null;
    return {
      ...this.mapUploadSession(row),
      clientKey: String(row.client_key),
      tempPath: String(row.temp_path)
    };
  }

  findResumableUpload(clientKey: string): UploadSessionRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM upload_sessions
      WHERE client_key = ? AND status IN ('uploading', 'ready', 'failed')
      ORDER BY updated_at DESC LIMIT 1
    `).get(clientKey) as Row | undefined;
    if (!row) return null;
    return {
      ...this.mapUploadSession(row),
      clientKey: String(row.client_key),
      tempPath: String(row.temp_path)
    };
  }

  listUploadSessions(limit = 25): UploadSession[] {
    const safeLimit = Math.min(200, Math.max(1, Math.trunc(limit)));
    return (this.db.prepare(`
      SELECT * FROM upload_sessions ORDER BY updated_at DESC LIMIT ?
    `).all(safeLimit) as Row[]).map((row) => this.mapUploadSession(row));
  }

  deleteUploadSessionsForJob(jobId: string): number {
    return this.db.prepare("DELETE FROM upload_sessions WHERE job_id = ?").run(jobId).changes;
  }

  updateUploadSession(
    id: string,
    update: {
      receivedBytes?: number;
      status?: UploadStatus;
      jobId?: string | null;
      message?: string | null;
    }
  ): UploadSession {
    const current = this.db.prepare("SELECT * FROM upload_sessions WHERE id = ?").get(id) as Row | undefined;
    if (!current) throw new Error("Upload session not found");
    this.db.prepare(`
      UPDATE upload_sessions SET
        received_size = ?, status = ?, job_id = ?, message = ?, updated_at = ?
      WHERE id = ?
    `).run(
      update.receivedBytes ?? current.received_size,
      update.status ?? current.status,
      update.jobId === undefined ? current.job_id : update.jobId,
      update.message === undefined ? current.message : update.message,
      new Date().toISOString(),
      id
    );
    return this.getUploadSession(id)!;
  }

  recordDiagnostic(input: DiagnosticInput): DiagnosticEvent {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO diagnostic_events (
        id, level, category, message, stack, job_id, archive_id,
        source_name, context_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.level,
      input.category,
      input.message.slice(0, 4_000),
      input.stack?.slice(0, 12_000) ?? null,
      input.jobId ?? null,
      input.archiveId ?? null,
      input.sourceName ?? null,
      serializeContext(input.context),
      now
    );
    return this.listDiagnostics({ id, limit: 1 })[0]!;
  }

  listDiagnostics(options: {
    id?: string;
    level?: DiagnosticLevel;
    category?: DiagnosticCategory;
    jobId?: string;
    limit?: number;
  } = {}): DiagnosticEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.id) {
      conditions.push("id = ?");
      params.push(options.id);
    }
    if (options.level) {
      conditions.push("level = ?");
      params.push(options.level);
    }
    if (options.category) {
      conditions.push("category = ?");
      params.push(options.category);
    }
    if (options.jobId) {
      conditions.push("job_id = ?");
      params.push(options.jobId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(1_000, Math.max(1, Math.trunc(options.limit ?? 300)));
    return (this.db.prepare(`
      SELECT * FROM diagnostic_events ${where}
      ORDER BY created_at DESC LIMIT ?
    `).all(...params, limit) as Row[]).map((row) => this.mapDiagnostic(row));
  }

  listAllDiagnostics(): DiagnosticEvent[] {
    return (this.db.prepare(`
      SELECT * FROM diagnostic_events ORDER BY created_at DESC
    `).all() as Row[]).map((row) => this.mapDiagnostic(row));
  }

  createAiJob(input: AiJobCreateInput): AiJob {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO ai_jobs (
        id, message_id, task, status, model, prompt_version, content_hash,
        attempts, max_attempts, created_at, updated_at
      ) VALUES (?, ?, 'analyze', 'queued', ?, ?, ?, 0, ?, ?, ?)
    `).run(
      id,
      input.messageId,
      input.model,
      input.promptVersion,
      input.contentHash,
      input.maxAttempts ?? 2,
      now,
      now
    );
    return this.getAiJob(id)!;
  }

  getAiJob(id: string): AiJob | null {
    const row = this.db.prepare("SELECT * FROM ai_jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapAiJob(row) : null;
  }

  getActiveAiJob(messageId: string): AiJob | null {
    const row = this.db.prepare(`
      SELECT * FROM ai_jobs
      WHERE message_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1
    `).get(messageId) as Row | undefined;
    return row ? this.mapAiJob(row) : null;
  }

  getLatestAiJob(messageId: string): AiJob | null {
    const row = this.db.prepare(`
      SELECT * FROM ai_jobs WHERE message_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(messageId) as Row | undefined;
    return row ? this.mapAiJob(row) : null;
  }

  listAiJobs(limit = 300): AiJob[] {
    return (this.db.prepare(`
      SELECT * FROM ai_jobs ORDER BY created_at DESC LIMIT ?
    `).all(Math.min(1_000, Math.max(1, Math.trunc(limit)))) as Row[])
      .map((row) => this.mapAiJob(row));
  }

  claimNextAiJob(): AiJob | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id FROM ai_jobs WHERE status = 'queued'
        ORDER BY created_at LIMIT 1
      `).get() as Row | undefined;
      if (!row) return null;
      const now = new Date().toISOString();
      this.db.prepare(`
        UPDATE ai_jobs
        SET status = 'running', attempts = attempts + 1, error = NULL,
            started_at = ?, completed_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(now, now, row.id);
      return this.getAiJob(String(row.id));
    });
    return claim();
  }

  hasQueuedAiJobs(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ai_jobs WHERE status = 'queued' LIMIT 1").get());
  }

  completeAiJob(id: string): AiJob {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ai_jobs
      SET status = 'completed', error = NULL, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(now, now, id);
    const job = this.getAiJob(id);
    if (!job) throw new Error("AI job not found");
    return job;
  }

  failAiJob(id: string, error: string, retry = false): AiJob {
    const current = this.getAiJob(id);
    if (!current) throw new Error("AI job not found");
    if (current.status === "cancelled") return current;
    const shouldRetry = retry && current.attempts < current.maxAttempts;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ai_jobs
      SET status = ?, error = ?, completed_at = ?, started_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      shouldRetry ? "queued" : "failed",
      error.slice(0, 4_000),
      shouldRetry ? null : now,
      shouldRetry ? null : current.startedAt,
      now,
      id
    );
    return this.getAiJob(id)!;
  }

  cancelAiJob(id: string): AiJob {
    const current = this.getAiJob(id);
    if (!current) throw new Error("AI job not found");
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE ai_jobs
      SET status = 'cancelled', error = 'Cancelled by user', completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.getAiJob(id)!;
  }

  getMessageAnalysis(messageId: string): MessageAnalysis | null {
    const row = this.db.prepare(`
      SELECT * FROM ai_message_analysis WHERE message_id = ?
    `).get(messageId) as Row | undefined;
    return row ? this.mapMessageAnalysis(row) : null;
  }

  upsertMessageAnalysis(input: MessageAnalysisUpsertInput): MessageAnalysis {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO ai_message_analysis (
        id, message_id, summary, categories_json, priority, action_required,
        action_summary, spam_probability, phishing_probability, draft_recommended,
        confidence, signals_json, model, prompt_version, content_hash,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        summary = excluded.summary,
        categories_json = excluded.categories_json,
        priority = excluded.priority,
        action_required = excluded.action_required,
        action_summary = excluded.action_summary,
        spam_probability = excluded.spam_probability,
        phishing_probability = excluded.phishing_probability,
        draft_recommended = excluded.draft_recommended,
        confidence = excluded.confidence,
        signals_json = excluded.signals_json,
        model = excluded.model,
        prompt_version = excluded.prompt_version,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.messageId,
      input.summary,
      JSON.stringify(input.categories),
      input.priority,
      input.actionRequired ? 1 : 0,
      input.actionSummary,
      input.spamProbability,
      input.phishingProbability,
      input.draftRecommended ? 1 : 0,
      input.confidence,
      JSON.stringify(input.signals),
      input.model,
      input.promptVersion,
      input.contentHash,
      now,
      now
    );
    return this.getMessageAnalysis(input.messageId)!;
  }

  getAiUsageSummary(at = new Date()): AiUsageSummary {
    const day = at.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const today = this.db.prepare(`
      SELECT request_count, input_tokens, output_tokens
      FROM ai_usage_daily WHERE usage_date = ?
    `).get(day) as Row | undefined;
    const monthly = this.db.prepare(`
      SELECT
        COALESCE(SUM(request_count), 0) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM ai_usage_daily WHERE substr(usage_date, 1, 7) = ?
    `).get(month) as Row;
    return {
      todayRequests: Number(today?.request_count ?? 0),
      monthRequests: Number(monthly.request_count ?? 0),
      todayInputTokens: Number(today?.input_tokens ?? 0),
      todayOutputTokens: Number(today?.output_tokens ?? 0),
      monthInputTokens: Number(monthly.input_tokens ?? 0),
      monthOutputTokens: Number(monthly.output_tokens ?? 0)
    };
  }

  consumeAiRequest(dailyLimit: number, monthlyLimit: number, at = new Date()): boolean {
    const consume = this.db.transaction(() => {
      const usage = this.getAiUsageSummary(at);
      if (usage.todayRequests >= dailyLimit || usage.monthRequests >= monthlyLimit) return false;
      const day = at.toISOString().slice(0, 10);
      const now = at.toISOString();
      this.db.prepare(`
        INSERT INTO ai_usage_daily (usage_date, request_count, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(usage_date) DO UPDATE SET
          request_count = request_count + 1,
          updated_at = excluded.updated_at
      `).run(day, now);
      return true;
    });
    return consume();
  }

  recordAiTokenUsage(inputTokens: number, outputTokens: number, at = new Date()): void {
    const day = at.toISOString().slice(0, 10);
    this.db.prepare(`
      UPDATE ai_usage_daily
      SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ?
      WHERE usage_date = ?
    `).run(
      Math.max(0, Math.trunc(inputTokens)),
      Math.max(0, Math.trunc(outputTokens)),
      at.toISOString(),
      day
    );
  }

  createGmailConnection(input: GmailConnectionCreateInput): GmailConnection {
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      const folder = this.db.prepare(`
        SELECT f.id FROM folders f
        JOIN archives a ON a.id = f.archive_id
        WHERE f.id = ? AND f.archive_id = ? AND a.status != 'importing'
      `).get(input.folderId, input.archiveId);
      if (!folder) throw new Error("The Gmail destination mailbox is unavailable");

      const existing = this.db.prepare(`
        SELECT id FROM gmail_connections
        WHERE lower(email) = lower(?) AND archive_id = ? AND folder_id = ?
        ORDER BY updated_at DESC LIMIT 1
      `).get(input.email, input.archiveId, input.folderId) as Row | undefined;
      const id = existing ? String(existing.id) : input.id ?? randomUUID();
      if (existing) {
        this.db.prepare(`
          UPDATE gmail_connections SET
            query = ?, ocr_enabled = ?, refresh_token = ?, access_token = ?,
            access_token_expires_at = ?, can_send = ?, status = 'connected', last_error = NULL,
            updated_at = ?
          WHERE id = ?
        `).run(
          input.query,
          input.ocrEnabled ? 1 : 0,
          input.refreshToken,
          input.accessToken ?? null,
          input.accessTokenExpiresAt ?? null,
          input.canSend ? 1 : 0,
          now,
          id
        );
      } else {
        this.db.prepare(`
          INSERT INTO gmail_connections (
            id, email, archive_id, folder_id, query, ocr_enabled,
            refresh_token, access_token, access_token_expires_at,
            can_send, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
        `).run(
          id,
          input.email,
          input.archiveId,
          input.folderId,
          input.query,
          input.ocrEnabled ? 1 : 0,
          input.refreshToken,
          input.accessToken ?? null,
          input.accessTokenExpiresAt ?? null,
          input.canSend ? 1 : 0,
          now,
          now
        );
      }
      return this.getGmailConnection(id)!;
    });
    return create();
  }

  getGmailConnection(id: string): GmailConnection | null {
    const row = this.gmailConnectionRow(id);
    return row ? this.mapGmailConnection(row) : null;
  }

  getGmailConnectionRecord(id: string): GmailConnectionRecord | null {
    const row = this.gmailConnectionRow(id);
    return row ? this.mapGmailConnectionRecord(row) : null;
  }

  listGmailConnections(): GmailConnection[] {
    return (this.db.prepare(`
      SELECT c.*, a.name AS archive_name, f.path AS folder_path
      FROM gmail_connections c
      JOIN archives a ON a.id = c.archive_id
      JOIN folders f ON f.id = c.folder_id
      ORDER BY c.updated_at DESC
    `).all() as Row[]).map((row) => this.mapGmailConnection(row));
  }

  updateGmailTokens(
    id: string,
    accessToken: string,
    accessTokenExpiresAt: string,
    refreshToken?: string
  ): void {
    const now = new Date().toISOString();
    if (refreshToken) {
      this.db.prepare(`
        UPDATE gmail_connections
        SET access_token = ?, access_token_expires_at = ?, refresh_token = ?, updated_at = ?
        WHERE id = ?
      `).run(accessToken, accessTokenExpiresAt, refreshToken, now, id);
    } else {
      this.db.prepare(`
        UPDATE gmail_connections
        SET access_token = ?, access_token_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(accessToken, accessTokenExpiresAt, now, id);
    }
  }

  updateGmailSync(
    id: string,
    update: {
      status?: GmailConnectionStatus;
      processedItems?: number;
      totalItems?: number | null;
      importedItems?: number;
      lastSyncedAt?: string | null;
      lastError?: string | null;
    }
  ): GmailConnection {
    const columns: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };
    if (update.status !== undefined) set("status", update.status);
    if (update.processedItems !== undefined) set("processed_items", update.processedItems);
    if (update.totalItems !== undefined) set("total_items", update.totalItems);
    if (update.importedItems !== undefined) set("imported_items", update.importedItems);
    if (update.lastSyncedAt !== undefined) set("last_synced_at", update.lastSyncedAt);
    if (update.lastError !== undefined) set("last_error", update.lastError);
    set("updated_at", new Date().toISOString());
    values.push(id);
    const result = this.db.prepare(`
      UPDATE gmail_connections SET ${columns.join(", ")} WHERE id = ?
    `).run(...values);
    if (result.changes === 0) throw new Error("Gmail connection not found");
    return this.getGmailConnection(id)!;
  }

  deleteGmailConnection(id: string): GmailConnectionRecord | null {
    const connection = this.getGmailConnectionRecord(id);
    if (!connection) return null;
    this.db.prepare("DELETE FROM gmail_connections WHERE id = ?").run(id);
    return connection;
  }

  hasActiveGmailSync(archiveIds: string[]): boolean {
    if (archiveIds.length === 0) return false;
    const placeholders = archiveIds.map(() => "?").join(", ");
    return Boolean(this.db.prepare(`
      SELECT 1 FROM gmail_connections
      WHERE status = 'syncing' AND archive_id IN (${placeholders}) LIMIT 1
    `).get(...archiveIds));
  }

  clearDiagnostics(): number {
    return this.db.prepare("DELETE FROM diagnostic_events").run().changes;
  }

  createFolder(archiveId: string, name: string, parentId: string | null = null): Folder {
    const create = this.db.transaction(() => {
      const archive = this.db.prepare("SELECT status FROM archives WHERE id = ?")
        .get(archiveId) as Row | undefined;
      if (!archive) throw new Error("Archive not found");
      if (archive.status === "importing") {
        throw new Error("Wait for the archive import to finish before creating a mailbox");
      }

      let parentPath = "";
      if (parentId) {
        const parent = this.db.prepare("SELECT archive_id, path FROM folders WHERE id = ?")
          .get(parentId) as Row | undefined;
        if (!parent || String(parent.archive_id) !== archiveId) {
          throw new Error("Parent mailbox not found in this archive");
        }
        parentPath = String(parent.path);
      }
      const cleanName = name.trim();
      const path = parentPath ? `${parentPath}/${cleanName}` : cleanName;
      const existing = this.db.prepare(
        "SELECT 1 FROM folders WHERE archive_id = ? AND path = ?"
      ).get(archiveId, path);
      if (existing) throw new Error(`A mailbox named "${cleanName}" already exists here`);

      const id = randomUUID();
      this.db.prepare(`
        INSERT INTO folders (id, archive_id, parent_id, name, path)
        VALUES (?, ?, ?, ?, ?)
      `).run(id, archiveId, parentId, cleanName, path);
      return this.getFolder(id)!;
    });
    return create();
  }

  ensureFolder(archiveId: string, path: string, name: string, parentId: string | null): Folder {
    const existing = this.db.prepare(
      "SELECT id FROM folders WHERE archive_id = ? AND path = ?"
    ).get(archiveId, path) as Row | undefined;
    if (existing) return this.getFolder(String(existing.id))!;

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO folders (id, archive_id, parent_id, name, path)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, archiveId, parentId, name, path);
    return this.getFolder(id)!;
  }

  getFolder(id: string): Folder | null {
    const row = this.db.prepare(`
      SELECT f.*,
        (
          SELECT COUNT(*) FROM messages m
          JOIN message_state s ON s.message_id = m.id
          WHERE m.folder_id = f.id AND s.is_read = 0
        ) AS live_unread_count
      FROM folders f WHERE f.id = ?
    `).get(id) as Row | undefined;
    return row ? this.mapFolder(row) : null;
  }

  listFolders(archiveId: string): Folder[] {
    return (this.db.prepare(`
      SELECT f.*,
        (
          SELECT COUNT(*) FROM messages m
          JOIN message_state s ON s.message_id = m.id
          WHERE m.folder_id = f.id AND s.is_read = 0
        ) AS live_unread_count
      FROM folders f WHERE f.archive_id = ? ORDER BY f.path COLLATE NOCASE
    `).all(archiveId) as Row[]).map((row) => this.mapFolder(row));
  }

  renameFolder(id: string, name: string): Folder {
    const rename = this.db.transaction(() => {
      const folderRow = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as Row | undefined;
      if (!folderRow) throw new Error("Folder not found");
      const archiveId = String(folderRow.archive_id);
      const archiveRow = this.db.prepare("SELECT status FROM archives WHERE id = ?")
        .get(archiveId) as Row | undefined;
      if (archiveRow?.status === "importing") {
        throw new Error("Wait for the archive import to finish before renaming this mailbox");
      }
      const oldPath = String(folderRow.path);
      let parentPath = "";
      if (folderRow.parent_id) {
        const parent = this.db.prepare("SELECT path FROM folders WHERE id = ?")
          .get(folderRow.parent_id) as Row | undefined;
        if (!parent) throw new Error("Parent folder not found");
        parentPath = String(parent.path);
      }
      const newPath = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
      if (newPath === oldPath) return this.getFolder(id)!;

      const affected = this.db.prepare(`
        SELECT id, path FROM folders
        WHERE archive_id = ?
          AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
        ORDER BY length(path), path
      `).all(archiveId, oldPath, oldPath, oldPath) as Row[];
      const affectedIds = new Set(affected.map((row) => String(row.id)));
      const replacements = affected.map((row) => ({
        id: String(row.id),
        path: `${newPath}${String(row.path).slice(oldPath.length)}`
      }));

      for (const replacement of replacements) {
        const collision = this.db.prepare(`
          SELECT id FROM folders WHERE archive_id = ? AND path = ?
        `).get(archiveId, replacement.path) as Row | undefined;
        if (collision && !affectedIds.has(String(collision.id))) {
          throw new Error(`A folder named "${name.trim()}" already exists here`);
        }
      }

      const temporaryPrefix = `__rename_${randomUUID()}`;
      affected.forEach((row, index) => {
        this.db.prepare("UPDATE folders SET path = ? WHERE id = ?")
          .run(`${temporaryPrefix}_${index}`, row.id);
      });
      this.db.prepare("UPDATE folders SET name = ? WHERE id = ?").run(name.trim(), id);
      for (const replacement of replacements) {
        this.db.prepare("UPDATE folders SET path = ? WHERE id = ?")
          .run(replacement.path, replacement.id);
      }

      const placeholders = replacements.map(() => "?").join(", ");
      this.db.prepare(`
        UPDATE message_fts
        SET folder = (
          SELECT f.path FROM messages m
          JOIN folders f ON f.id = m.folder_id
          WHERE m.id = message_fts.message_id
        )
        WHERE message_id IN (
          SELECT id FROM messages WHERE folder_id IN (${placeholders})
        )
      `).run(...replacements.map((replacement) => replacement.id));
      return this.getFolder(id)!;
    });
    return rename();
  }

  deleteFolder(id: string): string[] {
    const orphanedPaths: string[] = [];
    const remove = this.db.transaction(() => {
      const folder = this.db.prepare("SELECT * FROM folders WHERE id = ?").get(id) as Row | undefined;
      if (!folder) throw new Error("Mailbox not found");
      const archiveId = String(folder.archive_id);
      const path = String(folder.path);
      const archive = this.db.prepare("SELECT status FROM archives WHERE id = ?")
        .get(archiveId) as Row | undefined;
      if (archive?.status === "importing") {
        throw new Error("Wait for the archive import to finish before deleting this mailbox");
      }

      const blobs = this.db.prepare(`
        SELECT b.sha256, b.relative_path, COUNT(a.id) AS removed_refs, b.ref_count
        FROM blobs b
        JOIN attachments a ON a.blob_sha256 = b.sha256
        JOIN messages m ON m.id = a.message_id
        JOIN folders f ON f.id = m.folder_id
        WHERE f.archive_id = ?
          AND (f.path = ? OR substr(f.path, 1, length(?) + 1) = ? || '/')
        GROUP BY b.sha256
      `).all(archiveId, path, path, path) as Row[];

      this.db.prepare(`
        DELETE FROM attachment_fts
        WHERE message_id IN (
          SELECT m.id FROM messages m
          JOIN folders f ON f.id = m.folder_id
          WHERE f.archive_id = ?
            AND (f.path = ? OR substr(f.path, 1, length(?) + 1) = ? || '/')
        )
      `).run(archiveId, path, path, path);
      this.db.prepare(`
        DELETE FROM message_fts
        WHERE message_id IN (
          SELECT m.id FROM messages m
          JOIN folders f ON f.id = m.folder_id
          WHERE f.archive_id = ?
            AND (f.path = ? OR substr(f.path, 1, length(?) + 1) = ? || '/')
        )
      `).run(archiveId, path, path, path);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);

      for (const blob of blobs) {
        const nextRefCount = Number(blob.ref_count) - Number(blob.removed_refs);
        if (nextRefCount <= 0) {
          this.db.prepare("DELETE FROM blobs WHERE sha256 = ?").run(blob.sha256);
          orphanedPaths.push(String(blob.relative_path));
        } else {
          this.db.prepare("UPDATE blobs SET ref_count = ? WHERE sha256 = ?")
            .run(nextRefCount, blob.sha256);
        }
      }
    });
    remove();
    return orphanedPaths;
  }

  insertMessage(input: MessageInput): string {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const allRecipients = [...input.to, ...input.cc, ...input.bcc];
    const recipientsText = allRecipients.map(addressToText).join(" ");
    const folder = this.getFolder(input.folderId);
    if (!folder) throw new Error(`Folder ${input.folderId} not found`);

    const insert = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO messages (
          id, archive_id, folder_id, source_key, internet_message_id, subject,
          sender_name, sender_address, to_json, cc_json, bcc_json, recipients_text,
          sent_at, received_at, body_text, body_html, headers_json,
          has_attachments, attachment_count, size_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.archiveId,
        input.folderId,
        input.sourceKey,
        input.internetMessageId,
        input.subject,
        input.sender.name,
        input.sender.address,
        JSON.stringify(input.to),
        JSON.stringify(input.cc),
        JSON.stringify(input.bcc),
        recipientsText,
        input.sentAt,
        input.receivedAt,
        input.bodyText,
        input.bodyHtml,
        JSON.stringify(input.headers),
        input.attachments.length > 0 ? 1 : 0,
        input.attachments.length,
        input.sizeBytes,
        now
      );

      if (result.changes === 0) {
        const existing = this.db.prepare(`
          SELECT id FROM messages WHERE archive_id = ? AND source_key = ?
        `).get(input.archiveId, input.sourceKey) as Row;
        return String(existing.id);
      }

      this.db.prepare("INSERT INTO message_state (message_id) VALUES (?)").run(id);
      this.db.prepare(`
        INSERT INTO message_fts (message_id, subject, sender, recipients, folder, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.subject,
        addressToText(input.sender),
        recipientsText,
        folder.path,
        input.bodyText
      );

      for (const attachment of input.attachments) {
        const attachmentId = attachment.id ?? randomUUID();
        this.db.prepare(`
          INSERT INTO blobs (sha256, relative_path, size_bytes, ref_count)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(sha256) DO UPDATE SET ref_count = ref_count + 1
        `).run(attachment.blob.sha256, attachment.blob.relativePath, attachment.blob.sizeBytes);
        this.db.prepare(`
          INSERT INTO attachments (
            id, message_id, filename, content_type, size_bytes, content_id,
            disposition, text_status, extracted_text, blob_sha256
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          attachmentId,
          id,
          attachment.filename,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.contentId,
          attachment.disposition,
          attachment.textStatus,
          attachment.extractedText,
          attachment.blob.sha256
        );
        this.db.prepare(`
          INSERT INTO attachment_fts (attachment_id, message_id, filename, content)
          VALUES (?, ?, ?, ?)
        `).run(attachmentId, id, attachment.filename, attachment.extractedText);
      }

      this.db.prepare(`
        UPDATE folders SET message_count = message_count + 1 WHERE id = ?
      `).run(input.folderId);
      return id;
    });

    return insert();
  }

  hasMessage(archiveId: string, sourceKey: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM messages WHERE archive_id = ? AND source_key = ?
    `).get(archiveId, sourceKey));
  }

  setInitialMessageReadState(archiveId: string, sourceKey: string, isRead: boolean): boolean {
    const result = this.db.prepare(`
      UPDATE message_state
      SET is_read = ?
      WHERE message_id = (
        SELECT id FROM messages WHERE archive_id = ? AND source_key = ?
      ) AND updated_at IS NULL
    `).run(isRead ? 1 : 0, archiveId, sourceKey);
    return result.changes > 0;
  }

  listMessages(options: {
    archiveId?: string;
    folderId?: string;
    cursor?: string;
    limit?: number;
  }): CursorPage<MessageSummary> {
    const limit = clampLimit(options.limit);
    const offset = decodeOffset(options.cursor);
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (options.archiveId) {
      conditions.push("m.archive_id = ?");
      params.push(options.archiveId);
    }
    if (options.folderId) {
      conditions.push("m.folder_id = ?");
      params.push(options.folderId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT ${MESSAGE_SUMMARY_COLUMNS}
      ${MESSAGE_SUMMARY_JOINS}
      ${where}
      ORDER BY
        CASE WHEN COALESCE(m.received_at, m.sent_at) IS NULL THEN 1 ELSE 0 END,
        COALESCE(m.received_at, m.sent_at) DESC,
        m.created_at DESC,
        m.id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit + 1, offset) as Row[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.mapMessageSummary(row));
    return { items, nextCursor: hasMore ? encodeOffset(offset + limit) : null };
  }

  getMessage(id: string): MessageDetail | null {
    const row = this.db.prepare(`
      SELECT ${MESSAGE_SUMMARY_COLUMNS},
        m.cc_json, m.bcc_json, m.body_html, m.headers_json
      ${MESSAGE_SUMMARY_JOINS}
      WHERE m.id = ?
    `).get(id) as Row | undefined;
    if (!row) return null;
    const summary = this.mapMessageSummary(row);
    return {
      ...summary,
      to: parseJson<EmailAddress[]>(row.to_json, []),
      cc: parseJson<EmailAddress[]>(row.cc_json, []),
      bcc: parseJson<EmailAddress[]>(row.bcc_json, []),
      bodyText: String(row.body_text ?? ""),
      bodyHtml: row.body_html ? String(row.body_html) : null,
      headers: parseJson<Record<string, string>>(row.headers_json, {}),
      attachments: this.listAttachments(id)
    };
  }

  listAttachments(messageId: string): Attachment[] {
    return (this.db.prepare(`
      SELECT * FROM attachments WHERE message_id = ?
      ORDER BY CASE disposition WHEN 'inline' THEN 1 ELSE 0 END, filename COLLATE NOCASE
    `).all(messageId) as Row[]).map((row) => this.mapAttachment(row));
  }

  getAttachmentBlob(id: string): { attachment: Attachment; relativePath: string } | null {
    const row = this.db.prepare(`
      SELECT a.*, b.relative_path
      FROM attachments a JOIN blobs b ON b.sha256 = a.blob_sha256
      WHERE a.id = ?
    `).get(id) as Row | undefined;
    if (!row) return null;
    return {
      attachment: this.mapAttachment(row),
      relativePath: String(row.relative_path)
    };
  }

  updateMessageState(id: string, patch: LocalMessageStatePatch): LocalMessageState {
    const row = this.db.prepare(`
      SELECT * FROM message_state WHERE message_id = ?
    `).get(id) as Row | undefined;
    if (!row) throw new Error(`Message ${id} not found`);
    const current = this.mapState(row);
    const next: LocalMessageState = {
      isRead: patch.isRead ?? current.isRead,
      isStarred: patch.isStarred ?? current.isStarred,
      tags: patch.tags
        ? [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))]
        : current.tags,
      note: patch.note ?? current.note,
      updatedAt: new Date().toISOString()
    };
    this.db.prepare(`
      UPDATE message_state
      SET is_read = ?, is_starred = ?, tags_json = ?, note = ?, updated_at = ?
      WHERE message_id = ?
    `).run(
      next.isRead ? 1 : 0,
      next.isStarred ? 1 : 0,
      JSON.stringify(next.tags),
      next.note,
      next.updatedAt,
      id
    );
    return next;
  }

  copyMessageState(sourceArchiveId: string, destinationArchiveId: string): void {
    this.db.prepare(`
      UPDATE message_state AS destination
      SET
        is_read = source.is_read,
        is_starred = source.is_starred,
        tags_json = source.tags_json,
        note = source.note,
        updated_at = source.updated_at
      FROM messages AS destination_message
      JOIN messages AS source_message
        ON source_message.archive_id = ?
        AND destination_message.archive_id = ?
        AND (
          (
            source_message.internet_message_id IS NOT NULL
            AND source_message.internet_message_id = destination_message.internet_message_id
          )
          OR source_message.source_key = destination_message.source_key
        )
      JOIN message_state AS source ON source.message_id = source_message.id
      WHERE destination.message_id = destination_message.id
    `).run(sourceArchiveId, destinationArchiveId);
  }

  search(options: SearchQuery): CursorPage<SearchHit> {
    const ftsQuery = toFtsQuery(options.q);
    if (!ftsQuery) return { items: [], nextCursor: null };
    const limit = clampLimit(options.limit);
    const offset = decodeOffset(options.cursor);
    const filters: string[] = [];
    const filterParams: unknown[] = [];

    if (options.archiveId) {
      filters.push("m.archive_id = ?");
      filterParams.push(options.archiveId);
    }
    if (options.folderId) {
      filters.push("m.folder_id = ?");
      filterParams.push(options.folderId);
    }
    if (options.from) {
      filters.push("lower(m.sender_address || ' ' || COALESCE(m.sender_name, '')) LIKE ?");
      filterParams.push(`%${options.from.toLowerCase()}%`);
    }
    if (options.to) {
      filters.push("lower(m.recipients_text) LIKE ?");
      filterParams.push(`%${options.to.toLowerCase()}%`);
    }
    if (options.after) {
      filters.push("COALESCE(m.received_at, m.sent_at) >= ?");
      filterParams.push(options.after);
    }
    if (options.before) {
      filters.push("COALESCE(m.received_at, m.sent_at) <= ?");
      filterParams.push(options.before);
    }
    if (options.hasAttachment !== undefined) {
      filters.push("m.has_attachments = ?");
      filterParams.push(options.hasAttachment ? 1 : 0);
    }

    const filterSql = filters.length ? `AND ${filters.join(" AND ")}` : "";
    const sortSql = options.sort === "newest"
      ? `CASE WHEN COALESCE(m.received_at, m.sent_at) IS NULL THEN 1 ELSE 0 END,
        COALESCE(m.received_at, m.sent_at) DESC,
        ranked.rank ASC,
        m.created_at DESC,
        m.id DESC`
      : `ranked.rank ASC,
        CASE WHEN COALESCE(m.received_at, m.sent_at) IS NULL THEN 1 ELSE 0 END,
        COALESCE(m.received_at, m.sent_at) DESC,
        m.created_at DESC,
        m.id DESC`;

    const rows = this.db.prepare(`
      WITH raw_hits AS (
        SELECT
          message_id,
          bm25(message_fts, 0.0, 5.0, 2.5, 2.0, 1.5, 1.0) AS rank,
          'message' AS matched_in,
          NULL AS attachment_id,
          NULL AS attachment_name,
          snippet(message_fts, -1, '<mark>', '</mark>', ' ... ', 24) AS hit_snippet
        FROM message_fts
        WHERE message_fts MATCH ?
        UNION ALL
        SELECT
          message_id,
          bm25(attachment_fts, 0.0, 0.0, 3.0, 1.0) + 0.2 AS rank,
          'attachment' AS matched_in,
          attachment_id,
          filename AS attachment_name,
          snippet(attachment_fts, -1, '<mark>', '</mark>', ' ... ', 24) AS hit_snippet
        FROM attachment_fts
        WHERE attachment_fts MATCH ?
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY message_id ORDER BY rank ASC) AS hit_order
        FROM raw_hits
      )
      SELECT ${MESSAGE_SUMMARY_COLUMNS},
        ranked.rank,
        ranked.matched_in,
        ranked.attachment_id,
        ranked.attachment_name,
        ranked.hit_snippet
      FROM ranked
      JOIN messages m ON m.id = ranked.message_id
      JOIN folders f ON f.id = m.folder_id
      LEFT JOIN message_state s ON s.message_id = m.id
      WHERE ranked.hit_order = 1 ${filterSql}
      ORDER BY ${sortSql}
      LIMIT ? OFFSET ?
    `).all(ftsQuery, ftsQuery, ...filterParams, limit + 1, offset) as Row[];

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row): SearchHit => ({
      message: this.mapMessageSummary(row),
      score: Number(row.rank ?? 0),
      matchedIn: row.matched_in === "attachment" ? "attachment" : "message",
      matchedAttachmentId: row.attachment_id ? String(row.attachment_id) : null,
      matchedAttachmentName: row.attachment_name ? String(row.attachment_name) : null,
      snippet: String(row.hit_snippet ?? "")
    }));
    return { items, nextCursor: hasMore ? encodeOffset(offset + limit) : null };
  }

  mergeArchives(sourceArchiveId: string, targetArchiveId: string): ArchiveMergeResult {
    if (sourceArchiveId === targetArchiveId) {
      throw new Error("Choose a different destination archive");
    }

    const merge = this.db.transaction(() => {
      const source = this.db.prepare("SELECT * FROM archives WHERE id = ?")
        .get(sourceArchiveId) as Row | undefined;
      const target = this.db.prepare("SELECT * FROM archives WHERE id = ?")
        .get(targetArchiveId) as Row | undefined;
      if (!source) throw new Error("Source archive not found");
      if (!target) throw new Error("Destination archive not found");
      if (!["ready", "ready_with_errors"].includes(String(source.status))
        || !["ready", "ready_with_errors"].includes(String(target.status))) {
        throw new Error("Wait for both archives to finish before combining them");
      }
      if (this.hasActiveGmailSync([sourceArchiveId, targetArchiveId])) {
        throw new Error("Wait for Gmail sync to finish before combining these archives");
      }

      const sourceFolders = this.db.prepare(`
        SELECT * FROM folders WHERE archive_id = ? ORDER BY length(path), path
      `).all(sourceArchiveId) as Row[];
      const folderMap = new Map<string, string>();
      for (const sourceFolder of sourceFolders) {
        const existing = this.db.prepare(`
          SELECT id FROM folders WHERE archive_id = ? AND path = ?
        `).get(targetArchiveId, sourceFolder.path) as Row | undefined;
        if (existing) {
          folderMap.set(String(sourceFolder.id), String(existing.id));
          continue;
        }
        const targetFolderId = randomUUID();
        const targetParentId = sourceFolder.parent_id
          ? folderMap.get(String(sourceFolder.parent_id)) ?? null
          : null;
        this.db.prepare(`
          INSERT INTO folders (id, archive_id, parent_id, name, path, message_count)
          VALUES (?, ?, ?, ?, ?, 0)
        `).run(
          targetFolderId,
          targetArchiveId,
          targetParentId,
          sourceFolder.name,
          sourceFolder.path
        );
        folderMap.set(String(sourceFolder.id), targetFolderId);
      }

      const counts = this.db.prepare(`
        SELECT
          COUNT(DISTINCT m.id) AS messages,
          COUNT(a.id) AS attachments
        FROM messages m
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.archive_id = ?
      `).get(sourceArchiveId) as Row;

      this.db.exec(`
        DROP TABLE IF EXISTS temp.archive_merge_messages;
        CREATE TEMP TABLE archive_merge_messages (
          message_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
      `);
      this.db.prepare(`
        INSERT INTO archive_merge_messages (message_id)
        SELECT id FROM messages WHERE archive_id = ?
      `).run(sourceArchiveId);

      this.db.prepare(`
        UPDATE messages AS source_message
        SET source_key = 'merged:' || ? || ':' || source_key
        WHERE source_message.archive_id = ?
          AND EXISTS (
            SELECT 1 FROM messages target_message
            WHERE target_message.archive_id = ?
              AND target_message.source_key = source_message.source_key
          )
      `).run(sourceArchiveId, sourceArchiveId, targetArchiveId);

      for (const [sourceFolderId, targetFolderId] of folderMap) {
        this.db.prepare(`
          UPDATE messages
          SET archive_id = ?, folder_id = ?
          WHERE archive_id = ? AND folder_id = ?
        `).run(
          targetArchiveId,
          targetFolderId,
          sourceArchiveId,
          sourceFolderId
        );
        this.db.prepare(`
          UPDATE gmail_connections
          SET archive_id = ?, folder_id = ?, updated_at = ?
          WHERE archive_id = ? AND folder_id = ?
        `).run(
          targetArchiveId,
          targetFolderId,
          new Date().toISOString(),
          sourceArchiveId,
          sourceFolderId
        );
      }

      this.db.prepare(`
        UPDATE message_fts
        SET folder = (
          SELECT f.path FROM messages m
          JOIN folders f ON f.id = m.folder_id
          WHERE m.id = message_fts.message_id
        )
        WHERE message_id IN (SELECT message_id FROM archive_merge_messages)
      `).run();

      this.db.prepare(`
        UPDATE import_jobs SET archive_id = ? WHERE archive_id = ?
      `).run(targetArchiveId, sourceArchiveId);
      this.db.prepare("DELETE FROM folders WHERE archive_id = ?").run(sourceArchiveId);
      this.db.prepare("DELETE FROM archives WHERE id = ?").run(sourceArchiveId);

      this.db.prepare(`
        UPDATE folders SET message_count = (
          SELECT COUNT(*) FROM messages WHERE folder_id = folders.id
        ) WHERE archive_id = ?
      `).run(targetArchiveId);
      this.db.prepare(`
        UPDATE archives SET
          size_bytes = size_bytes + ?,
          status = ?,
          error_count = error_count + ?,
          message_count = (SELECT COUNT(*) FROM messages WHERE archive_id = archives.id),
          folder_count = (SELECT COUNT(*) FROM folders WHERE archive_id = archives.id),
          attachment_count = (
            SELECT COUNT(*) FROM attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE m.archive_id = archives.id
          ),
          imported_at = ?
        WHERE id = ?
      `).run(
        Number(source.size_bytes),
        source.status === "ready_with_errors" || target.status === "ready_with_errors"
          ? "ready_with_errors"
          : "ready",
        Number(source.error_count),
        new Date().toISOString(),
        targetArchiveId
      );
      this.db.exec("DROP TABLE temp.archive_merge_messages");

      return {
        movedMessages: Number(counts.messages),
        movedFolders: sourceFolders.length,
        movedAttachments: Number(counts.attachments)
      };
    });

    const result = merge();
    return {
      archive: this.getArchive(targetArchiveId)!,
      ...result
    };
  }

  mergeFolders(sourceFolderId: string, targetFolderId: string): MailboxMergeResult {
    if (sourceFolderId === targetFolderId) {
      throw new Error("Choose a different destination mailbox");
    }

    const merge = this.db.transaction(() => {
      const source = this.db.prepare("SELECT * FROM folders WHERE id = ?")
        .get(sourceFolderId) as Row | undefined;
      const target = this.db.prepare("SELECT * FROM folders WHERE id = ?")
        .get(targetFolderId) as Row | undefined;
      if (!source) throw new Error("Source mailbox not found");
      if (!target) throw new Error("Destination mailbox not found");

      const archiveId = String(source.archive_id);
      if (archiveId !== String(target.archive_id)) {
        throw new Error("Choose a destination mailbox in the same archive");
      }
      const archive = this.db.prepare("SELECT status FROM archives WHERE id = ?")
        .get(archiveId) as Row | undefined;
      if (!archive || !["ready", "ready_with_errors"].includes(String(archive.status))) {
        throw new Error("Wait for the archive import to finish before combining mailboxes");
      }
      if (this.hasActiveGmailSync([archiveId])) {
        throw new Error("Wait for Gmail sync to finish before combining these mailboxes");
      }

      const sourcePath = String(source.path);
      const targetPath = String(target.path);
      if (targetPath.startsWith(`${sourcePath}/`)) {
        throw new Error("A mailbox cannot be combined into one of its child mailboxes");
      }

      const sourceFolders = this.db.prepare(`
        SELECT id FROM folders
        WHERE archive_id = ?
          AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
      `).all(archiveId, sourcePath, sourcePath, sourcePath) as Row[];
      const sourceFolderIds = sourceFolders.map((folder) => String(folder.id));
      const placeholders = sourceFolderIds.map(() => "?").join(", ");
      const counts = this.db.prepare(`
        SELECT COUNT(DISTINCT m.id) AS messages, COUNT(a.id) AS attachments
        FROM messages m
        LEFT JOIN attachments a ON a.message_id = m.id
        WHERE m.folder_id IN (${placeholders})
      `).get(...sourceFolderIds) as Row;

      this.db.exec(`
        DROP TABLE IF EXISTS temp.mailbox_merge_messages;
        CREATE TEMP TABLE mailbox_merge_messages (
          message_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
      `);
      this.db.prepare(`
        INSERT INTO mailbox_merge_messages (message_id)
        SELECT id FROM messages WHERE folder_id IN (${placeholders})
      `).run(...sourceFolderIds);

      this.db.prepare(`
        UPDATE messages SET folder_id = ?
        WHERE id IN (SELECT message_id FROM mailbox_merge_messages)
      `).run(targetFolderId);
      this.db.prepare(`
        UPDATE gmail_connections SET folder_id = ?, updated_at = ?
        WHERE folder_id IN (${placeholders})
      `).run(targetFolderId, new Date().toISOString(), ...sourceFolderIds);
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(sourceFolderId);

      this.db.prepare(`
        UPDATE message_fts SET folder = ?
        WHERE message_id IN (SELECT message_id FROM mailbox_merge_messages)
      `).run(targetPath);
      this.db.prepare(`
        UPDATE folders SET message_count = (
          SELECT COUNT(*) FROM messages WHERE folder_id = folders.id
        ) WHERE archive_id = ?
      `).run(archiveId);
      this.db.prepare(`
        UPDATE archives SET
          message_count = (SELECT COUNT(*) FROM messages WHERE archive_id = archives.id),
          folder_count = (SELECT COUNT(*) FROM folders WHERE archive_id = archives.id),
          attachment_count = (
            SELECT COUNT(*) FROM attachments a
            JOIN messages m ON m.id = a.message_id
            WHERE m.archive_id = archives.id
          )
        WHERE id = ?
      `).run(archiveId);
      this.db.exec("DROP TABLE temp.mailbox_merge_messages");

      return {
        movedMessages: Number(counts.messages),
        removedMailboxes: sourceFolders.length,
        movedAttachments: Number(counts.attachments)
      };
    });

    const result = merge();
    return {
      mailbox: this.getFolder(targetFolderId)!,
      ...result
    };
  }

  deleteArchive(id: string): string[] {
    const orphanedPaths: string[] = [];
    const remove = this.db.transaction(() => {
      const blobs = this.db.prepare(`
        SELECT b.sha256, b.relative_path, COUNT(a.id) AS removed_refs, b.ref_count
        FROM blobs b
        JOIN attachments a ON a.blob_sha256 = b.sha256
        JOIN messages m ON m.id = a.message_id
        WHERE m.archive_id = ?
        GROUP BY b.sha256
      `).all(id) as Row[];

      this.db.prepare(`
        DELETE FROM attachment_fts
        WHERE message_id IN (SELECT id FROM messages WHERE archive_id = ?)
      `).run(id);
      this.db.prepare(`
        DELETE FROM message_fts
        WHERE message_id IN (SELECT id FROM messages WHERE archive_id = ?)
      `).run(id);
      this.db.prepare("DELETE FROM archives WHERE id = ?").run(id);

      for (const blob of blobs) {
        const nextRefCount = Number(blob.ref_count) - Number(blob.removed_refs);
        if (nextRefCount <= 0) {
          this.db.prepare("DELETE FROM blobs WHERE sha256 = ?").run(blob.sha256);
          orphanedPaths.push(String(blob.relative_path));
        } else {
          this.db.prepare(`
            UPDATE blobs SET ref_count = ? WHERE sha256 = ?
          `).run(nextRefCount, blob.sha256);
        }
      }
    });
    remove();
    return orphanedPaths;
  }

  private gmailConnectionRow(id: string): Row | undefined {
    return this.db.prepare(`
      SELECT c.*, a.name AS archive_name, f.path AS folder_path
      FROM gmail_connections c
      JOIN archives a ON a.id = c.archive_id
      JOIN folders f ON f.id = c.folder_id
      WHERE c.id = ?
    `).get(id) as Row | undefined;
  }

  private mapUser(row: Row): UserSummary {
    return {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      role: row.role as AccountRole,
      isActive: Boolean(row.is_active),
      mustChangePin: Boolean(row.must_change_pin),
      lastLoginAt: row.last_login_at ? String(row.last_login_at) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapUserRecord(row: Row): UserRecord {
    return {
      ...this.mapUser(row),
      pinHash: String(row.pin_hash),
      pinSalt: String(row.pin_salt)
    };
  }

  private mapAuthSession(row: Row): AuthSessionRecord {
    return {
      id: String(row.session_id),
      user: this.mapUser(row),
      role: row.effective_role as SessionRole,
      tokenHash: String(row.token_hash),
      ipAddress: String(row.ip_address),
      userAgent: row.user_agent ? String(row.user_agent) : null,
      expiresAt: String(row.expires_at),
      createdAt: String(row.session_created_at),
      lastSeenAt: String(row.last_seen_at)
    };
  }

  private mapAudit(row: Row): AuditEvent {
    return {
      id: String(row.id),
      sessionId: row.session_id ? String(row.session_id) : null,
      userId: row.user_id ? String(row.user_id) : null,
      username: row.username ? String(row.username) : null,
      displayName: row.display_name ? String(row.display_name) : null,
      role: row.role ? row.role as SessionRole : null,
      action: String(row.action),
      method: row.method ? String(row.method) : null,
      path: row.path ? String(row.path) : null,
      statusCode: Number(row.status_code),
      success: Boolean(row.success),
      ipAddress: String(row.ip_address),
      userAgent: row.user_agent ? String(row.user_agent) : null,
      details: parseJson<Record<string, unknown>>(row.details_json, {}),
      createdAt: String(row.created_at)
    };
  }

  private mapArchive(row: Row): Archive {
    return {
      id: String(row.id),
      name: String(row.name),
      sourceType: row.source_type as ArchiveSourceType,
      status: row.status as Archive["status"],
      sizeBytes: Number(row.size_bytes),
      messageCount: Number(row.live_message_count ?? row.message_count),
      unreadCount: Number(row.live_unread_count ?? 0),
      folderCount: Number(row.live_folder_count ?? row.folder_count),
      attachmentCount: Number(row.live_attachment_count ?? row.attachment_count),
      errorCount: Number(row.error_count),
      importedAt: row.imported_at ? String(row.imported_at) : null,
      createdAt: String(row.created_at)
    };
  }

  private mapFolder(row: Row): Folder {
    return {
      id: String(row.id),
      archiveId: String(row.archive_id),
      parentId: row.parent_id ? String(row.parent_id) : null,
      name: String(row.name),
      path: String(row.path),
      messageCount: Number(row.message_count),
      unreadCount: Number(row.live_unread_count ?? 0)
    };
  }

  private mapImportJob(row: Row): ImportJob {
    return {
      id: String(row.id),
      archiveId: row.archive_id ? String(row.archive_id) : null,
      sourceName: String(row.source_name),
      sourceType: row.source_type as ImportSourceType,
      status: row.status as ImportJobStatus,
      phase: row.phase as ImportPhase,
      processedItems: Number(row.processed_items),
      totalItems: row.total_items === null || row.total_items === undefined
        ? null
        : Number(row.total_items),
      processedBytes: Number(row.processed_bytes),
      totalBytes: Number(row.total_bytes),
      errorCount: Number(row.error_count),
      ocrEnabled: Boolean(row.ocr_enabled),
      canResume: Boolean(row.can_resume),
      message: row.message ? String(row.message) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapUploadSession(row: Row): UploadSession {
    return {
      id: String(row.id),
      filename: String(row.filename),
      sizeBytes: Number(row.expected_size),
      receivedBytes: Number(row.received_size),
      status: row.status as UploadStatus,
      ocrEnabled: Boolean(row.ocr_enabled),
      jobId: row.job_id ? String(row.job_id) : null,
      message: row.message ? String(row.message) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapDiagnostic(row: Row): DiagnosticEvent {
    return {
      id: String(row.id),
      level: row.level as DiagnosticLevel,
      category: row.category as DiagnosticCategory,
      message: String(row.message),
      stack: row.stack ? String(row.stack) : null,
      jobId: row.job_id ? String(row.job_id) : null,
      archiveId: row.archive_id ? String(row.archive_id) : null,
      sourceName: row.source_name ? String(row.source_name) : null,
      context: parseJson<Record<string, unknown>>(row.context_json, {}),
      createdAt: String(row.created_at)
    };
  }

  private mapAiJob(row: Row): AiJob {
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      task: "analyze",
      status: row.status as AiJobStatus,
      model: String(row.model),
      promptVersion: String(row.prompt_version),
      contentHash: String(row.content_hash),
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      error: row.error ? String(row.error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null
    };
  }

  private mapMessageAnalysis(row: Row): MessageAnalysis {
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      summary: String(row.summary),
      categories: parseJson<string[]>(row.categories_json, []),
      priority: row.priority as MessageAnalysis["priority"],
      actionRequired: Boolean(row.action_required),
      actionSummary: row.action_summary ? String(row.action_summary) : null,
      spamProbability: Number(row.spam_probability),
      phishingProbability: Number(row.phishing_probability),
      draftRecommended: Boolean(row.draft_recommended),
      confidence: Number(row.confidence),
      signals: parseJson<string[]>(row.signals_json, []),
      model: String(row.model),
      promptVersion: String(row.prompt_version),
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapGmailConnection(row: Row): GmailConnection {
    return {
      id: String(row.id),
      email: String(row.email),
      archiveId: String(row.archive_id),
      archiveName: String(row.archive_name),
      folderId: String(row.folder_id),
      folderPath: String(row.folder_path),
      query: String(row.query ?? ""),
      ocrEnabled: Boolean(row.ocr_enabled),
      canSend: Boolean(row.can_send),
      status: row.status as GmailConnectionStatus,
      processedItems: Number(row.processed_items),
      totalItems: row.total_items === null || row.total_items === undefined
        ? null
        : Number(row.total_items),
      importedItems: Number(row.imported_items),
      lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
      lastError: row.last_error ? String(row.last_error) : null,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };
  }

  private mapGmailConnectionRecord(row: Row): GmailConnectionRecord {
    return {
      ...this.mapGmailConnection(row),
      refreshToken: String(row.refresh_token),
      accessToken: row.access_token ? String(row.access_token) : null,
      accessTokenExpiresAt: row.access_token_expires_at
        ? String(row.access_token_expires_at)
        : null
    };
  }

  private mapMessageSummary(row: Row): MessageSummary {
    return {
      id: String(row.id),
      archiveId: String(row.archive_id),
      folderId: String(row.folder_id),
      folderPath: String(row.folder_path),
      subject: String(row.subject || "(No subject)"),
      sender: {
        name: row.sender_name ? String(row.sender_name) : null,
        address: String(row.sender_address ?? "")
      },
      recipients: parseJson<EmailAddress[]>(row.to_json, []),
      sentAt: row.sent_at ? String(row.sent_at) : null,
      receivedAt: row.received_at ? String(row.received_at) : null,
      preview: previewText(String(row.body_text ?? "")),
      hasAttachments: Boolean(row.has_attachments),
      attachmentCount: Number(row.attachment_count),
      state: this.mapState(row)
    };
  }

  private mapState(row: Row): LocalMessageState {
    if (row.is_read === undefined && row.is_starred === undefined) {
      return { ...EMPTY_STATE };
    }
    return {
      isRead: Boolean(row.is_read),
      isStarred: Boolean(row.is_starred),
      tags: parseJson<string[]>(row.tags_json, []),
      note: String(row.note ?? ""),
      updatedAt: row.updated_at ? String(row.updated_at) : null
    };
  }

  private mapAttachment(row: Row): Attachment {
    return {
      id: String(row.id),
      messageId: String(row.message_id),
      filename: String(row.filename),
      contentType: String(row.content_type),
      sizeBytes: Number(row.size_bytes),
      contentId: row.content_id ? String(row.content_id) : null,
      disposition: row.disposition === "inline" ? "inline" : "attachment",
      textStatus: row.text_status as Attachment["textStatus"]
    };
  }
}

// Adapter contract: private SQLite implementation details are intentionally excluded.
export type EmailStore = Pick<EmailDatabase, keyof EmailDatabase>;

const MESSAGE_SUMMARY_COLUMNS = `
  m.id,
  m.archive_id,
  m.folder_id,
  f.path AS folder_path,
  m.subject,
  m.sender_name,
  m.sender_address,
  m.to_json,
  m.sent_at,
  m.received_at,
  m.body_text,
  m.has_attachments,
  m.attachment_count,
  COALESCE(s.is_read, 0) AS is_read,
  COALESCE(s.is_starred, 0) AS is_starred,
  COALESCE(s.tags_json, '[]') AS tags_json,
  COALESCE(s.note, '') AS note,
  s.updated_at
`;

const MESSAGE_SUMMARY_JOINS = `
  FROM messages m
  JOIN folders f ON f.id = m.folder_id
  LEFT JOIN message_state s ON s.message_id = m.id
`;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeContext(value: Record<string, unknown> | undefined): string {
  if (!value) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: "Diagnostic context could not be serialized" });
  }
}

function addressToText(address: EmailAddress): string {
  return `${address.name ?? ""} ${address.address}`.trim();
}

function previewText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(limit!)));
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeOffset(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as { offset?: number };
    return Number.isInteger(parsed.offset) && parsed.offset! >= 0 ? parsed.offset! : 0;
  } catch {
    return 0;
  }
}

export function toFtsQuery(value: string): string {
  const parts: string[] = [];
  const matcher = /"([^"]+)"|(\S+)/g;
  for (const match of value.trim().matchAll(matcher)) {
    const raw = (match[1] ?? match[2] ?? "")
      .replace(/["*:^(){}\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!raw) continue;
    parts.push(`"${raw.replaceAll('"', '""')}"`);
  }
  return parts.join(" AND ");
}
