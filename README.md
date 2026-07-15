# Archive Mail

Archive Mail is a local React and Electron email archive reader. PST and MBOX inputs are read-only. Messages, search indexes, local message state, diagnostics, and attachment blobs are stored in managed local storage.

Manual OpenAI-powered message analysis is available as the first implementation phase. Draft generation, automated review queues, spam actions, and deduplication remain planned for later phases. A ChatGPT subscription cannot be used directly as API credit.

## Run it

Requirements: Node.js 22 or newer.

```bash
npm ci
npm run build
npm start
```

Open `http://localhost:3001`. `npm start` serves the compiled files directly from Fastify without Vite hot-module transforms, making it the stable mode for normal use and long-running imports. Data is stored in `~/.archive-mail` unless `EMAIL_CLIENT_DATA_DIR` is set.

After changing source code, use `npm run start:fresh` to rebuild before starting. Ordinary launches should use `npm start` so they do not traverse and transform the source tree.

Use `npm run dev` and `http://localhost:5173` only while editing the application. It enables Vite hot reload and may need to be restarted after the computer sleeps, a synchronized filesystem stalls, or source files change extensively.

Sign in with the first-run account:

- Username: `admin`
- PIN: `2332`

The PIN is a temporary bootstrap credential. Change it under **Admin settings > Security**.

Keep the data directory on a local disk. SQLite databases and their WAL files should not be placed in iCloud Drive, Dropbox, a network share, or another live-synchronized folder.

To run the Electron desktop shell:

```bash
npm run dev:desktop
```

For a production build:

```bash
npm run build
npm run start -w @email-client/desktop
```

## Import flow

### Browser

1. The browser creates a persisted upload session.
2. It copies the selected archive to local managed storage in 4 MB chunks.
3. SQLite records the confirmed byte offset after every chunk.
4. After the full file is present, the service validates its header and creates an import job.
5. The import streams messages, extracts attachments, writes normalized data, and updates SQLite FTS5 indexes.

If a transfer is interrupted, select the same file again. The client resumes from the server-confirmed offset. A fetch or proxy failure before the import job is created is shown as an upload failure, not a parser failure.

The Imports panel shows the current phase, overall percentage, processed and total email counts, and an estimated completion time. MBOX email boundaries are counted during the existing fingerprint scan. PST imports first count actual email items so skipped contacts, calendars, and tasks are not included. ETA appears after enough messages have been processed to measure throughput; an older paused MBOX uses byte progress until it is resumed and recounted.

### Import controls

- **Stop** asks the worker to finish its current item, saves the latest safe checkpoint, and changes the job to a restartable state. It does not delete imported messages or the managed source copy.
- **Restart import** continues a stopped, interrupted, or failed import from its saved MBOX byte offset or PST folder/message checkpoint. Already committed messages are not imported again.
- **Clear import** is available after the job has stopped. For a partial, cancelled, or failed import it permanently removes the partial archive, messages, search rows, upload record, managed temporary source, and unreferenced attachment blobs. For a completed import it only dismisses the import/upload history; the ready archive and its mail remain.

An active job must be stopped before it can be cleared. The clear confirmation states whether the archive data will be removed.

### Electron

Electron passes the selected local path directly to the import service, so it does not make a second browser upload copy. The original must remain available while an interrupted import is resumable. After a successful import, browsing and search use only managed SQLite and blob storage.

## Local changes

- Use the pencil buttons beside an archive or mailbox to rename it.
- Use the plus button beside **Folders** to create a top-level or child mailbox.
- Use the combine button beside an archive to move it into another completed archive. Folder paths with the same name are combined; message IDs, read/star/tag/note state, attachment references, and search entries are retained. The source archive is removed only after the SQLite transaction commits.
- Use the combine button beside a mailbox to move all messages from it and its child mailboxes into another mailbox in the same archive. Gmail destinations follow the messages, search paths are refreshed, and the source mailbox tree is removed only inside the committed SQLite transaction.
- Renames affect local display and search metadata only. PST and MBOX sources are never rewritten.
- Use the trash button to remove an archive or a completed mailbox. Mailbox deletion includes its child mailboxes, messages, search rows, and unreferenced attachment blobs.
- Removing an active archive first stops its import and then removes any managed temporary source copy. Directly selected original files are never deleted.
- Read, star, tags, and notes are stored in SQLite.

## Login, users, and audit

Archive Mail requires a named user and PIN on every service/application launch. PINs are stored with a random salt and scrypt hash. Session tokens are stored only as SHA-256 hashes, bound to the login IP address, and revoked when the service starts, a PIN changes, or an administrator changes that user.

The first-run `admin` account uses PIN `2332`. Login attempts are throttled per IP address. Under **Admin settings** an administrator can:

- create named administrator or standard user accounts;
- enable or disable users, change roles, and reset PINs;
- change their own PIN, which revokes every existing session for that user;
- inspect and export audit history.

The audit table is separate from Diagnostics and is not removed by **Clear logs**. Every API request and privileged Electron operation records the named user when available, effective role, timestamp, action, HTTP result, direct client IP address, route, and user agent. Request bodies, PINs, bearer tokens, Gmail tokens, and email content are not stored in audit details.

LAN viewers must have both a current QR pairing link and a valid Archive Mail username/PIN. Their effective session remains read-only even when the account is an administrator.

## Database adapters and connection settings

The service is constructed through the `EmailStore` adapter contract and `store-factory.ts`. Database bootstrap configuration is stored outside the mail database in `storage-settings.json`, avoiding the circular problem of needing the old database in order to locate the new one. **Admin settings > Database** shows the active and configured connection strings, structured-data path, attachment path, adapter availability, and whether a restart is required.

SQLite is currently the only installed adapter and uses a connection string such as:

```text
sqlite:///Users/<you>/.archive-mail/archive-mail.sqlite
```

PostgreSQL, MySQL, and Microsoft SQL Server cannot honestly be enabled by changing only a URL yet. The current implementation relies on SQLite transactions, JSON functions, and FTS5 ranking/snippets. Each external engine needs an `EmailStore` implementation, migrations, and a search adapter matching that engine. The Settings UI lists these providers as unavailable and refuses to save one until its adapter exists, rather than accepting a configuration that would make the archive unreadable.

Changing the SQLite connection string takes effect after restart and does not migrate data from the old database. Attachment bytes are intentionally not stored in the relational database: they remain in the SHA-256 content-addressed blob directory so large archives do not inflate database backups or transaction logs.

## Gmail authorization, sync, and send

Gmail uses the [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), a desktop OAuth client with PKCE, and a loopback callback. Archive Mail never asks for a Gmail password. Authorization requests only the granular `gmail.readonly` and `gmail.send` scopes. It does not request `gmail.modify` or the broad `mail.google.com` scope.

POP, IMAP, and SMTP are intentionally not used. Google requires the broad `https://mail.google.com/` scope for those protocols, which includes permanent-delete capability. The granular API scopes enforce pull-only synchronization plus sending without permission to delete, move, label, or mark remote Gmail messages.

1. In Google Cloud, enable the Gmail API and configure the OAuth consent screen.
2. Create an OAuth client with application type **Desktop app**.
3. Download the OAuth JSON, then open **Admin settings > Gmail**, choose that file, and save the configuration. The saved credential file is `~/.archive-mail/gmail-oauth-settings.json`, is restricted to the local OS user, and the client secret is never returned by the API.

Managed installations can use environment variables instead. Environment settings take precedence over the admin file and make the Gmail panel read-only:

```bash
GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
GMAIL_CLIENT_SECRET="your-desktop-client-secret" \
npm start
```

For Electron development, pass the same variables to `npm run dev:desktop`.

Open the Gmail button beside **Archives** and choose **New archive**, **New mailbox**, or **Existing mailbox**. Existing mailbox mode merges that account's imported messages into the selected local mailbox without merging account credentials or send identities. Google shows its account chooser for every authorization, so the same Desktop OAuth configuration can connect multiple Gmail accounts. Each account has its own refresh token, progress, sync action, and sending identity; multiple accounts may share one destination mailbox. The initial query defaults to `newer_than:30d` and accepts Gmail search syntax. Later **Sync now** pulls an overlapping date window and deduplicates by Gmail account plus message ID, so a retry does not duplicate mail.

Use **Compose** in the top toolbar or the send button beside a connected Gmail account to send a plain-text email. Gmail creates the remote Sent copy, and Archive Mail immediately imports that server-provided copy into the connection's local destination. Existing connections created before send support was added remain read-only until the same account is authorized again.

Unread counts are local. A newly imported Gmail message initially follows Gmail's `UNREAD` label, but opening or marking it in Archive Mail does not modify its remote Gmail state.

Raw Gmail MIME is processed by the same importer as MBOX. Attachments are written to the SHA-256 blob store, included in archive counts, available for download, and indexed by filename and extracted/OCR text. Per-message and attachment failures appear under **Diagnostics > Gmail sync** and in the event log.

Attachment parsing and OCR run in an isolated worker with a 60-second deadline per attachment. If an extractor crashes or times out on a malformed PDF or image, the original attachment remains stored and downloadable, the item is marked as an extraction failure in Diagnostics, and the mailbox import continues.

The Gmail refresh token is stored in the app's local SQLite database so background pulls can run while Archive Mail is open. **Disconnect Gmail** revokes the token; already imported messages and attachments remain local. Gmail operations are blocked for LAN read-only viewers.

## OpenAI message analysis

AI analysis is optional and disabled by default. It uses the OpenAI API, whose project keys and billing are separate from ChatGPT subscriptions.

1. Create an OpenAI API project, API key, and billing configuration.
2. Open **Admin settings > AI**.
3. Enter the API key, select the model, set daily and monthly request limits, enable AI, and save.
4. Use **Test connection** to verify the saved key and model.
5. Open a message and choose **Analyze**.

The first phase returns a structured local result with a summary, categories, priority, action recommendation, spam and phishing probabilities, draft recommendation, confidence, and supporting signals. Analysis is a suggestion and can be wrong. It never automatically sends, deletes, moves, labels, or rewrites email.

Analysis runs through a persistent SQLite job queue. Jobs survive restarts, transient provider failures retry once, active jobs can be cancelled, and current results are reused when the message, model, and prompt version have not changed. Job states and redacted failures appear in **Diagnostics > AI analysis**. Daily and monthly request limits are enforced before each provider request; request and token usage appears in Admin settings.

For each selected message, Archive Mail sends the subject, sender, recipients, dates, up to 40,000 characters of plain-text body, attachment filenames, and a small allowlist of headers. Attachment bytes and extracted attachment text are not sent in this phase. OpenAI requests use `store: false`. Email bodies, prompts, and API keys are excluded from audit and diagnostic records.

The admin-managed key is stored in `~/.archive-mail/ai-settings.json` with permissions restricted to the current operating-system user and is never returned by the API. A managed installation can instead provide an environment key, which takes precedence:

```bash
OPENAI_API_KEY="sk-proj-..." npm start
```

Environment-managed keys cannot be replaced or removed through the Admin panel. Model, enablement, and request limits remain editable there.

## Diagnostics

Open **Diagnostics** from the activity button in the top toolbar. It shows:

- resumable upload sessions and confirmed byte counts;
- import job status, phase, checkpoint progress, and error counts;
- parser, attachment extraction, API, and browser fetch failures;
- Gmail authorization, sync progress, per-message failures, and attachment extraction failures;
- AI job status, retries, cancellation, provider failures, model, and token counts without email content;
- lifecycle events such as start, resume, completion, cancellation, and removal.

Use **Export JSON** to save the latest diagnostic report. Browser failures are queued in local storage if the API is unavailable and are copied into SQLite after it reconnects. Diagnostic events are retained when an archive is removed.
Use **Clear logs** to permanently remove stored diagnostic events. Import and upload records are not deleted by this action.

## Remove local data

- Delete an archive in the sidebar to stop its active import and remove its messages, mailboxes, search rows, managed upload copy, Gmail connection, and unreferenced attachment blobs.
- Delete individual mailboxes when only part of an archive should be removed.
- Use **Diagnostics > Clear logs** to remove recorded events without deleting mail.
- For a complete reset, stop Archive Mail and remove its data directory. The default is `~/.archive-mail`; a custom run uses the directory named by `EMAIL_CLIENT_DATA_DIR`. This permanently removes every imported message, attachment, upload, job, Gmail token, OpenAI key, AI result, and diagnostic event.

## Verification

```bash
npm run typecheck
npm run test:run
npm run build
```
