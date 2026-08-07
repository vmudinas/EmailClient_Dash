import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoItem } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { TasksView } from "./TasksView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TasksView", () => {
  it("loads the working window and groups open and completed tasks", async () => {
    const today = todayIso();
    const tasks = [
      task("old-overdue", "Renew the long-expired passport", addDays(today, -3_650)),
      task("overdue", "Send the invoice", addDays(today, -2)),
      task("today", "Reply to the recruiter", today),
      task("upcoming", "Prepare interview notes", addDays(today, 3)),
      task("later", "Renew the certification", addDays(today, 14)),
      task("far-future", "Review the ten-year plan", addDays(today, 3_650)),
      task("done", "Book the appointment", addDays(today, 1), true)
    ];
    const api = apiStub({ listTodos: vi.fn().mockResolvedValue(tasks) });

    render(<TasksView api={api} />);

    expect(screen.getByRole("status").textContent).toContain("Loading your tasks");
    await waitFor(() => expect(api.listTodos).toHaveBeenCalledWith("0001-01-01", "9999-12-31"));

    expect(within(screen.getByRole("region", { name: /Overdue/ })).getByText("Renew the long-expired passport")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Overdue/ })).getByText("Send the invoice")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Today/ })).getByText("Reply to the recruiter")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Upcoming/ })).getByText("Prepare interview notes")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Later/ })).getByText("Renew the certification")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /Later/ })).getByText("Review the ten-year plan")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /^Completed/ })).getByText("Book the appointment")).toBeTruthy();
    expect(screen.getByLabelText("Task summary").textContent).toContain("6Open");
  });

  it("quick-adds a trimmed task for the selected date with native form submission", async () => {
    const dueDate = addDays(todayIso(), 900);
    const created = task("created", "Call the hiring manager", dueDate);
    const api = apiStub({
      listTodos: vi.fn().mockResolvedValue([]),
      createTodo: vi.fn().mockResolvedValue(created)
    });
    render(<TasksView api={api} />);

    await screen.findByText("You’re clear");
    expect(screen.getByLabelText("Due date").getAttribute("min")).toBeNull();
    expect(screen.getByLabelText("Due date").getAttribute("max")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("What needs to get done?"), {
      target: { value: "  Call the hiring manager  " }
    });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: dueDate } });
    fireEvent.submit(screen.getByRole("form", { name: "Quick add task" }));

    await waitFor(() => expect(api.createTodo).toHaveBeenCalledWith({
      date: dueDate,
      text: "Call the hiring manager"
    }));
    expect(await screen.findByText("Call the hiring manager")).toBeTruthy();
    expect((screen.getByPlaceholderText("What needs to get done?") as HTMLInputElement).value).toBe("");
  });

  it("completes immediately and rolls back when the server rejects the update", async () => {
    const pendingUpdate = deferred<TodoItem>();
    const current = task("today", "Review the contract", todayIso());
    const api = apiStub({
      listTodos: vi.fn().mockResolvedValue([current]),
      updateTodo: vi.fn().mockReturnValue(pendingUpdate.promise)
    });
    render(<TasksView api={api} />);

    const checkbox = await screen.findByRole("checkbox", { name: "Complete Review the contract" }) as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(api.updateTodo).toHaveBeenCalledWith("today", { completed: true });
    expect((screen.getByRole("checkbox", { name: "Reopen Review the contract" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("region", { name: /^Completed/ }).textContent).toContain("Review the contract");

    pendingUpdate.reject(new Error("The task service is offline"));

    expect((await screen.findByRole("alert")).textContent).toContain("The task service is offline");
    expect((screen.getByRole("checkbox", { name: "Complete Review the contract" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("region", { name: /Today/ }).textContent).toContain("Review the contract");
  });

  it("deletes optimistically and restores the task when deletion fails", async () => {
    const pendingDelete = deferred<void>();
    const current = task("delete-me", "Cancel unused subscription", todayIso());
    const api = apiStub({
      listTodos: vi.fn().mockResolvedValue([current]),
      deleteTodo: vi.fn().mockReturnValue(pendingDelete.promise)
    });
    render(<TasksView api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Cancel unused subscription" }));
    expect(api.deleteTodo).toHaveBeenCalledWith("delete-me");
    expect(screen.queryByText("Cancel unused subscription")).toBeNull();

    pendingDelete.reject(new Error("Delete failed"));

    expect(await screen.findByText("Cancel unused subscription")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Delete failed");
  });

  it("shows a useful load failure and retries without remounting", async () => {
    const api = apiStub({
      listTodos: vi.fn()
        .mockRejectedValueOnce(new Error("Could not reach the local service"))
        .mockResolvedValueOnce([task("recovered", "Recovered task", todayIso())])
    });
    const onError = vi.fn();
    render(<TasksView api={api} onError={onError} />);

    expect(await screen.findByText("Tasks are unavailable")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Could not reach the local service");
    expect(onError).toHaveBeenCalledWith("Could not reach the local service");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Recovered task")).toBeTruthy();
    expect(api.invalidateCache).toHaveBeenCalledWith("/api/todos");
    expect(api.listTodos).toHaveBeenCalledTimes(2);
  });
});

function apiStub(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    invalidateCache: vi.fn(),
    listTodos: vi.fn().mockResolvedValue([]),
    createTodo: vi.fn(),
    updateTodo: vi.fn(),
    deleteTodo: vi.fn(),
    ...overrides
  } as unknown as ApiClient;
}

function task(id: string, text: string, date: string, completed = false): TodoItem {
  return {
    id,
    date,
    text,
    completed,
    position: 0,
    createdAt: "2026-08-01T12:00:00.000Z",
    updatedAt: completed ? "2026-08-02T12:00:00.000Z" : "2026-08-01T12:00:00.000Z"
  };
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateIso: string, days: number): string {
  const [year, month, day] = dateIso.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
