using ArchiveMail.Api.Security;
using Npgsql;

namespace ArchiveMail.Api.Infrastructure;

public sealed class DatabaseInitializer(
    NpgsqlDataSource database,
    IConfiguration configuration,
    ILogger<DatabaseInitializer> logger)
{
    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        var schema = PostgresSettings.ResolveSchema(configuration);
        var quotedSchema = $"\"{schema.Replace("\"", "\"\"")}\"";
        await using var connection = await database.OpenConnectionAsync(cancellationToken);
        await using (var bootstrap = new NpgsqlCommand(
            $"CREATE SCHEMA IF NOT EXISTS {quotedSchema}; SET search_path TO {quotedSchema}, public;",
            connection))
        {
            await bootstrap.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var command = new NpgsqlCommand(CoreSchemaSql, connection))
            await command.ExecuteNonQueryAsync(cancellationToken);
        await using (var command = new NpgsqlCommand(ConnectedServicesSchemaSql, connection))
            await command.ExecuteNonQueryAsync(cancellationToken);
        await using (var command = new NpgsqlCommand(PropertySchemaSql, connection))
            await command.ExecuteNonQueryAsync(cancellationToken);

        await EnsureDefaultAdministratorAsync(connection, cancellationToken);
        logger.LogInformation("C# PostgreSQL schema is ready in {Schema}", schema);
    }

    private static async Task EnsureDefaultAdministratorAsync(
        NpgsqlConnection connection,
        CancellationToken cancellationToken)
    {
        await using var count = new NpgsqlCommand("SELECT COUNT(*) FROM users", connection);
        if (Convert.ToInt64(await count.ExecuteScalarAsync(cancellationToken)) > 0) return;

        var (hash, salt) = AuthService.HashSecret("2332");
        var id = Guid.NewGuid().ToString();
        var now = DateTimeOffset.UtcNow.ToString("O");
        const string sql = """
            INSERT INTO users (
              id, username, display_name, role, pin_hash, pin_salt,
              is_active, must_change_pin, created_at, updated_at
            ) VALUES (@id, 'admin', 'Administrator', 'admin', @hash, @salt, 1, 1, @now, @now);
            UPDATE archives SET owner_user_id = @id WHERE owner_user_id IS NULL;
            UPDATE upload_sessions SET owner_user_id = @id WHERE owner_user_id IS NULL;
            UPDATE diagnostic_events SET owner_user_id = @id WHERE owner_user_id IS NULL;
            """;
        await using var insert = new NpgsqlCommand(sql, connection);
        insert.Parameters.AddWithValue("id", id);
        insert.Parameters.AddWithValue("hash", hash);
        insert.Parameters.AddWithValue("salt", salt);
        insert.Parameters.AddWithValue("now", now);
        await insert.ExecuteNonQueryAsync(cancellationToken);
    }

    private const string CoreSchemaSql = """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin', 'user', 'renter')),
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          is_active BIGINT NOT NULL DEFAULT 1,
          must_change_pin BIGINT NOT NULL DEFAULT 0,
          last_login_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          allowed_screens TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_username_nocase_unique ON users (lower(username));

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          effective_role TEXT NOT NULL CHECK(effective_role IN ('admin', 'user', 'renter')),
          token_hash TEXT NOT NULL UNIQUE,
          ip_address TEXT NOT NULL,
          user_agent TEXT,
          expires_at TEXT NOT NULL,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
        CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id, created_at DESC);
        DELETE FROM auth_sessions WHERE effective_role='viewer';
        ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_effective_role_check;
        ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_effective_role_check
          CHECK(effective_role IN ('admin', 'user', 'renter'));

        CREATE TABLE IF NOT EXISTS archives (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('pst', 'mbox', 'gmail')),
          fingerprint TEXT NOT NULL,
          size_bytes BIGINT NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'importing',
          message_count BIGINT NOT NULL DEFAULT 0,
          folder_count BIGINT NOT NULL DEFAULT 0,
          attachment_count BIGINT NOT NULL DEFAULT 0,
          error_count BIGINT NOT NULL DEFAULT 0,
          replace_archive_id TEXT REFERENCES archives(id) ON DELETE SET NULL,
          imported_at TEXT,
          created_at TEXT NOT NULL,
          unread_count BIGINT NOT NULL DEFAULT 0,
          starred_count BIGINT NOT NULL DEFAULT 0,
          starred_unread_count BIGINT NOT NULL DEFAULT 0,
          owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS archives_fingerprint_idx ON archives(fingerprint);
        CREATE INDEX IF NOT EXISTS archives_owner_idx ON archives(owner_user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          message_count BIGINT NOT NULL DEFAULT 0,
          unread_count BIGINT NOT NULL DEFAULT 0,
          UNIQUE(archive_id, path)
        );
        CREATE INDEX IF NOT EXISTS folders_archive_idx ON folders(archive_id, parent_id);

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          source_key TEXT NOT NULL,
          internet_message_id TEXT,
          conversation_key TEXT,
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
          has_attachments BIGINT NOT NULL DEFAULT 0,
          attachment_count BIGINT NOT NULL DEFAULT 0,
          size_bytes BIGINT NOT NULL DEFAULT 0,
          inbox_category TEXT NOT NULL DEFAULT 'primary' CHECK(inbox_category IN (
            'primary', 'promotions', 'social', 'updates', 'bills', 'medical', 'mail_tracking'
          )),
          created_at TEXT NOT NULL,
          UNIQUE(archive_id, source_key)
        );
        CREATE INDEX IF NOT EXISTS messages_archive_date_idx ON messages(archive_id, received_at DESC, sent_at DESC);
        CREATE INDEX IF NOT EXISTS messages_folder_date_idx ON messages(folder_id, received_at DESC, sent_at DESC);
        CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages(sender_address);
        CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(archive_id, conversation_key);
        CREATE INDEX IF NOT EXISTS messages_postgres_search_idx ON messages USING GIN (to_tsvector('simple',
          COALESCE(subject, '') || ' ' || COALESCE(sender_name, '') || ' ' || COALESCE(sender_address, '') || ' ' ||
          COALESCE(recipients_text, '') || ' ' || COALESCE(body_text, '')
        ));

        CREATE TABLE IF NOT EXISTS message_state (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          is_read BIGINT NOT NULL DEFAULT 0,
          is_starred BIGINT NOT NULL DEFAULT 0,
          tags_json TEXT NOT NULL DEFAULT '[]',
          note TEXT NOT NULL DEFAULT '',
          updated_at TEXT
        );
        CREATE INDEX IF NOT EXISTS message_state_read_idx ON message_state(is_read, message_id);

        CREATE TABLE IF NOT EXISTS blobs (
          sha256 TEXT PRIMARY KEY,
          relative_path TEXT NOT NULL UNIQUE,
          size_bytes BIGINT NOT NULL,
          ref_count BIGINT NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          content_id TEXT,
          disposition TEXT NOT NULL,
          text_status TEXT NOT NULL,
          extracted_text TEXT NOT NULL DEFAULT '',
          blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256)
        );
        CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);
        CREATE INDEX IF NOT EXISTS attachments_postgres_search_idx ON attachments USING GIN (
          to_tsvector('simple', COALESCE(filename, '') || ' ' || COALESCE(extracted_text, ''))
        );

        CREATE TABLE IF NOT EXISTS import_jobs (
          id TEXT PRIMARY KEY,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          source_path TEXT NOT NULL,
          source_name TEXT NOT NULL,
          source_type TEXT NOT NULL,
          status TEXT NOT NULL,
          phase TEXT NOT NULL,
          processed_items BIGINT NOT NULL DEFAULT 0,
          total_items BIGINT,
          error_count BIGINT NOT NULL DEFAULT 0,
          ocr_enabled BIGINT NOT NULL DEFAULT 0,
          can_resume BIGINT NOT NULL DEFAULT 0,
          temporary_source BIGINT NOT NULL DEFAULT 0,
          checkpoint_json TEXT NOT NULL DEFAULT '{}',
          message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          processed_bytes BIGINT NOT NULL DEFAULT 0,
          total_bytes BIGINT NOT NULL DEFAULT 0,
          worker_id TEXT,
          lease_until TEXT,
          attempt BIGINT NOT NULL DEFAULT 0,
          checkpoint_version BIGINT NOT NULL DEFAULT 1,
          staging_path TEXT,
          parser_name TEXT
        );
        -- These columns belong to the C# resumable-import format and do not exist in
        -- SQLite databases created by the retired Node API.
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS worker_id TEXT;
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS lease_until TEXT;
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS attempt BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS checkpoint_version BIGINT NOT NULL DEFAULT 1;
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS staging_path TEXT;
        ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS parser_name TEXT;
        UPDATE import_jobs
        SET status = 'failed', can_resume = 0, worker_id = NULL, lease_until = NULL,
            message = 'Legacy Node import stopped during PostgreSQL cutover. Clear it and restart with the C# importer.'
        WHERE status IN ('queued', 'running', 'cancelled')
          AND processed_items > 0
          AND checkpoint_version <> 2;
        CREATE INDEX IF NOT EXISTS import_jobs_updated_idx ON import_jobs(updated_at DESC);
        CREATE INDEX IF NOT EXISTS import_jobs_claim_idx ON import_jobs(status, updated_at) WHERE status IN ('queued', 'running');

        CREATE TABLE IF NOT EXISTS import_errors (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
          source_key TEXT,
          stage TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS import_errors_job_idx ON import_errors(job_id);

        CREATE TABLE IF NOT EXISTS upload_sessions (
          id TEXT PRIMARY KEY,
          client_key TEXT NOT NULL,
          filename TEXT NOT NULL,
          expected_size BIGINT NOT NULL,
          received_size BIGINT NOT NULL DEFAULT 0,
          temp_path TEXT NOT NULL,
          status TEXT NOT NULL,
          ocr_enabled BIGINT NOT NULL DEFAULT 0,
          job_id TEXT REFERENCES import_jobs(id) ON DELETE SET NULL,
          message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS upload_sessions_updated_idx ON upload_sessions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS upload_sessions_owner_idx ON upload_sessions(owner_user_id, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_active_client_idx ON upload_sessions(client_key)
          WHERE status IN ('uploading', 'ready', 'failed');

        CREATE TABLE IF NOT EXISTS deferred_attachment_jobs (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          staging_path TEXT NOT NULL,
          source_file TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts BIGINT NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(message_id)
        );
        CREATE INDEX IF NOT EXISTS deferred_attachment_jobs_claim_idx ON deferred_attachment_jobs(status, updated_at)
          WHERE status = 'queued';

        CREATE TABLE IF NOT EXISTS diagnostic_events (
          id TEXT PRIMARY KEY,
          level TEXT NOT NULL,
          category TEXT NOT NULL,
          message TEXT NOT NULL,
          stack TEXT,
          job_id TEXT,
          archive_id TEXT,
          source_name TEXT,
          context_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS diagnostic_events_created_idx ON diagnostic_events(created_at DESC);

        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          username TEXT,
          display_name TEXT,
          role TEXT,
          action TEXT NOT NULL,
          method TEXT,
          path TEXT,
          status_code BIGINT NOT NULL,
          success BIGINT NOT NULL,
          ip_address TEXT NOT NULL,
          user_agent TEXT,
          details_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS inbox_tab_settings (
          archive_id TEXT PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
          tabs_json TEXT NOT NULL,
          ai_enabled BIGINT NOT NULL DEFAULT 0,
          ai_confidence_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK(ai_confidence_threshold >= 0 AND ai_confidence_threshold <= 1),
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message_follow_ups (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          conversation_key TEXT NOT NULL,
          due_at TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'completed', 'dismissed')),
          completed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS message_follow_ups_due_idx ON message_follow_ups(status, due_at);
        CREATE UNIQUE INDEX IF NOT EXISTS message_follow_ups_pending_conversation_idx ON message_follow_ups(conversation_key)
          WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          todo_date TEXT NOT NULL,
          text TEXT NOT NULL,
          completed BIGINT NOT NULL DEFAULT 0,
          position BIGINT NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS todos_owner_date_idx ON todos(owner_user_id,todo_date,position);

        CREATE TABLE IF NOT EXISTS sender_filing_rules (
          id TEXT PRIMARY KEY,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          sender_address TEXT NOT NULL,
          sender_name TEXT,
          match_field TEXT NOT NULL DEFAULT 'from' CHECK(match_field IN ('from', 'to')),
          source_scope TEXT NOT NULL DEFAULT 'inbox' CHECK(source_scope IN ('inbox', 'folder', 'all')),
          source_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          rule_type TEXT NOT NULL DEFAULT 'folder' CHECK(rule_type IN ('folder', 'spam')),
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        -- The one-time SQLite cutover preserves the legacy sender-rule table. Upgrade it
        -- before creating indexes that reference the folder-scoped rule columns. Legacy
        -- rules applied to every folder, so retain that behavior for existing rows while
        -- keeping Inbox as the default for newly created rows.
        ALTER TABLE sender_filing_rules
          ADD COLUMN IF NOT EXISTS match_field TEXT NOT NULL DEFAULT 'from'
          CHECK(match_field IN ('from', 'to'));
        ALTER TABLE sender_filing_rules
          ADD COLUMN IF NOT EXISTS source_scope TEXT NOT NULL DEFAULT 'all'
          CHECK(source_scope IN ('inbox', 'folder', 'all'));
        ALTER TABLE sender_filing_rules
          ADD COLUMN IF NOT EXISTS source_folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE;
        ALTER TABLE sender_filing_rules ALTER COLUMN source_scope SET DEFAULT 'inbox';
        DROP INDEX IF EXISTS sender_filing_rules_archive_id_sender_address_unique;
        CREATE INDEX IF NOT EXISTS sender_filing_rules_archive_idx ON sender_filing_rules(archive_id, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS sender_filing_rules_match_idx ON sender_filing_rules(
          archive_id, match_field, sender_address, source_scope, COALESCE(source_folder_id, '')
        );
        CREATE TABLE IF NOT EXISTS sender_filing_runs (
          archive_id TEXT PRIMARY KEY REFERENCES archives(id) ON DELETE CASCADE,
          moved_messages BIGINT NOT NULL DEFAULT 0,
          created_folders BIGINT NOT NULL DEFAULT 0,
          ran_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation_replies (
          conversation_key TEXT PRIMARY KEY,
          source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          sent_external_id TEXT,
          replied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS message_calendar_events (
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          connection_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          title TEXT NOT NULL,
          start_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(connection_id, event_id)
        );

        CREATE OR REPLACE FUNCTION archive_mail_message_insert_batch() RETURNS trigger AS $$
        BEGIN
          UPDATE archives archive SET
            message_count = archive.message_count + aggregate.message_count,
            attachment_count = archive.attachment_count + aggregate.attachment_count
          FROM (SELECT archive_id, COUNT(*) AS message_count, COALESCE(SUM(attachment_count), 0) AS attachment_count
                FROM inserted_messages GROUP BY archive_id) aggregate
          WHERE archive.id = aggregate.archive_id;
          UPDATE folders folder SET message_count = folder.message_count + aggregate.message_count
          FROM (SELECT folder_id, COUNT(*) AS message_count FROM inserted_messages GROUP BY folder_id) aggregate
          WHERE folder.id = aggregate.folder_id;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql;

        CREATE OR REPLACE FUNCTION archive_mail_state_insert_batch() RETURNS trigger AS $$
        BEGIN
          UPDATE archives archive SET
            unread_count = archive.unread_count + aggregate.unread_count,
            starred_count = archive.starred_count + aggregate.starred_count,
            starred_unread_count = archive.starred_unread_count + aggregate.starred_unread_count
          FROM (
            SELECT message.archive_id,
              SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
              SUM(CASE WHEN state.is_starred = 1 THEN 1 ELSE 0 END) AS starred_count,
              SUM(CASE WHEN state.is_starred = 1 AND state.is_read = 0 THEN 1 ELSE 0 END) AS starred_unread_count
            FROM inserted_states state JOIN messages message ON message.id = state.message_id GROUP BY message.archive_id
          ) aggregate WHERE archive.id = aggregate.archive_id;
          UPDATE folders folder SET unread_count = folder.unread_count + aggregate.unread_count
          FROM (
            SELECT message.folder_id, SUM(CASE WHEN state.is_read = 0 THEN 1 ELSE 0 END) AS unread_count
            FROM inserted_states state JOIN messages message ON message.id = state.message_id GROUP BY message.folder_id
          ) aggregate WHERE folder.id = aggregate.folder_id;
          RETURN NULL;
        END; $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS archive_message_insert_count ON messages;
        CREATE TRIGGER archive_message_insert_count AFTER INSERT ON messages
          REFERENCING NEW TABLE AS inserted_messages FOR EACH STATEMENT
          EXECUTE FUNCTION archive_mail_message_insert_batch();
        DROP TRIGGER IF EXISTS message_state_insert_count ON message_state;
        CREATE TRIGGER message_state_insert_count AFTER INSERT ON message_state
          REFERENCING NEW TABLE AS inserted_states FOR EACH STATEMENT
          EXECUTE FUNCTION archive_mail_state_insert_batch();
        """;

    private const string ConnectedServicesSchemaSql = """
        CREATE TABLE IF NOT EXISTS gmail_connections (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          query TEXT NOT NULL DEFAULT '',
          ocr_enabled BIGINT NOT NULL DEFAULT 0,
          refresh_token TEXT NOT NULL,
          access_token TEXT,
          access_token_expires_at TEXT,
          status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'syncing', 'error')),
          processed_items BIGINT NOT NULL DEFAULT 0,
          total_items BIGINT,
          imported_items BIGINT NOT NULL DEFAULT 0,
          last_synced_at TEXT,
          last_error TEXT,
          can_send BIGINT NOT NULL DEFAULT 0,
          can_manage_calendar BIGINT NOT NULL DEFAULT 0,
          can_modify_mailbox BIGINT NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS gmail_connections_archive_idx ON gmail_connections(archive_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS gmail_connections_folder_idx ON gmail_connections(folder_id);
        ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS can_send BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS can_manage_calendar BIGINT NOT NULL DEFAULT 0;
        ALTER TABLE gmail_connections ADD COLUMN IF NOT EXISTS can_modify_mailbox BIGINT NOT NULL DEFAULT 0;

        CREATE TABLE IF NOT EXISTS resume_assets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          sha256 TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS resume_assets_created_idx ON resume_assets(created_at DESC);

        CREATE TABLE IF NOT EXISTS ai_schedules (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          mode TEXT NOT NULL CHECK(mode IN ('all', 'unread')),
          interval_minutes BIGINT NOT NULL,
          enabled BIGINT NOT NULL DEFAULT 1,
          last_run_at TEXT,
          last_run_summary TEXT,
          provider TEXT NOT NULL DEFAULT 'openai',
          model TEXT NOT NULL DEFAULT 'gpt-5-mini',
          skills_json TEXT NOT NULL DEFAULT '[]',
          prompt TEXT NOT NULL DEFAULT '',
          task TEXT NOT NULL DEFAULT 'analyze' CHECK(task IN ('analyze', 'draft_reply')),
          message_id TEXT,
          gmail_connection_id TEXT,
          resume_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_schedules_folder_idx ON ai_schedules(folder_id);

        CREATE TABLE IF NOT EXISTS ai_jobs (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          task TEXT NOT NULL DEFAULT 'analyze' CHECK(task IN ('analyze', 'draft_reply')),
          schedule_id TEXT,
          gmail_connection_id TEXT,
          resume_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
          provider TEXT NOT NULL DEFAULT 'openai',
          model TEXT NOT NULL,
          skills_json TEXT NOT NULL DEFAULT '[]',
          prompt TEXT NOT NULL DEFAULT '',
          prompt_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          attempts BIGINT NOT NULL DEFAULT 0,
          max_attempts BIGINT NOT NULL DEFAULT 2,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS ai_jobs_message_idx ON ai_jobs(message_id, task, created_at DESC);
        CREATE INDEX IF NOT EXISTS ai_jobs_status_idx ON ai_jobs(status, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS ai_jobs_active_message_idx ON ai_jobs(message_id, task)
          WHERE status IN ('queued', 'running');

        CREATE TABLE IF NOT EXISTS ai_message_analysis (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
          summary TEXT NOT NULL,
          categories_json TEXT NOT NULL DEFAULT '[]',
          priority TEXT NOT NULL CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
          action_required BIGINT NOT NULL DEFAULT 0,
          action_summary TEXT,
          spam_probability DOUBLE PRECISION NOT NULL DEFAULT 0,
          phishing_probability DOUBLE PRECISION NOT NULL DEFAULT 0,
          draft_recommended BIGINT NOT NULL DEFAULT 0,
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
          signals_json TEXT NOT NULL DEFAULT '[]',
          model TEXT NOT NULL,
          prompt_version TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          context_hash TEXT NOT NULL DEFAULT '',
          related_context_json TEXT NOT NULL DEFAULT '[]',
          thread_message_count BIGINT NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS ai_message_analysis_updated_idx ON ai_message_analysis(updated_at DESC);

        CREATE TABLE IF NOT EXISTS ai_usage_daily (
          usage_date TEXT PRIMARY KEY,
          request_count BIGINT NOT NULL DEFAULT 0,
          input_tokens BIGINT NOT NULL DEFAULT 0,
          output_tokens BIGINT NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS email_drafts (
          id TEXT PRIMARY KEY,
          connection_id TEXT NOT NULL REFERENCES gmail_connections(id) ON DELETE CASCADE,
          source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          schedule_id TEXT REFERENCES ai_schedules(id) ON DELETE SET NULL,
          source TEXT NOT NULL CHECK(source IN ('manual', 'ai')),
          from_address TEXT,
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          body_text TEXT NOT NULL DEFAULT '',
          resume_id TEXT REFERENCES resume_assets(id) ON DELETE SET NULL,
          work_related BIGINT,
          development_opportunity BIGINT,
          ai_reason TEXT,
          ai_confidence DOUBLE PRECISION,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS email_drafts_updated_idx ON email_drafts(updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS email_drafts_schedule_message_idx ON email_drafts(schedule_id, source_message_id)
          WHERE schedule_id IS NOT NULL AND source_message_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS reply_styles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          tone TEXT NOT NULL,
          instructions TEXT NOT NULL,
          is_default BIGINT NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS reply_styles_name_idx ON reply_styles(lower(name));
        CREATE UNIQUE INDEX IF NOT EXISTS reply_styles_default_idx ON reply_styles(is_default) WHERE is_default = 1;

        CREATE TABLE IF NOT EXISTS smart_mail_rules (
          id TEXT PRIMARY KEY,
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          instruction TEXT NOT NULL,
          match_mode TEXT NOT NULL CHECK(match_mode IN ('all', 'any')),
          sender_contains_json TEXT NOT NULL DEFAULT '[]',
          subject_contains_json TEXT NOT NULL DEFAULT '[]',
          body_contains_json TEXT NOT NULL DEFAULT '[]',
          has_attachments BIGINT,
          target_folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
          mark_read BIGINT NOT NULL DEFAULT 0,
          star BIGINT NOT NULL DEFAULT 0,
          enabled BIGINT NOT NULL DEFAULT 1,
          matched_messages BIGINT NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS smart_mail_rules_archive_idx ON smart_mail_rules(archive_id, enabled, created_at);

        CREATE TABLE IF NOT EXISTS mailbox_tasks (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL DEFAULT 'smart_rule_run',
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
          archive_id TEXT NOT NULL REFERENCES archives(id) ON DELETE CASCADE,
          scope TEXT NOT NULL CHECK(scope IN ('inbox','all')),
          rule_ids_json TEXT NOT NULL DEFAULT '[]',
          total_rules BIGINT NOT NULL DEFAULT 0,
          completed_rules BIGINT NOT NULL DEFAULT 0,
          current_rule_id TEXT,
          current_rule_name TEXT,
          total_messages BIGINT NOT NULL DEFAULT 0,
          processed_messages BIGINT NOT NULL DEFAULT 0,
          matched_messages BIGINT NOT NULL DEFAULT 0,
          moved_messages BIGINT NOT NULL DEFAULT 0,
          marked_read_messages BIGINT NOT NULL DEFAULT 0,
          starred_messages BIGINT NOT NULL DEFAULT 0,
          cancel_requested BIGINT NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS mailbox_tasks_status_idx ON mailbox_tasks(status,created_at);

        CREATE TABLE IF NOT EXISTS ai_analysis_reviews (
          message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
          reviewed_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calendar_accounts (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK(provider IN ('apple')),
          label TEXT NOT NULL,
          username TEXT NOT NULL,
          server_url TEXT NOT NULL,
          secret TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('connected', 'error')),
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS calendar_accounts_provider_idx ON calendar_accounts(provider, updated_at DESC);

        INSERT INTO reply_styles(id, name, tone, instructions, is_default, created_at, updated_at)
        SELECT gen_random_uuid()::text, 'Professional', 'Professional and friendly',
          'Write concise, courteous replies. Use plain language, preserve factual accuracy, and end with a clear next step when appropriate.',
          1, CURRENT_TIMESTAMP::text, CURRENT_TIMESTAMP::text
        WHERE NOT EXISTS (SELECT 1 FROM reply_styles);
        """;

    private const string PropertySchemaSql = """
        CREATE TABLE IF NOT EXISTS managed_properties(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,name TEXT NOT NULL,address_line1 TEXT NOT NULL,address_line2 TEXT NOT NULL DEFAULT '',city TEXT NOT NULL,state TEXT NOT NULL,postal_code TEXT NOT NULL,property_type TEXT NOT NULL,status TEXT NOT NULL,image_filename TEXT,bedrooms DOUBLE PRECISION,bathrooms DOUBLE PRECISION,monthly_rent_cents BIGINT,notes TEXT NOT NULL DEFAULT '',organization_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS managed_properties_owner_idx ON managed_properties(owner_user_id,updated_at DESC);
        CREATE TABLE IF NOT EXISTS property_tenants(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS property_tenants_owner_idx ON property_tenants(owner_user_id,status,last_name,first_name);
        CREATE INDEX IF NOT EXISTS property_tenants_linked_user_idx ON property_tenants(linked_user_id,status);
        CREATE TABLE IF NOT EXISTS property_leases(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,unit_id TEXT,tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE RESTRICT,start_date TEXT NOT NULL,end_date TEXT NOT NULL,monthly_rent_cents BIGINT NOT NULL,security_deposit_cents BIGINT NOT NULL DEFAULT 0,due_day BIGINT NOT NULL DEFAULT 1,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_service_requests(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,title TEXT NOT NULL,description TEXT NOT NULL,category TEXT NOT NULL,priority TEXT NOT NULL,status TEXT NOT NULL,preferred_entry_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_rent_charges(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,description TEXT NOT NULL,amount_cents BIGINT NOT NULL,due_date TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_payments(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,provider TEXT NOT NULL,method TEXT NOT NULL,amount_cents BIGINT NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL,external_id TEXT,provider_transaction_id TEXT,checkout_url TEXT,reference TEXT,paid_at TEXT,failure_reason TEXT,notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_payment_events(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL REFERENCES property_payments(id) ON DELETE CASCADE,event_type TEXT NOT NULL,status TEXT NOT NULL,external_id TEXT,details_json TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_organizations(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,name TEXT NOT NULL,timezone TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_organization_members(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(organization_id,user_id));
        CREATE TABLE IF NOT EXISTS property_units(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,name TEXT NOT NULL,bedrooms DOUBLE PRECISION,bathrooms DOUBLE PRECISION,monthly_rent_cents BIGINT,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_tenant_invitations(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE CASCADE,email TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,accepted_at TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_documents(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,title TEXT NOT NULL,category TEXT NOT NULL,visibility TEXT NOT NULL,requires_acknowledgement BIGINT NOT NULL DEFAULT 0,created_by_user_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_document_versions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,version BIGINT NOT NULL,filename TEXT NOT NULL,content_type TEXT NOT NULL,size_bytes BIGINT NOT NULL,sha256 TEXT NOT NULL,storage_key TEXT NOT NULL,created_by_user_id TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,version));
        CREATE TABLE IF NOT EXISTS property_document_acknowledgements(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,user_id TEXT NOT NULL,acknowledged_at TEXT NOT NULL,UNIQUE(document_id,user_id));
        CREATE TABLE IF NOT EXISTS property_document_access_events(id TEXT PRIMARY KEY,document_id TEXT NOT NULL REFERENCES property_documents(id) ON DELETE CASCADE,version_id TEXT REFERENCES property_document_versions(id) ON DELETE SET NULL,user_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_request_comments(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,author_user_id TEXT NOT NULL,author_name TEXT NOT NULL,body TEXT NOT NULL,tenant_visible BIGINT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_request_attachments(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,uploaded_by_user_id TEXT NOT NULL,filename TEXT NOT NULL,content_type TEXT NOT NULL,size_bytes BIGINT NOT NULL,sha256 TEXT NOT NULL,storage_key TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_request_status_history(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES property_service_requests(id) ON DELETE CASCADE,from_status TEXT,to_status TEXT NOT NULL,actor_user_id TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_request_assignments(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE REFERENCES property_service_requests(id) ON DELETE CASCADE,assignee_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,target_date TEXT,assigned_by_user_id TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_rent_schedules(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,lease_id TEXT NOT NULL REFERENCES property_leases(id) ON DELETE CASCADE,amount_cents BIGINT NOT NULL,due_day BIGINT NOT NULL,description_template TEXT NOT NULL,next_charge_date TEXT NOT NULL,reminder_days_json TEXT NOT NULL,enabled BIGINT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_rent_schedule_runs(id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES property_rent_schedules(id) ON DELETE CASCADE,charge_date TEXT NOT NULL,charge_id TEXT,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL,completed_at TEXT,UNIQUE(schedule_id,charge_date));
        CREATE TABLE IF NOT EXISTS property_payment_allocations(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL REFERENCES property_payments(id) ON DELETE CASCADE,charge_id TEXT NOT NULL REFERENCES property_rent_charges(id) ON DELETE CASCADE,amount_cents BIGINT NOT NULL,created_at TEXT NOT NULL,UNIQUE(payment_id,charge_id));
        CREATE TABLE IF NOT EXISTS property_ledger_entries(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,property_id TEXT NOT NULL REFERENCES managed_properties(id) ON DELETE CASCADE,lease_id TEXT REFERENCES property_leases(id) ON DELETE SET NULL,charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,payment_id TEXT REFERENCES property_payments(id) ON DELETE SET NULL,entry_type TEXT NOT NULL,amount_cents BIGINT NOT NULL,description TEXT NOT NULL,effective_at TEXT NOT NULL,unique_key TEXT UNIQUE,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_receipts(id TEXT PRIMARY KEY,payment_id TEXT NOT NULL UNIQUE REFERENCES property_payments(id) ON DELETE CASCADE,receipt_number TEXT NOT NULL UNIQUE,amount_cents BIGINT NOT NULL,currency TEXT NOT NULL,paid_at TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_notification_jobs(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES property_organizations(id) ON DELETE CASCADE,tenant_id TEXT REFERENCES property_tenants(id) ON DELETE SET NULL,charge_id TEXT REFERENCES property_rent_charges(id) ON DELETE SET NULL,channel TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,scheduled_at TEXT NOT NULL,status TEXT NOT NULL,attempts BIGINT NOT NULL,max_attempts BIGINT NOT NULL,next_attempt_at TEXT NOT NULL,last_error TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,completed_at TEXT);
        CREATE TABLE IF NOT EXISTS property_delivery_attempts(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES property_notification_jobs(id) ON DELETE CASCADE,provider TEXT NOT NULL,provider_id TEXT,status TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS property_communication_consents(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL REFERENCES property_tenants(id) ON DELETE CASCADE,channel TEXT NOT NULL,destination TEXT NOT NULL,status TEXT NOT NULL,source TEXT NOT NULL,consented_at TEXT,revoked_at TEXT,updated_at TEXT NOT NULL,UNIQUE(tenant_id,channel,destination));
        CREATE TABLE IF NOT EXISTS property_provider_events(id TEXT PRIMARY KEY,provider TEXT NOT NULL,event_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL,attempts BIGINT NOT NULL,last_error TEXT,created_at TEXT NOT NULL,processed_at TEXT,UNIQUE(provider,event_id));
        ALTER TABLE managed_properties ADD COLUMN IF NOT EXISTS organization_id TEXT;
        ALTER TABLE property_leases ADD COLUMN IF NOT EXISTS unit_id TEXT;
        ALTER TABLE property_payments ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT;
        """;
}
