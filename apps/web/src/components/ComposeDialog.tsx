import { useEffect, useMemo, useState } from "react";
import { CircleAlert, FileEdit, LoaderCircle, MailPlus, Paperclip, Save, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import type { GmailConnection, GmailSendAsAlias, GmailSendRequest } from "@email-client/shared";

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
  onSave(connectionId: string, message: GmailSendRequest): void;
  onSend(connectionId: string, message: GmailSendRequest): void;
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

  useEffect(() => {
    if (!open) return;
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
    const connection = senders.find((entry) => entry.id === connectionId);
    setFromAddress(initialDraft?.fromAddress || connection?.email || "");
    setAliases(connection ? [{ email: connection.email, displayName: "", isPrimary: true, isDefault: true }] : []);
    let active = true;
    void onLoadSendAsAliases(connectionId).then((loaded) => {
      if (active && loaded.length > 0) {
        setAliases(loaded);
        setFromAddress((current) => loaded.some((alias) => alias.email === current)
          ? current
          : loaded.find((alias) => alias.isDefault)?.email ?? loaded[0]!.email);
      }
    });
    return () => { active = false; };
  }, [open, connectionId, senders, onLoadSendAsAliases]);

  if (!open) return null;
  const selectedConnection = senders.find((connection) => connection.id === connectionId);
  const message: GmailSendRequest = {
    to: parseRecipients(to),
    cc: parseRecipients(cc),
    bcc: parseRecipients(bcc),
    subject,
    bodyText,
    ...(fromAddress && fromAddress !== selectedConnection?.email ? { fromAddress } : {}),
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
              {aliases.length > 1 && (
                <label className="compose-line"><span>Send as</span><select value={fromAddress} onChange={(event) => setFromAddress(event.target.value)}>{aliases.map((alias) => <option key={alias.email} value={alias.email}>{alias.displayName ? `${alias.displayName} <${alias.email}>` : alias.email}</option>)}</select></label>
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
              {initialDraft?.resumeFilename && (
                <div className="compose-attachment"><Paperclip size={16} /><span>{initialDraft.resumeFilename}</span><small>Attached when this draft is sent</small></div>
              )}
            </>
          )}
          {error && <div className="import-error" role="alert"><CircleAlert size={18} /><div><strong>Draft action failed</strong><span>{error}</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="secondary-button" disabled={busy || !saveReady} onClick={() => onSave(connectionId, message)}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Save size={17} />} Save draft
          </button>
          <button className="primary-button" disabled={busy || !ready} onClick={() => onSend(connectionId, message)}>
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
