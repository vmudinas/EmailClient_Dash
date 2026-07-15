import { useEffect, useMemo, useState } from "react";
import { CircleAlert, LoaderCircle, MailPlus, Send, ShieldCheck, X } from "lucide-react";
import type { GmailConnection, GmailSendRequest } from "@email-client/shared";

interface ComposeDialogProps {
  open: boolean;
  connections: GmailConnection[];
  initialConnectionId: string | null;
  busy: boolean;
  error: string;
  onClose(): void;
  onOpenGmail(): void;
  onSend(connectionId: string, message: GmailSendRequest): void;
}

export function ComposeDialog({
  open,
  connections,
  initialConnectionId,
  busy,
  error,
  onClose,
  onOpenGmail,
  onSend
}: ComposeDialogProps) {
  const senders = useMemo(() => connections.filter((connection) => connection.canSend), [connections]);
  const [connectionId, setConnectionId] = useState("");
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
    setTo("");
    setCc("");
    setBcc("");
    setShowCopies(false);
    setSubject("");
    setBodyText("");
  }, [open, initialConnectionId, senders]);

  if (!open) return null;
  const message: GmailSendRequest = {
    to: parseRecipients(to),
    cc: parseRecipients(cc),
    bcc: parseRecipients(bcc),
    subject,
    bodyText
  };
  const ready = Boolean(connectionId)
    && message.to.length > 0
    && (subject.trim().length > 0 || bodyText.trim().length > 0);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog compose-dialog" role="dialog" aria-modal="true" aria-labelledby="compose-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><MailPlus size={20} /><h2 id="compose-title">New email</h2></div>
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
            </>
          )}
          {error && <div className="import-error" role="alert"><CircleAlert size={18} /><div><strong>Email was not sent</strong><span>{error}</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
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
