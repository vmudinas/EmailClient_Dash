import { BellRing, BrainCircuit, CalendarPlus, Check, CheckCheck, FileEdit, ListTodo, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import type { AiReviewAnalysisItem, AiReviewQueue, EmailDraft, MessageFollowUp, MessageSummary } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface AiReviewQueueDialogProps {
  open: boolean;
  queue: AiReviewQueue | null;
  loading: boolean;
  busyItemId: string | null;
  reviewAllBusy: boolean;
  planningAction: { messageId: string; action: "calendar_event" | "todo" } | null;
  readOnly: boolean;
  onClose(): void;
  onRefresh(): void;
  onOpenDraft(draft: EmailDraft): void;
  onDeleteDraft(draft: EmailDraft): void;
  onOpenMessage(message: Pick<MessageSummary, "id">): void;
  onCreateAction(item: AiReviewAnalysisItem, action: "calendar_event" | "todo"): void;
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
  planningAction,
  readOnly,
  onClose,
  onRefresh,
  onOpenDraft,
  onDeleteDraft,
  onOpenMessage,
  onCreateAction,
  onMarkAnalysisReviewed,
  onMarkAllAnalysesReviewed,
  onCompleteFollowUp
}: AiReviewQueueDialogProps) {
  if (!open) return null;
  const sortedDrafts = [...(queue?.drafts ?? [])].sort((left, right) => timestamp(right.updatedAt) - timestamp(left.updatedAt));
  const attentionGroups = groupAnalyses(queue?.analyses ?? []);
  const followUpGroups = groupFollowUps(queue?.followUps ?? []);
  const priorityCount = (queue?.analyses ?? []).filter(({ analysis }) => analysis.priority === "urgent" || analysis.priority === "high").length;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!reviewAllBusy) onClose(); }}>
      <section className="dialog ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><BrainCircuit size={20} /><h2 id="ai-review-title">AI review queue</h2></div>
          <div className="dialog-header-actions">
            {!readOnly && Boolean(queue?.analyses.length) && (
              <button className="secondary-button review-all-button" disabled={loading || reviewAllBusy} onClick={onMarkAllAnalysesReviewed} title="Set every Needs attention message as reviewed" aria-label="Set all reviewed">
                {reviewAllBusy ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />} <span>Set all reviewed</span>
              </button>
            )}
            <button className="icon-button" disabled={loading || reviewAllBusy} onClick={onRefresh} title="Refresh" aria-label="Refresh review queue"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
            <button className="icon-button" disabled={reviewAllBusy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
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
                <div className="review-queue-groups">
                  {attentionGroups.map((group) => (
                    <ReviewGroup key={group.id} title={group.title} count={group.items.length} tone={group.id}>
                      {group.items.map((item) => (
                        <div key={item.message.id} className={`review-queue-item attention priority-${item.analysis.priority}`}>
                          <button data-testid="attention-message" className="review-item-main" disabled={busyItemId === item.message.id} onClick={() => onOpenMessage(item.message)}>
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
                              <button className="review-quick-action event" disabled={reviewAllBusy || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onCreateAction(item, "calendar_event")} title="Create calendar event" aria-label={`Create event for ${item.message.subject}`}>
                                {planningAction?.messageId === item.message.id && planningAction.action === "calendar_event" ? <LoaderCircle className="spin" size={15} /> : <CalendarPlus size={15} />}<span>Event</span>
                              </button>
                              <button className="review-quick-action todo" disabled={reviewAllBusy || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onCreateAction(item, "todo")} title="Create to-do" aria-label={`Create to-do for ${item.message.subject}`}>
                                {planningAction?.messageId === item.message.id && planningAction.action === "todo" ? <LoaderCircle className="spin" size={15} /> : <ListTodo size={15} />}<span>To-do</span>
                              </button>
                              <button className="review-mark-button" disabled={reviewAllBusy || busyItemId === item.message.id || planningAction?.messageId === item.message.id} onClick={() => onMarkAnalysisReviewed(item)} title="Mark reviewed" aria-label={`Mark ${item.message.subject} reviewed`}>
                                {busyItemId === item.message.id ? <LoaderCircle className="spin" size={15} /> : <CheckCheck size={15} />}<span>Mark reviewed</span>
                              </button>
                            </div>
                          )}
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
