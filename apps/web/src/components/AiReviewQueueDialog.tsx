import { BellRing, BrainCircuit, Check, CheckCheck, FileEdit, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import type { AiReviewAnalysisItem, AiReviewQueue, EmailDraft, MessageFollowUp, MessageSummary } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface AiReviewQueueDialogProps {
  open: boolean;
  queue: AiReviewQueue | null;
  loading: boolean;
  busyItemId: string | null;
  readOnly: boolean;
  onClose(): void;
  onRefresh(): void;
  onOpenDraft(draft: EmailDraft): void;
  onDeleteDraft(draft: EmailDraft): void;
  onOpenMessage(message: Pick<MessageSummary, "id">): void;
  onMarkAnalysisReviewed(item: AiReviewAnalysisItem): void;
  onCompleteFollowUp(followUp: MessageFollowUp): void;
}

export function AiReviewQueueDialog({
  open,
  queue,
  loading,
  busyItemId,
  readOnly,
  onClose,
  onRefresh,
  onOpenDraft,
  onDeleteDraft,
  onOpenMessage,
  onMarkAnalysisReviewed,
  onCompleteFollowUp
}: AiReviewQueueDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="dialog ai-review-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-review-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><BrainCircuit size={20} /><h2 id="ai-review-title">AI review queue</h2></div>
          <div className="dialog-header-actions">
            <button className="icon-button" disabled={loading} onClick={onRefresh} title="Refresh" aria-label="Refresh review queue"><RefreshCw className={loading ? "spin" : ""} size={17} /></button>
            <button className="icon-button" onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body ai-review-body">
          {loading && !queue ? <div className="settings-loading"><LoaderCircle className="spin" size={20} /> Loading review work</div> : queue?.totalItems ? (
            <>
              <ReviewSection icon={<FileEdit size={17} />} title="Drafts to review" count={queue.drafts.length}>
                {queue.drafts.map((draft) => (
                  <div key={draft.id} className="review-queue-item">
                    <button className="review-item-main" disabled={busyItemId === draft.id} onClick={() => onOpenDraft(draft)}>
                      <span><strong>{draft.subject || "(No subject)"}</strong><small>To {draft.to.join(", ") || "No recipient"}{draft.replyStyleName ? ` · ${draft.replyStyleName}` : ""}</small></span>
                      <FileEdit size={16} />
                    </button>
                    {!readOnly && (
                      <button className="icon-button review-item-delete" disabled={busyItemId === draft.id} onClick={() => onDeleteDraft(draft)} title="Delete draft" aria-label={`Delete draft ${draft.subject || "(No subject)"}`}>
                        {busyItemId === draft.id ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                      </button>
                    )}
                  </div>
                ))}
              </ReviewSection>
              <ReviewSection icon={<BrainCircuit size={17} />} title="Messages needing decisions" count={queue.analyses.length}>
                {queue.analyses.map((item) => (
                  <div key={item.message.id} className="review-queue-item">
                    <button className="review-item-main" disabled={busyItemId === item.message.id} onClick={() => onOpenMessage(item.message)}>
                      <span><strong>{item.message.subject}</strong><small>{displayAddress(item.message.sender)} · {item.analysis.actionSummary || `${item.analysis.priority} priority`}</small></span>
                      <span className={`ai-priority priority-${item.analysis.priority}`}>{item.analysis.priority}</span>
                    </button>
                    {!readOnly && (
                      <button className="icon-button review-item-reviewed" disabled={busyItemId === item.message.id} onClick={() => onMarkAnalysisReviewed(item)} title="Mark reviewed" aria-label={`Mark ${item.message.subject} reviewed`}>
                        {busyItemId === item.message.id ? <LoaderCircle className="spin" size={16} /> : <CheckCheck size={16} />}
                      </button>
                    )}
                  </div>
                ))}
              </ReviewSection>
              <ReviewSection icon={<BellRing size={17} />} title="Follow-ups" count={queue.followUps.length}>
                {queue.followUps.map((followUp) => (
                  <div key={followUp.id} className={`review-queue-item follow-up ${new Date(followUp.dueAt).getTime() < Date.now() ? "overdue" : ""}`}>
                    <button className="review-item-main" onClick={() => onOpenMessage({ id: followUp.messageId })}>
                      <span><strong>{followUp.subject}</strong><small>{formatDateTime(followUp.dueAt)} · {followUp.note || displayAddress(followUp.sender)}</small></span>
                    </button>
                    {!readOnly && (
                      <button className="icon-button" disabled={busyItemId === followUp.id} onClick={() => onCompleteFollowUp(followUp)} title="Mark complete" aria-label="Mark follow-up complete">
                        {busyItemId === followUp.id ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
                      </button>
                    )}
                  </div>
                ))}
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
  count,
  children
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="review-queue-section">
      <header>{icon}<h3>{title}</h3><span>{count}</span></header>
      <div>{children}</div>
    </section>
  );
}
