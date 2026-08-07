import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, CalendarSource, GmailConnection, TodoItem } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { CalendarView } from "./CalendarView.js";

const desktopMatchMedia = window.matchMedia;

afterEach(() => {
  cleanup();
  window.matchMedia = desktopMatchMedia;
});
beforeEach(() => window.localStorage.clear());

const CONNECTION: GmailConnection = {
  id: "gmail-1",
  email: "owner@example.test",
  archiveId: "archive-1",
  archiveName: "Gmail",
  folderId: "folder-1",
  folderPath: "Gmail",
  query: "newer_than:30d",
  ocrEnabled: false,
  canSend: true,
  canManageCalendar: true,
  status: "connected",
  processedItems: 0,
  totalItems: null,
  importedItems: 0,
  lastSyncedAt: null,
  lastError: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
};

const EVENT: CalendarEvent = {
  id: "event-1",
  connectionId: CONNECTION.id,
  title: "Standup",
  description: "",
  location: "",
  startAt: new Date().toISOString(),
  endAt: new Date().toISOString(),
  allDay: false,
  htmlLink: null,
  meetingLink: "https://meet.google.com/abc-defg-hij",
  organizer: { email: "owner@example.test", displayName: "Owner" },
  attendees: [
    { email: "owner@example.test", displayName: "Owner", responseStatus: "accepted", organizer: true, self: true },
    { email: "guest@example.test", displayName: null, responseStatus: "tentative", organizer: false, self: false }
  ]
};

const SOURCE: CalendarSource = {
  id: "source-google-primary",
  provider: "google",
  accountId: CONNECTION.id,
  accountLabel: CONNECTION.email,
  externalId: "primary",
  name: "Personal",
  color: "#15805f",
  readOnly: false,
  primary: true,
  selectedByDefault: true
};

const TODO: TodoItem = {
  id: "todo-1",
  date: todayIso(),
  text: "Write the report",
  completed: false,
  position: 0,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
};

describe("CalendarView", () => {
  it("shows an empty state when no calendar is authorized", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[{ ...CONNECTION, canManageCalendar: false }]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("No authorized calendars")).toBeTruthy());
    expect(screen.getByText("9 AM")).toBeTruthy();
  });

  it("lets an existing Gmail account be reauthorized for calendar access from the empty state", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    const onReauthorize = vi.fn();
    const connection = { ...CONNECTION, canManageCalendar: false };
    render(<CalendarView api={api} connections={[connection]} onAddGoogle={vi.fn()} onReauthorize={onReauthorize} onError={vi.fn()} />);

    const button = await waitFor(() => screen.getByRole("button", { name: "Reauthorize owner@example.test for calendar access" }));
    fireEvent.click(button);
    expect(onReauthorize).toHaveBeenCalledWith(connection);
  });

  it("offers reauthorization when a calendar-enabled account has a token error", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    const onReauthorize = vi.fn();
    const connection = {
      ...CONNECTION,
      status: "error" as const,
      lastError: "Google access token refresh failed"
    };
    render(<CalendarView api={api} connections={[connection]} onAddGoogle={vi.fn()} onReauthorize={onReauthorize} onError={vi.fn()} />);

    const button = await waitFor(() => screen.getByRole("button", { name: "Reauthorize owner@example.test for calendar access" }));
    fireEvent.click(button);
    expect(onReauthorize).toHaveBeenCalledWith(connection);
  });

  it("shows healthy Google calendar accounts as connected without an unnecessary reauthorize button", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    const onAddGoogle = vi.fn();
    const onReauthorize = vi.fn();
    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={onAddGoogle} onReauthorize={onReauthorize} onError={vi.fn()} />);

    const add = await waitFor(() => screen.getByRole("button", { name: "Add Google account" }));
    fireEvent.click(add);

    expect(onAddGoogle).toHaveBeenCalledOnce();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reauthorize owner@example.test for Gmail and Calendar" })).toBeNull();
    expect(onReauthorize).not.toHaveBeenCalled();
  });

  it("shows the provider error when an Apple calendar cannot be loaded", async () => {
    const appleSource = { ...SOURCE, id: "apple:account-1", provider: "apple" as const, accountLabel: "iCloud", name: "iCloud" };
    const onError = vi.fn();
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([appleSource]),
      listCalendarSourceEvents: vi.fn().mockRejectedValue(new Error("Apple Calendar account iCloud must be disconnected and authorized again")),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={onError} />);

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Apple Calendar account iCloud must be disconnected and authorized again"));
  });

  it("loads the day's events and to-dos, and adds a new to-do", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([EVENT]),
      listTodos: vi.fn().mockResolvedValue([TODO]),
      createTodo: vi.fn().mockResolvedValue({
        id: "todo-2",
        date: todayIso(),
        text: "Call the vendor",
        completed: false,
        position: 1,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z"
      })
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Standup")).toBeTruthy());
    expect(screen.getByText("Write the report")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Add a to-do for this day"), {
      target: { value: "Call the vendor" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to-do" }));

    await waitFor(() => expect(api.createTodo).toHaveBeenCalledWith({ date: todayIso(), text: "Call the vendor" }));
    await waitFor(() => expect(screen.getByText("Call the vendor")).toBeTruthy());
  });

  it("highlights days with events or to-dos on the mini month and shows details in the tooltip", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([EVENT]),
      listTodos: vi.fn().mockResolvedValue([TODO])
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const highlighted = await waitFor(() => screen.getByTitle(/Standup/));
    expect(highlighted.className).toContain("has-items");
    expect(highlighted.title).toContain("Write the report");
    expect(highlighted.querySelector(".mini-day-dot.events")).toBeTruthy();
    expect(highlighted.querySelector(".mini-day-dot.todos")).toBeTruthy();

    const grid = highlighted.closest(".calendar-mini-grid")!;
    expect(grid.querySelectorAll(".has-items")).toHaveLength(1);
  });

  it("marks every local day a timed event intersects and treats all-day end dates as exclusive", async () => {
    const today = todayIso();
    const timedSecondDay = addTestDays(today, 1);
    const timedExclusiveEnd = addTestDays(today, 2);
    const allDayDate = addTestDays(today, 3);
    const allDayExclusiveEnd = addTestDays(today, 4);
    const timedEvent: CalendarEvent = {
      ...EVENT,
      id: "event-overnight",
      title: "Overnight migration",
      startAt: localDateTimeIso(today, 23),
      endAt: localDateTimeIso(timedExclusiveEnd, 0),
      allDay: false
    };
    const allDayEvent: CalendarEvent = {
      ...EVENT,
      id: "event-all-day",
      title: "Company holiday",
      startAt: allDayDate,
      endAt: allDayExclusiveEnd,
      allDay: true
    };
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockImplementation((_sourceId: string, startAt: string, endAt: string) => (
        isDayRange(startAt, endAt) ? Promise.resolve([]) : Promise.resolve([timedEvent, allDayEvent])
      )),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const timedStart = await screen.findByRole("button", { name: `${formatTestDate(today)}, 1 event` });
    const timedContinuation = screen.getByRole("button", { name: `${formatTestDate(timedSecondDay)}, 1 event` });
    const allDay = screen.getByRole("button", { name: `${formatTestDate(allDayDate)}, 1 event` });
    expect(timedStart.getAttribute("title")).toContain("Overnight migration");
    expect(timedContinuation.getAttribute("title")).toContain("Overnight migration");
    expect(allDay.getAttribute("title")).toContain("Company holiday");

    expect(screen.getByRole("button", { name: formatTestDate(timedExclusiveEnd) }).getAttribute("title")).toBeNull();
    expect(screen.getByRole("button", { name: formatTestDate(allDayExclusiveEnd) }).getAttribute("title")).toBeNull();
  });

  it("opens the edit dialog with full details when an event is clicked", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([EVENT]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const card = await waitFor(() => screen.getByRole("button", { name: "View details for Standup" }));
    fireEvent.click(card);

    expect(screen.getByRole("heading", { name: "Edit event" })).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Standup");
    expect(screen.getByLabelText("Starts")).toBeTruthy();
    expect(screen.getByLabelText("Ends")).toBeTruthy();

    expect(screen.getByRole("link", { name: /Join video meeting/ }).getAttribute("href")).toBe("https://meet.google.com/abc-defg-hij");
    expect(screen.getByText("Guests (2)")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("guest@example.test")).toBeTruthy();
  });

  it("toggles a to-do as completed", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([TODO]),
      updateTodo: vi.fn().mockResolvedValue({ ...TODO, completed: true })
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Write the report")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));

    await waitFor(() => expect(api.updateTodo).toHaveBeenCalledWith("todo-1", { completed: true }));
  });

  it("selects multiple calendars independently and shows a 24-hour day with a mini month", async () => {
    const appleSource: CalendarSource = {
      ...SOURCE,
      id: "source-apple-work",
      provider: "apple",
      accountId: "apple-1",
      accountLabel: "iCloud",
      externalId: "https://caldav.icloud.com/work/",
      name: "Work",
      color: "#ff3b30",
      primary: false
    };
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE, appleSource]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const personal = await screen.findByRole("checkbox", { name: /Personal/ });
    const work = screen.getByRole("checkbox", { name: /Work/ });
    expect((personal as HTMLInputElement).checked).toBe(true);
    expect((work as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText("Monthly date picker")).toBeTruthy();
    expect(screen.getByText("9 AM")).toBeTruthy();

    fireEvent.click(work);
    await waitFor(() => expect((work as HTMLInputElement).checked).toBe(false));
    await waitFor(() => expect(api.listCalendarSourceEvents).toHaveBeenLastCalledWith(
      SOURCE.id,
      expect.any(String),
      expect.any(String)
    ));
  });

  it("keeps the latest day when older event and to-do requests finish last", async () => {
    const today = todayIso();
    const tomorrow = addTestDays(today, 1);
    const firstEvents = deferred<CalendarEvent[]>();
    const nextEvents = deferred<CalendarEvent[]>();
    const firstTodos = deferred<TodoItem[]>();
    const nextTodos = deferred<TodoItem[]>();
    let dayEventRequest = 0;
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockImplementation((_sourceId: string, startAt: string, endAt: string) => {
        if (!isDayRange(startAt, endAt)) return Promise.resolve([]);
        dayEventRequest += 1;
        return dayEventRequest === 1 ? firstEvents.promise : nextEvents.promise;
      }),
      listTodos: vi.fn().mockImplementation((startDate: string, endDate: string) => {
        if (startDate !== endDate) return Promise.resolve([]);
        return startDate === today ? firstTodos.promise : nextTodos.promise;
      })
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(dayEventRequest).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await waitFor(() => expect(dayEventRequest).toBe(2));

    await act(async () => {
      nextEvents.resolve([eventForDay("event-next", "Tomorrow event", tomorrow)]);
      nextTodos.resolve([{ ...TODO, id: "todo-next", date: tomorrow, text: "Tomorrow task" }]);
    });
    await waitFor(() => expect(screen.getByText("Tomorrow event")).toBeTruthy());
    expect(screen.getByText("Tomorrow task")).toBeTruthy();

    await act(async () => {
      firstEvents.resolve([eventForDay("event-old", "Stale event", today)]);
      firstTodos.resolve([{ ...TODO, id: "todo-old", date: today, text: "Stale task" }]);
    });
    await waitFor(() => expect(screen.queryByText("Stale event")).toBeNull());
    expect(screen.queryByText("Stale task")).toBeNull();
    expect(screen.getByText("Tomorrow event")).toBeTruthy();
    expect(screen.getByText("Tomorrow task")).toBeTruthy();
  });

  it("reloads day events, day to-dos, and the mini-month after becoming active again", async () => {
    const listCalendarSourceEvents = vi.fn().mockResolvedValue([]);
    const listTodos = vi.fn().mockResolvedValue([]);
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents,
      listTodos
    } as unknown as ApiClient;
    const onAddGoogle = vi.fn();
    const onReauthorize = vi.fn();
    const onError = vi.fn();
    const view = render(
      <CalendarView
        api={api}
        connections={[CONNECTION]}
        active
        onAddGoogle={onAddGoogle}
        onReauthorize={onReauthorize}
        onError={onError}
      />
    );

    const dayEventCalls = () => listCalendarSourceEvents.mock.calls.filter(([, startAt, endAt]) => (
      isDayRange(String(startAt), String(endAt))
    )).length;
    const monthEventCalls = () => listCalendarSourceEvents.mock.calls.length - dayEventCalls();
    const dayTodoCalls = () => listTodos.mock.calls.filter(([startDate, endDate]) => startDate === endDate).length;
    const monthTodoCalls = () => listTodos.mock.calls.length - dayTodoCalls();

    await waitFor(() => {
      expect(dayEventCalls()).toBeGreaterThan(0);
      expect(monthEventCalls()).toBeGreaterThan(0);
      expect(dayTodoCalls()).toBeGreaterThan(0);
      expect(monthTodoCalls()).toBeGreaterThan(0);
    });

    view.rerender(
      <CalendarView
        api={api}
        connections={[CONNECTION]}
        active={false}
        onAddGoogle={onAddGoogle}
        onReauthorize={onReauthorize}
        onError={onError}
      />
    );
    const hiddenCounts = {
      dayEvents: dayEventCalls(),
      monthEvents: monthEventCalls(),
      dayTodos: dayTodoCalls(),
      monthTodos: monthTodoCalls()
    };

    view.rerender(
      <CalendarView
        api={api}
        connections={[CONNECTION]}
        active
        onAddGoogle={onAddGoogle}
        onReauthorize={onReauthorize}
        onError={onError}
      />
    );

    await waitFor(() => {
      expect(dayEventCalls()).toBeGreaterThan(hiddenCounts.dayEvents);
      expect(monthEventCalls()).toBeGreaterThan(hiddenCounts.monthEvents);
      expect(dayTodoCalls()).toBeGreaterThan(hiddenCounts.dayTodos);
      expect(monthTodoCalls()).toBeGreaterThan(hiddenCounts.monthTodos);
    });
  });

  it("does not restore events from a calendar after it is deselected", async () => {
    const appleSource: CalendarSource = {
      ...SOURCE,
      id: "source-apple-work",
      provider: "apple",
      accountId: "apple-1",
      accountLabel: "iCloud",
      name: "Work",
      primary: false
    };
    const oldPersonal = deferred<CalendarEvent[]>();
    const oldWork = deferred<CalendarEvent[]>();
    let personalDayRequests = 0;
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE, appleSource]),
      listCalendarSourceEvents: vi.fn().mockImplementation((sourceId: string, startAt: string, endAt: string) => {
        if (!isDayRange(startAt, endAt)) return Promise.resolve([]);
        if (sourceId === appleSource.id) return oldWork.promise;
        personalDayRequests += 1;
        if (personalDayRequests === 1) return oldPersonal.promise;
        return Promise.resolve([eventForDay("event-current", "Current personal event", todayIso())]);
      }),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const work = await screen.findByRole("checkbox", { name: /Work/ });
    await waitFor(() => expect(personalDayRequests).toBe(1));
    fireEvent.click(work);
    await waitFor(() => expect(screen.getByText("Current personal event")).toBeTruthy());

    await act(async () => {
      oldPersonal.resolve([eventForDay("event-old-personal", "Old personal event", todayIso())]);
      oldWork.resolve([eventForDay("event-old-work", "Deselected work event", todayIso())]);
    });
    await waitFor(() => expect(screen.queryByText("Deselected work event")).toBeNull());
    expect(screen.queryByText("Old personal event")).toBeNull();
    expect(screen.getByText("Current personal event")).toBeTruthy();
  });

  it("requires an event to end after it starts", async () => {
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([]),
      createCalendarSourceEvent: vi.fn()
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const newEvent = await screen.findByRole("button", { name: "New event" });
    await waitFor(() => expect((newEvent as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(newEvent);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Invalid range" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: `${todayIso()}T10:00` } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: `${todayIso()}T09:00` } });

    expect(screen.getByRole("alert").textContent).toContain("Event end must be after its start.");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Title").closest("form")!);
    expect(api.createCalendarSourceEvent).not.toHaveBeenCalled();
  });

  it("offers a tablet task drawer toggle", async () => {
    window.matchMedia = tabletMatchMedia;
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([TODO])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const toggle = await screen.findByRole("button", { name: /Tasks/ });
    const workspace = toggle.closest(".calendar-workspace")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(workspace.className).toContain("tablet-calendar-todos-open");

    fireEvent.click(workspace.querySelector<HTMLButtonElement>(".calendar-tablet-todo-close")!);
    expect(workspace.className).not.toContain("tablet-calendar-todos-open");
  });

  it("uses an agenda and sheet controls on mobile screens", async () => {
    window.matchMedia = mobileMatchMedia;
    const api = {
      listCalendarSources: vi.fn().mockResolvedValue([SOURCE]),
      listCalendarSourceEvents: vi.fn().mockResolvedValue([EVENT]),
      listTodos: vi.fn().mockResolvedValue([TODO])
    } as unknown as ApiClient;

    render(<CalendarView api={api} connections={[CONNECTION]} onAddGoogle={vi.fn()} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const agenda = await waitFor(() => screen.getByLabelText(/Agenda for/));
    expect(screen.queryByText("9 AM")).toBeNull();
    expect(await screen.findByRole("button", { name: "View details for Standup" })).toBeTruthy();
    const workspace = agenda.closest(".calendar-workspace")!;

    fireEvent.click(screen.getByRole("button", { name: "Choose calendars and date" }));
    expect(workspace.className).toContain("mobile-calendar-panel-calendars");
    fireEvent.click(screen.getByRole("button", { name: "Close calendar filters" }));
    expect(workspace.className).toContain("mobile-calendar-panel-none");

    fireEvent.click(screen.getByRole("button", { name: "Open to-do list" }));
    expect(workspace.className).toContain("mobile-calendar-panel-todos");
  });
});

const mobileMatchMedia = ((query: string): MediaQueryList => ({
  matches: query.includes("max-width: 800px"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false
})) as typeof window.matchMedia;

const tabletMatchMedia = ((query: string): MediaQueryList => ({
  matches: query.includes("min-width: 801px") && query.includes("max-width: 1120px"),
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false
})) as typeof window.matchMedia;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

function isDayRange(startAt: string, endAt: string): boolean {
  return new Date(endAt).getTime() - new Date(startAt).getTime() <= 26 * 60 * 60 * 1_000;
}

function eventForDay(id: string, title: string, date: string): CalendarEvent {
  return {
    ...EVENT,
    id,
    title,
    allDay: true,
    startAt: date,
    endAt: addTestDays(date, 1)
  };
}

function addTestDays(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localDateTimeIso(dateIso: string, hour: number): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Date(year, month - 1, day, hour).toISOString();
}

function formatTestDate(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
