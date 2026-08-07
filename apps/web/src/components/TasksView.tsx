import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  ClipboardCheck,
  LoaderCircle,
  Plus,
  RefreshCw,
  Trash2
} from "lucide-react";
import type { TodoItem } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";

// The current API requires a bounded start/end pair. Todos are validated as DateOnly values and
// stored as YYYY-MM-DD, so its full supported span is both safe and lexically sortable. An
// arbitrary rolling window would make an old overdue task or a long-range plan silently vanish.
const TASK_RANGE_START = "0001-01-01";
const TASK_RANGE_END = "9999-12-31";
const UPCOMING_WINDOW_DAYS = 7;

export interface TasksViewProps {
  api: ApiClient;
  active?: boolean;
  onError?(message: string): void;
}

type OpenTaskGroupId = "overdue" | "today" | "upcoming" | "later";

interface OpenTaskGroup {
  id: OpenTaskGroupId;
  label: string;
  description: string;
  tasks: TodoItem[];
}

/**
 * A focused task workspace over the existing local to-do API.
 *
 * It deliberately owns its loading and mutation state so it can be lazy-mounted beside Mail
 * and Calendar without pulling either workspace into its render path.
 */
export function TasksView({ api, active = true, onError }: TasksViewProps) {
  const [tasks, setTasks] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(active);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [newTaskText, setNewTaskText] = useState("");
  const [newTaskDate, setNewTaskDate] = useState(todayIso);
  const [creating, setCreating] = useState(false);
  const [pendingTaskIds, setPendingTaskIds] = useState<Set<string>>(new Set());
  const requestIdRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reportError = useCallback((message: string) => {
    setActionError(message);
    onErrorRef.current?.(message);
  }, []);

  const loadTasks = useCallback(async (invalidate = false) => {
    if (!active) return;
    const requestId = ++requestIdRef.current;
    if (invalidate) api.invalidateCache("/api/todos");
    setLoading(true);
    setLoadError("");
    try {
      const loaded = await api.listTodos(TASK_RANGE_START, TASK_RANGE_END);
      if (requestId !== requestIdRef.current) return;
      setTasks(loaded);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      const message = errorText(error, "Tasks could not be loaded.");
      setLoadError(message);
      onErrorRef.current?.(message);
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setHasLoaded(true);
      }
    }
  }, [active, api]);

  useEffect(() => {
    if (active) void loadTasks();
    else setLoading(false);
    return () => { requestIdRef.current += 1; };
  }, [active, loadTasks]);

  const today = todayIso();
  const groups = useMemo(() => groupOpenTasks(tasks, today), [tasks, today]);
  const completedTasks = useMemo(
    () => tasks.filter((task) => task.completed).sort(completedTaskOrder),
    [tasks]
  );
  const openCount = groups.reduce((total, group) => total + group.tasks.length, 0);
  const overdueCount = groups.find((group) => group.id === "overdue")?.tasks.length ?? 0;
  const todayCount = groups.find((group) => group.id === "today")?.tasks.length ?? 0;

  const markPending = (taskId: string, pending: boolean) => {
    setPendingTaskIds((current) => {
      const next = new Set(current);
      if (pending) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  };

  const createTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = newTaskText.trim();
    if (!text || creating) return;
    setCreating(true);
    setActionError("");
    setNotice("");
    try {
      const created = await api.createTodo({ date: newTaskDate, text });
      setTasks((current) => [...current.filter((task) => task.id !== created.id), created]);
      setNewTaskText("");
      setNotice(`Added “${created.text}”.`);
    } catch (error) {
      reportError(errorText(error, "The task could not be added."));
    } finally {
      setCreating(false);
    }
  };

  const toggleTask = async (task: TodoItem) => {
    if (pendingTaskIds.has(task.id)) return;
    const nextCompleted = !task.completed;
    markPending(task.id, true);
    setActionError("");
    setNotice("");
    setTasks((current) => current.map((entry) => entry.id === task.id
      ? { ...entry, completed: nextCompleted }
      : entry));
    try {
      const updated = await api.updateTodo(task.id, { completed: nextCompleted });
      setTasks((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setNotice(nextCompleted ? `Completed “${task.text}”.` : `Reopened “${task.text}”.`);
    } catch (error) {
      setTasks((current) => current.map((entry) => entry.id === task.id ? task : entry));
      reportError(errorText(error, `“${task.text}” could not be updated.`));
    } finally {
      markPending(task.id, false);
    }
  };

  const deleteTask = async (task: TodoItem) => {
    if (pendingTaskIds.has(task.id)) return;
    markPending(task.id, true);
    setActionError("");
    setNotice("");
    setTasks((current) => current.filter((entry) => entry.id !== task.id));
    try {
      await api.deleteTodo(task.id);
      setNotice(`Deleted “${task.text}”.`);
    } catch (error) {
      setTasks((current) => current.some((entry) => entry.id === task.id) ? current : [...current, task]);
      reportError(errorText(error, `“${task.text}” could not be deleted.`));
    } finally {
      markPending(task.id, false);
    }
  };

  return (
    <section className="tasks-workspace" aria-labelledby="tasks-title" aria-busy={loading}>
      <header className="tasks-header">
        <div className="tasks-heading">
          <span className="tasks-heading-icon" aria-hidden="true"><ClipboardCheck size={21} /></span>
          <div>
            <h1 id="tasks-title">Tasks</h1>
            <p>Your focused list for the next step, not another inbox.</p>
          </div>
        </div>
        <button
          type="button"
          className="icon-button tasks-refresh"
          onClick={() => void loadTasks(true)}
          disabled={loading}
          aria-label="Refresh tasks"
          title="Refresh tasks"
        >
          <RefreshCw className={loading ? "spin" : ""} size={17} />
        </button>
      </header>

      <div className="tasks-summary" aria-label="Task summary" aria-live="polite">
        <TaskMetric value={openCount} label="Open" />
        <TaskMetric value={todayCount} label="Due today" tone={todayCount > 0 ? "today" : undefined} />
        <TaskMetric value={overdueCount} label="Overdue" tone={overdueCount > 0 ? "overdue" : undefined} />
        <TaskMetric value={completedTasks.length} label="Completed" tone="completed" />
      </div>

      <form className="tasks-quick-add" onSubmit={(event) => void createTask(event)} aria-label="Quick add task">
        <label className="tasks-new-text">
          <span className="visually-hidden">Task</span>
          <input
            value={newTaskText}
            onChange={(event) => setNewTaskText(event.target.value)}
            placeholder="What needs to get done?"
            maxLength={2_000}
            disabled={creating}
            autoComplete="off"
          />
        </label>
        <label className="tasks-new-date">
          <CalendarDays size={15} aria-hidden="true" />
          <span className="visually-hidden">Due date</span>
          <input
            type="date"
            value={newTaskDate}
            onChange={(event) => setNewTaskDate(event.target.value)}
            disabled={creating}
            aria-label="Due date"
          />
        </label>
        <button className="primary-button tasks-add-button" disabled={creating || !newTaskText.trim()}>
          {creating ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          <span>Add task</span>
        </button>
      </form>

      {actionError && (
        <div className="tasks-alert" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{actionError}</span>
          <button type="button" className="text-button" onClick={() => setActionError("")} aria-label="Dismiss task error">Dismiss</button>
        </div>
      )}
      {notice && <p className="visually-hidden" role="status">{notice}</p>}

      {loading && !hasLoaded ? (
        <div className="tasks-loading" role="status">
          <LoaderCircle className="spin" size={22} />
          <span>Loading your tasks…</span>
        </div>
      ) : loadError && tasks.length === 0 ? (
        <div className="tasks-state tasks-state-error" role="alert">
          <CircleAlert size={28} aria-hidden="true" />
          <strong>Tasks are unavailable</strong>
          <p>{loadError}</p>
          <button type="button" className="secondary-button" onClick={() => void loadTasks(true)}>Try again</button>
        </div>
      ) : (
        <div className="tasks-content">
          {loadError && (
            <div className="tasks-inline-warning" role="status">
              <CircleAlert size={16} aria-hidden="true" />
              <span>{loadError} Showing the last loaded list.</span>
            </div>
          )}

          {openCount === 0 ? (
            <div className="tasks-state tasks-state-empty">
              <CheckCircle2 size={31} aria-hidden="true" />
              <strong>You’re clear</strong>
              <p>Add a task above, or enjoy the breathing room.</p>
            </div>
          ) : (
            <div className="tasks-open-groups" aria-label="Open tasks">
              {groups.filter((group) => group.tasks.length > 0).map((group) => (
                <TaskGroup
                  key={group.id}
                  group={group}
                  pendingTaskIds={pendingTaskIds}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                />
              ))}
            </div>
          )}

          <section className="tasks-completed" aria-labelledby="tasks-completed-title">
            <header className="tasks-section-heading">
              <div>
                <CheckCircle2 size={17} aria-hidden="true" />
                <h2 id="tasks-completed-title">Completed</h2>
              </div>
              <span>{completedTasks.length}</span>
            </header>
            {completedTasks.length > 0 ? (
              <ul className="tasks-list tasks-completed-list">
                {completedTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    pending={pendingTaskIds.has(task.id)}
                    onToggle={toggleTask}
                    onDelete={deleteTask}
                  />
                ))}
              </ul>
            ) : <p className="tasks-section-empty">Completed tasks will collect here.</p>}
          </section>
        </div>
      )}
    </section>
  );
}

function TaskMetric({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={`tasks-metric ${tone ? `tone-${tone}` : ""}`}>
      <strong>{value.toLocaleString()}</strong>
      <span>{label}</span>
    </div>
  );
}

function TaskGroup({
  group,
  pendingTaskIds,
  onToggle,
  onDelete
}: {
  group: OpenTaskGroup;
  pendingTaskIds: Set<string>;
  onToggle(task: TodoItem): void;
  onDelete(task: TodoItem): void;
}) {
  const titleId = `tasks-${group.id}-title`;
  return (
    <section className={`tasks-group tasks-group-${group.id}`} aria-labelledby={titleId}>
      <header className="tasks-section-heading">
        <div>
          <span className="tasks-group-dot" aria-hidden="true" />
          <span>
            <h2 id={titleId}>{group.label}</h2>
            <small>{group.description}</small>
          </span>
        </div>
        <span>{group.tasks.length}</span>
      </header>
      <ul className="tasks-list">
        {group.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            pending={pendingTaskIds.has(task.id)}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({
  task,
  pending,
  onToggle,
  onDelete
}: {
  task: TodoItem;
  pending: boolean;
  onToggle(task: TodoItem): void;
  onDelete(task: TodoItem): void;
}) {
  return (
    <li className={`tasks-row ${task.completed ? "completed" : ""} ${pending ? "pending" : ""}`}>
      <label className="tasks-toggle">
        <input
          type="checkbox"
          checked={task.completed}
          disabled={pending}
          onChange={() => onToggle(task)}
          aria-label={task.completed ? `Reopen ${task.text}` : `Complete ${task.text}`}
        />
        <span aria-hidden="true">{pending && <LoaderCircle className="spin" size={13} />}</span>
      </label>
      <span className="tasks-row-copy">
        <strong>{task.text}</strong>
        <time dateTime={task.date}>{taskDateLabel(task.date)}</time>
      </span>
      <button
        type="button"
        className="icon-button danger tasks-delete"
        onClick={() => onDelete(task)}
        disabled={pending}
        aria-label={`Delete ${task.text}`}
        title="Delete task"
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}

function groupOpenTasks(tasks: TodoItem[], today: string): OpenTaskGroup[] {
  const upcomingEnd = addDays(today, UPCOMING_WINDOW_DAYS);
  const groups: OpenTaskGroup[] = [
    { id: "overdue", label: "Overdue", description: "Needs a decision", tasks: [] },
    { id: "today", label: "Today", description: "Your focus now", tasks: [] },
    { id: "upcoming", label: "Upcoming", description: "Next 7 days", tasks: [] },
    { id: "later", label: "Later", description: "Beyond this week", tasks: [] }
  ];
  for (const task of tasks.filter((entry) => !entry.completed).sort(openTaskOrder)) {
    const group = task.date < today
      ? groups[0]
      : task.date === today
        ? groups[1]
        : task.date <= upcomingEnd
          ? groups[2]
          : groups[3];
    group!.tasks.push(task);
  }
  return groups;
}

function openTaskOrder(left: TodoItem, right: TodoItem): number {
  return left.date.localeCompare(right.date)
    || left.position - right.position
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function completedTaskOrder(left: TodoItem, right: TodoItem): number {
  return right.updatedAt.localeCompare(left.updatedAt)
    || right.date.localeCompare(left.date)
    || right.id.localeCompare(left.id);
}

function taskDateLabel(dateIso: string): string {
  const today = todayIso();
  if (dateIso === today) return "Today";
  if (dateIso === addDays(today, 1)) return "Tomorrow";
  const dayDelta = daysBetween(dateIso, today);
  if (dayDelta > 0) return `${dayDelta} day${dayDelta === 1 ? "" : "s"} overdue`;
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" })
    .format(localDate(dateIso));
}

function todayIso(): string {
  return dateToIso(new Date());
}

function addDays(dateIso: string, days: number): string {
  const date = localDate(dateIso);
  date.setDate(date.getDate() + days);
  return dateToIso(date);
}

function daysBetween(earlier: string, later: string): number {
  const [earlierYear, earlierMonth, earlierDay] = earlier.split("-").map(Number) as [number, number, number];
  const [laterYear, laterMonth, laterDay] = later.split("-").map(Number) as [number, number, number];
  return Math.round((
    Date.UTC(laterYear, laterMonth - 1, laterDay) - Date.UTC(earlierYear, earlierMonth - 1, earlierDay)
  ) / 86_400_000);
}

function localDate(dateIso: string): Date {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function dateToIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}
