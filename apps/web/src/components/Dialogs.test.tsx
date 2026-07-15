import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Archive, Folder, GmailConnection } from "@email-client/shared";
import { GmailDialog } from "./Dialogs.js";

afterEach(cleanup);

describe("GmailDialog", () => {
  it("adds multiple accounts to new or existing local destinations", async () => {
    const onConnect = vi.fn();
    const onLoadFolders = vi.fn().mockResolvedValue(FOLDERS);
    render(
      <GmailDialog
        open
        archives={ARCHIVES}
        selectedArchiveId={ARCHIVES[0]!.id}
        connections={CONNECTIONS}
        loading={false}
        busy={false}
        error=""
        onClose={vi.fn()}
        onLoadFolders={onLoadFolders}
        onConnect={onConnect}
        onSync={vi.fn()}
        onCancel={vi.fn()}
        onCompose={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    expect(screen.getByText("first@example.test")).toBeTruthy();
    expect(screen.getByText("second@example.test")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add another Gmail account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New mailbox" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("New mailbox name"), { target: { value: "Second account" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: ARCHIVES[0]!.id,
      folderId: null,
      folderName: "Second account"
    }));

    fireEvent.click(screen.getByRole("button", { name: "Existing mailbox" }));
    await waitFor(() => expect(screen.getByLabelText("Merge into mailbox")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Merge into mailbox"), { target: { value: FOLDERS[1]!.id } });
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: ARCHIVES[0]!.id,
      folderId: FOLDERS[1]!.id
    }));

    fireEvent.click(screen.getByRole("button", { name: "New archive" }));
    fireEvent.change(screen.getByLabelText("Archive name"), { target: { value: "Personal Gmail" } });
    fireEvent.change(screen.getByLabelText("First mailbox"), { target: { value: "Inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: null,
      folderId: null,
      archiveName: "Personal Gmail",
      folderName: "Inbox"
    }));
  });
});

const ARCHIVES: Archive[] = [{
  id: "archive-one",
  name: "Combined mail",
  sourceType: "mbox",
  status: "ready",
  sizeBytes: 1_000,
  messageCount: 10,
  unreadCount: 4,
  folderCount: 2,
  attachmentCount: 0,
  errorCount: 0,
  importedAt: "2026-07-13T00:00:00.000Z",
  createdAt: "2026-07-13T00:00:00.000Z"
}];

const FOLDERS: Folder[] = [
  { id: "folder-inbox", archiveId: "archive-one", parentId: null, name: "Inbox", path: "Inbox", messageCount: 7, unreadCount: 3 },
  { id: "folder-shared", archiveId: "archive-one", parentId: null, name: "Shared", path: "Shared", messageCount: 3, unreadCount: 1 }
];

const CONNECTIONS: GmailConnection[] = [
  gmailConnection("connection-one", "first@example.test", "folder-inbox", "Inbox"),
  gmailConnection("connection-two", "second@example.test", "folder-shared", "Shared")
];

function gmailConnection(id: string, email: string, folderId: string, folderPath: string): GmailConnection {
  return {
    id,
    email,
    archiveId: "archive-one",
    archiveName: "Combined mail",
    folderId,
    folderPath,
    query: "newer_than:30d",
    ocrEnabled: false,
    canSend: true,
    status: "connected",
    processedItems: 0,
    totalItems: null,
    importedItems: 0,
    lastSyncedAt: null,
    lastError: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
}
