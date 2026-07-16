import { useEffect, useState } from "react";
import { BellPlus, CircleAlert, LoaderCircle, X } from "lucide-react";
import type { MessageFollowUp } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

interface FollowUpDialogProps {
  open: boolean;
  api: ApiClient;
  messageId: string;
  subject: string;
  suggestedNote?: string | null;
  onClose(): void;
  onCreated(followUp: MessageFollowUp): void;
}

export function FollowUpDialog({
  open,
  api,
  messageId,
  subject,
  suggestedNote,
  onClose,
  onCreated
}: FollowUpDialogProps) {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setDate(localDate(tomorrow));
    setTime("09:00");
    setNote(suggestedNote?.trim() || `Follow up on: ${subject}`);
    setError("");
  }, [open, subject, suggestedNote]);

  if (!open) return null;

  const save = async () => {
    if (!date || !time) return;
    setBusy(true);
    setError("");
    try {
      const due = new Date(`${date}T${time}:00`);
      const followUp = await api.createMessageFollowUp(messageId, {
        dueAt: due.toISOString(),
        note: note.trim()
      });
      onCreated(followUp);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Follow-up could not be saved");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog follow-up-dialog" role="dialog" aria-modal="true" aria-labelledby="follow-up-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><BellPlus size={20} /><h2 id="follow-up-title">Track a follow-up</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body settings-form">
          <p className="settings-hint">This reminder stays linked to the entire email conversation and completes automatically when you send a reply.</p>
          <div className="follow-up-date-row">
            <label>Due date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
            <label>Time<input type="time" value={time} onChange={(event) => setTime(event.target.value)} disabled={busy} /></label>
          </div>
          <label>Reminder note<textarea rows={4} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} /></label>
          {error && <div className="import-error" role="alert"><CircleAlert size={18} /><div><strong>Follow-up failed</strong><span>{error}</span></div></div>}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !date || !time} onClick={() => void save()}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <BellPlus size={17} />} Save follow-up
          </button>
        </footer>
      </section>
    </div>
  );
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
