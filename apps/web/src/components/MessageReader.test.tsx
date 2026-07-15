import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiMessageState, MessageDetail } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { MessageReader } from "./MessageReader.js";

afterEach(cleanup);

describe("MessageReader AI analysis", () => {
  it("loads a saved structured analysis and can request it again", async () => {
    const state = analysisState();
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue(state),
      analyzeMessage: vi.fn().mockResolvedValue(state)
    } as unknown as ApiClient;
    renderReader(api);

    await waitFor(() => expect(screen.getByText("This email asks for a contract review.")).toBeTruthy());
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByText("Review the attached contract")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Analyze again/ }));
    await waitFor(() => expect(api.analyzeMessage).toHaveBeenCalledWith("message-1"));
  });

  it("shows configuration errors next to the message", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null }),
      analyzeMessage: vi.fn().mockRejectedValue(new Error("OpenAI is not configured. Add an API key in Admin settings > AI."))
    } as unknown as ApiClient;
    renderReader(api);

    await waitFor(() => expect(api.getMessageAiState).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(screen.getByText(/OpenAI is not configured/)).toBeTruthy());
  });
});

function renderReader(api: ApiClient): void {
  render(
    <MessageReader
      message={MESSAGE}
      loading={false}
      readOnly={false}
      api={api}
      onMobileBack={vi.fn()}
      onUpdateState={vi.fn().mockResolvedValue(undefined)}
      onError={vi.fn()}
    />
  );
}

function analysisState(): AiMessageState {
  return {
    job: {
      id: "job-1",
      messageId: "message-1",
      task: "analyze",
      status: "completed",
      model: "test-model",
      promptVersion: "message-analysis-v1",
      contentHash: "hash",
      attempts: 1,
      maxAttempts: 2,
      error: null,
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:01.000Z",
      startedAt: "2026-07-14T12:00:00.000Z",
      completedAt: "2026-07-14T12:00:01.000Z"
    },
    analysis: {
      id: "analysis-1",
      messageId: "message-1",
      summary: "This email asks for a contract review.",
      categories: ["Legal", "Customer"],
      priority: "high",
      actionRequired: true,
      actionSummary: "Review the attached contract",
      spamProbability: 0.01,
      phishingProbability: 0.02,
      draftRecommended: true,
      confidence: 0.82,
      signals: ["Direct request"],
      model: "test-model",
      promptVersion: "message-analysis-v1",
      contentHash: "hash",
      createdAt: "2026-07-14T12:00:01.000Z",
      updatedAt: "2026-07-14T12:00:01.000Z"
    }
  };
}

const MESSAGE: MessageDetail = {
  id: "message-1",
  archiveId: "archive-1",
  folderId: "folder-1",
  folderPath: "Inbox",
  subject: "Contract review",
  sender: { name: "Customer", address: "customer@example.test" },
  recipients: [{ name: "Owner", address: "owner@example.test" }],
  to: [{ name: "Owner", address: "owner@example.test" }],
  cc: [],
  bcc: [],
  sentAt: "2026-07-14T12:00:00.000Z",
  receivedAt: "2026-07-14T12:00:00.000Z",
  preview: "Please review the contract.",
  bodyText: "Please review the contract.",
  bodyHtml: null,
  headers: {},
  hasAttachments: false,
  attachmentCount: 0,
  attachments: [],
  state: {
    isRead: true,
    isStarred: false,
    tags: [],
    note: "",
    updatedAt: null
  }
};
