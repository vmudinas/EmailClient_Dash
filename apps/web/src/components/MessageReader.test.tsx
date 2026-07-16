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

describe("MessageReader reply, forward, and move", () => {
  it("invokes onReply and onForward with the current message", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    const onReply = vi.fn();
    const onForward = vi.fn();
    renderReader(api, MESSAGE, { onReply, onForward });

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));

    expect(onReply).toHaveBeenCalledWith(MESSAGE);
    expect(onForward).toHaveBeenCalledWith(MESSAGE);
  });

  it("loads mailboxes for the move menu and moves the message to the chosen one", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    const onLoadFolders = vi.fn().mockResolvedValue([
      { id: "folder-1", archiveId: "archive-1", parentId: null, name: "Inbox", path: "Inbox", messageCount: 1, unreadCount: 0 },
      { id: "folder-2", archiveId: "archive-1", parentId: null, name: "Archived", path: "Archived", messageCount: 0, unreadCount: 0 }
    ]);
    const onMove = vi.fn().mockResolvedValue(undefined);
    renderReader(api, MESSAGE, { onLoadFolders, onMove });

    fireEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await waitFor(() => expect(onLoadFolders).toHaveBeenCalledWith("archive-1"));

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Archived" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: "Inbox" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Archived" }));
    expect(onMove).toHaveBeenCalledWith("message-1", "folder-2");
  });

  it("offers a one-click Archive action for inbox messages", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    const onArchive = vi.fn().mockResolvedValue(undefined);
    renderReader(api, MESSAGE, { onArchive });

    fireEvent.click(screen.getByRole("button", { name: "Archive message" }));
    expect(onArchive).toHaveBeenCalledWith(MESSAGE);
  });
});

describe("MessageReader attachment preview", () => {
  it("previews an image attachment and offers no preview for a non-previewable one", async () => {
    const imageBlob = new Blob(["fake-image-bytes"], { type: "image/png" });
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null }),
      attachmentBlob: vi.fn().mockResolvedValue(imageBlob)
    } as unknown as ApiClient;
    renderReader(api, {
      ...MESSAGE,
      attachments: [
        {
          id: "attachment-1",
          messageId: MESSAGE.id,
          filename: "photo.png",
          contentType: "image/png",
          sizeBytes: 2_048,
          contentId: null,
          disposition: "attachment",
          textStatus: "unsupported"
        },
        {
          id: "attachment-2",
          messageId: MESSAGE.id,
          filename: "archive.zip",
          contentType: "application/zip",
          sizeBytes: 4_096,
          contentId: null,
          disposition: "attachment",
          textStatus: "unsupported"
        }
      ]
    });

    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Preview photo.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview archive.zip" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview photo.png" }));

    await waitFor(() => expect(api.attachmentBlob).toHaveBeenCalledWith("attachment-1"));
    await waitFor(() => expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "photo.png" })).toBeNull());
  });
});

describe("MessageReader remote images", () => {
  it("blocks remote images by default and reveals them after Show images is clicked", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    renderReader(api, {
      ...MESSAGE,
      bodyHtml: '<img src="https://example.test/pixel.gif" alt="pixel" data-remote-src="https://example.test/pixel.gif">'
    });

    await waitFor(() => expect(screen.getByText("Images are blocked to protect your privacy.")).toBeTruthy());
    const frame = document.querySelector("iframe.email-frame") as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("srcdoc")).not.toMatch(/<img[^>]*\ssrc=/));

    fireEvent.click(screen.getByRole("button", { name: "Show images" }));

    await waitFor(() => expect(screen.queryByText("Images are blocked to protect your privacy.")).toBeNull());
    await waitFor(() => expect(document.querySelector("iframe.email-frame")?.getAttribute("srcdoc")).toContain("https://example.test/pixel.gif"));
  });

  it("does not show the banner for a message with no remote images", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    renderReader(api, {
      ...MESSAGE,
      bodyHtml: "<p>Plain content with no images.</p>"
    });

    await waitFor(() => expect(document.querySelector("iframe.email-frame")).toBeTruthy());
    expect(screen.queryByText("Images are blocked to protect your privacy.")).toBeNull();
  });
});

function renderReader(
  api: ApiClient,
  message: MessageDetail = MESSAGE,
  handlers: Partial<React.ComponentProps<typeof MessageReader>> = {}
) {
  return render(
    <MessageReader
      message={message}
      loading={false}
      readOnly={false}
      api={api}
      onMobileBack={vi.fn()}
      onUpdateState={vi.fn().mockResolvedValue(undefined)}
      onError={vi.fn()}
      onReply={vi.fn()}
      onForward={vi.fn()}
      onLoadFolders={vi.fn().mockResolvedValue([])}
      onMove={vi.fn().mockResolvedValue(undefined)}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      moveBusy={false}
      {...handlers}
    />
  );
}

function analysisState(): AiMessageState {
  return {
    job: {
      id: "job-1",
      messageId: "message-1",
      task: "analyze",
      scheduleId: null,
      gmailConnectionId: null,
      resumeId: null,
      status: "completed",
      provider: "openai",
      model: "test-model",
      skills: ["summarize"],
      prompt: "",
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
