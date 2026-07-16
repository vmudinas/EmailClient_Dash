import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  HelpCircle,
  KeyRound,
  LoaderCircle,
  Plus,
  Trash2,
  Users,
  Video,
  X
} from "lucide-react";
import type { CalendarEvent, CalendarEventAttendee, CalendarEventInput, CalendarEventOrganizer, GmailConnection, TodoItem } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

interface CalendarViewProps {
  api: ApiClient;
  connections: GmailConnection[];
  onReauthorize(connection: GmailConnection): void;
  onError(message: string): void;
}

interface EventDraft {
  connectionId: string;
  eventId: string | null;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  startAt: string;
  endAt: string;
  meetingLink: string | null;
  organizer: CalendarEventOrganizer | null;
  attendees: CalendarEventAttendee[];
}

export function CalendarView({ api, connections, onReauthorize, onError }: CalendarViewProps) {
  const calendarConnections = connections.filter((connection) => connection.canManageCalendar);
  const [date, setDate] = useState(todayIso());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodoText, setNewTodoText] = useState("");
  const [todoBusy, setTodoBusy] = useState(false);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [eventBusy, setEventBusy] = useState(false);

  const loadEvents = useCallback(async () => {
    if (calendarConnections.length === 0) {
      setEvents([]);
      return;
    }
    setLoadingEvents(true);
    try {
      const { startOfDay, endOfDay } = dayBoundsIso(date);
      const results = await Promise.all(calendarConnections.map((connection) => (
        api.listCalendarEvents(connection.id, startOfDay, endOfDay).catch(() => [] as CalendarEvent[])
      )));
      setEvents(results.flat().sort((a, b) => a.startAt.localeCompare(b.startAt)));
    } finally {
      setLoadingEvents(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, date, calendarConnections.map((connection) => connection.id).join(",")]);

  const loadTodos = useCallback(async () => {
    const loaded = await api.listTodos(date, date).catch(() => [] as TodoItem[]);
    setTodos(loaded);
  }, [api, date]);

  useEffect(() => { void loadEvents(); }, [loadEvents]);
  useEffect(() => { void loadTodos(); }, [loadTodos]);

  const addTodo = async () => {
    const text = newTodoText.trim();
    if (!text) return;
    setTodoBusy(true);
    try {
      const created = await api.createTodo({ date, text });
      setTodos((current) => [...current, created]);
      setNewTodoText("");
    } catch (error) {
      onError(errorText(error));
    } finally {
      setTodoBusy(false);
    }
  };

  const toggleTodo = async (todo: TodoItem) => {
    try {
      const updated = await api.updateTodo(todo.id, { completed: !todo.completed });
      setTodos((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (error) {
      onError(errorText(error));
    }
  };

  const removeTodo = async (todo: TodoItem) => {
    try {
      await api.deleteTodo(todo.id);
      setTodos((current) => current.filter((entry) => entry.id !== todo.id));
    } catch (error) {
      onError(errorText(error));
    }
  };

  const saveEvent = async (input: EventDraft) => {
    setEventBusy(true);
    try {
      const payload: CalendarEventInput = {
        title: input.title.trim(),
        description: input.description.trim(),
        location: input.location.trim(),
        allDay: input.allDay,
        startAt: input.allDay ? input.startAt : new Date(input.startAt).toISOString(),
        endAt: input.allDay ? input.endAt : new Date(input.endAt).toISOString()
      };
      if (input.eventId) {
        await api.updateCalendarEvent(input.connectionId, input.eventId, payload);
      } else {
        await api.createCalendarEvent(input.connectionId, payload);
      }
      setDraft(null);
      await loadEvents();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setEventBusy(false);
    }
  };

  const removeEvent = async (event: CalendarEvent) => {
    if (!window.confirm(`Delete "${event.title}" from Google Calendar?`)) return;
    try {
      await api.deleteCalendarEvent(event.connectionId, event.id);
      setEvents((current) => current.filter((entry) => entry.id !== event.id));
    } catch (error) {
      onError(errorText(error));
    }
  };

  return (
    <div className="calendar-workspace">
      <section className="calendar-day-panel">
        <header className="calendar-day-header">
          <div className="calendar-day-nav">
            <button className="icon-button" onClick={() => setDate((current) => addDays(current, -1))} title="Previous day" aria-label="Previous day"><ChevronLeft size={18} /></button>
            <button className="text-button" onClick={() => setDate(todayIso())}>Today</button>
            <button className="icon-button" onClick={() => setDate((current) => addDays(current, 1))} title="Next day" aria-label="Next day"><ChevronRight size={18} /></button>
          </div>
          <h2><CalendarDays size={19} /> {formatDayHeading(date)}</h2>
          {calendarConnections.length > 0 && (
            <button
              className="primary-button compact"
              onClick={() => setDraft(emptyDraft(calendarConnections[0]!.id, date))}
            ><Plus size={16} /> New event</button>
          )}
        </header>

        {calendarConnections.length === 0 ? (
          <div className="compose-empty">
            <CalendarDays size={22} />
            <strong>No calendar-connected Gmail accounts</strong>
            {connections.length === 0 ? (
              <p>Connect a Gmail account to grant calendar access.</p>
            ) : (
              <>
                <p>Reauthorize an existing account to grant calendar access.</p>
                <ul className="calendar-reauth-list">
                  {connections.map((connection) => (
                    <li key={connection.id}>
                      <span>{connection.email}</span>
                      <button
                        className="primary-button compact"
                        onClick={() => onReauthorize(connection)}
                        aria-label={`Reauthorize ${connection.email} for calendar access`}
                      ><KeyRound size={14} /> Reauthorize</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : loadingEvents ? (
          <div className="calendar-loading"><LoaderCircle className="spin" size={20} /></div>
        ) : events.length === 0 ? (
          <div className="calendar-empty">No events on this day.</div>
        ) : (
          <ul className="calendar-event-list">
            {events.map((event) => (
              <li
                className="calendar-event-card"
                key={`${event.connectionId}:${event.id}`}
                role="button"
                tabIndex={0}
                onClick={() => setDraft(draftFromEvent(event))}
                onKeyDown={(keyEvent) => {
                  if (keyEvent.key === "Enter" || keyEvent.key === " ") {
                    keyEvent.preventDefault();
                    setDraft(draftFromEvent(event));
                  }
                }}
                aria-label={`View details for ${event.title}`}
              >
                <div className="calendar-event-time">{formatEventTime(event)}</div>
                <div className="calendar-event-copy">
                  <strong>{event.title}</strong>
                  {event.location && <span>{event.location}</span>}
                  <small>{calendarConnections.find((connection) => connection.id === event.connectionId)?.email}</small>
                </div>
                <div className="calendar-event-actions">
                  <button
                    className="icon-button"
                    onClick={(clickEvent) => { clickEvent.stopPropagation(); void removeEvent(event); }}
                    title="Delete event"
                    aria-label={`Delete ${event.title}`}
                  ><Trash2 size={15} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="todo-panel">
        <h3>To-do <span className="gmail-count">{todos.filter((todo) => !todo.completed).length}</span></h3>
        <p className="todo-hint">Local only — not synced to Gmail or Calendar.</p>
        <form className="todo-add" onSubmit={(event) => { event.preventDefault(); void addTodo(); }}>
          <input
            value={newTodoText}
            onChange={(event) => setNewTodoText(event.target.value)}
            placeholder="Add a to-do for this day"
            disabled={todoBusy}
          />
          <button className="icon-button" disabled={todoBusy || !newTodoText.trim()} title="Add to-do" aria-label="Add to-do"><Plus size={16} /></button>
        </form>
        {todos.length === 0 ? (
          <p className="todo-empty">Nothing on the list yet.</p>
        ) : (
          <ul className="todo-list">
            {todos.map((todo) => (
              <li className={`todo-item ${todo.completed ? "completed" : ""}`} key={todo.id}>
                <button className="todo-check" onClick={() => void toggleTodo(todo)} aria-label={todo.completed ? "Mark not done" : "Mark done"}>
                  {todo.completed && <Check size={14} />}
                </button>
                <span>{todo.text}</span>
                <button className="icon-button" onClick={() => void removeTodo(todo)} title="Delete to-do" aria-label={`Delete ${todo.text}`}><Trash2 size={14} /></button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {draft && (
        <EventDialog
          draft={draft}
          connections={calendarConnections}
          busy={eventBusy}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onSave={() => void saveEvent(draft)}
        />
      )}
    </div>
  );
}

function EventDialog({
  draft,
  connections,
  busy,
  onChange,
  onClose,
  onSave
}: {
  draft: EventDraft;
  connections: GmailConnection[];
  busy: boolean;
  onChange(value: EventDraft): void;
  onClose(): void;
  onSave(): void;
}) {
  const ready = Boolean(draft.title.trim() && draft.startAt && draft.endAt);
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => { if (!busy) onClose(); }}>
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="event-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header">
          <div><CalendarDays size={20} /><h2 id="event-title">{draft.eventId ? "Edit event" : "New event"}</h2></div>
          <button className="icon-button" disabled={busy} onClick={onClose} title="Close" aria-label="Close"><X size={18} /></button>
        </header>
        <div className="dialog-body">
          {(draft.meetingLink || draft.attendees.length > 0 || draft.organizer) && (
            <div className="calendar-event-details">
              {draft.meetingLink && (
                <a className="calendar-meet-link" href={draft.meetingLink} target="_blank" rel="noreferrer">
                  <Video size={15} /> Join with Google Meet <ExternalLink size={12} />
                </a>
              )}
              {draft.organizer && !draft.attendees.some((attendee) => attendee.email === draft.organizer!.email) && (
                <div className="calendar-organizer">Organized by {draft.organizer.displayName || draft.organizer.email}</div>
              )}
              {draft.attendees.length > 0 && (
                <div className="calendar-attendees">
                  <h4><Users size={14} /> Guests ({draft.attendees.length})</h4>
                  <ul>
                    {draft.attendees.map((attendee) => (
                      <li key={attendee.email}>
                        {attendeeStatusIcon(attendee.responseStatus)}
                        <span>{attendee.displayName || attendee.email}</span>
                        {attendee.organizer && <em>Organizer</em>}
                        {attendee.self && <em>You</em>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <form className="settings-form" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
            {connections.length > 1 && (
              <label>Calendar account
                <select value={draft.connectionId} onChange={(event) => onChange({ ...draft, connectionId: event.target.value })} disabled={busy || Boolean(draft.eventId)}>
                  {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.email}</option>)}
                </select>
              </label>
            )}
            <label>Title
              <input autoFocus value={draft.title} maxLength={500} onChange={(event) => onChange({ ...draft, title: event.target.value })} disabled={busy} />
            </label>
            <label className="settings-checkbox">
              <input
                type="checkbox"
                checked={draft.allDay}
                onChange={(event) => {
                  const allDay = event.target.checked;
                  onChange({
                    ...draft,
                    allDay,
                    startAt: allDay ? toDateValue(draft.startAt) : toDatetimeLocalValue(draft.startAt),
                    endAt: allDay ? toDateValue(draft.endAt) : toDatetimeLocalValue(draft.endAt)
                  });
                }}
                disabled={busy}
              />
              <span>All-day event</span>
            </label>
            <label>Starts
              <input
                type={draft.allDay ? "date" : "datetime-local"}
                value={draft.startAt}
                onChange={(event) => onChange({ ...draft, startAt: event.target.value })}
                disabled={busy}
              />
            </label>
            <label>Ends
              <input
                type={draft.allDay ? "date" : "datetime-local"}
                value={draft.endAt}
                onChange={(event) => onChange({ ...draft, endAt: event.target.value })}
                disabled={busy}
              />
            </label>
            <label>Location
              <input value={draft.location} maxLength={500} onChange={(event) => onChange({ ...draft, location: event.target.value })} disabled={busy} />
            </label>
            <label>Description
              <textarea value={draft.description} maxLength={10_000} onChange={(event) => onChange({ ...draft, description: event.target.value })} disabled={busy} />
            </label>
          </form>
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !ready} onClick={onSave}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save
          </button>
        </footer>
        {!ready && <div className="import-error" role="alert"><CircleAlert size={18} /><div><span>Add a title and valid dates.</span></div></div>}
      </section>
    </div>
  );
}

function attendeeStatusIcon(status: CalendarEventAttendee["responseStatus"]) {
  switch (status) {
    case "accepted":
      return <Check className="attendee-status accepted" size={13} aria-label="Accepted" />;
    case "declined":
      return <X className="attendee-status declined" size={13} aria-label="Declined" />;
    case "tentative":
      return <HelpCircle className="attendee-status tentative" size={13} aria-label="Maybe" />;
    default:
      return <CircleDashed className="attendee-status pending" size={13} aria-label="No response yet" />;
  }
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayBoundsIso(dateIso: string): { startOfDay: string; endOfDay: string } {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day, 0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return { startOfDay: start.toISOString(), endOfDay: end.toISOString() };
}

function formatDayHeading(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

function formatEventTime(event: CalendarEvent): string {
  if (event.allDay) return "All day";
  const start = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(event.startAt));
  const end = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(event.endAt));
  return `${start} – ${end}`;
}

function toDatetimeLocalValue(value: string): string {
  const date = value.length === 10 ? new Date(`${value}T09:00:00`) : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateValue(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function emptyDraft(connectionId: string, dateIso: string): EventDraft {
  return {
    connectionId,
    eventId: null,
    title: "",
    description: "",
    location: "",
    allDay: false,
    startAt: `${dateIso}T09:00`,
    endAt: `${dateIso}T10:00`,
    meetingLink: null,
    organizer: null,
    attendees: []
  };
}

function draftFromEvent(event: CalendarEvent): EventDraft {
  return {
    connectionId: event.connectionId,
    eventId: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    allDay: event.allDay,
    startAt: event.allDay ? event.startAt : toDatetimeLocalValue(event.startAt),
    endAt: event.allDay ? event.endAt : toDatetimeLocalValue(event.endAt),
    meetingLink: event.meetingLink,
    organizer: event.organizer,
    attendees: event.attendees
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}
