import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Archive,
  Check,
  CircleAlert,
  CloudDownload,
  Combine as CombineIcon,
  Download,
  Filter,
  FolderPlus,
  FolderTree,
  KeyRound,
  LoaderCircle,
  MailCheck,
  PencilLine,
  RefreshCw,
  ScanText,
  Send,
  ShieldCheck,
  Trash2,
  Unplug,
  Upload,
  X
} from "lucide-react";
import type {
  Archive as ArchiveModel,
  DiagnosticsSnapshot,
  Folder,
  GmailAuthRequest,
  GmailConnection
} from "@email-client/shared";
import type { UploadProgress } from "../lib/api.js";
import { importEmailCountLabel, importProgressPercent } from "../lib/import-progress.js";

export interface UiSearchFilters {
  folderId: string;
  from: string;
  to: string;
  after: string;
  before: string;
  hasAttachment: boolean | undefined;
}

export const EMPTY_FILTERS: UiSearchFilters = {
  folderId: "",
  from: "",
  to: "",
  after: "",
  before: "",
  hasAttachment: undefined
};

export const ALL_MAIL_SEARCH_SCOPE = "__all_mail__";

interface ImportDialogProps {
  open: boolean;
  busy: boolean;
  progress: UploadProgress | null;
  error: string;
  onClose(): void;
  onOpenDiagnostics(): void;
  onCancelUpload(): void;
  onImport(file: File | null, ocrEnabled: boolean): void;
}

export function ImportDialog({
  open,
  busy,
  progress,
  error,
  onClose,
  onOpenDiagnostics,
  onCancelUpload,
  onImport
}: ImportDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setFile(null);
      setOcrEnabled(false);
    }
  }, [open]);

  if (!open) return null;
  const canStopUpload = busy && progress?.stage === "uploading";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><Archive size={20} /><h2 id="import-title">Import archive</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
              <button disabled={busy} className={`file-picker ${file ? "has-file" : ""}`} onClick={() => inputRef.current?.click()}>
                {file ? <Check size={22} /> : <Upload size={22} />}
                <span>
                  <strong>{file?.name ?? "Choose PST or MBOX"}</strong>
                  <small>{file ? formatFileSize(file.size) : "The source stays read-only."}</small>
                </span>
              </button>
          </>

          <label className="setting-row">
            <span className="setting-icon"><ScanText size={19} /></span>
            <span>
              <strong>Scan images for text</strong>
              <small>English OCR for scanned PDFs and image attachments.</small>
            </span>
            <input
              type="checkbox"
              checked={ocrEnabled}
              onChange={(event) => setOcrEnabled(event.target.checked)}
            />
          </label>
          <div className="privacy-row"><ShieldCheck size={16} /> Processing stays on this computer.</div>
          {progress && (
            <div className="upload-progress" aria-live="polite">
              <div><strong>{progress.stage === "starting" ? "Starting import" : `Uploading ${progress.percent}%`}</strong><span>{progress.message}</span></div>
              <progress max={100} value={progress.percent} />
            </div>
          )}
          {error && (
            <div className="import-error" role="alert">
              <CircleAlert size={18} />
              <div><strong>Import did not start</strong><span>{error}</span></div>
              <button className="text-button" onClick={onOpenDiagnostics}>Diagnostics</button>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <button
            className="secondary-button"
            disabled={busy && !canStopUpload}
            onClick={canStopUpload ? onCancelUpload : onClose}
          >
            {canStopUpload ? "Stop upload" : busy ? "Please wait" : error ? "Close" : "Cancel"}
          </button>
          <button
            className="primary-button"
            disabled={busy || !file}
            onClick={() => onImport(file, ocrEnabled)}
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}
            {progress?.stage === "uploading" ? `Uploading ${progress.percent}%` : "Import"}
          </button>
        </footer>
      </section>
    </div>
  );
}

interface RenameDialogProps {
  target: { kind: "archive" | "mailbox"; name: string } | null;
  busy: boolean;
  onClose(): void;
  onRename(name: string): void;
}

export function RenameDialog({ target, busy, onClose, onRename }: RenameDialogProps) {
  const [name, setName] = useState("");
  useEffect(() => setName(target?.name ?? ""), [target]);
  if (!target) return null;
  const label = target.kind === "archive" ? "archive" : "mailbox";
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><PencilLine size={20} /><h2 id="rename-title">Rename {label}</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onRename(name.trim());
        }}>
          <div className="dialog-body">
            <label className="rename-field"><span>Name</span><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
            <small>This changes the local display name only. The original archive is never modified.</small>
          </div>
          <footer className="dialog-footer">
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <PencilLine size={17} />} Rename
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

interface CreateMailboxDialogProps {
  open: boolean;
  archive: ArchiveModel | null;
  folders: Folder[];
  initialParentId?: string | null;
  busy: boolean;
  onClose(): void;
  onCreate(name: string, parentId: string | null): void;
}

export function CreateMailboxDialog({
  open,
  archive,
  folders,
  initialParentId = null,
  busy,
  onClose,
  onCreate
}: CreateMailboxDialogProps) {
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setParentId(initialParentId ?? "");
    }
  }, [initialParentId, open]);
  if (!open || !archive) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="create-mailbox-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><FolderPlus size={20} /><h2 id="create-mailbox-title">Create mailbox</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onCreate(name.trim(), parentId || null);
        }}>
          <div className="dialog-body">
            <label className="rename-field"><span>Name</span><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
            <label className="rename-field">
              <span>Parent</span>
              <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                <option value="">Top level in {archive.name}</option>
                {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
              </select>
            </label>
          </div>
          <footer className="dialog-footer">
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="submit" className="primary-button" disabled={busy || !name.trim()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <FolderPlus size={17} />} Create
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

interface CombineArchiveDialogProps {
  source: ArchiveModel | null;
  archives: ArchiveModel[];
  busy: boolean;
  onClose(): void;
  onCombine(targetArchiveId: string): void;
}

export function CombineArchiveDialog({
  source,
  archives,
  busy,
  onClose,
  onCombine
}: CombineArchiveDialogProps) {
  const targets = archives.filter((archive) => (
    archive.id !== source?.id && archive.status !== "importing" && archive.status !== "failed"
  ));
  const [targetId, setTargetId] = useState("");
  useEffect(() => setTargetId(targets[0]?.id ?? ""), [source?.id, archives.length]);
  if (!source) return null;
  const target = targets.find((archive) => archive.id === targetId);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog combine-dialog" role="dialog" aria-modal="true" aria-labelledby="combine-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><CombineIcon size={20} /><h2 id="combine-title">Combine archives</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <div className="combine-source"><span>Move from</span><strong>{source.name}</strong><small>{source.messageCount.toLocaleString()} messages · {source.attachmentCount.toLocaleString()} attachments</small></div>
          <label className="rename-field">
            <span>Destination</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targets.map((archive) => <option key={archive.id} value={archive.id}>{archive.name}</option>)}
            </select>
          </label>
          {target && <small className="combine-result">The source archive is removed after its data is committed to {target.name}.</small>}
          {targets.length === 0 && <div className="import-error"><CircleAlert size={18} /><div><strong>No destination available</strong><span>Import or connect another archive first.</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !targetId} onClick={() => onCombine(targetId)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <CombineIcon size={17} />} Combine
          </button>
        </footer>
      </section>
    </div>
  );
}

interface CombineMailboxDialogProps {
  source: Folder | null;
  folders: Folder[];
  busy: boolean;
  onClose(): void;
  onCombine(targetFolderId: string): void;
}

export function CombineMailboxDialog({
  source,
  folders,
  busy,
  onClose,
  onCombine
}: CombineMailboxDialogProps) {
  const targets = folders.filter((folder) => (
    folder.id !== source?.id && !folder.path.startsWith(`${source?.path}/`)
  ));
  const sourceMailboxes = source
    ? folders.filter((folder) => folder.path === source.path || folder.path.startsWith(`${source.path}/`))
    : [];
  const messageCount = sourceMailboxes.reduce((total, folder) => total + folder.messageCount, 0);
  const [targetId, setTargetId] = useState("");
  useEffect(() => setTargetId(targets[0]?.id ?? ""), [source?.id, folders]);
  if (!source) return null;
  const target = targets.find((folder) => folder.id === targetId);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog combine-dialog" role="dialog" aria-modal="true" aria-labelledby="combine-mailbox-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><CombineIcon size={20} /><h2 id="combine-mailbox-title">Combine mailboxes</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <div className="combine-source"><span>Move from</span><strong>{source.path}</strong><small>{messageCount.toLocaleString()} messages in {sourceMailboxes.length.toLocaleString()} mailbox{sourceMailboxes.length === 1 ? "" : "es"}</small></div>
          <label className="rename-field">
            <span>Destination</span>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targets.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
            </select>
          </label>
          {target && <small className="combine-result">Messages and Gmail destinations move into {target.path}. The source mailbox and its child mailboxes are then removed.</small>}
          {targets.length === 0 && <div className="import-error"><CircleAlert size={18} /><div><strong>No destination available</strong><span>Create another mailbox first.</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !targetId} onClick={() => onCombine(targetId)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <CombineIcon size={17} />} Combine
          </button>
        </footer>
      </section>
    </div>
  );
}

interface MailboxDropDialogProps {
  source: Folder | null;
  target: Folder | null;
  busy: boolean;
  onClose(): void;
  onMerge(): void;
  onMoveAsChild(): void;
}

export function MailboxDropDialog({
  source,
  target,
  busy,
  onClose,
  onMerge,
  onMoveAsChild
}: MailboxDropDialogProps) {
  if (!source || !target) return null;
  const alreadyChild = source.parentId === target.id;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog combine-dialog" role="dialog" aria-modal="true" aria-labelledby="organize-mailbox-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><FolderTree size={20} /><h2 id="organize-mailbox-title">Organize mailbox</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <div className="combine-source">
            <span>Dragged mailbox</span>
            <strong>{source.path}</strong>
            <small>Dropped onto {target.path}</small>
          </div>
          <div className="mailbox-drop-options">
            <div><CombineIcon size={18} /><span><strong>Merge mailboxes</strong><small>Move every message into {target.path}, then remove {source.path} and its child mailboxes.</small></span></div>
            <div><FolderPlus size={18} /><span><strong>Move as child</strong><small>Keep the mailbox tree and place it under {target.path} without duplicating messages.</small></span></div>
          </div>
          {alreadyChild && <small className="combine-result">{source.name} is already a child of {target.path}. You can merge it or cancel.</small>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="danger-button" disabled={busy} onClick={onMerge}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <CombineIcon size={17} />} Merge
          </button>
          <button className="primary-button" disabled={busy || alreadyChild} onClick={onMoveAsChild}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <FolderPlus size={17} />} Move as child
          </button>
        </footer>
      </section>
    </div>
  );
}

interface GmailDialogProps {
  open: boolean;
  archives: ArchiveModel[];
  selectedArchiveId: string | null;
  connections: GmailConnection[];
  loading: boolean;
  busy: boolean;
  error: string;
  onClose(): void;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onConnect(request: GmailAuthRequest): void;
  onSync(connectionId: string): void;
  onFullSync(connectionId: string): void;
  onCancel(connectionId: string): void;
  onReorganize(connectionId: string): void;
  onCompose(connection: GmailConnection): void;
  onReauthorize(connection: GmailConnection): void;
  onDisconnect(connection: GmailConnection): void;
}

type GmailDestinationMode = "new_archive" | "new_mailbox" | "existing_mailbox";

export function GmailDialog({
  open,
  archives,
  selectedArchiveId,
  connections,
  loading,
  busy,
  error,
  onClose,
  onLoadFolders,
  onConnect,
  onSync,
  onFullSync,
  onCancel,
  onReorganize,
  onCompose,
  onReauthorize,
  onDisconnect
}: GmailDialogProps) {
  const readyArchives = archives.filter((archive) => archive.status !== "importing" && archive.status !== "failed");
  const [archiveId, setArchiveId] = useState("");
  const [archiveName, setArchiveName] = useState("Gmail");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderChoice, setFolderChoice] = useState("");
  const [folderName, setFolderName] = useState("Gmail");
  const [query, setQuery] = useState("newer_than:30d");
  const [ocrEnabled, setOcrEnabled] = useState(false);
  const [destinationMode, setDestinationMode] = useState<GmailDestinationMode>("new_archive");

  useEffect(() => {
    if (!open) return;
    const initialArchive = selectedArchiveId && readyArchives.some((archive) => archive.id === selectedArchiveId)
      ? selectedArchiveId
      : readyArchives[0]?.id ?? "";
    setArchiveId(initialArchive);
    setArchiveName("Gmail");
    setFolderChoice("");
    setFolderName("Gmail");
    setQuery("newer_than:30d");
    setOcrEnabled(false);
    setDestinationMode(selectedArchiveId && initialArchive ? "new_mailbox" : "new_archive");
  }, [open]);

  useEffect(() => {
    let active = true;
    if (!open || !archiveId) {
      setFolders([]);
      return;
    }
    void onLoadFolders(archiveId).then((loaded) => {
      if (active) {
        setFolders(loaded);
        setFolderChoice((current) => loaded.some((folder) => folder.id === current)
          ? current
          : loaded[0]?.id ?? "");
      }
    }).catch(() => {
      if (active) setFolders([]);
    });
    return () => { active = false; };
  }, [open, archiveId, onLoadFolders]);

  if (!open) return null;
  const destinationArchiveId = destinationMode === "new_archive" ? null : archiveId || null;
  const selectedFolderId = destinationMode === "existing_mailbox" ? folderChoice || null : null;
  const destinationReady = destinationMode === "new_archive"
    ? Boolean(archiveName.trim() && folderName.trim())
    : destinationMode === "new_mailbox"
      ? Boolean(archiveId && folderName.trim())
      : Boolean(archiveId && selectedFolderId);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog gmail-dialog" role="dialog" aria-modal="true" aria-labelledby="gmail-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><MailCheck size={20} /><h2 id="gmail-title">Gmail</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body gmail-body">
          {connections.length > 0 && (
            <section className="gmail-section">
              <h3>Connected accounts <span className="gmail-count">{connections.length}</span></h3>
              <div className="gmail-connections">
                {connections.map((connection) => {
                  const percent = connection.totalItems && connection.totalItems > 0
                    ? Math.min(100, Math.round(connection.processedItems / connection.totalItems * 100))
                    : 0;
                  return (
                    <div className="gmail-connection" key={connection.id}>
                      <span className={`status-dot status-${connection.status}`} />
                      <div className="gmail-connection-copy">
                        <strong>{connection.email}</strong>
                        <span>{connection.archiveName} / {connection.folderPath}</span>
                        <small className="gmail-permission">
                          {connection.canModifyMailbox ? "Gmail mailbox permission granted" : "Mailbox changes stay local until reauthorized"}
                          {connection.canSend ? " · sending enabled" : " · authorize again to send"}
                        </small>
                        {connection.status === "syncing" ? (
                          <><progress max={100} value={percent} /><small>{connection.processedItems.toLocaleString()} of {(connection.totalItems ?? 0).toLocaleString()} · {connection.importedItems.toLocaleString()} new</small></>
                        ) : (
                          <small>{connection.lastError ?? (connection.lastSyncedAt ? `Last sync ${formatDiagnosticTime(connection.lastSyncedAt)}` : "Not synced yet")}</small>
                        )}
                      </div>
                      <div className="gmail-actions">
                        <button className="icon-button" disabled={!connection.canSend} onClick={() => onCompose(connection)} title={connection.canSend ? "Compose email" : "Authorize this account again to send"} aria-label={`Compose from ${connection.email}`}><Send size={15} /></button>
                        {connection.status === "syncing" ? (
                          <button className="icon-button" onClick={() => onCancel(connection.id)} title="Stop Gmail sync" aria-label={`Stop Gmail sync for ${connection.email}`}><X size={15} /></button>
                        ) : (
                          <>
                            <button className="icon-button" onClick={() => onSync(connection.id)} title="Sync Gmail now" aria-label={`Sync ${connection.email} now`}><RefreshCw size={15} /></button>
                            <button
                              className="icon-button"
                              onClick={() => {
                                if (window.confirm(`Pull all mail and folders for ${connection.email}, not just recent messages? This removes any date limit from the original search and can take a while for large mailboxes.`)) {
                                  onFullSync(connection.id);
                                }
                              }}
                              title="Sync everything (all folders, full history)"
                              aria-label={`Sync all mail and folders for ${connection.email}`}
                            ><CloudDownload size={15} /></button>
                            <button
                              className="icon-button"
                              onClick={() => {
                                if (window.confirm(`Reorganize ${connection.email}'s local mail into Inbox/Sent/Spam/label sub-folders based on its current Gmail labels? Messages already synced before this feature will be moved.`)) {
                                  onReorganize(connection.id);
                                }
                              }}
                              title="Reorganize into label folders"
                              aria-label={`Reorganize folders for ${connection.email}`}
                            ><FolderTree size={15} /></button>
                          </>
                        )}
                        <button
                          className="secondary-button compact gmail-reauthorize-button"
                          onClick={() => onReauthorize(connection)}
                          title="Reauthorize Gmail, send-as settings, and Google Calendar permissions"
                          aria-label={`Reauthorize ${connection.email}`}
                        ><KeyRound size={14} /> Reauthorize</button>
                        <button className="icon-button" onClick={() => onDisconnect(connection)} title="Disconnect Gmail" aria-label={`Disconnect ${connection.email}`}><Unplug size={15} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="gmail-section gmail-connect-form">
            <h3>{connections.length > 0 ? "Add another Gmail account" : "Add Gmail account"}</h3>
            <div className="gmail-destination-modes" role="group" aria-label="Gmail destination">
              <button
                type="button"
                className={destinationMode === "new_archive" ? "selected" : ""}
                aria-pressed={destinationMode === "new_archive"}
                onClick={() => setDestinationMode("new_archive")}
              ><Archive size={16} /><span>New archive</span></button>
              <button
                type="button"
                className={destinationMode === "new_mailbox" ? "selected" : ""}
                aria-pressed={destinationMode === "new_mailbox"}
                disabled={readyArchives.length === 0}
                onClick={() => setDestinationMode("new_mailbox")}
              ><FolderPlus size={16} /><span>New mailbox</span></button>
              <button
                type="button"
                className={destinationMode === "existing_mailbox" ? "selected" : ""}
                aria-pressed={destinationMode === "existing_mailbox"}
                disabled={readyArchives.length === 0}
                onClick={() => {
                  setDestinationMode("existing_mailbox");
                  setFolderChoice((current) => folders.some((folder) => folder.id === current)
                    ? current
                    : folders[0]?.id ?? "");
                }}
              ><CombineIcon size={16} /><span>Existing mailbox</span></button>
            </div>
            <div className="gmail-fields">
              {destinationMode === "new_archive" ? (
                <>
                  <label className="rename-field"><span>Archive name</span><input value={archiveName} maxLength={120} onChange={(event) => setArchiveName(event.target.value)} /></label>
                  <label className="rename-field"><span>Local folder name</span><input value={folderName} maxLength={120} onChange={(event) => setFolderName(event.target.value)} /></label>
                </>
              ) : (
                <label className="rename-field">
                  <span>Archive</span>
                  <select value={archiveId} onChange={(event) => { setArchiveId(event.target.value); setFolderChoice(""); }}>
                    {readyArchives.map((archive) => <option key={archive.id} value={archive.id}>{archive.name}</option>)}
                  </select>
                </label>
              )}
              {destinationMode === "new_mailbox" && <label className="rename-field"><span>New local folder name</span><input value={folderName} maxLength={120} onChange={(event) => setFolderName(event.target.value)} /></label>}
              {destinationMode === "existing_mailbox" && folders.length > 0 && (
                <label className="rename-field">
                  <span>Merge into mailbox</span>
                  <select value={folderChoice} onChange={(event) => setFolderChoice(event.target.value)}>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                  </select>
                </label>
              )}
              <label className="rename-field gmail-query"><span>Initial Gmail search</span><input value={query} maxLength={500} placeholder="newer_than:30d" onChange={(event) => setQuery(event.target.value)} /></label>
            </div>
            {destinationMode === "existing_mailbox" && folders.length === 0 && (
              <div className="import-error"><CircleAlert size={18} /><div><strong>No mailbox in this archive</strong><span>Choose New mailbox to create one first.</span></div></div>
            )}
            {destinationMode === "existing_mailbox" && selectedFolderId && (
              <p className="gmail-destination-note">Mail from this Gmail account will be merged into the selected local mailbox. Existing messages stay in place, and Gmail accounts remain separately syncable.</p>
            )}
            <label className="setting-row gmail-ocr">
              <span className="setting-icon"><ScanText size={19} /></span>
              <span><strong>Scan attachments for text</strong><small>English OCR for images and scanned PDFs.</small></span>
              <input type="checkbox" checked={ocrEnabled} onChange={(event) => setOcrEnabled(event.target.checked)} />
            </label>
            <p className="gmail-destination-note">Gmail labels are mirrored underneath this local folder: Inbox, Sent, Drafts, Spam, Trash, and custom labels each become their own sub-folder. Mail with no matching label is filed under Archived.</p>
            <div className="gmail-safety"><ShieldCheck size={18} /><span>Authorization includes Gmail read, send, send-as settings, Google Calendar lists, and Calendar event access. If mailbox mirroring is enabled in Admin settings, it also grants permission to archive, move, mark Spam, move to Trash, change read state, and star messages. Permanent deletion is never performed.</span></div>
          </section>
          {error && <div className="import-error" role="alert"><CircleAlert size={18} /><div><strong>Gmail action failed</strong><span>{error}</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Close</button>
          <button
            className="primary-button"
            disabled={busy || loading || !destinationReady}
            onClick={() => onConnect({
              archiveId: destinationArchiveId,
              folderId: selectedFolderId,
              archiveName: archiveName.trim() || "Gmail",
              folderName: folderName.trim() || "Gmail",
              query: query.trim(),
              ocrEnabled
            })}
          >
            {busy ? <LoaderCircle className="spin" size={17} /> : <MailCheck size={17} />} Authorize new Google account
          </button>
        </footer>
      </section>
    </div>
  );
}

interface DiagnosticsDialogProps {
  open: boolean;
  data: DiagnosticsSnapshot | null;
  loading: boolean;
  clearing: boolean;
  pendingCount: number;
  onClose(): void;
  onRefresh(): void;
  onDownload(): void;
  onClear(): void;
}

export function DiagnosticsDialog({
  open,
  data,
  loading,
  clearing,
  pendingCount,
  onClose,
  onRefresh,
  onDownload,
  onClear
}: DiagnosticsDialogProps) {
  const [level, setLevel] = useState<"all" | "warning" | "error">("all");
  if (!open) return null;
  const events = data?.events.filter((event) => level === "all" || event.level === level) ?? [];
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog diagnostics-dialog" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header diagnostics-header">
          <div><Activity size={20} /><h2 id="diagnostics-title">Diagnostics</h2></div>
          <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="diagnostics-toolbar">
          <div className="sort-segment" aria-label="Diagnostic severity">
            <button className={level === "all" ? "selected" : ""} onClick={() => setLevel("all")}>All</button>
            <button className={level === "warning" ? "selected" : ""} onClick={() => setLevel("warning")}>Warnings</button>
            <button className={level === "error" ? "selected" : ""} onClick={() => setLevel("error")}>Errors</button>
          </div>
          <button className="icon-button" disabled={loading} onClick={onRefresh} title="Refresh diagnostics" aria-label="Refresh diagnostics"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
        </div>
        <div className="dialog-body diagnostics-body">
          {pendingCount > 0 && (
            <div className="diagnostic-offline"><CircleAlert size={17} /><span>{pendingCount} browser error{pendingCount === 1 ? " is" : "s are"} waiting for the local service to reconnect.</span></div>
          )}

          <section className="diagnostic-section">
            <h3>Uploads</h3>
            <div className="diagnostic-rows">
              {(data?.uploads ?? []).slice(0, 8).map((upload) => (
                <div className="diagnostic-row" key={upload.id}>
                  <span className={`status-dot status-${upload.status}`} />
                  <div><strong>{upload.filename}</strong><span>{formatFileSize(upload.receivedBytes)} of {formatFileSize(upload.sizeBytes)} · {upload.status.replaceAll("_", " ")}</span>{upload.message && <small>{upload.message}</small>}</div>
                  <time>{formatDiagnosticTime(upload.updatedAt)}</time>
                </div>
              ))}
              {!loading && (data?.uploads.length ?? 0) === 0 && <p className="diagnostic-empty">No upload sessions recorded.</p>}
            </div>
          </section>

          <section className="diagnostic-section">
            <h3>Import jobs</h3>
            <div className="diagnostic-rows">
              {(data?.importJobs ?? []).slice(0, 10).map((job) => (
                <div className="diagnostic-row" key={job.id}>
                  <span className={`status-dot status-${job.status}`} />
                  <div><strong>{job.sourceName}</strong><span>{job.status.replaceAll("_", " ")} · {job.phase} · {importProgressPercent(job)}% · {importEmailCountLabel(job)}</span>{job.message && <small>{job.message}</small>}</div>
                  <time>{formatDiagnosticTime(job.updatedAt)}</time>
                </div>
              ))}
              {!loading && (data?.importJobs.length ?? 0) === 0 && <p className="diagnostic-empty">No import jobs recorded.</p>}
            </div>
          </section>

          <section className="diagnostic-section">
            <h3>Gmail sync</h3>
            <div className="diagnostic-rows">
              {(data?.gmailConnections ?? []).map((connection) => (
                <div className="diagnostic-row" key={connection.id}>
                  <span className={`status-dot status-${connection.status}`} />
                  <div><strong>{connection.email}</strong><span>{connection.status} · {connection.processedItems.toLocaleString()} of {(connection.totalItems ?? 0).toLocaleString()} · {connection.importedItems.toLocaleString()} new</span>{connection.lastError && <small>{connection.lastError}</small>}</div>
                  <time>{formatDiagnosticTime(connection.updatedAt)}</time>
                </div>
              ))}
              {!loading && (data?.gmailConnections.length ?? 0) === 0 && <p className="diagnostic-empty">No Gmail connections recorded.</p>}
            </div>
          </section>

          <section className="diagnostic-section">
            <h3>AI analysis</h3>
            <div className="diagnostic-rows">
              {(data?.aiJobs ?? []).slice(0, 10).map((job) => (
                <div className="diagnostic-row" key={job.id}>
                  <span className={`status-dot status-${job.status}`} />
                  <div><strong>{job.status.replaceAll("_", " ")} · {job.model}</strong><span>Message {job.messageId} · attempt {job.attempts} of {job.maxAttempts}</span>{job.error && <small>{job.error}</small>}</div>
                  <time>{formatDiagnosticTime(job.updatedAt)}</time>
                </div>
              ))}
              {!loading && (data?.aiJobs.length ?? 0) === 0 && <p className="diagnostic-empty">No AI analysis jobs recorded.</p>}
            </div>
          </section>

          <section className="diagnostic-section diagnostic-events">
            <h3>Event log <span>{events.length}</span></h3>
            <div className="diagnostic-rows">
              {events.map((event) => (
                <details className={`diagnostic-event level-${event.level}`} key={event.id}>
                  <summary>
                    <span className={`event-level event-${event.level}`}>{event.level}</span>
                    <div><strong>{event.message}</strong><span>{event.category}{event.sourceName ? ` · ${event.sourceName}` : ""}</span></div>
                    <time>{formatDiagnosticTime(event.createdAt)}</time>
                  </summary>
                  <pre>{JSON.stringify({ jobId: event.jobId, archiveId: event.archiveId, context: event.context, stack: event.stack }, null, 2)}</pre>
                </details>
              ))}
              {!loading && events.length === 0 && <p className="diagnostic-empty">No events match this filter.</p>}
            </div>
          </section>
        </div>
        <footer className="dialog-footer">
          <div className="dialog-footer-group">
            <button className="secondary-button" onClick={onDownload}><Download size={17} /> Export JSON</button>
            <button className="danger-button" disabled={clearing} onClick={onClear}><Trash2 size={17} /> {clearing ? "Clearing..." : "Clear logs"}</button>
          </div>
          <button className="primary-button" onClick={onClose}>Close</button>
        </footer>
      </section>
    </div>
  );
}

interface FilterPanelProps {
  open: boolean;
  value: UiSearchFilters;
  folders: Folder[];
  currentFolderLabel: string;
  onChange(value: UiSearchFilters): void;
  onClose(): void;
}

export function FilterPanel({
  open,
  value,
  folders,
  currentFolderLabel,
  onChange,
  onClose
}: FilterPanelProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value, open]);
  if (!open) return null;
  return (
    <section className="filter-popover" role="dialog" aria-label="Search filters">
      <header>
        <div><Filter size={17} /><strong>Search filters</strong></div>
        <button className="icon-button subtle" onClick={onClose} title="Close filters" aria-label="Close filters"><X size={16} /></button>
      </header>
      <label>
        <span>Search in</span>
        <select
          value={draft.folderId}
          onChange={(event) => setDraft({ ...draft, folderId: event.target.value })}
          aria-label="Search in mailbox"
        >
          <option value="">Current view — {currentFolderLabel}</option>
          <option value={ALL_MAIL_SEARCH_SCOPE}>Entire archive</option>
          <optgroup label="Specific mailbox">
            {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
          </optgroup>
        </select>
      </label>
      <label><span>From</span><input value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} placeholder="name or address" /></label>
      <label><span>To or CC</span><input value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} placeholder="name or address" /></label>
      <div className="filter-date-grid">
        <label><span>After</span><input type="date" value={draft.after} onChange={(event) => setDraft({ ...draft, after: event.target.value })} /></label>
        <label><span>Before</span><input type="date" value={draft.before} onChange={(event) => setDraft({ ...draft, before: event.target.value })} /></label>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={draft.hasAttachment === true}
          onChange={(event) => setDraft({ ...draft, hasAttachment: event.target.checked ? true : undefined })}
        />
        <span>Has attachments</span>
      </label>
      <footer>
        <button className="text-button" onClick={() => {
          setDraft(EMPTY_FILTERS);
          onChange(EMPTY_FILTERS);
        }}>Clear</button>
        <button className="primary-button compact" onClick={() => {
          onChange(draft);
          onClose();
        }}>Apply</button>
      </footer>
    </section>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDiagnosticTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  });
}
