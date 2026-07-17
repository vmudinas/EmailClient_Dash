import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FollowUpDialog } from "./FollowUpDialog.js";

describe("FollowUpDialog", () => {
  it("creates an editable conversation follow-up", async () => {
    const created = {
      id: "follow-up-1",
      messageId: "message-1",
      subject: "Contract review",
      sender: { name: "Client", address: "client@example.test" },
      dueAt: "2026-07-18T13:00:00.000Z",
      note: "Review and reply",
      status: "pending" as const,
      completedAt: null,
      createdAt: "2026-07-16T13:00:00.000Z",
      updatedAt: "2026-07-16T13:00:00.000Z"
    };
    const createMessageFollowUp = vi.fn().mockResolvedValue(created);
    const onCreated = vi.fn();
    render(
      <FollowUpDialog
        open
        api={{ createMessageFollowUp } as never}
        messageId="message-1"
        subject="Contract review"
        suggestedNote="Review and reply"
        onClose={vi.fn()}
        onCreated={onCreated}
      />
    );

    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-18" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:00" } });
    fireEvent.change(screen.getByLabelText("Reminder note"), { target: { value: "Review and reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Save follow-up" }));

    await waitFor(() => expect(createMessageFollowUp).toHaveBeenCalledWith("message-1", {
      dueAt: expect.any(String),
      note: "Review and reply"
    }));
    expect(onCreated).toHaveBeenCalledWith(created);
  });
});
