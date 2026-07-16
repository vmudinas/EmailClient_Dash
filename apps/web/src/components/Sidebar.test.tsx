import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Archive, Folder, MessageSummary } from "@email-client/shared";
import { Sidebar } from "./Sidebar.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const READY_ARCHIVE: Archive = {
  id: "archive-ready",
  name: "Ready archive",
  sourceType: "mbox",
  status: "ready",
  sizeBytes: 1_024,
  messageCount: 4,
  unreadCount: 3,
  folderCount: 1,
  attachmentCount: 0,
  errorCount: 0,
  importedAt: "2026-07-12T12:00:00.000Z",
  createdAt: "2026-07-12T12:00:00.000Z"
};

const INBOX: Folder = {
  id: "folder-inbox",
  archiveId: READY_ARCHIVE.id,
  parentId: null,
  name: "Inbox",
  path: "Inbox",
  messageCount: 4,
  unreadCount: 3
};

const SAVED: Folder = {
  ...INBOX,
  id: "folder-saved",
  name: "Saved",
  path: "Saved",
  messageCount: 0,
  unreadCount: 0
};

const DRAGGED_MESSAGE: MessageSummary = {
  id: "message-1",
  archiveId: READY_ARCHIVE.id,
  folderId: INBOX.id,
  folderPath: INBOX.path,
  subject: "Move me",
  sender: { name: null, address: "sender@example.test" },
  recipients: [],
  sentAt: null,
  receivedAt: "2026-07-15T00:00:00.000Z",
  preview: "Move me",
  hasAttachments: false,
  attachmentCount: 0,
  state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
};

describe("Sidebar archive and mailbox actions", () => {
  it("moves a dragged message onto another mailbox", () => {
    const onMoveMessage = vi.fn();
    renderSidebar({
      folders: [INBOX, SAVED],
      draggedMessage: DRAGGED_MESSAGE,
      onMoveMessage
    });

    fireEvent.drop(screen.getByTitle("Saved").closest("button")!);
    expect(onMoveMessage).toHaveBeenCalledWith(DRAGGED_MESSAGE.id, SAVED.id);
  });

  it("exposes working rename and delete controls for completed local archives", () => {
    const onRemoveArchive = vi.fn();
    const onRemoveFolder = vi.fn();
    const onRenameArchive = vi.fn();
    const onRenameFolder = vi.fn();
    renderSidebar({
      onRemoveArchive,
      onRemoveFolder,
      onRenameArchive,
      onRenameFolder
    });

    fireEvent.click(screen.getByRole("button", { name: "Rename Ready archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Ready archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Inbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete mailbox Inbox" }));

    expect(onRenameArchive).toHaveBeenCalledWith(READY_ARCHIVE);
    expect(onRemoveArchive).toHaveBeenCalledWith(READY_ARCHIVE.id);
    expect(onRenameFolder).toHaveBeenCalledWith(INBOX);
    expect(onRemoveFolder).toHaveBeenCalledWith(INBOX);
  });

  it("shows unread and total counts for archives and mailboxes", () => {
    renderSidebar();

    expect(screen.getByText("3 unread · 4 total · 1.0 KB")).toBeTruthy();
    expect(screen.getAllByLabelText("3 unread, 4 total")).toHaveLength(2);
  });

  it("allows active archive removal but hides mailbox mutations until import finishes", () => {
    renderSidebar({
      archives: [{ ...READY_ARCHIVE, status: "importing", name: "Active archive" }]
    });

    expect(screen.getByRole("button", { name: "Rename Active archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove Active archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename Inbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete mailbox Inbox" })).toBeNull();
  });

  it("does not expose mutation controls to read-only viewers", () => {
    renderSidebar({ readOnly: true });

    expect(screen.queryByRole("button", { name: "Rename Ready archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove Ready archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename Inbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete mailbox Inbox" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pull mail from Gmail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create mailbox" })).toBeNull();
  });

  it("opens Gmail, mailbox creation, archive combine, and mailbox combine actions", () => {
    const onOpenGmail = vi.fn();
    const onCreateFolder = vi.fn();
    const onCombineArchive = vi.fn();
    const onCombineFolder = vi.fn();
    renderSidebar({
      archives: [
        READY_ARCHIVE,
        { ...READY_ARCHIVE, id: "archive-second", name: "Second archive" }
      ],
      folders: [INBOX, SAVED],
      onOpenGmail,
      onCreateFolder,
      onCombineArchive,
      onCombineFolder
    });

    fireEvent.click(screen.getByRole("button", { name: "Pull mail from Gmail" }));
    fireEvent.click(screen.getByRole("button", { name: "Create mailbox" }));
    fireEvent.click(screen.getByRole("button", { name: "Combine Ready archive" }));
    fireEvent.click(screen.getByRole("button", { name: "Combine mailbox Inbox" }));

    expect(onOpenGmail).toHaveBeenCalledOnce();
    expect(onCreateFolder).toHaveBeenCalledOnce();
    expect(onCombineArchive).toHaveBeenCalledWith(READY_ARCHIVE);
    expect(onCombineFolder).toHaveBeenCalledWith(INBOX);
  });

  it("shows percentage and total email progress for an active import", () => {
    renderSidebar({
      jobs: [{
        id: "job-1",
        archiveId: READY_ARCHIVE.id,
        sourceName: "Inbox.mbox",
        sourceType: "mbox",
        status: "running",
        phase: "parsing",
        processedItems: 25,
        totalItems: 100,
        processedBytes: 256,
        totalBytes: 1_024,
        errorCount: 0,
        ocrEnabled: false,
        canResume: false,
        message: "Importing messages",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z"
      }]
    });

    expect(screen.getByText("32%")).toBeTruthy();
    expect(screen.getByText("25 of 100 emails")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Inbox.mbox import progress" }).getAttribute("aria-valuenow")).toBe("32");
  });

  it("collapses and expands nested mailboxes, remembering the state after remount", () => {
    const CHILD: Folder = {
      ...INBOX,
      id: "folder-inbox-alerts",
      parentId: INBOX.id,
      name: "Alerts",
      path: "Inbox/Alerts"
    };
    const view = renderSidebar({ folders: [INBOX, CHILD] });

    expect(screen.getByText("Alerts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Inbox" }));
    expect(screen.queryByText("Alerts")).toBeNull();

    view.unmount();
    renderSidebar({ folders: [INBOX, CHILD] });
    expect(screen.queryByText("Alerts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand Inbox" }));
    expect(screen.getByText("Alerts")).toBeTruthy();
  });

  it("restarts stopped imports from their checkpoint or clears them", () => {
    const onResumeJob = vi.fn();
    const onClearJob = vi.fn();
    renderSidebar({
      jobs: [{
        id: "job-stopped",
        archiveId: READY_ARCHIVE.id,
        sourceName: "Stopped.mbox",
        sourceType: "mbox",
        status: "cancelled",
        phase: "parsing",
        processedItems: 400,
        totalItems: 1_000,
        processedBytes: 4_000,
        totalBytes: 10_000,
        errorCount: 0,
        ocrEnabled: false,
        canResume: true,
        message: "Import cancelled",
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:01:00.000Z"
      }],
      onResumeJob,
      onClearJob
    });

    fireEvent.click(screen.getByRole("button", { name: "Restart import from checkpoint" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear import" }));

    expect(onResumeJob).toHaveBeenCalledWith("job-stopped");
    expect(onClearJob).toHaveBeenCalledWith("job-stopped");
  });
});

function renderSidebar(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return render(
    <Sidebar
      archives={[READY_ARCHIVE]}
      folders={[INBOX]}
      jobs={[]}
      selectedArchiveId={READY_ARCHIVE.id}
      selectedFolderId={null}
      readOnly={false}
      draggedMessage={null}
      moveBusy={false}
      onSelectArchive={vi.fn()}
      onSelectFolder={vi.fn()}
      onImport={vi.fn()}
      onOpenGmail={vi.fn()}
      onCreateFolder={vi.fn()}
      onCombineArchive={vi.fn()}
      onCombineFolder={vi.fn()}
      onCancelJob={vi.fn()}
      onResumeJob={vi.fn()}
      onClearJob={vi.fn()}
      onRemoveArchive={vi.fn()}
      onRemoveFolder={vi.fn()}
      onRenameArchive={vi.fn()}
      onRenameFolder={vi.fn()}
      onMoveMessage={vi.fn()}
      onOpenDiagnostics={vi.fn()}
      {...overrides}
    />
  );
}
