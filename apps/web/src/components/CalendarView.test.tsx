import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("always exposes add and reauthorize actions on the Calendar screen", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Reauthorize owner@example.test for Gmail and Calendar" }));

    expect(onAddGoogle).toHaveBeenCalledOnce();
    expect(onReauthorize).toHaveBeenCalledWith(CONNECTION);
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

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
