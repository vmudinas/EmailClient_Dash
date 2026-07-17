import { useMemo, useState, type FormEvent } from "react";
import { CalendarPlus, ListTodo, LoaderCircle, Sparkles, X } from "lucide-react";
import type {
  CalendarEventInput,
  GmailConnection,
  MessageActionSuggestion
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

export type ReviewAction = "calendar_event" | "todo";

interface CalendarDraft {
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
}

interface TodoDraft {
  date: string;
  text: string;
}

export function MessageActionDialog({
  api,
  messageId,
  suggestion,
  connections,
  initialAction,
  onClose,
  onCreated,
  onError
}: {
  api: ApiClient;
  messageId: string;
  suggestion: MessageActionSuggestion;
  connections: GmailConnection[];
  initialAction?: ReviewAction;
  onClose(): void;
  onCreated(message: string, action: ReviewAction): void | Promise<void>;
  onError(message: string): void;
}) {
  const calendarConnections = useMemo(
    () => connections.filter((connection) => connection.canManageCalendar),
    [connections]
  );
  const fallbackDate = suggestion.calendarEvent?.startDate ?? suggestion.todo?.date ?? todayIso();
  const [action, setAction] = useState<ReviewAction>(
    initialAction ?? (suggestion.recommendedAction === "calendar_event"
      ? "calendar_event"
      : suggestion.recommendedAction === "todo"
        ? "todo"
        : calendarConnections.length > 0 ? "calendar_event" : "todo")
  );
  const [connectionId, setConnectionId] = useState(calendarConnections[0]?.id ?? "");
  const [calendar, setCalendar] = useState<CalendarDraft>(() => ({
    title: suggestion.calendarEvent?.title ?? suggestion.todo?.text ?? "",
    description: suggestion.calendarEvent?.description ?? "",
    location: suggestion.calendarEvent?.location ?? "",
    allDay: suggestion.calendarEvent?.allDay ?? true,
    startDate: fallbackDate,
    endDate: suggestion.calendarEvent?.endDate ?? fallbackDate,
    startTime: suggestion.calendarEvent?.startTime ?? "09:00",
    endTime: suggestion.calendarEvent?.endTime ?? "10:00"
  }));
  const [todo, setTodo] = useState<TodoDraft>(() => ({
    date: suggestion.todo?.date ?? fallbackDate,
    text: suggestion.todo?.text ?? suggestion.calendarEvent?.title ?? ""
  }));
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (action === "todo") {
        const created = await api.createTodo({ date: todo.date, text: todo.text.trim() });
        await onCreated(`To-do created for ${formatDate(created.date)}.`, "todo");
        return;
      }
      if (!connectionId) throw new Error("Choose a calendar-connected Gmail account");
      const payload: CalendarEventInput = {
        title: calendar.title.trim(),
        description: calendar.description.trim(),
        location: calendar.location.trim(),
        allDay: calendar.allDay,
        startAt: calendar.allDay
          ? calendar.startDate
          : localDateTimeToIso(calendar.startDate, calendar.startTime),
        endAt: calendar.allDay
          ? calendar.endDate
          : localDateTimeToIso(calendar.endDate, calendar.endTime)
      };
      if (new Date(payload.endAt).getTime() < new Date(payload.startAt).getTime()) {
        throw new Error("The event end must be after its start");
      }
      const created = await api.createCalendarEventFromMessage(messageId, connectionId, payload);
      await onCreated(`Calendar event "${created.title}" created.`, "calendar_event");
    } catch (error) {
      onError(error instanceof Error ? error.message : "The suggested action could not be created");
    } finally {
      setBusy(false);
    }
  };

  const ready = action === "todo"
    ? Boolean(todo.date && todo.text.trim())
    : Boolean(
        connectionId
        && calendar.title.trim()
        && calendar.startDate
        && calendar.endDate
        && (calendar.allDay || (calendar.startTime && calendar.endTime))
      );

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog message-action-dialog" role="dialog" aria-modal="true" aria-labelledby="message-action-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><Sparkles size={20} /><h2 id="message-action-title">Review AI action</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          <div className="message-action-reason">
            <strong>{suggestion.recommendedAction === "calendar_event"
              ? "Calendar event recommended"
              : suggestion.recommendedAction === "todo"
                ? "To-do recommended"
                : "No clear dated action found"}</strong>
            <p>{suggestion.reason}</p>
            <span>{Math.round(suggestion.confidence * 100)}% confidence · {suggestion.provider} · {suggestion.model}</span>
            {suggestion.dateEvidence.length > 0 && (
              <ul>{suggestion.dateEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>
            )}
          </div>
          <div className="settings-warning neutral"><Sparkles size={16} /><span>Nothing has been created. Review and edit every field, then confirm the action you want.</span></div>
          <form className="settings-form" onSubmit={(event) => void submit(event)}>
            <label>Action type
              <select value={action} onChange={(event) => setAction(event.target.value as ReviewAction)} disabled={busy}>
                <option value="calendar_event">Calendar event</option>
                <option value="todo">To-do</option>
              </select>
            </label>
            {action === "calendar_event" ? (
              <>
                <label>Calendar account
                  <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} disabled={busy || calendarConnections.length === 0}>
                    {calendarConnections.length === 0 && <option value="">No calendar-enabled account</option>}
                    {calendarConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.email}</option>)}
                  </select>
                  {calendarConnections.length === 0 && <small className="settings-hint">Reauthorize a Gmail account with Calendar permission, or switch this suggestion to a to-do.</small>}
                </label>
                <label>Title
                  <input autoFocus value={calendar.title} maxLength={500} onChange={(event) => setCalendar((current) => ({ ...current, title: event.target.value }))} disabled={busy} />
                </label>
                <label className="settings-checkbox">
                  <input type="checkbox" checked={calendar.allDay} onChange={(event) => setCalendar((current) => ({ ...current, allDay: event.target.checked }))} disabled={busy} />
                  <span>All-day event</span>
                </label>
                <div className="settings-form-grid">
                  <label>Start date<input type="date" value={calendar.startDate} onChange={(event) => setCalendar((current) => ({ ...current, startDate: event.target.value }))} disabled={busy} /></label>
                  {!calendar.allDay && <label>Start time<input type="time" value={calendar.startTime} onChange={(event) => setCalendar((current) => ({ ...current, startTime: event.target.value }))} disabled={busy} /></label>}
                  <label>End date<input type="date" value={calendar.endDate} onChange={(event) => setCalendar((current) => ({ ...current, endDate: event.target.value }))} disabled={busy} /></label>
                  {!calendar.allDay && <label>End time<input type="time" value={calendar.endTime} onChange={(event) => setCalendar((current) => ({ ...current, endTime: event.target.value }))} disabled={busy} /></label>}
                </div>
                <label>Location<input value={calendar.location} maxLength={500} onChange={(event) => setCalendar((current) => ({ ...current, location: event.target.value }))} disabled={busy} /></label>
                <label>Description<textarea rows={5} value={calendar.description} maxLength={10_000} onChange={(event) => setCalendar((current) => ({ ...current, description: event.target.value }))} disabled={busy} /></label>
              </>
            ) : (
              <>
                <label>Due date<input autoFocus type="date" value={todo.date} onChange={(event) => setTodo((current) => ({ ...current, date: event.target.value }))} disabled={busy} /></label>
                <label>To-do<textarea rows={4} value={todo.text} maxLength={2_000} onChange={(event) => setTodo((current) => ({ ...current, text: event.target.value }))} disabled={busy} /></label>
                <small className="settings-hint">To-dos are stored locally and appear in the Calendar view for the selected date.</small>
              </>
            )}
            <div className="settings-button-row">
              <button className="primary-button" disabled={busy || !ready}>
                {busy ? <LoaderCircle className="spin" size={16} /> : action === "calendar_event" ? <CalendarPlus size={16} /> : <ListTodo size={16} />}
                {action === "calendar_event" ? "Create calendar event" : "Create to-do"}
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

function localDateTimeToIso(date: string, time: string): string {
  const parsed = new Date(`${date}T${time}`);
  if (Number.isNaN(parsed.getTime())) throw new Error("Enter a valid event date and time");
  return parsed.toISOString();
}

function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString([], { dateStyle: "medium" });
}
