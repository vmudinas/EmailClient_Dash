import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MessageActionSuggestion } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { MessageActionDialog } from "./MessageActionDialog.js";

const SUGGESTION: MessageActionSuggestion = {
  recommendedAction: "calendar_event",
  reason: "The message requests a dated follow-up.",
  confidence: 0.92,
  dateEvidence: ["Please respond by July 20"],
  calendarEvent: {
    title: "Respond to manager",
    description: "Review the request and respond.",
    location: "",
    allDay: true,
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    startTime: null,
    endTime: null
  },
  todo: {
    date: "2026-07-20",
    text: "Respond to manager"
  },
  provider: "deepseek",
  model: "deepseek-chat"
};

describe("MessageActionDialog", () => {
  it("honors the requested action and waits for post-create review work", async () => {
    const createTodo = vi.fn().mockResolvedValue({
      id: "todo-1",
      date: "2026-07-20",
      text: "Respond to manager",
      completed: false,
      createdAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z"
    });
    const onCreated = vi.fn().mockResolvedValue(undefined);
    const api = { createTodo } as unknown as ApiClient;

    render(
      <MessageActionDialog
        api={api}
        messageId="message-1"
        suggestion={SUGGESTION}
        connections={[]}
        initialAction="todo"
        onClose={vi.fn()}
        onCreated={onCreated}
        onError={vi.fn()}
      />
    );

    expect((screen.getByLabelText("Action type") as HTMLSelectElement).value).toBe("todo");
    fireEvent.click(screen.getByRole("button", { name: "Create to-do" }));

    await waitFor(() => expect(createTodo).toHaveBeenCalledWith({
      date: "2026-07-20",
      text: "Respond to manager"
    }));
    expect(onCreated).toHaveBeenCalledWith("To-do created for Jul 20, 2026.", "todo");
  });
});
