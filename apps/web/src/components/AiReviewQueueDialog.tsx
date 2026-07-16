import { BellRing, BrainCircuit, Check, FileEdit, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { ReactNode } from "react";
import type { AiReviewQueue, EmailDraft, MessageFollowUp, MessageSummary } from "@email-client/shared";
import { displayAddress, formatDateTime } from "../lib/format.js";

interface AiReviewQueueDialogProps {
  open: boolean;
  queue: AiReviewQueue | null;
  loading: boolean;
  busyFollowUpId: string | null;
  readOnly: boolean;
  onClose(): void;
  onRefresh(): void;
  onOpenDraft(draft: EmailDraft): void;
  onOpenMessage(message: Pick<MessageSummary, "id">): void;
  onCompleteFollowUp(followUp: MessageFollowUp): void;
}

export function AiReviewQueueDialog({
  open,
  queue,
  loading,
  busyFollowUpId,
  readOnly,
  onClose,
  onRefresh,
  onOpenDraft,
  onOpenMessage,
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
                  <button key={draft.id} className="review-queue-item" onClick={() => onOpenDraft(draft)}>
                    <span><strong>{draft.subject || "(No subject)"}</strong><small>To {draft.to.join(", ") || "No recipient"}{draft.replyStyleName ? ` · ${draft.replyStyleName}` : ""}</small></span>
                    <FileEdit size={16} />
                  </button>
                ))}
              </ReviewSection>
              <ReviewSection icon={<BrainCircuit size={17} />} title="Messages needing decisions" count={queue.analyses.length}>
                {queue.analyses.map(({ message, analysis }) => (
                  <button key={message.id} className="review-queue-item" onClick={() => onOpenMessage(message)}>
                    <span><strong>{message.subject}</strong><small>{displayAddress(message.sender)} · {analysis.actionSummary || `${analysis.priority} priority`}</small></span>
                    <span className={`ai-priority priority-${analysis.priority}`}>{analysis.priority}</span>
                  </button>
                ))}
              </ReviewSection>
              <ReviewSection icon={<BellRing size={17} />} title="Follow-ups" count={queue.followUps.length}>
                {queue.followUps.map((followUp) => (
                  <div key={followUp.id} className={`review-queue-item follow-up ${new Date(followUp.dueAt).getTime() < Date.now() ? "overdue" : ""}`}>
                    <button className="review-item-main" onClick={() => onOpenMessage({ id: followUp.messageId })}>
                      <span><strong>{followUp.subject}</strong><small>{formatDateTime(followUp.dueAt)} · {followUp.note || displayAddress(followUp.sender)}</small></span>
                    </button>
                    {!readOnly && (
                      <button className="icon-button" disabled={busyFollowUpId === followUp.id} onClick={() => onCompleteFollowUp(followUp)} title="Mark complete" aria-label="Mark follow-up complete">
                        {busyFollowUpId === followUp.id ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
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
