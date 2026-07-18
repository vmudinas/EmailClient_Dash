import {
  Archive as ArchiveIcon,
  ChevronRight,
  CircleAlert,
  Combine,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Inbox,
  LoaderCircle,
  MailCheck,
  Pause,
  Pencil,
  Play,
  Plus,
  Square,
  Star,
  Trash2
} from "lucide-react";
import type {
  Archive,
  Folder,
  ImportJob,
  MessageSummary
} from "@email-client/shared";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { formatBytes } from "../lib/format.js";
import {
  formatImportEta,
  importEmailCountLabel,
  importPhaseLabel,
  importProgressPercent,
  updateImportEta,
  type ImportEtaSample
} from "../lib/import-progress.js";

interface SidebarProps {
  archives: Archive[];
  folders: Folder[];
  jobs: ImportJob[];
  selectedArchiveId: string | null;
  selectedFolderId: string | null;
  selectedSmartMailbox: "starred" | null;
  readOnly: boolean;
  draggedMessage: MessageSummary | null;
  moveBusy: boolean;
  folderBusy: boolean;
  onSelectArchive(id: string): void;
  onSelectFolder(id: string | null): void;
  onSelectSmartMailbox(mailbox: "starred"): void;
  onImport(): void;
  onOpenGmail(): void;
  onCreateFolder(): void;
  onCombineArchive(archive: Archive): void;
  onCombineFolder(folder: Folder): void;
  onOrganizeFolder(source: Folder, target: Folder): void;
  onCancelJob(id: string): void;
  onResumeJob(id: string): void;
  onClearJob(id: string): void;
  onRemoveArchive(id: string): void;
  onRemoveFolder(folder: Folder): void;
  onRenameArchive(archive: Archive): void;
  onRenameFolder(folder: Folder): void;
  onMoveMessage(messageId: string, folderId: string): void;
  onOpenDiagnostics(): void;
}

export function Sidebar({
  archives,
  folders,
  jobs,
  selectedArchiveId,
  selectedFolderId,
  selectedSmartMailbox,
  readOnly,
  draggedMessage,
  moveBusy,
  folderBusy,
  onSelectArchive,
  onSelectFolder,
  onSelectSmartMailbox,
  onImport,
  onOpenGmail,
  onCreateFolder,
  onCombineArchive,
  onCombineFolder,
  onOrganizeFolder,
  onCancelJob,
  onResumeJob,
  onClearJob,
  onRemoveArchive,
  onRemoveFolder,
  onRenameArchive,
  onRenameFolder,
  onMoveMessage,
  onOpenDiagnostics
}: SidebarProps) {
  const selectedArchive = archives.find((archive) => archive.id === selectedArchiveId);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => loadCollapsedFolders());
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);
  const [draggedFolderId, setDraggedFolderId] = useState<string | null>(null);
  useEffect(() => { saveCollapsedFolders(collapsedFolderIds); }, [collapsedFolderIds]);
  const toggleFolderCollapsed = (folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  };
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Folder[]>();
    for (const folder of folders) {
      const key = folder.parentId;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(folder);
    }
    return map;
  }, [folders]);
  const renderFolders = (parentId: string | null, depth: number): ReactElement[] => (
    (childrenByParent.get(parentId) ?? []).flatMap((folder) => {
      const children = childrenByParent.get(folder.id) ?? [];
      const hasChildren = children.length > 0;
      const isCollapsed = collapsedFolderIds.has(folder.id);
      const canCombine = folders.some((candidate) => (
        candidate.id !== folder.id && !candidate.path.startsWith(`${folder.path}/`)
      ));
      const draggedFolder = draggedFolderId
        ? folders.find((candidate) => candidate.id === draggedFolderId) ?? null
        : null;
      const canDragFolder = !readOnly
        && !folderBusy
        && Boolean(selectedArchive && ["ready", "ready_with_errors"].includes(selectedArchive.status));
      const canDropFolder = canDragFolder
        && draggedFolder !== null
        && draggedFolder.id !== folder.id
        && draggedFolder.archiveId === folder.archiveId
        && !folder.path.startsWith(`${draggedFolder.path}/`);
      const canDropMessage = !readOnly
        && !moveBusy
        && draggedMessage?.archiveId === folder.archiveId
        && draggedMessage.folderId !== folder.id;
      const canDrop = canDropFolder || canDropMessage;
      const row = (
        <div className="folder-entry" key={folder.id}>
          <button
            className={`folder-row ${selectedFolderId === folder.id ? "selected" : ""} ${canDrop && dropFolderId === folder.id ? "drop-target" : ""}`}
            style={{ "--folder-depth": depth } as React.CSSProperties}
            draggable={canDragFolder}
            onClick={() => onSelectFolder(folder.id)}
            onDragStart={(event) => {
              if (!canDragFolder) return;
              setDraggedFolderId(folder.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("application/x-archive-mail-folder", folder.id);
            }}
            onDragEnd={() => {
              setDraggedFolderId(null);
              setDropFolderId(null);
            }}
            onDragEnter={(event) => {
              if (!canDrop) return;
              event.preventDefault();
              setDropFolderId(folder.id);
            }}
            onDragOver={(event) => {
              if (!canDrop) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropFolderId((current) => current === folder.id ? null : current);
              }
            }}
            onDrop={(event) => {
              if (!canDrop) return;
              event.preventDefault();
              setDropFolderId(null);
              if (canDropFolder && draggedFolder) {
                setDraggedFolderId(null);
                onOrganizeFolder(draggedFolder, folder);
                return;
              }
              if (canDropMessage && draggedMessage) onMoveMessage(draggedMessage.id, folder.id);
            }}
          >
            {hasChildren ? (
              <span
                className={`folder-toggle ${isCollapsed ? "collapsed" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={isCollapsed ? `Expand ${folder.name}` : `Collapse ${folder.name}`}
                onClick={(event) => { event.stopPropagation(); toggleFolderCollapsed(folder.id); }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  toggleFolderCollapsed(folder.id);
                }}
              ><ChevronRight size={13} /></span>
            ) : (
              <span className="folder-toggle-spacer" />
            )}
            {selectedFolderId === folder.id ? <FolderOpen size={16} /> : <FolderIcon size={16} />}
            <span title={folder.name}>{folder.name}</span>
            <span className="folder-counts" aria-label={`${folder.unreadCount.toLocaleString()} unread, ${folder.messageCount.toLocaleString()} total`}>
              <b>{folder.unreadCount.toLocaleString()}</b>
              <small>{folder.messageCount.toLocaleString()}</small>
            </span>
          </button>
          {!readOnly && selectedArchive?.status !== "importing" && (
            <span className="folder-actions">
              {canCombine && (
                <button className="icon-button folder-combine" onClick={() => onCombineFolder(folder)} title={`Combine mailbox ${folder.name}`} aria-label={`Combine mailbox ${folder.name}`}>
                  <Combine size={13} />
                </button>
              )}
              <button className="icon-button folder-rename" onClick={() => onRenameFolder(folder)} title={`Rename ${folder.name}`} aria-label={`Rename ${folder.name}`}>
                <Pencil size={13} />
              </button>
              <button className="icon-button folder-delete" onClick={() => onRemoveFolder(folder)} title={`Delete mailbox ${folder.name}`} aria-label={`Delete mailbox ${folder.name}`}>
                <Trash2 size={13} />
              </button>
            </span>
          )}
        </div>
      );
      return hasChildren && !isCollapsed ? [row, ...renderFolders(folder.id, depth + 1)] : [row];
    })
  );
  const visibleJobs = jobs.filter((job) => (
    job.status === "running"
    || job.status === "queued"
    || job.status === "paused"
    || job.status === "cancelled"
    || job.status === "failed"
    || job.status === "completed_with_errors"
  )).slice(0, 3);
  const etaByJob = useImportEtas(jobs);

  return (
    <aside className="sidebar" aria-label="Archives and folders">
      <div className="sidebar-scroll">
        <div className="section-heading">
          <span>Archives</span>
          {!readOnly && (
            <span className="section-actions">
              <button className="icon-button subtle" onClick={onOpenGmail} title="Pull mail from Gmail" aria-label="Pull mail from Gmail"><MailCheck size={16} /></button>
              <button className="icon-button subtle" onClick={onImport} title="Import archive" aria-label="Import archive"><Plus size={17} /></button>
            </span>
          )}
        </div>

        <div className="archive-list">
          {archives.map((archive) => (
            <div
              className={`archive-row ${archive.id === selectedArchiveId ? "selected" : ""}`}
              key={archive.id}
            >
              <button className="archive-select" onClick={() => onSelectArchive(archive.id)}>
                <span className="archive-icon"><ArchiveIcon size={17} /></span>
                <span className="archive-copy">
                  <span className="archive-name" title={archive.name}>{archive.name}</span>
                  <span className="archive-meta">
                    {archive.unreadCount.toLocaleString()} unread · {archive.messageCount.toLocaleString()} total · {archive.sourceType === "gmail" ? "Gmail" : formatBytes(archive.sizeBytes)}
                  </span>
                </span>
                <ChevronRight size={15} />
              </button>
              {!readOnly && (
                <span className="archive-actions">
                  {archives.length > 1 && archive.status !== "importing" && archive.status !== "failed" && (
                    <button
                      className="icon-button archive-combine"
                      title={`Combine ${archive.name}`}
                      aria-label={`Combine ${archive.name}`}
                      onClick={() => onCombineArchive(archive)}
                    >
                      <Combine size={14} />
                    </button>
                  )}
                  <button
                    className="icon-button archive-rename"
                    title={`Rename ${archive.name}`}
                    aria-label={`Rename ${archive.name}`}
                    onClick={() => onRenameArchive(archive)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="icon-button archive-delete"
                    title={`Remove ${archive.name}`}
                    aria-label={`Remove ${archive.name}`}
                    onClick={() => onRemoveArchive(archive.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              )}
            </div>
          ))}
          {archives.length === 0 && (
            <button className="empty-import" onClick={onImport} disabled={readOnly}>
              <ArchiveIcon size={20} />
              <span>{readOnly ? "No shared archives" : "Import PST or MBOX"}</span>
            </button>
          )}
        </div>

        {selectedArchive && (
          <>
            <div className="section-heading folder-heading">
              <span>Folders</span>
              <span className="section-actions">
                <span className="section-count">{selectedArchive.folderCount}</span>
                {!readOnly && selectedArchive.status !== "importing" && (
                  <button className="icon-button subtle" onClick={onCreateFolder} title="Create mailbox" aria-label="Create mailbox"><FolderPlus size={15} /></button>
                )}
              </span>
            </div>
            <nav className="folder-list" aria-label={`${selectedArchive.name} folders`}>
              <button
                className={`folder-row ${selectedFolderId === null && selectedSmartMailbox === null ? "selected" : ""}`}
                onClick={() => onSelectFolder(null)}
              >
                <span className="folder-toggle-spacer" />
                <Inbox size={16} />
                <span>All mail</span>
                <span className="folder-counts" aria-label={`${selectedArchive.unreadCount.toLocaleString()} unread, ${selectedArchive.messageCount.toLocaleString()} total`}>
                  <b>{selectedArchive.unreadCount.toLocaleString()}</b>
                  <small>{selectedArchive.messageCount.toLocaleString()}</small>
                </span>
              </button>
              <button
                className={`folder-row smart-folder-row ${selectedSmartMailbox === "starred" ? "selected" : ""}`}
                onClick={() => onSelectSmartMailbox("starred")}
              >
                <span className="folder-toggle-spacer" />
                <Star size={16} fill={selectedSmartMailbox === "starred" ? "currentColor" : "none"} />
                <span>Starred</span>
                <span
                  className="folder-counts"
                  aria-label={`${(selectedArchive.starredUnreadCount ?? 0).toLocaleString()} unread, ${(selectedArchive.starredCount ?? 0).toLocaleString()} total`}
                >
                  <b>{(selectedArchive.starredUnreadCount ?? 0).toLocaleString()}</b>
                  <small>{(selectedArchive.starredCount ?? 0).toLocaleString()}</small>
                </span>
              </button>
              {renderFolders(null, 0)}
            </nav>
          </>
        )}
      </div>

      {visibleJobs.length > 0 && !readOnly && (
        <div className="jobs-panel" aria-label="Import jobs">
          <div className="section-heading"><span>Imports</span><button className="icon-button subtle" onClick={onOpenDiagnostics} title="Open diagnostics" aria-label="Open diagnostics"><CircleAlert size={16} /></button></div>
          {visibleJobs.map((job) => (
            <div className="job-row" key={job.id}>
              <div className="job-status-icon">
                {job.status === "running" || job.status === "queued"
                  ? <LoaderCircle className="spin" size={16} />
                  : job.status === "failed"
                    ? <CircleAlert size={16} />
                    : <Pause size={16} />}
              </div>
              <div className="job-copy">
                <div className="job-title"><strong>{job.sourceName}</strong><b>{importProgressPercent(job)}%</b></div>
                <span className="job-phase">{importPhaseLabel(job)}</span>
                <div className="progress-track" role="progressbar" aria-label={`${job.sourceName} import progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={importProgressPercent(job)}>
                  <div
                    className="progress-fill"
                    style={{ width: `${importProgressPercent(job)}%` }}
                  />
                </div>
                <span className="job-count">{importEmailCountLabel(job)}</span>
                <span className="job-eta">{job.status === "running"
                  ? formatImportEta(etaByJob.get(job.id) ?? null)
                  : job.message || importPhaseLabel(job)}</span>
              </div>
              <span className="job-actions">
                {(job.status === "running" || job.status === "queued") ? (
                  <button className="icon-button subtle" onClick={() => onCancelJob(job.id)} title="Stop import" aria-label="Stop import">
                    <Square size={14} />
                  </button>
                ) : (
                  <>
                    {job.canResume && (
                      <button className="icon-button subtle" onClick={() => onResumeJob(job.id)} title="Restart import from checkpoint" aria-label="Restart import from checkpoint">
                        <Play size={15} />
                      </button>
                    )}
                    <button className="icon-button subtle" onClick={() => onClearJob(job.id)} title="Clear import" aria-label="Clear import">
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

const COLLAPSED_FOLDERS_STORAGE_KEY = "archive-mail-collapsed-folders";

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedFolders(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_FOLDERS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Private browsing / storage quota — expand/collapse state just won't persist.
  }
}

function useImportEtas(jobs: ImportJob[]): Map<string, number | null> {
  const samples = useRef(new Map<string, ImportEtaSample>());
  const [estimates, setEstimates] = useState(new Map<string, number | null>());

  useEffect(() => {
    const nextEstimates = new Map<string, number | null>();
    const activeIds = new Set(jobs.map((job) => job.id));
    for (const id of samples.current.keys()) {
      if (!activeIds.has(id)) samples.current.delete(id);
    }
    for (const job of jobs) {
      const update = updateImportEta(samples.current.get(job.id), job);
      samples.current.set(job.id, update.sample);
      nextEstimates.set(job.id, update.secondsRemaining);
    }
    setEstimates(nextEstimates);
  }, [jobs]);

  return estimates;
}
