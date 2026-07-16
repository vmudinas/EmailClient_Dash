import { useState } from "react";
import {
  Activity,
  BookOpen,
  BrainCircuit,
  Database,
  FolderTree,
  Import,
  MailCheck,
  ShieldCheck,
  X
} from "lucide-react";

interface GuideDialogProps {
  open: boolean;
  onClose(): void;
}

type GuideSection = "overview" | "import" | "storage" | "gmail" | "ai" | "organize" | "security" | "diagnostics";

const MENU: Array<{
  id: GuideSection;
  label: string;
  icon: typeof BookOpen;
}> = [
  { id: "overview", label: "Overview", icon: BookOpen },
  { id: "import", label: "Import", icon: Import },
  { id: "storage", label: "Storage", icon: Database },
  { id: "gmail", label: "Gmail", icon: MailCheck },
  { id: "ai", label: "AI", icon: BrainCircuit },
  { id: "organize", label: "Organize", icon: FolderTree },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "diagnostics", label: "Diagnostics", icon: Activity }
];

export function GuideDialog({ open, onClose }: GuideDialogProps) {
  const [section, setSection] = useState<GuideSection>("overview");
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog guide-dialog" role="dialog" aria-modal="true" aria-labelledby="guide-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><BookOpen size={20} /><h2 id="guide-title">Guide</h2></div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="guide-layout">
          <nav className="guide-menu" aria-label="Guide topics">
            {MENU.map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={section === item.id ? "selected" : ""} onClick={() => setSection(item.id)}>
                  <Icon size={17} /><span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <article className="guide-content">
            <GuideContent section={section} />
          </article>
        </div>
      </section>
    </div>
  );
}

function GuideContent({ section }: { section: GuideSection }) {
  if (section === "import") {
    return (
      <>
        <h3>Import PST and MBOX</h3>
        <p>The source is scanned, fingerprinted, counted, parsed one message at a time, and normalized into local storage. Attachments are saved and searchable text is extracted in the background.</p>
        <ol>
          <li>Select a PST, MBOX, MBX, or extensionless MBOX file.</li>
          <li>Optionally enable English OCR for images and scanned PDFs.</li>
          <li>Follow email count, percentage, phase, and estimated completion time in Imports.</li>
        </ol>
        <h4>Stop, restart, and clear</h4>
        <p><strong>Stop</strong> saves a safe checkpoint. <strong>Restart</strong> continues from that checkpoint. <strong>Clear</strong> removes a stopped partial import; clearing completed history keeps the imported archive.</p>
      </>
    );
  }
  if (section === "storage") {
    return (
      <>
        <h3>Local storage</h3>
        <p>Archive Mail stores normalized mail in one SQLite database and stores original attachment bytes in a SHA-256 blob directory.</p>
        <dl className="guide-definitions">
          <div><dt>SQLite</dt><dd>Folders, message fields, sanitized HTML, headers, local read state, tags, notes, search indexes, jobs, and diagnostics.</dd></div>
          <div><dt>Blobs</dt><dd>Original attachment files. Identical attachments share one physical blob.</dd></div>
          <div><dt>Incoming</dt><dd>A managed source copy retained only while a browser upload is importing or restartable.</dd></div>
        </dl>
        <p>The app does not retain a byte-for-byte raw EML copy of each message. Keep the original PST or MBOX as an external backup when exact archival reproduction matters.</p>
      </>
    );
  }
  if (section === "gmail") {
    return (
      <>
        <h3>Authorize, sync, and send</h3>
        <p>Connect Gmail opens Google OAuth in the system browser. Archive Mail requests separate read-only and send permissions and stores the refresh token only in the local database.</p>
        <div className="guide-assurance"><ShieldCheck size={18} /><span>Sync can list and download mail, but it cannot delete, move, label, or mark messages in Gmail.</span></div>
        <h4>One-time Google setup</h4>
        <ol>
          <li>In Google Cloud Console, enable the Gmail API and configure the OAuth consent screen.</li>
          <li>Create an OAuth 2.0 client with <strong>Desktop app</strong> as the application type.</li>
          <li>Open Admin settings, choose Gmail, load the downloaded Desktop OAuth JSON, and save it. Environment variables remain available for managed installations.</li>
        </ol>
        <h4>Multiple accounts and destinations</h4>
        <p>The same Desktop OAuth configuration can authorize multiple Gmail accounts. For each account, choose a new archive, create a mailbox in an existing archive, or merge incoming mail into an existing mailbox. Accounts that share a mailbox retain separate sync and send identities.</p>
        <p>A connection created by an older read-only version must be authorized again before it can send.</p>
        <h4>Why Gmail API instead of POP or IMAP?</h4>
        <p>Google requires a broad full-mail permission for POP, IMAP, and SMTP. The Gmail API provides narrower permissions that enforce pull-only synchronization and sending without remote deletion access.</p>
        <h4>Unread state</h4>
        <p>New Gmail messages initially use Gmail's unread label. After import, read and unread changes are local to Archive Mail and are not pushed back to Gmail.</p>
        <h4>Disconnect</h4>
        <p>Disconnecting revokes the Google token. Messages and attachments already imported into local storage remain available.</p>
      </>
    );
  }
  if (section === "organize") {
    return (
      <>
        <h3>Organize local mail</h3>
        <p>Rename changes only the local display name. Archive Mail never rewrites an original PST or MBOX.</p>
        <ul>
          <li>Starred is a smart mailbox. Starring a message keeps it in its original mailbox while also showing it in Starred.</li>
          <li>Combine archives to move folders, messages, state, search rows, and attachment references into another completed archive.</li>
          <li>Combine mailboxes within one archive to move a mailbox tree into another mailbox.</li>
          <li>Delete removes local mail and unreferenced attachment blobs. It does not delete anything from Gmail.</li>
        </ul>
      </>
    );
  }
  if (section === "ai") {
    return (
      <>
        <h3>AI email analysis</h3>
        <p>AI is optional and disabled until an administrator adds an OpenAI API project key under Admin settings and AI. ChatGPT subscriptions and OpenAI API billing are separate.</p>
        <ol>
          <li>Create an API key in an OpenAI API project and add billing or credits to that project.</li>
          <li>Save the key, choose a model and request limits, enable AI, then test the connection.</li>
          <li>Open an email and choose Analyze. The result is stored locally and can be viewed again without another request.</li>
        </ol>
        <div className="guide-assurance"><ShieldCheck size={18} /><span>The selected message and up to 20 messages from its conversation are supplied for context. Requests use <code>store: false</code>; API keys and message bodies are excluded from diagnostics.</span></div>
        <h4>Jobs and limits</h4>
        <p>Analysis runs as a durable background job. Queued, running, failed, cancelled, and completed states remain visible in Diagnostics. Daily and monthly request limits are enforced before a request is sent.</p>
        <h4>Draft identity</h4>
        <p>Admin settings and Drafts controls the default verified send-as address and the name that replaces <code>[Name]</code> placeholders. Saved drafts can be reviewed or sent directly from the Drafts list after confirmation.</p>
        <p>After analysis, use Draft reply to choose a sending account, optional résumé, and personalized reply style. The generated draft opens in the existing review composer and is never sent automatically. Plan opens the editable calendar/to-do suggestion, while Follow up tracks the conversation until you reply.</p>
        <p>AI draft schedules create at most one active job or reviewable draft per email conversation. Conversations with a recorded reply or matching Sent message are skipped, and the exact skip reason is written to Diagnostics.</p>
        <h4>Review queue and workflows</h4>
        <p>The brain button in the top bar opens one queue for AI drafts, actionable or high-priority analyses, and pending follow-ups. Follow-ups complete automatically after a reply is sent and can also be completed manually.</p>
        <p>Admin settings and Reply styles stores reusable tone profiles. Smart rules converts a plain-language filing request into literal sender, subject, body, and attachment conditions. Review the destination and actions before activation; enabled rules then apply locally to new Inbox mail.</p>
        <h4>Safety boundary</h4>
        <p>AI results are suggestions and can be wrong. AI never sends or deletes email. A smart rule can move, mark read, or star local Inbox mail only after an administrator reviews and activates the structured rule.</p>
      </>
    );
  }
  if (section === "security") {
    return (
      <>
        <h3>Login, settings, and audit</h3>
        <p>Every application launch requires a named Archive Mail user and PIN. The first-run account is <code>admin</code> with PIN <code>2332</code>; change it under Admin settings and Security.</p>
        <ul>
          <li>PINs are salted and hashed. Session tokens are stored as hashes, bound to the login IP address, and revoked when the service restarts.</li>
          <li>Administrators can create named users, change roles, disable access, reset PINs, and review or export the audit history.</li>
          <li>Audit entries include user, time, action, result, IP address, route, and user agent. PINs, tokens, and email bodies are excluded.</li>
        </ul>
        <h4>Database adapters</h4>
        <p>Admin settings stores the database connection in a bootstrap file outside the mail database. SQLite is the installed adapter. PostgreSQL, MySQL, and SQL Server require their own query, migration, and search adapters before they can be selected.</p>
      </>
    );
  }
  if (section === "diagnostics") {
    return (
      <>
        <h3>Diagnostics and failures</h3>
        <p>Diagnostics records upload offsets, import checkpoints, parser failures, attachment extraction problems, Gmail authorization and sync events, AI job failures, send failures, and browser fetch errors.</p>
        <ul>
          <li>Export JSON before clearing logs when investigating a problem.</li>
          <li>An attachment extraction failure keeps the original attachment downloadable.</li>
          <li>A message-level failure is recorded and the importer continues with the next message when possible.</li>
        </ul>
      </>
    );
  }
  return (
    <>
      <h3>How Archive Mail works</h3>
      <p>Archive Mail is a local-first reader and search index for PST, MBOX, and authorized Gmail accounts. Imported content stays on this computer unless you explicitly analyze a selected email with the optional OpenAI integration.</p>
      <div className="guide-flow" aria-label="Import flow">
        <span>Source archive or Gmail</span><b>1</b><span>Parse and normalize</span><b>2</b><span>SQLite and attachment blobs</span><b>3</b><span>Browse, search, and organize</span>
      </div>
      <h4>What remains remote?</h4>
      <p>Gmail sync only pulls copies. Local reads, tags, notes, mailbox changes, archive deletion, and merging do not modify the Gmail mailbox.</p>
    </>
  );
}
