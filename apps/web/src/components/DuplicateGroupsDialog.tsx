import { useState } from "react";
import { Archive, CheckCheck, ChevronDown, ChevronRight, Copy, FolderInput, LoaderCircle, RefreshCw, ScanSearch, Split, Star, Trash2, X } from "lucide-react";
import type { Archive as ArchiveModel, DuplicateDetectionTier, DuplicateGroup, DuplicateGroupDetail, DuplicateGroupList, DuplicateReviewStatus, DuplicateScan, Folder } from "@email-client/shared";
import { isDuplicateScanActive } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface DuplicateGroupsDialogProps {
  open: boolean;
  list: DuplicateGroupList | null;
  status: DuplicateReviewStatus;
  expanded: DuplicateGroupDetail | null;
  expandedId: string | null;
  loading: boolean;
  scan: DuplicateScan | null;
  scanStarting: boolean;
  busyGroupId: string | null;
  readOnly: boolean;
  archives: Pick<ArchiveModel, "id" | "name">[];
  onClose(): void;
  onRefresh(): void;
  onScan(): void;
  onCancelScan(): void;
  onChangeStatus(status: DuplicateReviewStatus): void;
  onToggleGroup(group: DuplicateGroup): void;
  onConfirm(group: DuplicateGroup): void;
  onDismiss(group: DuplicateGroup): void;
  onSetPreferred(group: DuplicateGroup, messageId: string): void;
  onOpenMessage(messageId: string): void;
  onLoadFolders(archiveId: string): Promise<Folder[]>;
  onMoveCopies(detail: DuplicateGroupDetail, request: DuplicateMoveRequest): Promise<boolean>;
}

export type DuplicateMoveRequest =
  | { destination: "archived" | "trash" }
  | {
    destination: "folder";
    createRules: boolean;
    targets: Array<{ archiveId: string; folderId: string; folderPath: string }>;
  };

const TIER_LABELS: Record<DuplicateDetectionTier, string> = {
  exact_id: "Identical Message-ID",
  raw_hash: "Identical raw bytes",
  content_hash: "Identical content",
  near_duplicate: "Near-duplicate"
};

const PHASE_LABELS: Record<DuplicateScan["phase"], string> = {
  queued: "Waiting for a worker",
  fingerprinting: "Fingerprinting messages",
  matching: "Comparing messages",
  grouping: "Grouping copies",
  done: "Finishing"
};

export function DuplicateGroupsDialog({
  open,
  list,
  status,
  expanded,
  expandedId,
  loading,
  scan,
  scanStarting,
  busyGroupId,
  readOnly,
  archives,
  onClose,
  onRefresh,
  onScan,
  onCancelScan,
  onChangeStatus,
  onToggleGroup,
  onConfirm,
  onDismiss,
  onSetPreferred,
  onOpenMessage,
  onLoadFolders,
  onMoveCopies
}: DuplicateGroupsDialogProps) {
  const [folderEditorGroupId, setFolderEditorGroupId] = useState<string | null>(null);
  const [folderOptions, setFolderOptions] = useState<Record<string, Folder[]>>({});
  const [folderTargets, setFolderTargets] = useState<Record<string, string>>({});
  const [folderLoading, setFolderLoading] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [createRules, setCreateRules] = useState(false);
  if (!open) return null;
  const groups = list?.groups ?? [];
  const duplicateMessages = groups.reduce((total, group) => total + Math.max(0, group.memberCount - 1), 0);
  const scanning = isDuplicateScanActive(scan);
  const busy = scanning || scanStarting;

  const openFolderEditor = async (detail: DuplicateGroupDetail) => {
    const archiveIds = duplicateArchiveIds(detail);
    setFolderEditorGroupId(detail.group.id);
    setFolderOptions({});
    setFolderTargets({});
    setCreateRules(false);
    setFolderError("");
    setFolderLoading(true);
    try {
      const loaded = await Promise.all(archiveIds.map(async (archiveId) => [archiveId, await onLoadFolders(archiveId)] as const));
      setFolderOptions(Object.fromEntries(loaded));
    } catch (error) {
      setFolderError(error instanceof Error ? error.message : "Folders could not be loaded");
    } finally {
      setFolderLoading(false);
    }
  };

  const submitFolderMove = async (detail: DuplicateGroupDetail) => {
    const archiveIds = duplicateArchiveIds(detail);
    const targets = archiveIds.flatMap((archiveId) => {
      const folderId = folderTargets[archiveId];
      const folder = folderOptions[archiveId]?.find((item) => item.id === folderId);
      return folder ? [{ archiveId, folderId: folder.id, folderPath: folder.path }] : [];
    });
    if (targets.length !== archiveIds.length) {
      setFolderError("Choose a destination folder for every archive containing duplicate copies.");
      return;
    }
    setFolderError("");
    if (await onMoveCopies(detail, { destination: "folder", createRules, targets })) {
      setFolderEditorGroupId(null);
    }
  };

  return (
    // The dialog closes during a scan. The scan is a background job now, so holding the user here
    // bought nothing - it only meant a scan they started locked them out of their own mail.
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog duplicates-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicates-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div><Copy size={20} /><h2 id="duplicates-title">Duplicate messages</h2></div>
          <div className="dialog-header-actions">
            {!readOnly && (scanning ? (
              <button className="secondary-button" onClick={onCancelScan} title="Stop the running scan">
                <X size={15} /><span>Stop scan</span>
              </button>
            ) : (
              <button className="secondary-button" disabled={loading || scanStarting} onClick={onScan} title="Scan the archive for duplicates">
                {scanStarting ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}
                <span>Scan now</span>
              </button>
            ))}
            <button className="icon-button" disabled={loading} onClick={onRefresh} title="Refresh" aria-label="Refresh duplicate groups">
              <RefreshCw className={loading ? "spin" : ""} size={17} />
            </button>
            <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body duplicates-body">
          <div className="duplicates-overview" aria-label="Duplicate summary">
            <Metric value={groups.length} label="Groups" />
            <Metric value={duplicateMessages} label="Extra copies" tone={duplicateMessages > 0 ? "urgent" : "neutral"} />
            <Metric value={list?.totalPending ?? 0} label="Pending" tone="draft" />
          </div>

          <div className="duplicates-tabs" role="tablist" aria-label="Duplicate review status">
            {(["pending", "confirmed"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={status === value}
                className={status === value ? "active" : ""}
                disabled={loading}
                onClick={() => onChangeStatus(value)}
              >
                {value === "pending" ? "Needs review" : "Confirmed"}
              </button>
            ))}
          </div>

          {busy && <ScanProgress scan={scan} />}
          {!busy && scan?.status === "failed" && (
            <p className="duplicates-scan-failed" role="status">The last scan failed: {scan.message}</p>
          )}
          {!busy && scan?.status === "completed" && scan.skippedMessages > 0 && (
            <p className="duplicates-note" role="status">
              {scan.scannedMessages.toLocaleString()} messages were compared for near-duplicates and{" "}
              {scan.skippedMessages.toLocaleString()} were past that limit — those were still checked for
              identical copies.
            </p>
          )}

          <p className="duplicates-note">
            Detected locally with content fingerprints — no AI and no API cost. Reviewing alone never
            deletes mail, and filing actions always keep the preferred copy.
          </p>

          {loading && !list ? (
            <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading duplicate groups</div>
          ) : groups.length === 0 ? (
            <div className="review-queue-empty">
              <CheckCheck size={30} />
              <strong>{status === "pending" ? "No duplicates to review" : "Nothing confirmed yet"}</strong>
              <span>
                {status === "pending"
                  ? "Run a scan after importing an archive to look for duplicate copies."
                  : "Groups you confirm as duplicates will appear here."}
              </span>
            </div>
          ) : (
            <div className="duplicates-list">
              {groups.map((group) => {
                const isOpen = expandedId === group.id;
                const busy = busyGroupId === group.id;
                return (
                  <article key={group.id} className={`duplicate-group ${isOpen ? "open" : ""}`}>
                    <button
                      className="duplicate-group-summary"
                      aria-expanded={isOpen}
                      onClick={() => onToggleGroup(group)}
                    >
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      <div className="duplicate-group-copy">
                        <div className="duplicate-group-heading">
                          <strong>{group.memberCount} copies</strong>
                          <span className={`duplicate-tier tier-${group.detectionTier}`}>{TIER_LABELS[group.detectionTier]}</span>
                        </div>
                        <small>
                          {Math.round(group.confidence * 100)}% confidence · updated {formatDateTime(group.updatedAt)}
                        </small>
                      </div>
                    </button>

                    {isOpen && (
                      <div className="duplicate-group-detail">
                        {!expanded || expanded.group.id !== group.id ? (
                          <div className="settings-loading"><LoaderCircle className="spin" size={16} /> Loading copies</div>
                        ) : (
                          <>
                            <ul className="duplicate-member-list">
                              {expanded.members.map((member) => {
                                const preferred = expanded.group.preferredMessageId === member.message.id;
                                return (
                                  <li key={member.message.id} className={preferred ? "preferred" : ""}>
                                    <button
                                      className="duplicate-member-main"
                                      onClick={() => onOpenMessage(member.message.id)}
                                      title="Open this copy"
                                    >
                                      <div className="duplicate-member-copy">
                                        <div className="duplicate-member-heading">
                                          <strong>{member.message.subject || "(No subject)"}</strong>
                                          {preferred && <span className="duplicate-preferred-badge"><Star size={11} /> Preferred</span>}
                                        </div>
                                        <small>
                                          {displayAddress(member.message.sender)} ·{" "}
                                          {formatDateTime(member.message.receivedAt ?? member.message.sentAt)}
                                        </small>
                                        {member.evidence.length > 0 && (
                                          <div className="duplicate-evidence">
                                            {member.evidence.map((reason) => <span key={reason}>{reason}</span>)}
                                          </div>
                                        )}
                                      </div>
                                    </button>
                                    {!readOnly && !preferred && (
                                      <button
                                        className="icon-button duplicate-prefer-button"
                                        disabled={busy}
                                        onClick={() => onSetPreferred(group, member.message.id)}
                                        title="Keep this copy as the preferred one"
                                        aria-label={`Prefer ${member.message.subject || "(No subject)"}`}
                                      >
                                        <Star size={15} />
                                      </button>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>

                            {!readOnly && (
                              <div className="duplicate-actions-wrap">
                                <div className="duplicate-group-actions">
                                  {group.reviewStatus !== "confirmed" && (
                                    <button className="primary-button" disabled={busy} onClick={() => onConfirm(group)}>
                                      {busy ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />}
                                      <span>Mark duplicate</span>
                                    </button>
                                  )}
                                  <button className="secondary-button" disabled={busy} onClick={() => onMoveCopies(expanded, { destination: "archived" })}>
                                    <Archive size={15} /><span>Archive copies</span>
                                  </button>
                                  <button className="secondary-button danger" disabled={busy} onClick={() => onMoveCopies(expanded, { destination: "trash" })}>
                                    <Trash2 size={15} /><span>Trash copies</span>
                                  </button>
                                  <button className="secondary-button" disabled={busy || folderLoading} onClick={() => void openFolderEditor(expanded)}>
                                    <FolderInput size={15} /><span>Move to folder</span>
                                  </button>
                                  <button className="secondary-button" disabled={busy} onClick={() => onDismiss(group)}>
                                    <Split size={15} /><span>Keep separate</span>
                                  </button>
                                </div>

                                {folderEditorGroupId === group.id && (
                                  <div className="duplicate-folder-editor">
                                    <div className="duplicate-folder-editor-heading">
                                      <div>
                                        <strong>Move {duplicateCopyCount(expanded)} extra {duplicateCopyCount(expanded) === 1 ? "copy" : "copies"}</strong>
                                        <small>The preferred copy stays where it is.</small>
                                      </div>
                                      <button className="icon-button" disabled={busy} onClick={() => setFolderEditorGroupId(null)} aria-label="Close folder choices">
                                        <X size={16} />
                                      </button>
                                    </div>

                                    {folderLoading ? (
                                      <div className="settings-loading"><LoaderCircle className="spin" size={16} /> Loading folders</div>
                                    ) : (
                                      <div className="duplicate-folder-targets">
                                        {duplicateArchiveIds(expanded).map((archiveId) => (
                                          <label key={archiveId}>
                                            <span>{archives.find((archive) => archive.id === archiveId)?.name ?? "Mail archive"}</span>
                                            <select
                                              aria-label={`Destination folder for ${archives.find((archive) => archive.id === archiveId)?.name ?? "mail archive"}`}
                                              value={folderTargets[archiveId] ?? ""}
                                              onChange={(event) => setFolderTargets((current) => ({ ...current, [archiveId]: event.target.value }))}
                                            >
                                              <option value="">Choose folder</option>
                                              {(folderOptions[archiveId] ?? []).map((folder) => (
                                                <option key={folder.id} value={folder.id}>{folder.path}</option>
                                              ))}
                                            </select>
                                          </label>
                                        ))}
                                      </div>
                                    )}

                                    <label className="duplicate-rule-option">
                                      <input
                                        type="checkbox"
                                        checked={createRules}
                                        disabled={busy || folderLoading}
                                        onChange={(event) => setCreateRules(event.target.checked)}
                                      />
                                      <span>
                                        <strong>Create future sender rules</strong>
                                        <small>New Inbox mail from these senders will go to the selected folder. Existing mail is not affected.</small>
                                      </span>
                                    </label>
                                    {folderError && <p className="duplicate-folder-error" role="alert">{folderError}</p>}
                                    <div className="duplicate-folder-editor-actions">
                                      <button className="secondary-button" disabled={busy} onClick={() => setFolderEditorGroupId(null)}>Cancel</button>
                                      <button className="primary-button" disabled={busy || folderLoading} onClick={() => void submitFolderMove(expanded)}>
                                        {busy ? <LoaderCircle className="spin" size={15} /> : <FolderInput size={15} />}
                                        <span>Move copies</span>
                                      </button>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function duplicateMembers(detail: DuplicateGroupDetail) {
  const preferredId = detail.group.preferredMessageId ?? detail.members[0]?.message.id;
  return detail.members.filter((member) => member.message.id !== preferredId);
}

function duplicateArchiveIds(detail: DuplicateGroupDetail) {
  return [...new Set(duplicateMembers(detail).map((member) => member.message.archiveId))];
}

function duplicateCopyCount(detail: DuplicateGroupDetail) {
  return duplicateMembers(detail).length;
}

function Metric({ value, label, tone = "neutral" }: { value: number; label: string; tone?: string }) {
  return <div className={`review-queue-metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

/**
 * Fingerprinting is the only phase with a countable total, so the bar is determinate there and
 * indeterminate afterwards rather than inventing a percentage for the matching passes.
 */
function ScanProgress({ scan }: { scan: DuplicateScan | null }) {
  const total = scan?.totalItems ?? 0;
  const determinate = scan?.phase === "fingerprinting" && total > 0;
  const percent = determinate ? Math.min(100, Math.round((scan!.processedItems / total) * 100)) : null;
  return (
    <div className="duplicates-scan-progress" role="status" aria-live="polite">
      <div className="duplicates-scan-heading">
        <LoaderCircle className="spin" size={15} />
        <span>{scan ? PHASE_LABELS[scan.phase] : "Starting scan"}</span>
        {percent !== null && <strong>{percent}%</strong>}
      </div>
      <div
        className={`duplicates-scan-bar ${determinate ? "" : "indeterminate"}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={determinate ? 100 : undefined}
        aria-valuenow={percent ?? undefined}
      >
        <span style={determinate ? { width: `${percent}%` } : undefined} />
      </div>
      <small>You can close this and keep working — the scan runs in the background.</small>
    </div>
  );
}
