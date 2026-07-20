import { useEffect, useMemo, useState } from "react";
import { CircleAlert, FileEdit, LoaderCircle, Paperclip, ShieldCheck, X } from "lucide-react";
import type {
  GmailConnection,
  MessageDraftReplyStart,
  ReplyStyle,
  ResumeAsset
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

interface AiDraftReplyDialogProps {
  open: boolean;
  api: ApiClient;
  messageId: string;
  archiveId: string;
  connections: GmailConnection[];
  onClose(): void;
  onStarted(result: MessageDraftReplyStart): void;
}

export function AiDraftReplyDialog({
  open,
  api,
  messageId,
  archiveId,
  connections,
  onClose,
  onStarted
}: AiDraftReplyDialogProps) {
  const senders = useMemo(() => connections.filter((connection) => connection.canSend), [connections]);
  const [connectionId, setConnectionId] = useState("");
  const [resumeId, setResumeId] = useState("");
  const [resumes, setResumes] = useState<ResumeAsset[]>([]);
  const [replyStyles, setReplyStyles] = useState<ReplyStyle[]>([]);
  const [replyStyleId, setReplyStyleId] = useState("");
  const [instructions, setInstructions] = useState("");
  const [loadingResumes, setLoadingResumes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setConnectionId(
      senders.find((connection) => connection.archiveId === archiveId)?.id
        ?? senders[0]?.id
        ?? ""
    );
    setResumeId("");
    setReplyStyleId("");
    setInstructions("");
    setError("");
  }, [open, archiveId, senders]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoadingResumes(true);
    const replyStylesRequest = typeof api.listReplyStyles === "function"
      ? api.listReplyStyles()
      : Promise.resolve([]);
    void Promise.all([api.listAvailableResumes(), replyStylesRequest])
      .then(([items, styles]) => {
        if (!active) return;
        setResumes(items);
        setReplyStyles(styles);
        setReplyStyleId(styles.find((style) => style.isDefault)?.id ?? "");
      })
      .catch(() => {
        if (!active) return;
        setResumes([]);
        setReplyStyles([]);
      })
      .finally(() => { if (active) setLoadingResumes(false); });
    return () => { active = false; };
  }, [api, open]);

  if (!open) return null;

  const generate = async () => {
    if (!connectionId) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.startMessageDraftReply(messageId, {
        gmailConnectionId: connectionId,
        resumeId: resumeId || null,
        replyStyleId: replyStyleId || null,
        instructions: instructions.trim() || null
      });
      onStarted(result);
      onClose();
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "AI draft could not be started");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section
        className="dialog message-draft-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="message-draft-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div><FileEdit size={20} /><h2 id="message-draft-title">Create AI reply draft</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body settings-form message-draft-body">
          <div className="message-draft-assurance">
            <ShieldCheck size={18} />
            <span>AI creates a saved draft for review. It never sends the email automatically.</span>
          </div>
          {senders.length === 0 ? (
            <div className="compose-empty">
              <strong>Gmail send permission is required</strong>
              <p>Connect or reauthorize a Gmail account before creating reply drafts.</p>
            </div>
          ) : (
            <>
              <label>Sending account
                <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} disabled={busy}>
                  {senders.map((connection) => (
                    <option key={connection.id} value={connection.id}>{connection.email}</option>
                  ))}
                </select>
              </label>
              <label>Optional résumé
                <select value={resumeId} onChange={(event) => setResumeId(event.target.value)} disabled={busy || loadingResumes}>
                  <option value="">No résumé</option>
                  {resumes.map((resume) => (
                    <option key={resume.id} value={resume.id}>{resume.name} · {resume.filename}</option>
                  ))}
                </select>
              </label>
              <label>Reply style
                <select value={replyStyleId} onChange={(event) => setReplyStyleId(event.target.value)} disabled={busy || loadingResumes}>
                  <option value="">Provider default</option>
                  {replyStyles.map((style) => (
                    <option key={style.id} value={style.id}>{style.name} · {style.tone}</option>
                  ))}
                </select>
              </label>
              <label>Guidance for this reply (optional)
                <textarea
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                  disabled={busy}
                  rows={3}
                  maxLength={2000}
                  placeholder="e.g. Accept the interview but ask to move it to Thursday afternoon; mention I'm available after 2 PM."
                />
                <small>Tell the AI what the reply should say or avoid. Combined with the selected reply style.</small>
              </label>
              <div className="message-draft-hint">
                <Paperclip size={15} />
                <span>The résumé is attached only when AI identifies a development or job opportunity.</span>
              </div>
            </>
          )}
          {error && (
            <div className="import-error" role="alert">
              <CircleAlert size={18} /><div><strong>Draft action failed</strong><span>{error}</span></div>
            </div>
          )}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !connectionId} onClick={() => void generate()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <FileEdit size={17} />}
            Generate reviewable draft
          </button>
        </footer>
      </section>
    </div>
  );
}
