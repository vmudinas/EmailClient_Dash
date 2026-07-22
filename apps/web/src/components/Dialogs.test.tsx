import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Archive, Folder, GmailConnection } from "@email-client/shared";
import {
  CreateMailboxDialog,
  EMPTY_FILTERS,
  FilterPanel,
  GmailDialog,
  MailboxDropDialog
} from "./Dialogs.js";

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
        onFullSync={vi.fn()}
        onCancel={vi.fn()}
        onReorganize={vi.fn()}
        onReauthorize={vi.fn()}
        onCompose={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    expect(screen.getByText("first@example.test")).toBeTruthy();
    expect(screen.getByText("second@example.test")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Add another Gmail account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New mailbox" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("New local folder name"), { target: { value: "Second account" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize new Google account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: ARCHIVES[0]!.id,
      folderId: null,
      folderName: "Second account"
    }));

    fireEvent.click(screen.getByRole("button", { name: "Existing mailbox" }));
    await waitFor(() => expect(screen.getByLabelText("Merge into mailbox")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Merge into mailbox"), { target: { value: FOLDERS[1]!.id } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize new Google account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: ARCHIVES[0]!.id,
      folderId: FOLDERS[1]!.id
    }));

    fireEvent.click(screen.getByRole("button", { name: "New archive" }));
    fireEvent.change(screen.getByLabelText("Archive name"), { target: { value: "Personal Gmail" } });
    fireEvent.change(screen.getByLabelText("Local folder name"), { target: { value: "Inbox" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize new Google account" }));
    expect(onConnect).toHaveBeenLastCalledWith(expect.objectContaining({
      archiveId: null,
      folderId: null,
      archiveName: "Personal Gmail",
      folderName: "Inbox"
    }));
  });

  it("lets an existing connection be reauthorized in one click", () => {
    const onReauthorize = vi.fn();
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
        onLoadFolders={vi.fn().mockResolvedValue(FOLDERS)}
        onConnect={vi.fn()}
        onSync={vi.fn()}
        onFullSync={vi.fn()}
        onCancel={vi.fn()}
        onReorganize={vi.fn()}
        onReauthorize={onReauthorize}
        onCompose={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Reauthorize first@example.test" }));
    expect(onReauthorize).toHaveBeenCalledWith(CONNECTIONS[0]);
  });

  it("triggers a full sync for a connection after confirming", () => {
    const onFullSync = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
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
        onLoadFolders={vi.fn().mockResolvedValue(FOLDERS)}
        onConnect={vi.fn()}
        onSync={vi.fn()}
        onFullSync={onFullSync}
        onCancel={vi.fn()}
        onReorganize={vi.fn()}
        onReauthorize={vi.fn()}
        onCompose={vi.fn()}
        onDisconnect={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Sync all mail and folders for first@example.test" }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(onFullSync).toHaveBeenCalledWith(CONNECTIONS[0]!.id);
    confirmSpy.mockRestore();
  });
});

describe("mailbox organization dialogs", () => {
  it("defaults new mailboxes to the requested parent", () => {
    const onCreate = vi.fn();
    render(
      <CreateMailboxDialog
        open
        archive={ARCHIVES[0]!}
        folders={FOLDERS}
        initialParentId={FOLDERS[0]!.id}
        busy={false}
        onClose={vi.fn()}
        onCreate={onCreate}
      />
    );

    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(FOLDERS[0]!.id);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Receipts" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onCreate).toHaveBeenCalledWith("Receipts", FOLDERS[0]!.id);
  });

  it("asks whether a dropped mailbox should merge or move as a child", () => {
    const onMerge = vi.fn();
    const onMoveAsChild = vi.fn();
    render(
      <MailboxDropDialog
        source={FOLDERS[0]!}
        target={FOLDERS[1]!}
        busy={false}
        onClose={vi.fn()}
        onMerge={onMerge}
        onMoveAsChild={onMoveAsChild}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Move as child" }));
    expect(onMerge).toHaveBeenCalledOnce();
    expect(onMoveAsChild).toHaveBeenCalledOnce();
  });
});

describe("FilterPanel", () => {
  it("applies a specific mailbox as the search scope", () => {
    const onChange = vi.fn();
    render(
      <FilterPanel
        open
        value={EMPTY_FILTERS}
        folders={FOLDERS}
        currentFolderLabel="Inbox"
        onChange={onChange}
        onClose={vi.fn()}
      />
    );

    fireEvent.change(screen.getByLabelText("Search in mailbox"), {
      target: { value: FOLDERS[1]!.id }
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect(onChange).toHaveBeenCalledWith({
      ...EMPTY_FILTERS,
      folderId: FOLDERS[1]!.id
    });
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
    canManageCalendar: false,
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
