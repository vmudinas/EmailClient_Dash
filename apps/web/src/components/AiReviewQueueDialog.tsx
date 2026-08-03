import { Archive, ArrowRight, BellRing, BrainCircuit, CalendarPlus, Check, CheckCheck, FileEdit, FolderInput, ListTodo, LoaderCircle, MailPlus, RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AiFilingProposal, AiReviewAnalysisItem, AiReviewQueue, EmailDraft, MessageFollowUp, MessageSummary } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface AiReviewQueueDialogProps {
  open: boolean;
  queue: AiReviewQueue | null;
  loading: boolean;
  busyItemId: string | null;
  reviewAllBusy: boolean;
  bulkBusy: boolean;
  filingProposals: AiFilingProposal[];
  proposalsLoading: boolean;
  proposalBusyId: string | null;
  planningAction: { messageId: string; action: "calendar_event" | "todo" } | null;
  readOnly: boolean;
  onClose(): void;
  onRefresh(): void;
  onOpenDraft(draft: EmailDraft): void;
  onDeleteDraft(draft: EmailDraft): void;
  onOpenMessage(message: Pick<MessageSummary, "id">): void;
  onCreateAction(item: AiReviewAnalysisItem, action: "calendar_event" | "todo"): void;
  onCreateDraft(item: AiReviewAnalysisItem): void;
  onReviewAndArchive(items: AiReviewAnalysisItem[]): void;
  onDeleteAnalyses(items: AiReviewAnalysisItem[]): void;
  onMoveAnalyses(items: AiReviewAnalysisItem[], folderId: string): void;
  onAiFileAnalyses(items: AiReviewAnalysisItem[]): void;
  onGenerateFilingProposals(items: AiReviewAnalysisItem[]): void;
  onApproveFilingProposal(proposal: AiFilingProposal): void;
  onDeclineFilingProposal(proposal: AiFilingProposal): void;
  onMarkAnalysisReviewed(item: AiReviewAnalysisItem): void;
  onMarkAllAnalysesReviewed(): void;
  onCompleteFollowUp(followUp: MessageFollowUp): void;
}

export function AiReviewQueueDialog({
  open,
  queue,
  loading,
  busyItemId,
  reviewAllBusy,
  bulkBusy,
  filingProposals,
  proposalsLoading,
  proposalBusyId,
  planningAction,
  readOnly,
  onClose,
  onRefresh,
  onOpenDraft,
  onDeleteDraft,
  onOpenMessage,
  onCreateAction,
  onCreateDraft,
  onReviewAndArchive,
  onDeleteAnalyses,
  onMoveAnalyses,
  onAiFileAnalyses,
  onGenerateFilingProposals,
  onApproveFilingProposal,
  onDeclineFilingProposal,
  onMarkAnalysisReviewed,
  onMarkAllAnalysesReviewed,
  onCompleteFollowUp
}: AiReviewQueueDialogProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const analyses = queue?.analyses ?? [];
  useEffect(() => {
    const availableIds = new Set((queue?.analyses ?? []).map((item) => item.message.id));
    setSelectedIds((current) => new Set([...current].filter((id) => availableIds.has(id))));
  }, [queue]);
  const selectedItems = useMemo(
    () => analyses.filter((item) => selectedIds.has(item.message.id)),
    [analyses, selectedIds]
  );
  const selectedArchiveIds = new Set(selectedItems.map((item) => item.message.archiveId));
  const bulkFolders = selectedArchiveIds.size === 1
    ? (queue?.folders ?? []).filter((folder) => folder.archiveId === selectedItems[0]?.message.archiveId)
    : [];
  const allSelected = analyses.length > 0 && selectedIds.size === analyses.length;
  const actionsDisabled = loading || reviewAllBusy || bulkBusy;
  const sortedDrafts = useMemo(
    () => [...(queue?.drafts ?? [])].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt)),
    [queue?.drafts]
  );
  const attentionGroups = useMemo(() => groupAnalyses(queue?.analyses ?? []), [queue?.analyses]);
  const followUpGroups = useMemo(() => groupFollowUps(queue?.followUps ?? []), [queue?.followUps]);
  const priorityCount = useMemo(
    () => (queue?.analyses ?? []).filter(({ analysis }) => analysis.priority === "urgent" || analysis.priority === "high").length,
    [queue?.analyses]
  );
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!reviewAllBusy && !bulkBusy) onClose(); }}>
      <section className="dialog ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><BrainCircuit size={20} /><h2 id="ai-review-title">AI review queue</h2></div>
          <div className="dialog-header-actions">
            {!readOnly && Boolean(queue?.analyses.length) && (
              <button className="secondary-button review-all-button" disabled={actionsDisabled} onClick={onMarkAllAnalysesReviewed} title="Set every Needs attention message as reviewed" aria-label="Set all reviewed">
                {reviewAllBusy ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />} <span>Set all reviewed</span>
              </button>
            )}
            <button className="icon-button" disabled={actionsDisabled} onClick={onRefresh} title="Refresh" aria-label="Refresh review queue"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
            <button className="icon-button" disabled={reviewAllBusy || bulkBusy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body ai-review-body">
          {loading && !queue ? <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading review work</div> : queue?.totalItems ? (
            <>
              <div className="review-queue-overview" aria-label="AI review queue summary">
                <QueueMetric value={queue.totalItems} label="Total" />
                <QueueMetric value={priorityCount} label="Priority" tone={priorityCount > 0 ? "urgent" : "neutral"} />
                <QueueMetric value={queue.drafts.length} label="Drafts" tone="draft" />
                <QueueMetric value={queue.followUps.length} label="Follow-ups" tone="follow-up" />
              </div>
              <ReviewSection icon={<BrainCircuit size={17} />} title="Needs attention" detail="Grouped by urgency · newest first" count={queue.analyses.length}>
                {!readOnly && (
                  <div className="review-bulk-bar" aria-label="Selected message actions">
                    <label className="review-select-all">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={() => setSelectedIds(allSelected ? new Set() : new Set(analyses.map((item) => item.message.id)))}
                        disabled={actionsDisabled}
                      />
                      <span>{selectedItems.length ? `${selectedItems.length} selected` : "Select all"}</span>
                    </label>
                    <div className="review-bulk-actions">
                      <button className="review-bulk-button archive" disabled={actionsDisabled || selectedItems.length === 0} onClick={() => onReviewAndArchive(selectedItems)}>
                        {bulkBusy ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />} Review &amp; archive
                      </button>
                      <button className="review-bulk-button ai" disabled={actionsDisabled || selectedItems.length === 0 || selectedArchiveIds.size !== 1} onClick={() => onAiFileAnalyses(selectedItems)}>
                        <Sparkles size={15} /> AI file
                      </button>
                      <button className="review-bulk-button propose" disabled={actionsDisabled || proposalsLoading || analyses.length === 0} onClick={() => onGenerateFilingProposals(selectedItems.length ? selectedItems : analyses)}>
                        {proposalsLoading ? <LoaderCircle className="spin" size={15} /> : <BrainCircuit size={15} />} Recategorize with AI
                      </button>
                      <select
                        aria-label="Move selected messages to folder"
                        value=""
                        disabled={actionsDisabled || selectedItems.length === 0 || selectedArchiveIds.size !== 1}
                        onChange={(event) => { if (event.target.value) onMoveAnalyses(selectedItems, event.target.value); }}
                      >
                        <option value="">Move to folder…</option>
                        {bulkFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
                      </select>
                      <button className="review-bulk-button delete" disabled={actionsDisabled || selectedItems.length === 0} onClick={() => onDeleteAnalyses(selectedItems)}>
                        <Trash2 size={15} /> Delete
                      </button>
                    </div>
                    {selectedItems.length > 1 && selectedArchiveIds.size > 1 && <small>Choose messages from one archive to move them to a specific folder.</small>}
                  </div>
                )}
                {filingProposals.length > 0 && (
                  <section className="review-proposal-panel" aria-labelledby="filing-proposals-title">
                    <header>
                      <div><Sparkles size={16} /><div><h4 id="filing-proposals-title">AI recategorization proposals</h4><small>Nothing moves until you approve it.</small></div></div>
                      <span>{filingProposals.length}</span>
                    </header>
                    <div className="review-proposal-list">
                      {filingProposals.map((proposal) => (
                        <article key={proposal.id} className="review-proposal-card">
                          <div className="review-proposal-copy">
                            <strong>{proposal.subject}</strong>
                            <small>{displayAddress(proposal.sender)}</small>
                            <div className="review-proposal-route"><span>{proposal.currentFolderPath}</span><ArrowRight size={14} /><span>{proposal.proposedFolderPath}</span><em>{Math.round(proposal.confidence * 100)}%</em></div>
                            <p>{proposal.reason}</p>
                          </div>
                          <div className="review-proposal-actions">
                            <button className="review-proposal-approve" disabled={actionsDisabled || proposalBusyId === proposal.id} onClick={() => onApproveFilingProposal(proposal)}>{proposalBusyId === proposal.id ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Approve</button>
                            <button className="review-proposal-decline" disabled={actionsDisabled || proposalBusyId === proposal.id} onClick={() => onDeclineFilingProposal(proposal)}><X size={14} /> Decline</button>
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                )}
                <div className="review-queue-groups">
                  {attentionGroups.map((group) => (
                    <ReviewGroup key={group.id} title={group.title} count={group.items.length} tone={group.id}>
                      {group.items.map((item) => (
                        <div key={item.message.id} className={`review-queue-item attention priority-${item.analysis.priority} ${selectedIds.has(item.message.id) ? "selected" : ""}`}>
                          {!readOnly && <label className="review-item-selector"><input type="checkbox" checked={selectedIds.has(item.message.id)} disabled={actionsDisabled || busyItemId === item.message.id} onChange={() => setSelectedIds(toggleSelection(selectedIds, item.message.id))} aria-label={`Select ${item.message.subject}`} /></label>}
                          <div className="review-attention-content">
                            <div className="review-attention-top">
                              <button data-testid="attention-message" className="review-item-main" disabled={busyItemId === item.message.id || bulkBusy} onClick={() => onOpenMessage(item.message)}>
                                <div className="review-item-copy">
                                  <div className="review-item-heading"><strong>{item.message.subject}</strong><span className={`ai-priority priority-${item.analysis.priority}`}>{item.analysis.priority}</span></div>
                                  <small>{displayAddress(item.message.sender)} · {formatDateTime(item.message.receivedAt ?? item.message.sentAt ?? item.analysis.updatedAt)}</small>
                                  <span className="review-item-action-summary">{item.analysis.actionSummary || item.analysis.summary}</span>
                                  <div className="review-item-tags">
                                    {item.analysis.categories.slice(0, 2).map((category) => <span key={category}>{category}</span>)}
                                    {item.analysis.draftRecommended && <span>Reply suggested</span>}
                                  </div>
                                </div>
                              </button>
                              {!readOnly && (
                                <div className="review-item-actions">
                                  <button className="review-quick-action draft" disabled={actionsDisabled || busyItemId === item.message.id} onClick={() => onCreateDraft(item)} title="Create a reply draft" aria-label={`Create draft for ${item.message.subject}`}><MailPlus size={15} /><span>Draft</span></button>
                                  <button className="review-quick-action event" disabled={actionsDisabled || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onCreateAction(item, "calendar_event")} title="Create calendar event" aria-label={`Create event for ${item.message.subject}`}>
                                    {planningAction?.messageId === item.message.id && planningAction.action === "calendar_event" ? <LoaderCircle className="spin" size={15} /> : <CalendarPlus size={15} />}<span>Event</span>
                                  </button>
                                  <button className="review-quick-action todo" disabled={actionsDisabled || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onCreateAction(item, "todo")} title="Create to-do" aria-label={`Create to-do for ${item.message.subject}`}>
                                    {planningAction?.messageId === item.message.id && planningAction.action === "todo" ? <LoaderCircle className="spin" size={15} /> : <ListTodo size={15} />}<span>To-do</span>
                                  </button>
                                  <button className="review-mark-button" disabled={actionsDisabled || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onMarkAnalysisReviewed(item)} title="Mark reviewed" aria-label={`Mark ${item.message.subject} reviewed`}>
                                    {busyItemId === item.message.id ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />}<span>Reviewed</span>
                                  </button>
                                  <button className="review-archive-button" disabled={actionsDisabled || busyItemId === item.message.id} onClick={() => onReviewAndArchive([item])} title="Mark reviewed and archive" aria-label={`Mark ${item.message.subject} reviewed and archive`}><Archive size={15} /><span>Archive</span></button>
                                </div>
                              )}
                            </div>
                            {!readOnly && (
                              <div className="review-filing-row">
                                <span><Sparkles size={13} /> AI folders</span>
                                {(item.filingSuggestions ?? []).length ? item.filingSuggestions!.map((suggestion, index) => (
                                  <button key={suggestion.folderId} disabled={actionsDisabled || busyItemId === item.message.id} onClick={() => onMoveAnalyses([item], suggestion.folderId)} title={`${suggestion.reason} ${Math.round(suggestion.confidence * 100)}% confidence`}>
                                    {index === 0 && <Sparkles size={12} />}{suggestion.folderPath}<small>{Math.round(suggestion.confidence * 100)}%</small>
                                  </button>
                                )) : <small>No filing history yet</small>}
                                <label className="review-folder-picker"><FolderInput size={13} /><span className="visually-hidden">Move {item.message.subject} to folder</span><select value="" disabled={actionsDisabled || busyItemId === item.message.id} onChange={(event) => { if (event.target.value) onMoveAnalyses([item], event.target.value); }} aria-label={`Move ${item.message.subject} to folder`}><option value="">Choose folder…</option>{(queue.folders ?? []).filter((folder) => folder.archiveId === item.message.archiveId && folder.id !== item.message.folderId).map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select></label>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </ReviewGroup>
                  ))}
                </div>
              </ReviewSection>
              <ReviewSection icon={<FileEdit size={17} />} title="Drafts to review" detail="Newest first" count={queue.drafts.length}>
                <div className="review-queue-list">
                  {sortedDrafts.map((draft) => (
                    <div key={draft.id} className="review-queue-item draft">
                      <button className="review-item-main" disabled={busyItemId === draft.id} onClick={() => onOpenDraft(draft)}>
                        <div className="review-item-copy">
                          <strong>{draft.subject || "(No subject)"}</strong>
                          <small>To {draft.to.join(", ") || "No recipient"}{draft.replyStyleName ? ` · ${draft.replyStyleName}` : ""}</small>
                          <span className="review-item-action-summary">Updated {formatDateTime(draft.updatedAt)}</span>
                        </div>
                        <FileEdit size={16} />
                      </button>
                      {!readOnly && (
                        <button className="icon-button review-item-delete" disabled={busyItemId === draft.id} onClick={() => onDeleteDraft(draft)} title="Delete draft" aria-label={`Delete draft ${draft.subject || "(No subject)"}`}>
                          {busyItemId === draft.id ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </ReviewSection>
              <ReviewSection icon={<BellRing size={17} />} title="Follow-ups" detail="Grouped by due date · earliest first" count={queue.followUps.length}>
                <div className="review-queue-groups">
                  {followUpGroups.map((group) => (
                    <ReviewGroup key={group.id} title={group.title} count={group.items.length} tone={group.id}>
                      {group.items.map((followUp) => (
                        <div key={followUp.id} className={`review-queue-item follow-up ${group.id}`}>
                          <button className="review-item-main" disabled={busyItemId === followUp.id} onClick={() => onOpenMessage({ id: followUp.messageId })}>
                            <div className="review-item-copy">
                              <strong>{followUp.subject}</strong>
                              <small>{displayAddress(followUp.sender)} · {formatDateTime(followUp.dueAt)}</small>
                              {followUp.note && <span className="review-item-action-summary">{followUp.note}</span>}
                            </div>
                          </button>
                          {!readOnly && (
                            <button className="icon-button review-item-reviewed" disabled={busyItemId === followUp.id} onClick={() => onCompleteFollowUp(followUp)} title="Mark complete" aria-label="Mark follow-up complete">
                              {busyItemId === followUp.id ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                            </button>
                          )}
                        </div>
                      ))}
                    </ReviewGroup>
                  ))}
                </div>
              </ReviewSection>
            </>
          ) : (
            <div className="review-queue-empty"><Check size={30} /><strong>You’re caught up</strong><span>No AI drafts, actionable analyses, or pending follow-ups need review.</span></div>
          )}
        </div>
      </section>
    </div>
  );
}

function ReviewSection({
  icon,
  title,
  detail,
  count,
  children
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="review-queue-section">
      <header>{icon}<div><h3>{title}</h3><small>{detail}</small></div><span>{count}</span></header>
      <div className="review-section-content">{children}</div>
    </section>
  );
}

function QueueMetric({ value, label, tone = "neutral" }: { value: number; label: string; tone?: string }) {
  return <div className={`review-queue-metric ${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

function ReviewGroup({ title, count, tone, children }: { title: string; count: number; tone: string; children: ReactNode }) {
  return (
    <section className={`review-queue-group ${tone}`}>
      <header><h4>{title}</h4><span>{count}</span></header>
      <div className="review-queue-list">{children}</div>
    </section>
  );
}

function groupAnalyses(items: AiReviewAnalysisItem[]) {
  const sorted = [...items].sort((left, right) => {
    const priorityDifference = priorityRank(right.analysis.priority) - priorityRank(left.analysis.priority);
    return priorityDifference || timestamp(right.analysis.updatedAt) - timestamp(left.analysis.updatedAt);
  });
  const groups = [
    { id: "urgent", title: "Urgent", items: [] as AiReviewAnalysisItem[] },
    { id: "high", title: "High priority", items: [] as AiReviewAnalysisItem[] },
    { id: "reply", title: "Reply suggested", items: [] as AiReviewAnalysisItem[] },
    { id: "action", title: "Action needed", items: [] as AiReviewAnalysisItem[] }
  ];
  for (const item of sorted) {
    const id = item.analysis.priority === "urgent"
      ? "urgent"
      : item.analysis.priority === "high"
        ? "high"
        : item.analysis.draftRecommended
          ? "reply"
          : "action";
    groups.find((group) => group.id === id)!.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

function groupFollowUps(items: MessageFollowUp[]) {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const groups = [
    { id: "overdue", title: "Overdue", items: [] as MessageFollowUp[] },
    { id: "today", title: "Due today", items: [] as MessageFollowUp[] },
    { id: "upcoming", title: "Upcoming", items: [] as MessageFollowUp[] }
  ];
  for (const item of [...items].sort((left, right) => timestamp(left.dueAt) - timestamp(right.dueAt))) {
    const dueAt = timestamp(item.dueAt);
    const id = dueAt < now.getTime() ? "overdue" : dueAt < tomorrow.getTime() ? "today" : "upcoming";
    groups.find((group) => group.id === id)!.items.push(item);
  }
  return groups.filter((group) => group.items.length > 0);
}

function priorityRank(priority: AiReviewAnalysisItem["analysis"]["priority"]): number {
  return { low: 0, normal: 1, high: 2, urgent: 3 }[priority];
}

function timestamp(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toggleSelection(selectedIds: Set<string>, messageId: string): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(messageId)) next.delete(messageId);
  else next.add(messageId);
  return next;
}
