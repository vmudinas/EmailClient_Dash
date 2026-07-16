import { FileEdit, LoaderCircle, Paperclip, Pencil, RefreshCw, Send, Sparkles, Trash2, X } from "lucide-react";
import type { EmailDraft } from "@email-client/shared";
import { formatDateTime } from "../lib/format.js";

interface DraftsDialogProps {
  open: boolean;
  drafts: EmailDraft[];
  loading: boolean;
  busy: boolean;
  error: string;
  onClose(): void;
  onRefresh(): void;
  onEdit(draft: EmailDraft): void;
  onSend(draft: EmailDraft): void;
  onDelete(draft: EmailDraft): void;
}

export function DraftsDialog({
  open,
  drafts,
  loading,
  busy,
  error,
  onClose,
  onRefresh,
  onEdit,
  onSend,
  onDelete
}: DraftsDialogProps) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog drafts-dialog" role="dialog" aria-modal="true" aria-labelledby="drafts-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><FileEdit size={20} /><h2 id="drafts-title">Drafts</h2></div>
          <div className="dialog-header-actions">
            <button className="icon-button" disabled={busy || loading} onClick={onRefresh} title="Refresh drafts" aria-label="Refresh drafts"><RefreshCw size={17} /></button>
            <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
          </div>
        </header>
        <div className="dialog-body drafts-body">
          {error && <div className="settings-message error" role="alert">{error}</div>}
          {loading ? (
            <div className="settings-loading"><LoaderCircle className="spin" size={19} /> Loading drafts</div>
          ) : drafts.length === 0 ? (
            <div className="drafts-empty"><FileEdit size={24} /><strong>No saved drafts</strong><span>Saved and AI-generated drafts will appear here for review.</span></div>
          ) : (
            <ul className="draft-list">
              {drafts.map((draft) => (
                <li key={draft.id}>
                  <button className="draft-main" onClick={() => onEdit(draft)} disabled={busy}>
                    <span className="draft-title">
                      {draft.source === "ai" && <Sparkles size={14} />}
                      <strong>{draft.subject || "(No subject)"}</strong>
                    </span>
                    <span>To {draft.to.join(", ") || "(no recipient)"} · From {draft.fromAddress || draft.connectionEmail}</span>
                    <small>
                      {draft.source === "ai" ? `AI draft${draft.scheduleName ? ` · ${draft.scheduleName}` : ""}` : "Saved draft"}
                      {draft.resumeFilename ? ` · Resume: ${draft.resumeFilename}` : ""}
                      {` · ${formatDateTime(draft.updatedAt)}`}
                    </small>
                    {draft.aiReason && <small className="draft-reason">{draft.aiReason}</small>}
                  </button>
                  <div className="draft-actions">
                    {draft.resumeId && <Paperclip size={15} aria-label="Resume attached" />}
                    <button
                      className="draft-send-button"
                      disabled={busy || draft.to.length === 0 || (!draft.subject.trim() && !draft.bodyText.trim())}
                      onClick={() => onSend(draft)}
                      title="Send draft now"
                      aria-label={`Send ${draft.subject || "draft"}`}
                    ><Send size={14} /><span>Send</span></button>
                    <button className="icon-button" disabled={busy} onClick={() => onEdit(draft)} title="Edit draft" aria-label={`Edit ${draft.subject || "draft"}`}><Pencil size={15} /></button>
                    <button className="icon-button" disabled={busy} onClick={() => onDelete(draft)} title="Delete draft" aria-label={`Delete ${draft.subject || "draft"}`}><Trash2 size={15} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className="dialog-footer"><button className="secondary-button" disabled={busy} onClick={onClose}>Close</button></footer>
      </section>
    </div>
  );
}
