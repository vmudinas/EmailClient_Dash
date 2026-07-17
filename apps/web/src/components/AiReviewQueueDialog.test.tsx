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
    const onDeleteDraft = vi.fn();
    const onCreateAction = vi.fn();
    const onMarkAnalysisReviewed = vi.fn();
    const onMarkAllAnalysesReviewed = vi.fn();
    const onCompleteFollowUp = vi.fn();
    const analysisItem = {
      message: {
        id: "message-2",
        archiveId: "archive-1",
        folderId: "folder-1",
        folderPath: "Inbox",
        subject: "Approve the launch plan",
        sender: { name: "Manager", address: "manager@example.test" },
        recipients: [{ name: "Owner", address: "owner@example.test" }],
        sentAt: "2026-07-16T12:00:00.000Z",
        receivedAt: "2026-07-16T12:00:00.000Z",
        preview: "Please approve the launch plan.",
        hasAttachments: false,
        attachmentCount: 0,
        state: { isRead: true, isStarred: false, tags: [], note: "", updatedAt: null }
      },
      analysis: {
        id: "analysis-1",
        messageId: "message-2",
        summary: "Approval requested.",
        categories: ["Work"],
        priority: "high" as const,
        actionRequired: true,
        actionSummary: "Approve or request changes",
        spamProbability: 0,
        phishingProbability: 0,
        draftRecommended: false,
        confidence: 0.95,
        signals: ["Direct approval request"],
        model: "test-model",
        promptVersion: "test-v1",
        contentHash: "content-hash",
        createdAt: "2026-07-16T12:01:00.000Z",
        updatedAt: "2026-07-16T12:01:00.000Z"
      }
    };
    const urgentAnalysisItem = {
      message: {
        ...analysisItem.message,
        id: "message-3",
        subject: "Production outage",
        receivedAt: "2026-07-16T11:00:00.000Z"
      },
      analysis: {
        ...analysisItem.analysis,
        id: "analysis-2",
        messageId: "message-3",
        priority: "urgent" as const,
        actionSummary: "Restore service immediately",
        updatedAt: "2026-07-16T11:01:00.000Z"
      }
    };
    const newerHighAnalysisItem = {
      message: {
        ...analysisItem.message,
        id: "message-4",
        subject: "Review the updated budget",
        receivedAt: "2026-07-16T13:00:00.000Z"
      },
      analysis: {
        ...analysisItem.analysis,
        id: "analysis-3",
        messageId: "message-4",
        actionSummary: "Approve the revised budget",
        updatedAt: "2026-07-16T13:01:00.000Z"
      }
    };
    render(
      <AiReviewQueueDialog
        open
        queue={{ drafts: [draft], analyses: [analysisItem, urgentAnalysisItem, newerHighAnalysisItem], followUps: [followUp], totalItems: 5 }}
        loading={false}
        busyItemId={null}
        reviewAllBusy={false}
        planningAction={null}
        readOnly={false}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onOpenDraft={onOpenDraft}
        onDeleteDraft={onDeleteDraft}
        onOpenMessage={vi.fn()}
        onCreateAction={onCreateAction}
        onMarkAnalysisReviewed={onMarkAnalysisReviewed}
        onMarkAllAnalysesReviewed={onMarkAllAnalysesReviewed}
        onCompleteFollowUp={onCompleteFollowUp}
      />
    );

    expect(screen.getByRole("heading", { name: "Urgent" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "High priority" })).toBeTruthy();
    const attentionItems = screen.getAllByTestId("attention-message");
    expect(attentionItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Production outage"),
      expect.stringContaining("Review the updated budget"),
      expect.stringContaining("Approve the launch plan")
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Set all reviewed" }));
    expect(onMarkAllAnalysesReviewed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /^Re: Contract review/i }));
    expect(onOpenDraft).toHaveBeenCalledWith(draft);
    fireEvent.click(screen.getByRole("button", { name: "Delete draft Re: Contract review" }));
    expect(onDeleteDraft).toHaveBeenCalledWith(draft);
    fireEvent.click(screen.getByRole("button", { name: "Create event for Approve the launch plan" }));
    expect(onCreateAction).toHaveBeenCalledWith(analysisItem, "calendar_event");
    fireEvent.click(screen.getByRole("button", { name: "Create to-do for Approve the launch plan" }));
    expect(onCreateAction).toHaveBeenCalledWith(analysisItem, "todo");
    fireEvent.click(screen.getByRole("button", { name: "Mark Approve the launch plan reviewed" }));
    expect(onMarkAnalysisReviewed).toHaveBeenCalledWith(analysisItem);
    fireEvent.click(screen.getByRole("button", { name: "Mark follow-up complete" }));
    expect(onCompleteFollowUp).toHaveBeenCalledWith(followUp);
  });
});
