import { CheckCheck, ChevronDown, ChevronRight, Copy, LoaderCircle, RefreshCw, ScanSearch, Split, Star, X } from "lucide-react";
import type { DuplicateDetectionTier, DuplicateGroup, DuplicateGroupDetail, DuplicateGroupList, DuplicateReviewStatus } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface DuplicateGroupsDialogProps {
  open: boolean;
  list: DuplicateGroupList | null;
  status: DuplicateReviewStatus;
  expanded: DuplicateGroupDetail | null;
  expandedId: string | null;
  loading: boolean;
  scanning: boolean;
  busyGroupId: string | null;
  readOnly: boolean;
  onClose(): void;
  onRefresh(): void;
  onScan(): void;
  onChangeStatus(status: DuplicateReviewStatus): void;
  onToggleGroup(group: DuplicateGroup): void;
  onConfirm(group: DuplicateGroup): void;
  onDismiss(group: DuplicateGroup): void;
  onSetPreferred(group: DuplicateGroup, messageId: string): void;
  onOpenMessage(messageId: string): void;
}

const TIER_LABELS: Record<DuplicateDetectionTier, string> = {
  exact_id: "Identical Message-ID",
  raw_hash: "Identical raw bytes",
  content_hash: "Identical content",
  near_duplicate: "Near-duplicate"
};

export function DuplicateGroupsDialog({
  open,
  list,
  status,
  expanded,
  expandedId,
  loading,
  scanning,
  busyGroupId,
  readOnly,
  onClose,
  onRefresh,
  onScan,
  onChangeStatus,
  onToggleGroup,
  onConfirm,
  onDismiss,
  onSetPreferred,
  onOpenMessage
}: DuplicateGroupsDialogProps) {
  if (!open) return null;
  const groups = list?.groups ?? [];
  const duplicateMessages = groups.reduce((total, group) => total + Math.max(0, group.memberCount - 1), 0);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!scanning) onClose(); }}>
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
            {!readOnly && (
              <button className="secondary-button" disabled={loading || scanning} onClick={onScan} title="Scan the archive for duplicates">
                {scanning ? <LoaderCircle className="spin" size={15} /> : <ScanSearch size={15} />}
                <span>{scanning ? "Scanning" : "Scan now"}</span>
              </button>
            )}
            <button className="icon-button" disabled={loading || scanning} onClick={onRefresh} title="Refresh" aria-label="Refresh duplicate groups">
              <RefreshCw className={loading ? "spin" : ""} size={17} />
            </button>
            <button className="icon-button" disabled={scanning} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
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
                disabled={loading || scanning}
                onClick={() => onChangeStatus(value)}
              >
                {value === "pending" ? "Needs review" : "Confirmed"}
              </button>
            ))}
          </div>

          <p className="duplicates-note">
            Detected locally with content fingerprints — no AI and no API cost. Nothing is ever deleted:
            confirming only collapses copies behind the preferred one.
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
                              <div className="duplicate-group-actions">
                                {group.reviewStatus !== "confirmed" && (
                                  <button className="primary-button" disabled={busy} onClick={() => onConfirm(group)}>
                                    {busy ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />}
                                    <span>Mark duplicate</span>
                                  </button>
                                )}
                                <button className="secondary-button" disabled={busy} onClick={() => onDismiss(group)}>
                                  <Split size={15} /><span>Keep separate</span>
                                </button>
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

function Metric({ value, label, tone = "neutral" }: { value: number; label: string; tone?: string }) {
  return <div className={`review-queue-metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}
