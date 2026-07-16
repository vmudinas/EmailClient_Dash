import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiReviewQueueDialog } from "./AiReviewQueueDialog.js";

describe("AiReviewQueueDialog", () => {
  it("opens drafts and completes tracked follow-ups from one queue", () => {
    const draft = {
      id: "draft-1",
      connectionId: "connection-1",
      connectionEmail: "owner@example.test",
      sourceMessageId: "message-1",
      sourceMessageSubject: "Contract review",
      scheduleId: null,
      scheduleName: null,
      source: "ai" as const,
      fromAddress: "owner@example.test",
      to: ["client@example.test"],
      cc: [], bcc: [],
      subject: "Re: Contract review",
      bodyText: "Thanks, I will review it.",
      resumeId: null, resumeName: null, resumeFilename: null,
      workRelated: true,
      developmentOpportunity: false,
      aiReason: "Client request",
      aiConfidence: 0.9,
      createdAt: "2026-07-16T12:00:00.000Z",
      updatedAt: "2026-07-16T12:00:00.000Z"
    };
    const followUp = {
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
    const onOpenDraft = vi.fn();
    const onCompleteFollowUp = vi.fn();
    render(
      <AiReviewQueueDialog
        open
        queue={{ drafts: [draft], analyses: [], followUps: [followUp], totalItems: 2 }}
        loading={false}
        busyFollowUpId={null}
        readOnly={false}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onOpenDraft={onOpenDraft}
        onOpenMessage={vi.fn()}
        onCompleteFollowUp={onCompleteFollowUp}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Re: Contract review/i }));
    expect(onOpenDraft).toHaveBeenCalledWith(draft);
    fireEvent.click(screen.getByRole("button", { name: "Mark follow-up complete" }));
    expect(onCompleteFollowUp).toHaveBeenCalledWith(followUp);
  });
});
