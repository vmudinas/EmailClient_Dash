# Archive Mail

Archive Mail is a local React and Electron email archive reader. PST and MBOX inputs are read-only. Messages, search indexes, local message state, diagnostics, and attachment blobs are stored in managed local storage.

AI-powered message analysis (OpenAI or DeepSeek) is available manually and through configurable scheduled agents. The client also stores manual drafts and can schedule work-related reply drafts, with an optional resume attachment for development opportunities. Every generated draft remains local until a user reviews and sends it. A ChatGPT or DeepSeek chat subscription cannot be used directly as API credit.

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
- Use the plus button beside **Folders** to create a mailbox. When a mailbox is selected, it is preselected as the parent so a child mailbox takes one step; choose the archive top level in the dialog when needed.
- Use the combine button beside an archive to move it into another completed archive. Folder paths with the same name are combined; message IDs, read/star/tag/note state, attachment references, and search entries are retained. The source archive is removed only after the SQLite transaction commits.
- Use the combine button beside a mailbox to move all messages from it and its child mailboxes into another mailbox in the same archive. Gmail destinations follow the messages, search paths are refreshed, and the source mailbox tree is removed only inside the committed SQLite transaction.
- Open an email and click **Archive** to move it into a sibling **Archived** mailbox. If that mailbox does not exist, Archive Mail creates it automatically. The adjacent folder button can move the email to any other local mailbox.
- On desktop, drag an email row from the message list onto any visible mailbox in the sidebar. If the dragged row is checked, every selected message moves together after one confirmation; dragging an unchecked row moves only that email. The destination highlights before drop, and read-only viewer sessions cannot drag messages.
- Drag one mailbox onto another to choose between merging the source tree into the destination or moving the intact source tree underneath it as a child mailbox.
- Open **Search filters** to search the current view, the entire archive, or one specific mailbox. The active mailbox scope appears in the search placeholder and results title.
- Use the eye button beside **Search filters** to hide read messages across every mailbox and search result. The preference remains selected after restarting the app.
- Renames affect local display and search metadata only. PST and MBOX sources are never rewritten.
- Use the trash button to remove an archive or a completed mailbox. Mailbox deletion includes its child mailboxes, messages, search rows, and unreferenced attachment blobs.
- Removing an active archive first stops its import and then removes any managed temporary source copy. Directly selected original files are never deleted.
- Read, star, tags, and notes are stored in SQLite.

Archive and folder moves reorganize the local Archive Mail copy only by default. Admins can opt in to **Mirror mailbox actions to Gmail** so archive, move, Spam, Trash, read/unread, and star actions run in Gmail first and update the local copy only after Gmail succeeds.

## Mobile layout

At widths up to 800px, Archive Mail uses separate folder, message, and reader screens with a five-item bottom navigation for folders, mail, compose, calendar, and additional actions. Swipe a writable message right to reveal Archive and Read/Unread, swipe left to reveal the sender-level Spam action, or press and hold a row to enter bulk selection. Inbox category tabs scroll horizontally.

Compose, review, import, and admin dialogs use the full viewport on phones. Calendar switches to an agenda view; calendar selection, the highlighted monthly date picker, and the local to-do list open as touch-friendly sheets. Admin settings use section-level navigation instead of the desktop side menu. On narrow phones the news ticker is hidden so the message area retains usable height; the stock ticker remains visible.

The desktop QR/LAN sharing flow is still intentionally read-only. Making archive, compose, calendar, or admin mutations from a separate phone requires a future authenticated HTTPS deployment rather than weakening the paired viewer role.

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

Gmail uses the [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), a desktop OAuth client with PKCE, and a loopback callback. Archive Mail never asks for a Gmail password. By default, authorization requests granular `gmail.readonly` and `gmail.send` scopes, plus `gmail.settings.basic` and calendar scopes. Enabling **Mirror mailbox actions to Gmail** replaces `gmail.readonly` with `gmail.modify`; it never requests the broad `mail.google.com` scope or permanent-delete permission.

POP, IMAP, and SMTP are intentionally not used. Google requires the broad `https://mail.google.com/` scope for those protocols, which includes permanent-delete capability. The granular API scopes keep mailbox mutation off by default and, when explicitly enabled, allow label-based moves and state changes without granting permanent deletion.

1. In Google Cloud, enable the Gmail API and configure the OAuth consent screen.
2. Create an OAuth client with application type **Desktop app**.
3. Download the OAuth JSON, then open **Admin settings > Gmail**, choose that file, and save the configuration. The saved credential file is `~/.archive-mail/gmail-oauth-settings.json`, is restricted to the local OS user, and the client secret is never returned by the API.

Managed installations can use environment variables instead. Environment settings take precedence over the admin file and make the Gmail panel read-only:

```bash
GMAIL_CLIENT_ID="your-client-id.apps.googleusercontent.com" \
GMAIL_CLIENT_SECRET="your-desktop-client-secret" \
GMAIL_SYNC_INTERVAL_MINUTES="5" \
GMAIL_SYNC_MAILBOX_ACTIONS="true" \
npm start
```

`GMAIL_SYNC_INTERVAL_MINUTES` and `GMAIL_SYNC_MAILBOX_ACTIONS` are optional and independent of the OAuth client variables. When set, each overrides its Admin setting and makes that control read-only.

For Electron development, pass the same variables to `npm run dev:desktop`.

Open the Gmail button beside **Archives** and choose **New archive**, **New mailbox**, or **Existing mailbox**. Existing mailbox mode merges that account's imported messages into the selected local mailbox without merging account credentials or send identities. Google shows its account chooser for every authorization, so the same Desktop OAuth configuration can connect multiple Gmail accounts. Each account has its own refresh token, progress, sync action, and sending identity; multiple accounts may share one destination mailbox. The initial query defaults to `newer_than:30d` and accepts Gmail search syntax.

Each connected account is synced automatically on an interval (5 minutes by default; configurable under **Admin settings > Gmail > Auto-sync every**, or set to Off for manual sync only), in addition to the **Sync now** button on each connection. Automatic sync runs in the API process itself, so it keeps pulling mail even while no browser tab is open. A sync pulls an overlapping date window and deduplicates by Gmail account plus message ID, so a retry or an overlapping automatic sync never duplicates mail.

To backfill an account beyond its original recent-mail query, open **Admin settings > Gmail > Connected account pulls** and choose **Pull all email**. This walks every Gmail API result page, includes Spam and Trash, removes the original date restriction for future syncs, and shows checked-message count, newly imported count, percentage, completion time, errors, and a Stop action. When mailbox action sync is enabled, every pull reconciles messages in that pull, and normal sync also performs an hourly lightweight Inbox repair for older messages filed by rules or moved while Gmail permissions were unavailable. Moving mail out of Inbox removes Gmail's `INBOX` label (archive semantics); moving it to Trash adds Gmail's `TRASH` label rather than permanently deleting it. The same full-history action is also available from the Gmail accounts dialog.

Gmail's own folder/label structure is mirrored locally underneath the account's local folder: **Inbox**, **Sent**, **Drafts**, **Spam**, and **Trash** each become their own local sub-folder, and custom Gmail labels (including `Parent/Child`-style nested labels) become nested local folders under the same name. A message with no matching label — for example mail archived out of the Inbox without any other label — is filed under **Archived**. To make this possible, sync queries widen to include Spam and Trash, which Gmail's API excludes by default.

Inbox mail is presented under seven category tabs: **Primary**, **Promotions**, **Social**, **Updates**, **Bills**, **Medical**, and **Mail/Tracking**. Gmail's category labels seed the standard four categories, while deterministic sender, subject, header, and body signals identify bills, healthcare messages, and shipment tracking. Existing archives are reclassified automatically during database migration.

Use **Compose** in the top toolbar or the send button beside a connected Gmail account to send a plain-text email. Gmail creates the remote Sent copy, and Archive Mail immediately imports that server-provided copy into the connection's local destination. Existing connections created before send support was added remain read-only until the same account is authorized again.

Compose includes **Save draft**. Open the Drafts button in the top toolbar to review, edit, delete, or send saved and AI-generated drafts. Drafts are stored locally; sending uses the selected Gmail account. If an AI development draft has a resume selected, the resume is attached to the MIME message only when the reviewed draft is sent.

If a connected account has verified "Send mail as" aliases in Gmail (**Settings > Accounts > Send mail as**) — for example a custom domain address — Compose shows a **Send as** dropdown once more than one verified address is available, so a message can go out from `you@yourdomain.com` instead of the primary Gmail address. An address is rejected if it is not one of the account's verified aliases. Connections authorized before this feature was added need to be reconnected once to grant the `gmail.settings.basic` scope.

Unread counts are local when mailbox action sync is disabled. A newly imported Gmail message initially follows Gmail's `UNREAD` label; with mailbox action sync enabled, marking read/unread and starring/un-starring update Gmail first. Existing accounts must be reauthorized once after enabling the option.

Raw Gmail MIME is processed by the same importer as MBOX. Attachments are written to the SHA-256 blob store, included in archive counts, available for download, and indexed by filename and extracted/OCR text. Per-message and attachment failures appear under **Diagnostics > Gmail sync** and in the event log.

Attachment parsing and OCR run in an isolated worker with a 60-second deadline per attachment. If an extractor crashes or times out on a malformed PDF or image, the original attachment remains stored and downloadable, the item is marked as an extraction failure in Diagnostics, and the mailbox import continues.

The Gmail refresh token is stored in the app's local SQLite database so background pulls can run while Archive Mail is open. **Disconnect Gmail** revokes the token; already imported messages and attachments remain local. Gmail operations are blocked for LAN read-only viewers.

## Calendar and to-do lists

The calendar icon in the top toolbar switches between Mail and a day-focused **Calendar** view. It reuses the same Gmail OAuth connection — no separate authorization step — and reads and writes events directly on each connected account's primary Google Calendar. Connections authorized before this feature was added need to be reconnected once to grant the `calendar.events` scope; until then that account is left out of the Calendar view.

- Use the day navigator (previous/next/Today) to move between days. Events from every calendar-capable connected account appear together, each labeled with its account.
- **New event** creates a timed or all-day event with a title, location, description, and start/end time. Selecting an existing event's edit icon updates it; the trash icon deletes it from Google Calendar after confirmation.
- Changes are written straight to Google Calendar through the API — there is no local copy of calendar events to keep in sync.

Alongside the day's events, a **To-do** panel holds a simple local checklist for that date: add an item, check it off, or delete it. To-do items are stored only in the local SQLite database — they are never sent to Gmail or Google Calendar, and there is currently no action to turn a to-do list into a calendar event.

## AI message analysis (OpenAI or DeepSeek)

AI analysis is optional and disabled by default. It can use the OpenAI API and/or the DeepSeek API — each has its own card in Admin settings, so both can be connected (key, model, tested) at the same time without either overwriting the other. Whichever card is marked **Active** is the provider actually used when you click Analyze; switching which one is active is instant and doesn't touch the other's saved key or model.

1. Create an API project, API key, and billing configuration with your chosen provider(s) (OpenAI and/or DeepSeek).
2. Open **Admin settings > AI**.
3. In a provider's card, enter its API key and model, then save. For DeepSeek, use **Load DeepSeek models** to fetch the live list of currently available model ids and pick one from the dropdown — each option shows reference pricing where known (see note below). OpenAI's model field is free text.
4. Click **Make active** on whichever provider should handle analysis, toggle **Enable AI analysis** in the shared section above the cards, and set daily/monthly request limits there.
5. Use each card's **Test** button to verify that provider's saved key and model independently.
6. Open a message and choose **Analyze** — it runs against the active provider.

DeepSeek's model lineup changes over time; `deepseek-chat` and `deepseek-reasoner` retire on 2026-07-24 in favor of `deepseek-v4-flash` and `deepseek-v4-pro`, which is why the model list is fetched live from DeepSeek rather than hardcoded. Pricing shown next to each model is a reference snapshot baked into the app, not a live quote — check [platform.deepseek.com/api-docs/pricing](https://api-docs.deepseek.com/quick_start/pricing) for current rates before relying on it for cost decisions.

The first phase returns a structured local result with a summary, categories, priority, action recommendation, spam and phishing probabilities, draft recommendation, confidence, and supporting signals. When a message belongs to a thread, analysis and draft generation include up to 20 chronological messages so the result reflects the conversation instead of treating one reply in isolation. Analysis is a suggestion and can be wrong. It never automatically sends, deletes, moves, labels, or rewrites email.

Analysis runs through a persistent SQLite job queue. Jobs survive restarts, transient provider failures retry once, active jobs can be cancelled, and current results are reused when the message, model, and prompt version have not changed. Job states and redacted failures appear in **Diagnostics > AI analysis**. Daily and monthly request limits are enforced before each provider request; request and token usage appears in Admin settings.

For each selected message, Archive Mail sends the subject, sender, recipients, dates, up to 40,000 characters of plain-text body, attachment filenames, and a small allowlist of headers. Attachment bytes and extracted attachment text are not sent in this phase. OpenAI requests use `store: false`. Email bodies, prompts, and API keys are excluded from audit and diagnostic records.

The admin-managed keys are stored in `~/.archive-mail/ai-settings.json` with permissions restricted to the current operating-system user and are never returned by the API. A managed installation can also provide an environment key per provider:

```bash
OPENAI_API_KEY="sk-proj-..." npm start
# or
DEEPSEEK_API_KEY="sk-..." npm start
```

An environment key is a fallback, not a UI lock. You can enter and save a different key in the provider's Admin card; the saved Admin key takes precedence immediately. Removing the saved key restores the environment value without requiring a restart. Model, provider selection, enablement, and request limits remain editable in either case.

### Scheduled AI agents

Below the provider cards, **Admin settings > AI > Scheduled AI agents** lets you set up recurring analysis or draft tasks:

1. Click **Add schedule**, name it, choose **Analyze email** or **Create work-related reply drafts**, and pick an archive and mailbox.
2. Target the full mailbox (new/unread or everything) or one specific email from the 100 most recent messages shown in the picker.
3. Set an interval in minutes (e.g. `60` for hourly, `1440` for daily).
4. Choose the agent's provider and model. This selection is pinned to the schedule and does not change when the manual-analysis Active provider changes.
5. Select one or more agent skills (summary, categorization, priority, action extraction, spam/phishing checks, and reply recommendation), then optionally add a schedule-specific prompt.
6. For a draft task, choose the Gmail sending account, a saved reply style, and optionally a resume uploaded under **Admin settings > Resumes**. The resume is selected only for development opportunities.
7. Save. The schedule runs with that exact agent configuration, respects the same daily/monthly request limits, and skips messages already processed with the same content and configuration.

Draft tasks classify each email as work-related and development-related. Work-related email produces a local reply draft; non-work email produces no draft. Development drafts reference the selected resume. Schedules never send email or resumes automatically: use the top-bar Drafts panel to review and send.

Each schedule can be edited, toggled on/off, triggered immediately with **Run now**, or deleted. The list shows its task, target, provider, model, skills, prompt, sending account/resume when applicable, last-run time, and status summary.

### AI workflow tools

- **Thread-level AI:** Open a message to expand its conversation context. Analysis, AI actions, and reply drafts use that context and avoid generating another reply after the conversation has already been answered.
- **Follow-up tracker:** Choose **Follow up** on a message, set a date/time and note, and review pending items in the AI Review Queue. A pending follow-up completes automatically when a sent reply is recorded for that conversation.
- **AI Review Queue:** Use the brain button in the top toolbar to review generated drafts, messages needing a decision, and due or upcoming follow-ups in one place. Attention items are grouped by urgency and sorted by newest analysis; follow-ups are grouped by due date and sorted earliest first. Create an editable AI-suggested event or to-do directly from an attention item; successful creation marks that analysis reviewed. You can also delete unwanted drafts or mark an analysis reviewed manually. The badge shows the current review count.
- **Smart mail rules:** Under **Admin settings > Smart rules**, describe a rule in natural language, review and edit the AI-generated conditions/actions, then activate it. Rules can move matching local Inbox mail to an existing folder, mark it read, or star it; they never send or delete email. You can optionally apply a reviewed rule to existing messages.
- **Sender-aware moves:** When moving a message to another mailbox, choose whether to move only that message or every local message from the same sender. Moving all also creates a sender rule that files future imported Inbox mail into the selected mailbox.
- **Reply styles:** Under **Admin settings > Reply styles**, save reusable tone and writing instructions and select a default. Manual and scheduled AI drafts can pin a specific style, and the selected style is recorded with the draft for review.

## Insights

**Admin settings > Insights** is a read-only snapshot of everything imported and analyzed so far: total messages and attachments, the oldest and newest message by date, the top 10 senders and top 10 recipients by message count, and — once at least one message has been analyzed — an AI analysis summary (priority breakdown, top categories, action-required and draft-recommended counts, and spam/phishing flag rates). It has a **Refresh** button and otherwise recomputes from the database each time the tab is opened.

## Diagnostics

Open **Admin settings > Tools > Diagnostics**. It shows:

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
- For a complete reset, stop Archive Mail and remove its data directory. The default is `~/.archive-mail`; a custom run uses the directory named by `EMAIL_CLIENT_DATA_DIR`. This permanently removes every imported message, attachment, upload, job, Gmail token, OpenAI/DeepSeek key, AI result, diagnostic event, and local to-do item. It has no effect on Google Calendar; events created there remain until deleted in Calendar itself.

## Verification

```bash
npm run typecheck
npm run test:run
npm run build
```
