import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Apple,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  HelpCircle,
  KeyRound,
  ListFilter,
  ListTodo,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  Video,
  X
} from "lucide-react";
import type {
  CalendarEvent,
  CalendarEventAttendee,
  CalendarEventInput,
  CalendarEventOrganizer,
  CalendarSource,
  GmailConnection,
  TodoItem
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { useMediaQuery } from "../lib/use-media-query.js";

const HOUR_HEIGHT = 64;
const CALENDAR_SELECTION_KEY = "archive-mail.calendar.sources.v1";

interface CalendarViewProps {
  api: ApiClient;
  connections: GmailConnection[];
  onReauthorize(connection: GmailConnection): void;
  onError(message: string): void;
}

interface EventDraft {
  sourceId: string;
  eventId: string | null;
  readOnly: boolean;
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

interface PositionedEvent {
  event: CalendarEvent;
  top: number;
  height: number;
  column: number;
  columns: number;
}

interface DaySummary {
  eventTitles: string[];
  todoTexts: string[];
}

export function CalendarView({ api, connections, onReauthorize, onError }: CalendarViewProps) {
  const mobile = useMediaQuery("(max-width: 800px)");
  const [date, setDate] = useState(todayIso());
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [sources, setSources] = useState<CalendarSource[]>([]);
  const [selectedSourceIds, setSelectedSourceIds] = useState<Set<string>>(new Set());
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [newTodoText, setNewTodoText] = useState("");
  const [todoBusy, setTodoBusy] = useState(false);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  const [monthSummary, setMonthSummary] = useState<Map<string, DaySummary>>(new Map());
  const [mobilePanel, setMobilePanel] = useState<"calendars" | "todos" | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  const selectedSources = useMemo(
    () => sources.filter((source) => selectedSourceIds.has(source.id)),
    [sources, selectedSourceIds]
  );
  const sourceById = useMemo(() => new Map(sources.map((source) => [source.id, source])), [sources]);
  const sourceGroups = useMemo(() => groupSources(sources), [sources]);
  const writableSource = selectedSources.find((source) => !source.readOnly) ?? null;

  const loadSources = useCallback(async () => {
    setSourcesLoading(true);
    setSourcesError(null);
    try {
      const loaded = await api.listCalendarSources();
      setSources(loaded);
      setSelectedSourceIds((current) => initialSourceSelection(loaded, current));
    } catch (error) {
      const message = errorText(error);
      setSourcesError(message);
      onError(message);
    } finally {
      setSourcesLoading(false);
    }
  }, [api, onError]);

  const loadEvents = useCallback(async () => {
    if (selectedSources.length === 0) {
      setEvents([]);
      return;
    }
    setLoadingEvents(true);
    const { startOfDay, endOfDay } = dayBoundsIso(date);
    try {
      const results = await Promise.allSettled(selectedSources.map(async (source) => {
        const loaded = await api.listCalendarSourceEvents(source.id, startOfDay, endOfDay);
        return loaded.map((event) => ({
          ...event,
          sourceId: source.id,
          provider: source.provider,
          calendarName: source.name,
          calendarColor: source.color
        }));
      }));
      setEvents(results.flatMap((result) => result.status === "fulfilled" ? result.value : []));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) onError(`${failures.length} selected calendar${failures.length === 1 ? "" : "s"} could not be loaded.`);
    } finally {
      setLoadingEvents(false);
    }
  }, [api, date, onError, selectedSources]);

  const loadTodos = useCallback(async () => {
    try {
      setTodos(await api.listTodos(date, date));
    } catch (error) {
      onError(errorText(error));
    }
  }, [api, date, onError]);

  const loadMonthSummary = useCallback(async () => {
    const grid = monthDays(month);
    const gridStart = grid[0]!.date;
    const gridEnd = grid[grid.length - 1]!.date;
    const summary = new Map<string, DaySummary>();
    const addEvent = (dateIso: string, title: string) => {
      const entry = summary.get(dateIso) ?? { eventTitles: [], todoTexts: [] };
      entry.eventTitles.push(title);
      summary.set(dateIso, entry);
    };
    const addTodo = (dateIso: string, text: string) => {
      const entry = summary.get(dateIso) ?? { eventTitles: [], todoTexts: [] };
      entry.todoTexts.push(text);
      summary.set(dateIso, entry);
    };
    try {
      if (selectedSources.length > 0) {
        const { startOfDay } = dayBoundsIso(gridStart);
        const { endOfDay } = dayBoundsIso(gridEnd);
        const results = await Promise.allSettled(
          selectedSources.map((source) => api.listCalendarSourceEvents(source.id, startOfDay, endOfDay))
        );
        for (const result of results) {
          if (result.status !== "fulfilled") continue;
          for (const event of result.value) {
            for (const dateIso of eventDates(event)) addEvent(dateIso, event.title);
          }
        }
      }
      for (const todo of await api.listTodos(gridStart, gridEnd)) addTodo(todo.date, todo.text);
    } catch {
      // Best-effort: the mini month just shows no highlights if this fails.
    }
    setMonthSummary(summary);
  }, [api, month, selectedSources]);

  useEffect(() => { void loadSources(); }, [loadSources]);
  useEffect(() => { void loadEvents(); }, [loadEvents]);
  useEffect(() => { void loadTodos(); }, [loadTodos]);
  useEffect(() => { void loadMonthSummary(); }, [loadMonthSummary]);
  useEffect(() => { setMonth(date.slice(0, 7)); }, [date]);
  useEffect(() => {
    if (sourcesLoading) return;
    window.localStorage.setItem(CALENDAR_SELECTION_KEY, JSON.stringify([...selectedSourceIds]));
  }, [selectedSourceIds, sourcesLoading]);
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const currentHour = date === todayIso() ? new Date().getHours() : 8;
    timeline.scrollTop = Math.max(0, (currentHour - 1) * HOUR_HEIGHT);
  }, [date, sourcesLoading]);

  const changeSourceSelection = (sourceId: string, selected: boolean) => {
    setSelectedSourceIds((current) => {
      const next = new Set(current);
      if (selected) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  };

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
      setTodos((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
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
      if (input.eventId) await api.updateCalendarSourceEvent(input.sourceId, input.eventId, payload);
      else await api.createCalendarSourceEvent(input.sourceId, payload);
      setDraft(null);
      await loadEvents();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setEventBusy(false);
    }
  };

  const removeEvent = async (event: CalendarEvent) => {
    const sourceId = event.sourceId;
    if (!sourceId || !window.confirm(`Delete "${event.title}" from ${event.calendarName || "this calendar"}?`)) return;
    try {
      await api.deleteCalendarSourceEvent(sourceId, event.id);
      setEvents((current) => current.filter((entry) => !(entry.sourceId === sourceId && entry.id === event.id)));
    } catch (error) {
      onError(errorText(error));
    }
  };

  const openNewEvent = (hour = 9) => {
    if (!writableSource) return;
    setDraft(emptyDraft(writableSource.id, date, hour));
  };

  const allDayEvents = events.filter((event) => event.allDay);
  const agendaEvents = [...events].sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    return left.startAt.localeCompare(right.startAt);
  });
  const positionedEvents = positionTimedEvents(events.filter((event) => !event.allDay), date);
  const currentMinute = date === todayIso() ? minutesIntoDay(new Date()) : null;
  const missingCalendarConnections = connections.filter((connection) => !connection.canManageCalendar);
  const hasAuthorizedGoogleCalendar = connections.some((connection) => connection.canManageCalendar);
  const needsAuthorization = !hasAuthorizedGoogleCalendar && missingCalendarConnections.length > 0;

  return (
    <div className={`calendar-workspace mobile-calendar-panel-${mobilePanel ?? "none"}`}>
      <aside className="calendar-sidebar">
        <div className="calendar-sidebar-heading">
          <div><CalendarDays size={17} /><strong>Calendars</strong></div>
          <div className="calendar-sidebar-actions">
            <button className="icon-button" onClick={() => void loadSources()} disabled={sourcesLoading} title="Refresh calendars" aria-label="Refresh calendars">
              <RefreshCw className={sourcesLoading ? "spin" : ""} size={15} />
            </button>
            <button className="icon-button mobile-only" onClick={() => setMobilePanel(null)} aria-label="Close calendar filters"><X size={17} /></button>
          </div>
        </div>
        <div className="calendar-selection-actions">
          <button className="text-button" onClick={() => setSelectedSourceIds(new Set(sources.map((source) => source.id)))}>Select all</button>
          <button className="text-button" onClick={() => setSelectedSourceIds(new Set())}>Clear</button>
        </div>
        <div className="calendar-source-list">
          {sourcesLoading && sources.length === 0 ? (
            <div className="calendar-source-loading"><LoaderCircle className="spin" size={16} /> Loading calendars</div>
          ) : sourceGroups.length === 0 ? (
            <p className="calendar-source-empty">{needsAuthorization ? "Authorize Google or Apple Calendar in Admin settings." : "No calendars were returned. Refresh or check provider settings."}</p>
          ) : sourceGroups.map((group) => (
            <section className="calendar-source-group" key={group.key}>
              <h3>{group.provider === "apple" ? <Apple size={13} /> : <span className="google-calendar-mark">G</span>}{group.accountLabel}</h3>
              {group.sources.map((source) => (
                <label className="calendar-source-option" key={source.id} title={source.name}>
                  <input
                    type="checkbox"
                    checked={selectedSourceIds.has(source.id)}
                    onChange={(event) => changeSourceSelection(source.id, event.target.checked)}
                  />
                  <span className="calendar-color" style={{ backgroundColor: source.color }} />
                  <span>{source.name}</span>
                  {source.readOnly && <small>read only</small>}
                </label>
              ))}
            </section>
          ))}
        </div>
        <MiniMonth month={month} selectedDate={date} monthSummary={monthSummary} onMonthChange={setMonth} onSelectDate={(value) => { setDate(value); setMobilePanel(null); }} />
      </aside>

      <section className="calendar-day-panel">
        <header className="calendar-day-header">
          <div className="calendar-day-nav">
            <button className="icon-button" onClick={() => setDate((current) => addDays(current, -1))} title="Previous day" aria-label="Previous day"><ChevronLeft size={18} /></button>
            <button className="text-button" onClick={() => setDate(todayIso())}>Today</button>
            <button className="icon-button" onClick={() => setDate((current) => addDays(current, 1))} title="Next day" aria-label="Next day"><ChevronRight size={18} /></button>
          </div>
          <h2><CalendarDays size={19} /> {formatDayHeading(date)}</h2>
          <button className="primary-button compact" onClick={() => openNewEvent()} disabled={!writableSource} title={writableSource ? "Create event" : "Select a writable calendar"}>
            <Plus size={16} /> New event
          </button>
          <div className="mobile-calendar-tools mobile-only">
            <button className="icon-button" onClick={() => setMobilePanel("calendars")} aria-label="Choose calendars and date"><ListFilter size={18} /></button>
            <button className="icon-button" onClick={() => setMobilePanel("todos")} aria-label="Open to-do list">
              <ListTodo size={18} />{todos.filter((todo) => !todo.completed).length > 0 && <span>{todos.filter((todo) => !todo.completed).length}</span>}
            </button>
          </div>
        </header>

        {sources.length === 0 && !sourcesLoading && (
          <div className="calendar-connect-banner">
            <CalendarDays size={22} />
            <div>
              <strong>{needsAuthorization ? "No authorized calendars" : "No calendars available"}</strong>
              <p>{sourcesError ?? (needsAuthorization
                ? "Open Admin settings → Calendars to add Google accounts or Apple iCloud calendars."
                : "Refresh calendars or check the provider connection in Admin settings → Calendars.")}</p>
            </div>
            {missingCalendarConnections.length > 0 && (
              <ul className="calendar-reauth-list">
                {missingCalendarConnections.map((connection) => (
                  <li key={connection.id}>
                    <span>{connection.email}</span>
                    <button className="primary-button compact" onClick={() => onReauthorize(connection)} aria-label={`Reauthorize ${connection.email} for calendar access`}>
                      <KeyRound size={14} /> Reauthorize
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {!mobile && <><div className="calendar-all-day">
          <span>all-day</span>
          <div className="calendar-all-day-events">
            {allDayEvents.map((event) => (
              <button
                key={`${event.sourceId}:${event.id}`}
                className="calendar-all-day-event"
                style={eventStyle(event)}
                onClick={() => setDraft(draftFromEvent(event, sourceById.get(event.sourceId ?? "")))}
                aria-label={`View details for ${event.title}`}
              >{event.title}</button>
            ))}
          </div>
        </div>
        <div className="calendar-timeline-scroll" ref={timelineRef}>
          <div className="calendar-timeline" style={{ height: 24 * HOUR_HEIGHT }}>
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                className="calendar-hour-row"
                key={hour}
                style={{ height: HOUR_HEIGHT, top: hour * HOUR_HEIGHT }}
                onDoubleClick={() => openNewEvent(hour)}
              >
                <span>{formatHour(hour)}</span>
              </div>
            ))}
            <div className="calendar-event-layer">
              {positionedEvents.map(({ event, top, height, column, columns }) => (
                <button
                  className="calendar-timed-event"
                  key={`${event.sourceId}:${event.id}`}
                  style={{
                    ...eventStyle(event),
                    top,
                    height,
                    left: `${(column / columns) * 100}%`,
                    width: `calc(${100 / columns}% - 5px)`
                  }}
                  onClick={() => setDraft(draftFromEvent(event, sourceById.get(event.sourceId ?? "")))}
                  aria-label={`View details for ${event.title}`}
                >
                  <strong>{event.title}</strong>
                  <span>{formatEventTime(event)}{event.location ? ` · ${event.location}` : ""}</span>
                </button>
              ))}
              {currentMinute !== null && (
                <div className="calendar-now-line" style={{ top: currentMinute * HOUR_HEIGHT / 60 }}><span /></div>
              )}
              {loadingEvents && <div className="calendar-loading-overlay"><LoaderCircle className="spin" size={20} /></div>}
              {!loadingEvents && selectedSources.length === 0 && <div className="calendar-timeline-message">Select one or more calendars.</div>}
              {!loadingEvents && selectedSources.length > 0 && events.length === 0 && <div className="calendar-timeline-message">No events on this day.</div>}
            </div>
          </div>
        </div></>}
        {mobile && <section className="calendar-mobile-agenda" aria-label={`Agenda for ${formatDayHeading(date)}`}>
          {loadingEvents ? (
            <div className="calendar-loading"><LoaderCircle className="spin" size={20} /> Loading events</div>
          ) : selectedSources.length === 0 ? (
            <div className="calendar-empty">Choose one or more calendars.</div>
          ) : agendaEvents.length === 0 ? (
            <div className="calendar-empty">No events on this day.</div>
          ) : agendaEvents.map((event) => (
            <button
              className="calendar-agenda-card"
              key={`${event.sourceId}:${event.id}`}
              onClick={() => setDraft(draftFromEvent(event, sourceById.get(event.sourceId ?? "")))}
              aria-label={`View details for ${event.title}`}
            >
              <span className="calendar-agenda-color" style={{ backgroundColor: event.calendarColor || "#176747" }} />
              <span className="calendar-agenda-time">{event.allDay ? "All day" : formatEventTime(event)}</span>
              <span className="calendar-agenda-copy">
                <strong>{event.title}</strong>
                <small>{[event.calendarName, event.location].filter(Boolean).join(" · ")}</small>
              </span>
              <ChevronRight size={17} />
            </button>
          ))}
        </section>}
      </section>

      <aside className="todo-panel">
        <div className="todo-panel-heading">
          <h3>To-do <span className="gmail-count">{todos.filter((todo) => !todo.completed).length}</span></h3>
          <button className="icon-button mobile-only" onClick={() => setMobilePanel(null)} aria-label="Close to-do list"><X size={17} /></button>
        </div>
        <p className="todo-hint">Local only — not synced to Gmail or Calendar.</p>
        <form className="todo-add" onSubmit={(event) => { event.preventDefault(); void addTodo(); }}>
          <input value={newTodoText} onChange={(event) => setNewTodoText(event.target.value)} placeholder="Add a to-do for this day" disabled={todoBusy} />
          <button className="icon-button" disabled={todoBusy || !newTodoText.trim()} title="Add to-do" aria-label="Add to-do"><Plus size={16} /></button>
        </form>
        {todos.length === 0 ? <p className="todo-empty">Nothing on the list yet.</p> : (
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
          sources={sources.filter((source) => !source.readOnly)}
          busy={eventBusy}
          onChange={setDraft}
          onClose={() => setDraft(null)}
          onDelete={draft.eventId && !draft.readOnly ? () => {
            const target = events.find((event) => event.id === draft.eventId && event.sourceId === draft.sourceId);
            if (target) void removeEvent(target).then(() => setDraft(null));
          } : undefined}
          onSave={() => void saveEvent(draft)}
        />
      )}
    </div>
  );
}

function MiniMonth({
  month,
  selectedDate,
  monthSummary,
  onMonthChange,
  onSelectDate
}: {
  month: string;
  selectedDate: string;
  monthSummary: Map<string, DaySummary>;
  onMonthChange(value: string): void;
  onSelectDate(value: string): void;
}) {
  const days = monthDays(month);
  return (
    <section className="calendar-mini-month" aria-label="Monthly date picker">
      <header>
        <button className="icon-button" onClick={() => onMonthChange(addMonths(month, -1))} aria-label="Previous month"><ChevronLeft size={15} /></button>
        <strong>{formatMonth(month)}</strong>
        <button className="icon-button" onClick={() => onMonthChange(addMonths(month, 1))} aria-label="Next month"><ChevronRight size={15} /></button>
      </header>
      <div className="calendar-mini-weekdays">{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
      <div className="calendar-mini-grid">
        {days.map((day) => {
          const summary = monthSummary.get(day.date);
          const hasEvents = Boolean(summary?.eventTitles.length);
          const hasTodos = Boolean(summary?.todoTexts.length);
          return (
            <button
              key={day.date}
              className={[
                day.currentMonth ? "" : "outside",
                day.date === selectedDate ? "selected" : "",
                day.date === todayIso() ? "today" : "",
                hasEvents || hasTodos ? "has-items" : ""
              ].filter(Boolean).join(" ")}
              onClick={() => onSelectDate(day.date)}
              aria-label={ariaLabelForDay(day.date, summary)}
              aria-pressed={day.date === selectedDate}
              title={dayTooltip(summary)}
            >
              <span className="mini-day-number">{Number(day.date.slice(-2))}</span>
              {(hasEvents || hasTodos) && (
                <span className="mini-day-dots">
                  {hasEvents && <span className="mini-day-dot events" />}
                  {hasTodos && <span className="mini-day-dot todos" />}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function dayTooltip(summary: DaySummary | undefined): string | undefined {
  if (!summary || (summary.eventTitles.length === 0 && summary.todoTexts.length === 0)) return undefined;
  const lines: string[] = [];
  if (summary.eventTitles.length > 0) {
    lines.push(`Events (${summary.eventTitles.length}):`);
    lines.push(...summary.eventTitles.slice(0, 6).map((title) => `• ${title}`));
    if (summary.eventTitles.length > 6) lines.push(`• +${summary.eventTitles.length - 6} more`);
  }
  if (summary.todoTexts.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`To-dos (${summary.todoTexts.length}):`);
    lines.push(...summary.todoTexts.slice(0, 6).map((text) => `• ${text}`));
    if (summary.todoTexts.length > 6) lines.push(`• +${summary.todoTexts.length - 6} more`);
  }
  return lines.join("\n");
}

function ariaLabelForDay(dateIso: string, summary: DaySummary | undefined): string {
  const label = formatDateLabel(dateIso);
  const parts: string[] = [];
  if (summary?.eventTitles.length) parts.push(`${summary.eventTitles.length} event${summary.eventTitles.length === 1 ? "" : "s"}`);
  if (summary?.todoTexts.length) parts.push(`${summary.todoTexts.length} to-do${summary.todoTexts.length === 1 ? "" : "s"}`);
  return parts.length > 0 ? `${label}, ${parts.join(", ")}` : label;
}

function eventDates(event: CalendarEvent): string[] {
  if (!event.allDay) return [dateToIso(new Date(event.startAt))];
  const start = event.startAt.slice(0, 10);
  const end = event.endAt.slice(0, 10);
  const dates: string[] = [];
  let cursor = localDate(start);
  const endDate = localDate(end);
  let guard = 0;
  while (cursor.getTime() <= endDate.getTime() && guard < 62) {
    dates.push(dateToIso(cursor));
    cursor = new Date(cursor);
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return dates;
}

function EventDialog({
  draft,
  sources,
  busy,
  onChange,
  onClose,
  onDelete,
  onSave
}: {
  draft: EventDraft;
  sources: CalendarSource[];
  busy: boolean;
  onChange(value: EventDraft): void;
  onClose(): void;
  onDelete?: () => void;
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
                  <Video size={15} /> Join video meeting <ExternalLink size={12} />
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
          {draft.readOnly && <div className="settings-warning neutral"><CircleAlert size={16} /><span>This calendar is read only.</span></div>}
          <form className="settings-form" onSubmit={(event) => { event.preventDefault(); if (!draft.readOnly) onSave(); }}>
            {sources.length > 1 && (
              <label>Calendar
                <select value={draft.sourceId} onChange={(event) => onChange({ ...draft, sourceId: event.target.value })} disabled={busy || Boolean(draft.eventId)}>
                  {sources.map((source) => <option key={source.id} value={source.id}>{source.accountLabel} — {source.name}</option>)}
                </select>
              </label>
            )}
            <label>Title<input autoFocus value={draft.title} maxLength={500} onChange={(event) => onChange({ ...draft, title: event.target.value })} disabled={busy || draft.readOnly} /></label>
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
                disabled={busy || draft.readOnly}
              />
              <span>All-day event</span>
            </label>
            <label>Starts<input type={draft.allDay ? "date" : "datetime-local"} value={draft.startAt} onChange={(event) => onChange({ ...draft, startAt: event.target.value })} disabled={busy || draft.readOnly} /></label>
            <label>Ends<input type={draft.allDay ? "date" : "datetime-local"} value={draft.endAt} onChange={(event) => onChange({ ...draft, endAt: event.target.value })} disabled={busy || draft.readOnly} /></label>
            <label>Location<input value={draft.location} maxLength={500} onChange={(event) => onChange({ ...draft, location: event.target.value })} disabled={busy || draft.readOnly} /></label>
            <label>Description<textarea value={draft.description} maxLength={10_000} onChange={(event) => onChange({ ...draft, description: event.target.value })} disabled={busy || draft.readOnly} /></label>
          </form>
        </div>
        <footer className="dialog-footer calendar-dialog-footer">
          {onDelete && <button className="danger-button" disabled={busy} onClick={onDelete}><Trash2 size={15} /> Delete</button>}
          <span />
          <button className="secondary-button" disabled={busy} onClick={onClose}>{draft.readOnly ? "Close" : "Cancel"}</button>
          {!draft.readOnly && (
            <button className="primary-button" disabled={busy || !ready} onClick={onSave}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Save
            </button>
          )}
        </footer>
        {!draft.readOnly && !ready && <div className="import-error" role="alert"><CircleAlert size={18} /><div><span>Add a title and valid dates.</span></div></div>}
      </section>
    </div>
  );
}

function attendeeStatusIcon(status: CalendarEventAttendee["responseStatus"]) {
  switch (status) {
    case "accepted": return <Check className="attendee-status accepted" size={13} aria-label="Accepted" />;
    case "declined": return <X className="attendee-status declined" size={13} aria-label="Declined" />;
    case "tentative": return <HelpCircle className="attendee-status tentative" size={13} aria-label="Maybe" />;
    default: return <CircleDashed className="attendee-status pending" size={13} aria-label="No response yet" />;
  }
}

function groupSources(sources: CalendarSource[]) {
  const groups = new Map<string, { key: string; provider: CalendarSource["provider"]; accountLabel: string; sources: CalendarSource[] }>();
  for (const source of sources) {
    const key = `${source.provider}:${source.accountId}`;
    const group = groups.get(key) ?? { key, provider: source.provider, accountLabel: source.accountLabel, sources: [] };
    group.sources.push(source);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function initialSourceSelection(sources: CalendarSource[], current: Set<string>): Set<string> {
  if (current.size > 0) return new Set(sources.filter((source) => current.has(source.id)).map((source) => source.id));
  try {
    const saved = JSON.parse(window.localStorage.getItem(CALENDAR_SELECTION_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) {
      const savedIds = new Set(saved.filter((value): value is string => typeof value === "string"));
      return new Set(sources.filter((source) => savedIds.has(source.id)).map((source) => source.id));
    }
  } catch {
    window.localStorage.removeItem(CALENDAR_SELECTION_KEY);
  }
  const defaults = sources.filter((source) => source.selectedByDefault);
  return new Set((defaults.length > 0 ? defaults : sources.filter((source) => source.primary)).map((source) => source.id));
}

function positionTimedEvents(events: CalendarEvent[], dateIso: string): PositionedEvent[] {
  const sorted = events
    .map((event) => ({ event, start: eventMinute(event.startAt, dateIso), end: eventMinute(event.endAt, dateIso) }))
    .filter((entry) => entry.end > 0 && entry.start < 24 * 60)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const output: PositionedEvent[] = [];
  let group: typeof sorted = [];
  let groupEnd = -1;
  const flush = () => {
    if (group.length === 0) return;
    const columnEnds: number[] = [];
    const assignments = group.map((entry) => {
      let column = columnEnds.findIndex((end) => end <= entry.start);
      if (column < 0) column = columnEnds.length;
      columnEnds[column] = entry.end;
      return { entry, column };
    });
    const columns = Math.max(1, columnEnds.length);
    for (const { entry, column } of assignments) {
      const start = Math.max(0, entry.start);
      const end = Math.min(24 * 60, entry.end);
      output.push({
        event: entry.event,
        top: start * HOUR_HEIGHT / 60,
        height: Math.max(30, (end - start) * HOUR_HEIGHT / 60),
        column,
        columns
      });
    }
    group = [];
  };
  for (const entry of sorted) {
    if (group.length > 0 && entry.start >= groupEnd) flush();
    group.push(entry);
    groupEnd = Math.max(groupEnd, entry.end);
  }
  flush();
  return output;
}

function eventMinute(value: string, dateIso: string): number {
  const date = new Date(value);
  const selectedStart = localDate(dateIso);
  return (date.getTime() - selectedStart.getTime()) / 60_000;
}

function eventStyle(event: CalendarEvent): CSSProperties {
  const color = event.calendarColor || "#15805f";
  return { borderColor: color, backgroundColor: `${color}20`, color: "var(--ink)" };
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateIso: string, days: number): string {
  const date = localDate(dateIso);
  date.setDate(date.getDate() + days);
  return dateToIso(date);
}

function addMonths(monthIso: string, months: number): string {
  const [year, month] = monthIso.split("-").map(Number) as [number, number];
  const date = new Date(year, month - 1 + months, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayBoundsIso(dateIso: string): { startOfDay: string; endOfDay: string } {
  const start = localDate(dateIso);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startOfDay: start.toISOString(), endOfDay: end.toISOString() };
}

function localDate(dateIso: string): Date {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function dateToIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthDays(monthIso: string): Array<{ date: string; currentMonth: boolean }> {
  const [year, month] = monthIso.split("-").map(Number) as [number, number];
  const first = new Date(year, month - 1, 1);
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return { date: dateToIso(date), currentMonth: date.getMonth() === month - 1 };
  });
}

function formatDayHeading(dateIso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(localDate(dateIso));
}

function formatMonth(monthIso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(localDate(`${monthIso}-01`));
}

function formatDateLabel(dateIso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(localDate(dateIso));
}

function formatHour(hour: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(new Date(2026, 0, 1, hour));
}

function formatEventTime(event: CalendarEvent): string {
  if (event.allDay) return "All day";
  const format = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${format.format(new Date(event.startAt))} – ${format.format(new Date(event.endAt))}`;
}

function minutesIntoDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function toDatetimeLocalValue(value: string): string {
  const date = value.length === 10 ? new Date(`${value}T09:00:00`) : new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateValue(value: string): string {
  return dateToIso(new Date(value));
}

function emptyDraft(sourceId: string, dateIso: string, hour: number): EventDraft {
  const safeHour = Math.min(23, Math.max(0, hour));
  const end = safeHour === 23 ? { date: addDays(dateIso, 1), hour: 0 } : { date: dateIso, hour: safeHour + 1 };
  return {
    sourceId,
    eventId: null,
    readOnly: false,
    title: "",
    description: "",
    location: "",
    allDay: false,
    startAt: `${dateIso}T${String(safeHour).padStart(2, "0")}:00`,
    endAt: `${end.date}T${String(end.hour).padStart(2, "0")}:00`,
    meetingLink: null,
    organizer: null,
    attendees: []
  };
}

function draftFromEvent(event: CalendarEvent, source?: CalendarSource): EventDraft {
  return {
    sourceId: event.sourceId ?? source?.id ?? "",
    eventId: event.id,
    readOnly: Boolean(source?.readOnly),
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
