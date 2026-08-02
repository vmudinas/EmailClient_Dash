import { useEffect, useMemo, useState } from "react";
import { CircleAlert, FileEdit, LoaderCircle, MailPlus, Paperclip, Save, Send, ShieldCheck, Sparkles, Trash2, X } from "lucide-react";
import type { GmailConnection, GmailSendAsAlias, GmailSendRequest, ResumeAsset } from "@email-client/shared";
import { DEVELOPMENT_FROM_ADDRESS, SENDING_ADDRESSES, defaultSendingAddress, isAllowedSendingAddress } from "../lib/sendingIdentity.js";

export interface ComposeDraft {
  id?: string;
  source?: "manual" | "ai";
  sourceMessageId?: string | null;
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  bodyText?: string;
  fromAddress?: string | null;
  resumeId?: string | null;
  resumeFilename?: string | null;
}

interface ComposeDialogProps {
  open: boolean;
  connections: GmailConnection[];
  initialConnectionId: string | null;
  initialDraft?: ComposeDraft | null;
  busy: boolean;
  error: string;
  onClose(): void;
  onOpenGmail(): void;
  onLoadSendAsAliases(connectionId: string): Promise<GmailSendAsAlias[]>;
  onLoadResumes?(): Promise<ResumeAsset[]>;
  onDelete?(): void;
  // resumeId is passed alongside the message rather than inside it: GmailSendRequest is the
  // payload Gmail itself receives, and a resume is an Archive Mail concept the draft carries.
  onSave(connectionId: string, message: GmailSendRequest, resumeId: string | null): void;
  onSend(connectionId: string, message: GmailSendRequest, resumeId: string | null): void;
}

export function ComposeDialog({
  open,
  connections,
  initialConnectionId,
  initialDraft,
  busy,
  error,
  onClose,
  onOpenGmail,
  onLoadSendAsAliases,
  onLoadResumes,
  onDelete,
  onSave,
  onSend
}: ComposeDialogProps) {
  const senders = useMemo(() => connections.filter((connection) => connection.canSend), [connections]);
  const [connectionId, setConnectionId] = useState("");
  const [aliases, setAliases] = useState<GmailSendAsAlias[]>([]);
  const [fromAddress, setFromAddress] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCopies, setShowCopies] = useState(false);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [resumes, setResumes] = useState<ResumeAsset[]>([]);
  const [resumeId, setResumeId] = useState("");

  useEffect(() => {
    if (!open) return;
    setResumeId(initialDraft?.resumeId ?? "");
    setConnectionId(
      initialConnectionId && senders.some((connection) => connection.id === initialConnectionId)
        ? initialConnectionId
        : senders[0]?.id ?? ""
    );
    setTo(Array.isArray(initialDraft?.to) ? initialDraft.to.join(", ") : initialDraft?.to ?? "");
    setCc(initialDraft?.cc?.join(", ") ?? "");
    setBcc(initialDraft?.bcc?.join(", ") ?? "");
    setShowCopies(Boolean(initialDraft?.cc?.length || initialDraft?.bcc?.length));
    setSubject(initialDraft?.subject ?? "");
    setBodyText(initialDraft?.bodyText ?? "");
    // Draft prefill should only apply once, when the dialog opens with a given draft — not
    // re-run on every keystroke, so initialDraft/initialConnectionId are read but not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, senders]);

  useEffect(() => {
    if (!open || !connectionId) {
      setAliases([]);
      return;
    }
    // The server accepts only the configured addresses, so those are the choices offered here
    // rather than whatever the connected account happens to expose. Gmail's own aliases are still
    // fetched, but only to label the ones it recognises -- an address Gmail has not verified will
    // be refused by Google at send time, and saying so up front beats a failed send.
    setFromAddress(initialDraft?.fromAddress && isAllowedSendingAddress(initialDraft.fromAddress)
      ? initialDraft.fromAddress
      : defaultSendingAddress(Boolean(initialDraft?.resumeId)));
    setAliases([]);
    let active = true;
    void onLoadSendAsAliases(connectionId).then((loaded) => {
      if (active) setAliases(loaded);
    });
    return () => { active = false; };
  }, [open, connectionId, senders, onLoadSendAsAliases, initialDraft]);

  useEffect(() => {
    if (!open || !onLoadResumes) return;
    let active = true;
    // A failed load leaves the list empty rather than blocking the dialog: composing without a
    // resume is the common case, and losing the attachment picker should not stop an email.
    void onLoadResumes()
      .then((loaded) => { if (active) setResumes(loaded); })
      .catch(() => { if (active) setResumes([]); });
    return () => { active = false; };
  }, [open, onLoadResumes]);

  if (!open) return null;
  const selectedConnection = senders.find((connection) => connection.id === connectionId);
  const message: GmailSendRequest = {
    to: parseRecipients(to),
    cc: parseRecipients(cc),
    bcc: parseRecipients(bcc),
    subject,
    bodyText,
    // Always sent, even when it matches the connected account: the address is now a deliberate
    // choice rather than a deviation from the account default, and omitting it would hand the
    // server a blank to fill in.
    ...(fromAddress ? { fromAddress } : {}),
    ...(initialDraft?.sourceMessageId ? { sourceMessageId: initialDraft.sourceMessageId } : {})
  };
  const ready = Boolean(connectionId)
    && message.to.length > 0
    && (subject.trim().length > 0 || bodyText.trim().length > 0);
  const saveReady = Boolean(connectionId);
  const editing = Boolean(initialDraft?.id);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div>
            {initialDraft?.source === "ai" ? <Sparkles size={20} /> : editing ? <FileEdit size={20} /> : <MailPlus size={20} />}
            <h2 id="compose-title">{initialDraft?.source === "ai" ? "Review AI draft" : editing ? "Edit draft" : "New email"}</h2>
          </div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body compose-body">
          {senders.length === 0 ? (
            <div className="compose-empty">
              <ShieldCheck size={22} />
              <strong>Gmail send permission is required</strong>
              <p>Connect Gmail, or authorize an existing account again, to grant the separate send-only permission.</p>
              <button className="primary-button" onClick={onOpenGmail}>Open Gmail accounts</button>
            </div>
          ) : (
            <>
              <label className="compose-line"><span>From</span><select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>{senders.map((connection) => <option key={connection.id} value={connection.id}>{connection.email}</option>)}</select></label>
              <label className="compose-line"><span>Send as</span><select value={fromAddress} onChange={(event) => setFromAddress(event.target.value)}>{SENDING_ADDRESSES.map((entry) => <option key={entry.email} value={entry.email}>{`${entry.email} — ${entry.label}`}</option>)}</select></label>
              {aliases.length > 0 && !aliases.some((alias) => alias.email.trim().toLowerCase() === fromAddress.trim().toLowerCase()) && (
                <p className="compose-line compose-hint">Gmail has not verified {fromAddress} as a send-as alias on {selectedConnection?.email}. Google will refuse the send until it is added there.</p>
              )}
              <label className="compose-line"><span>To</span><input autoFocus value={to} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></label>
              {!showCopies ? (
                <button className="text-button compose-copies" onClick={() => setShowCopies(true)}>Add Cc or Bcc</button>
              ) : (
                <div className="compose-copy-lines">
                  <label className="compose-line"><span>Cc</span><input value={cc} onChange={(event) => setCc(event.target.value)} /></label>
                  <label className="compose-line"><span>Bcc</span><input value={bcc} onChange={(event) => setBcc(event.target.value)} /></label>
                </div>
              )}
              <label className="compose-line"><span>Subject</span><input value={subject} maxLength={998} onChange={(event) => setSubject(event.target.value)} /></label>
              <label className="compose-message"><span className="visually-hidden">Message</span><textarea value={bodyText} maxLength={1_000_000} onChange={(event) => setBodyText(event.target.value)} placeholder="Write a message" /></label>
              {resumes.length > 0 ? (
                <label className="compose-line"><span>Résumé</span>
                  <select value={resumeId} onChange={(event) => setResumeId(event.target.value)} disabled={busy}>
                    <option value="">No résumé</option>
                    {resumes.map((resume) => (
                      <option key={resume.id} value={resume.id}>{resume.name} · {resume.filename}</option>
                    ))}
                  </select>
                </label>
              ) : initialDraft?.resumeFilename ? (
                // The picker needs the list; without it, still show what the draft already carries
                // rather than implying nothing is attached.
                <div className="compose-attachment"><Paperclip size={16} /><span>{initialDraft.resumeFilename}</span><small>Attached when this draft is sent</small></div>
              ) : null}
              {resumeId && (
                <p className="compose-line compose-hint">Attached when this draft is sent, and mail with a résumé goes out from {DEVELOPMENT_FROM_ADDRESS} unless you choose otherwise above.</p>
              )}
            </>
          )}
          {error && <div className="import-error" role="alert"><CircleAlert size={18} /><div><strong>Draft action failed</strong><span>{error}</span></div></div>}
        </div>
        <footer className="dialog-footer">
          {editing && onDelete && <button className="danger-button compose-delete-button" disabled={busy} onClick={onDelete}><Trash2 size={17} /> Delete draft</button>}
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="secondary-button" disabled={busy || !saveReady} onClick={() => onSave(connectionId, message, resumeId || null)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save draft
          </button>
          <button className="primary-button" disabled={busy || !ready} onClick={() => onSend(connectionId, message, resumeId || null)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} Send
          </button>
        </footer>
      </section>
    </div>
  );
}

function parseRecipients(value: string): string[] {
  return [...new Set(value.split(/[,;\n]+/).map((entry) => entry.trim()).filter(Boolean))];
}
