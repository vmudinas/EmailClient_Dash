import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiMessageState, EmailDraft, MessageDetail } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { MessageReader } from "./MessageReader.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("MessageReader AI analysis", () => {
  it("returns to the message list from the reader toolbar", () => {
    const api = { getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null }) } as unknown as ApiClient;
    const onMobileBack = vi.fn();
    renderReader(api, MESSAGE, { onMobileBack });

    fireEvent.click(screen.getByRole("button", { name: "Back to messages" }));

    expect(onMobileBack).toHaveBeenCalledOnce();
  });

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

  it("reviews and edits an AI-recommended to-do before creating it", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue(analysisState()),
      suggestMessageAction: vi.fn().mockResolvedValue({
        recommendedAction: "todo",
        reason: "The contract review is due Friday.",
        confidence: 0.9,
        dateEvidence: ["Please review by Friday, July 17"],
        calendarEvent: null,
        todo: { date: "2026-07-17", text: "Review the attached contract" },
        provider: "openai",
        model: "test-model"
      }),
      createTodo: vi.fn().mockResolvedValue({
        id: "todo-1",
        date: "2026-07-18",
        text: "Review and approve the attached contract",
        completed: false,
        position: 0,
        createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z"
      })
    } as unknown as ApiClient;
    renderReader(api);
    await waitFor(() => expect(screen.getByRole("button", { name: "Plan event or to-do" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Plan event or to-do" }));

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Review AI action" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-07-18" } });
    fireEvent.change(screen.getByLabelText("To-do"), { target: { value: "Review and approve the attached contract" } });
    fireEvent.click(screen.getByRole("button", { name: "Create to-do" }));

    await waitFor(() => expect(api.createTodo).toHaveBeenCalledWith({
      date: "2026-07-18",
      text: "Review and approve the attached contract"
    }));
    expect(await screen.findByText(/To-do created/)).toBeTruthy();
  });

  it("reviews and edits an AI-recommended calendar event before creating it", async () => {
    const connection = calendarConnection();
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue(analysisState()),
      suggestMessageAction: vi.fn().mockResolvedValue({
        recommendedAction: "calendar_event",
        reason: "The email confirms a specific interview time.",
        confidence: 0.95,
        dateEvidence: ["Interview July 20 at 2 PM"],
        calendarEvent: {
          title: "AWS interview",
          description: "Interview from the email",
          location: "Google Meet",
          allDay: false,
          startDate: "2026-07-20",
          endDate: "2026-07-20",
          startTime: "14:00",
          endTime: "15:00"
        },
        todo: null,
        provider: "deepseek",
        model: "deepseek-chat"
      }),
      createCalendarEventFromMessage: vi.fn().mockResolvedValue({
        id: "event-1",
        connectionId: connection.id,
        title: "AWS engineering interview",
        description: "Interview from the email",
        location: "Google Meet",
        startAt: "2026-07-20T18:00:00.000Z",
        endAt: "2026-07-20T19:00:00.000Z",
        allDay: false,
        htmlLink: null,
        meetingLink: null,
        organizer: null,
        attendees: []
      })
    } as unknown as ApiClient;
    const onIndicatorsChange = vi.fn();
    renderReader(api, MESSAGE, { connections: [connection], onIndicatorsChange });
    await waitFor(() => expect(screen.getByRole("button", { name: "Plan event or to-do" })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Plan event or to-do" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Review AI action" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "AWS engineering interview" } });
    fireEvent.click(screen.getByRole("button", { name: "Create calendar event" }));

    await waitFor(() => expect(api.createCalendarEventFromMessage).toHaveBeenCalledWith(
      MESSAGE.id,
      connection.id,
      expect.objectContaining({
        title: "AWS engineering interview",
        allDay: false,
        location: "Google Meet"
      })
    ));
    expect(onIndicatorsChange).toHaveBeenCalledWith(MESSAGE.id, { hasCalendarEvent: true });
    expect(await screen.findByText('Calendar event "AWS engineering interview" created.')).toBeTruthy();
  });

  it("creates an AI draft with a selected account and resume, then opens it for review", async () => {
    const connection = calendarConnection();
    const queuedJob = {
      ...analysisState().job!,
      id: "draft-job-1",
      task: "draft_reply" as const,
      status: "queued" as const,
      gmailConnectionId: connection.id
    };
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue(analysisState()),
      listAvailableResumes: vi.fn().mockResolvedValue([{
        id: "00000000-0000-4000-8000-000000000002",
        name: "Engineering résumé",
        filename: "resume.pdf",
        contentType: "application/pdf",
        sizeBytes: 100,
        createdAt: "2026-07-16T12:00:00.000Z",
        updatedAt: "2026-07-16T12:00:00.000Z"
      }]),
      startMessageDraftReply: vi.fn().mockResolvedValue({ job: queuedJob, draft: null }),
      getAiJob: vi.fn().mockResolvedValue({
        ...queuedJob,
        status: "completed",
        completedAt: "2026-07-16T12:00:01.000Z"
      }),
      listDrafts: vi.fn().mockResolvedValue([AI_DRAFT])
    } as unknown as ApiClient;
    const onOpenDraft = vi.fn();
    renderReader(api, MESSAGE, { connections: [connection], onOpenDraft });

    await waitFor(() => expect(screen.getByRole("button", { name: "Draft reply" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Create AI reply draft" })).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText("Optional résumé").textContent).toContain("Engineering résumé"));
    fireEvent.change(screen.getByLabelText("Optional résumé"), {
      target: { value: "00000000-0000-4000-8000-000000000002" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate reviewable draft" }));

    await waitFor(() => expect(api.startMessageDraftReply).toHaveBeenCalledWith(MESSAGE.id, {
      gmailConnectionId: connection.id,
      resumeId: "00000000-0000-4000-8000-000000000002",
      replyStyleId: null
    }));
    await waitFor(() => expect(onOpenDraft).toHaveBeenCalledWith(AI_DRAFT));
  });

  it("offers contextual review-safe actions under More", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue(analysisState())
    } as unknown as ApiClient;
    const onReply = vi.fn();
    renderReader(api, {
      ...MESSAGE,
      headers: { "list-unsubscribe": "<https://example.test/unsubscribe>" }
    }, { onReply });

    await waitFor(() => expect(screen.getByRole("button", { name: /More/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /More/ }));
    expect(screen.getByRole("menuitem", { name: /Reply manually/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Create follow-up/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Copy summary/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Add sender to contacts/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Unsubscribe/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Move to folder/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Archive/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Always send sender to Spam/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: /Reply manually/ }));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: MESSAGE.id }));
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
      { id: "folder-2", archiveId: "archive-1", parentId: null, name: "Archived", path: "Account Mailboxes/Archived", messageCount: 0, unreadCount: 0 }
    ]);
    const onMove = vi.fn().mockResolvedValue(undefined);
    renderReader(api, MESSAGE, { onLoadFolders, onMove });

    fireEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await waitFor(() => expect(onLoadFolders).toHaveBeenCalledWith("archive-1"));

    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Account Mailboxes/Archived" })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: "Inbox" })).toBeNull();

    const archivedItem = screen.getByRole("menuitem", { name: "Account Mailboxes/Archived" });
    expect(archivedItem.textContent).toContain("Archived");
    expect(archivedItem.textContent).toContain("Account Mailboxes/Archived");
    fireEvent.click(archivedItem);
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

  it("offers an action to always send the current sender to Spam", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    const onSpamSender = vi.fn().mockResolvedValue(undefined);
    renderReader(api, MESSAGE, { onSpamSender });

    fireEvent.click(screen.getByRole("button", { name: "Always send sender to Spam" }));
    expect(onSpamSender).toHaveBeenCalledWith(MESSAGE);
  });
});

describe("MessageReader attachment preview", () => {
  it("shows inline attachments and lets the user download them", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null }),
      attachmentBlob: vi.fn().mockResolvedValue(new Blob(["inline-image"], { type: "image/png" }))
    } as unknown as ApiClient;
    renderReader(api, {
      ...MESSAGE,
      hasAttachments: true,
      attachmentCount: 1,
      attachments: [{
        id: "inline-attachment",
        messageId: MESSAGE.id,
        filename: "signature-logo.png",
        contentType: "application/octet-stream",
        sizeBytes: 1_024,
        contentId: "signature-logo",
        disposition: "inline",
        textStatus: "unsupported"
      }]
    });

    expect(await screen.findByText("signature-logo.png")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "1 inline image" })).toBeTruthy();
    expect(screen.getByText(/Inline/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview signature-logo.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download signature-logo.png" }));
    await waitFor(() => expect(api.attachmentBlob).toHaveBeenCalledWith("inline-attachment"));
  });

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
      bodyHtml: '<img src="https://example.test/pixel.gif" alt="pixel">'
    });

    await waitFor(() => expect(screen.getByText(/Remote images are blocked/)).toBeTruthy());
    const frame = document.querySelector("iframe.email-frame") as HTMLIFrameElement;
    await waitFor(() => expect(frame.getAttribute("srcdoc")).not.toMatch(/<img[^>]*\ssrc=/));

    fireEvent.click(screen.getByRole("button", { name: "Show images" }));

    await waitFor(() => expect(screen.queryByText(/Remote images are blocked/)).toBeNull());
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
    expect(screen.queryByText(/Remote images are blocked/)).toBeNull();
  });

  it("can remember and revoke remote images for a sender", async () => {
    const api = {
      getMessageAiState: vi.fn().mockResolvedValue({ job: null, analysis: null })
    } as unknown as ApiClient;
    renderReader(api, {
      ...MESSAGE,
      bodyHtml: '<img data-remote-src="https://example.test/logo.png" alt="logo">'
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Always for sender" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Always for sender" }));

    await waitFor(() => expect(screen.getByText(/shown automatically for Customer/)).toBeTruthy());
    expect(window.localStorage.getItem("archive-mail.trusted-remote-image-senders")).toContain("customer@example.test");

    fireEvent.click(screen.getByRole("button", { name: "Block images" }));
    await waitFor(() => expect(screen.getByText(/Remote images are blocked/)).toBeTruthy());
    expect(window.localStorage.getItem("archive-mail.trusted-remote-image-senders")).toBe("[]");
  });
});

function renderReader(
  api: ApiClient,
  message: MessageDetail = MESSAGE,
  handlers: Partial<React.ComponentProps<typeof MessageReader>> = {}
) {
  const { connections = [], ...overrides } = handlers;
  return render(
    <MessageReader
      message={message}
      loading={false}
      readOnly={false}
      api={api}
      connections={connections}
      onMobileBack={vi.fn()}
      onUpdateState={vi.fn().mockResolvedValue(undefined)}
      onError={vi.fn()}
      onReply={vi.fn()}
      onForward={vi.fn()}
      onLoadFolders={vi.fn().mockResolvedValue([])}
      onMove={vi.fn().mockResolvedValue(undefined)}
      onArchive={vi.fn().mockResolvedValue(undefined)}
      onSpamSender={vi.fn().mockResolvedValue(undefined)}
      onOpenDraft={vi.fn()}
      onIndicatorsChange={vi.fn()}
      moveBusy={false}
      spamBusy={false}
      {...overrides}
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
      scheduleRunId: null,
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

const AI_DRAFT: EmailDraft = {
  id: "00000000-0000-4000-8000-000000000003",
  connectionId: "connection-calendar",
  connectionEmail: "owner@example.test",
  sourceMessageId: MESSAGE.id,
  sourceMessageSubject: MESSAGE.subject,
  scheduleId: null,
  scheduleName: null,
  source: "ai",
  fromAddress: "ai@vitas.work",
  to: ["customer@example.test"],
  cc: [],
  bcc: [],
  subject: "Re: Contract review",
  bodyText: "Thanks for sending this. I will review it.",
  resumeId: null,
  resumeName: null,
  resumeFilename: null,
  workRelated: true,
  developmentOpportunity: false,
  aiReason: "A reply is recommended.",
  aiConfidence: 0.9,
  createdAt: "2026-07-16T12:00:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z"
};

function calendarConnection() {
  return {
    id: "connection-calendar",
    email: "owner@example.test",
    archiveId: "archive-1",
    archiveName: "Gmail",
    folderId: "folder-1",
    folderPath: "Inbox",
    query: "",
    ocrEnabled: false,
    canSend: true,
    canManageCalendar: true,
    status: "connected" as const,
    processedItems: 0,
    totalItems: null,
    importedItems: 0,
    lastSyncedAt: null,
    lastError: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z"
  };
}
