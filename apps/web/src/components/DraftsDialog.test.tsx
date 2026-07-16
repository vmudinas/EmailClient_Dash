import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmailDraft } from "@email-client/shared";
import { DraftsDialog } from "./DraftsDialog.js";

const DRAFT: EmailDraft = {
  id: "draft-1",
  connectionId: "connection-1",
  connectionEmail: "owner@example.test",
  sourceMessageId: "message-1",
  sourceMessageSubject: "Engineering opportunity",
  scheduleId: "schedule-1",
  scheduleName: "Development replies",
  source: "ai",
  fromAddress: null,
  to: ["recruiter@example.test"],
  cc: [],
  bcc: [],
  subject: "Re: Engineering opportunity",
  bodyText: "Thank you for reaching out.",
  resumeId: "resume-1",
  resumeName: "Engineering resume",
  resumeFilename: "resume.pdf",
  workRelated: true,
  developmentOpportunity: true,
  aiReason: "A recruiter is offering software development work.",
  aiConfidence: 0.96,
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:01:00.000Z"
};

describe("DraftsDialog", () => {
  it("shows AI and resume context and opens the selected draft for review", () => {
    const onEdit = vi.fn();
    render(
      <DraftsDialog
        open
        drafts={[DRAFT]}
        loading={false}
        busy={false}
        error=""
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onEdit={onEdit}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText(/AI draft · Development replies/)).toBeTruthy();
    expect(screen.getByText(/Resume: resume.pdf/)).toBeTruthy();
    expect(screen.getByText(DRAFT.aiReason!)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Re: Engineering opportunity" }));
    expect(onEdit).toHaveBeenCalledWith(DRAFT);
  });
});
