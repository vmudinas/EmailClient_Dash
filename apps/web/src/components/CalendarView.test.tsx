import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, GmailConnection, TodoItem } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { CalendarView } from "./CalendarView.js";

afterEach(cleanup);

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
  it("shows an empty state when no Gmail account has calendar access", async () => {
    const api = {
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[{ ...CONNECTION, canManageCalendar: false }]} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("No calendar-connected Gmail accounts")).toBeTruthy());
  });

  it("lets an existing Gmail account be reauthorized for calendar access from the empty state", async () => {
    const api = {
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    const onReauthorize = vi.fn();
    const connection = { ...CONNECTION, canManageCalendar: false };
    render(<CalendarView api={api} connections={[connection]} onReauthorize={onReauthorize} onError={vi.fn()} />);

    const button = await waitFor(() => screen.getByRole("button", { name: "Reauthorize owner@example.test for calendar access" }));
    fireEvent.click(button);
    expect(onReauthorize).toHaveBeenCalledWith(connection);
  });

  it("loads the day's events and to-dos, and adds a new to-do", async () => {
    const api = {
      listCalendarEvents: vi.fn().mockResolvedValue([EVENT]),
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
    render(<CalendarView api={api} connections={[CONNECTION]} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Standup")).toBeTruthy());
    expect(screen.getByText("Write the report")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("Add a to-do for this day"), {
      target: { value: "Call the vendor" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to-do" }));

    await waitFor(() => expect(api.createTodo).toHaveBeenCalledWith({ date: todayIso(), text: "Call the vendor" }));
    await waitFor(() => expect(screen.getByText("Call the vendor")).toBeTruthy());
  });

  it("opens the edit dialog with full details when an event is clicked", async () => {
    const api = {
      listCalendarEvents: vi.fn().mockResolvedValue([EVENT]),
      listTodos: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onReauthorize={vi.fn()} onError={vi.fn()} />);

    const card = await waitFor(() => screen.getByRole("button", { name: "View details for Standup" }));
    fireEvent.click(card);

    expect(screen.getByRole("heading", { name: "Edit event" })).toBeTruthy();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Standup");
    expect(screen.getByLabelText("Starts")).toBeTruthy();
    expect(screen.getByLabelText("Ends")).toBeTruthy();

    expect(screen.getByRole("link", { name: /Join with Google Meet/ }).getAttribute("href")).toBe("https://meet.google.com/abc-defg-hij");
    expect(screen.getByText("Guests (2)")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("guest@example.test")).toBeTruthy();
  });

  it("toggles a to-do as completed", async () => {
    const api = {
      listCalendarEvents: vi.fn().mockResolvedValue([]),
      listTodos: vi.fn().mockResolvedValue([TODO]),
      updateTodo: vi.fn().mockResolvedValue({ ...TODO, completed: true })
    } as unknown as ApiClient;
    render(<CalendarView api={api} connections={[CONNECTION]} onReauthorize={vi.fn()} onError={vi.fn()} />);

    await waitFor(() => expect(screen.getByText("Write the report")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Mark done" }));

    await waitFor(() => expect(api.updateTodo).toHaveBeenCalledWith("todo-1", { completed: true }));
  });
});

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
