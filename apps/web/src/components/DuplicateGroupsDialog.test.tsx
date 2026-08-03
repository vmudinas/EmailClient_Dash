import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuplicateGroup, DuplicateGroupDetail, DuplicateScan, MessageDetail } from "@email-client/shared";
import { DuplicateGroupsDialog } from "./DuplicateGroupsDialog.js";

afterEach(cleanup);

function message(id: string, subject: string): MessageDetail {
  return {
    id,
    archiveId: "archive-1",
    folderId: "folder-1",
    subject,
    sender: { name: "Billing", address: "billing@example.test" },
    to: [{ name: null, address: "me@example.test" }],
    sentAt: "2026-07-01T09:00:00.000Z",
    receivedAt: "2026-07-01T09:00:00.000Z",
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: 900,
    isRead: true,
    isFlagged: false,
    inboxCategory: "primary",
    cc: [],
    bcc: [],
    bodyText: "Payment is due Friday.",
    bodyHtml: null,
    headers: {}
  } as unknown as MessageDetail;
}

const group: DuplicateGroup = {
  id: "group-1",
  groupKey: "u:message-1",
  preferredMessageId: "message-1",
  detectionTier: "content_hash",
  confidence: 0.95,
  memberCount: 2,
  reviewStatus: "pending",
  reviewedAt: null,
  createdAt: "2026-07-02T09:00:00.000Z",
  updatedAt: "2026-07-02T09:00:00.000Z"
};

const detail: DuplicateGroupDetail = {
  group,
  members: [
    { message: message("message-1", "Invoice 42"), relation: "same_message", evidence: ["identical normalized content and attachments"] },
    { message: message("message-2", "Re: Invoice 42"), relation: "same_message", evidence: ["identical normalized content and attachments"] }
  ]
};

function renderDialog(overrides: Partial<Parameters<typeof DuplicateGroupsDialog>[0]> = {}) {
  const props = {
    open: true,
    list: { groups: [group], totalPending: 1, scan: null },
    status: "pending" as const,
    expanded: null,
    expandedId: null,
    loading: false,
    scan: null,
    scanStarting: false,
    busyGroupId: null,
    readOnly: false,
    archives: [{ id: "archive-1", name: "Primary archive" }],
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onScan: vi.fn(),
    onCancelScan: vi.fn(),
    onChangeStatus: vi.fn(),
    onToggleGroup: vi.fn(),
    onConfirm: vi.fn(),
    onDismiss: vi.fn(),
    onSetPreferred: vi.fn(),
    onOpenMessage: vi.fn(),
    onLoadFolders: vi.fn().mockResolvedValue([{ id: "folder-2", archiveId: "archive-1", parentId: null, name: "Receipts", path: "Receipts", messageCount: 0, unreadCount: 0 }]),
    onMoveCopies: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  render(<DuplicateGroupsDialog {...props} />);
  return props;
}

describe("DuplicateGroupsDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <DuplicateGroupsDialog
        open={false}
        list={null}
        status="pending"
        expanded={null}
        expandedId={null}
        loading={false}
        scan={null}
        scanStarting={false}
        busyGroupId={null}
        readOnly={false}
        archives={[]}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onScan={vi.fn()}
        onCancelScan={vi.fn()}
        onChangeStatus={vi.fn()}
        onToggleGroup={vi.fn()}
        onConfirm={vi.fn()}
        onDismiss={vi.fn()}
        onSetPreferred={vi.fn()}
        onOpenMessage={vi.fn()}
        onLoadFolders={vi.fn().mockResolvedValue([])}
        onMoveCopies={vi.fn().mockResolvedValue(true)}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("summarises groups and extra copies", () => {
    renderDialog();
    expect(screen.getByText("Groups")).toBeTruthy();
    expect(screen.getByText("Extra copies")).toBeTruthy();
    expect(screen.getByText("Identical content")).toBeTruthy();
  });

  it("states that filing keeps the preferred copy", () => {
    renderDialog();
    expect(screen.getByText(/filing actions always keep the preferred copy/)).toBeTruthy();
  });

  it("expands a group when its summary is clicked", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /2 copies/ }));
    expect(props.onToggleGroup).toHaveBeenCalledWith(group);
  });

  it("lists member copies with their evidence once expanded", () => {
    renderDialog({ expanded: detail, expandedId: "group-1" });
    expect(screen.getByText("Invoice 42")).toBeTruthy();
    expect(screen.getByText("Re: Invoice 42")).toBeTruthy();
    expect(screen.getAllByText("identical normalized content and attachments")).toHaveLength(2);
  });

  it("marks the preferred copy and lets another copy take over", () => {
    const props = renderDialog({ expanded: detail, expandedId: "group-1" });
    expect(screen.getByText("Preferred")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Prefer Re: Invoice 42"));
    expect(props.onSetPreferred).toHaveBeenCalledWith(group, "message-2");
  });

  it("confirms and dismisses a group", () => {
    const props = renderDialog({ expanded: detail, expandedId: "group-1" });
    fireEvent.click(screen.getByRole("button", { name: /Mark duplicate/ }));
    expect(props.onConfirm).toHaveBeenCalledWith(group);
    fireEvent.click(screen.getByRole("button", { name: /Keep separate/ }));
    expect(props.onDismiss).toHaveBeenCalledWith(group);
  });

  it("archives or trashes every copy except the preferred one", () => {
    const props = renderDialog({ expanded: detail, expandedId: "group-1" });

    fireEvent.click(screen.getByRole("button", { name: "Archive copies" }));
    expect(props.onMoveCopies).toHaveBeenCalledWith(detail, { destination: "archived" });

    fireEvent.click(screen.getByRole("button", { name: "Trash copies" }));
    expect(props.onMoveCopies).toHaveBeenCalledWith(detail, { destination: "trash" });
  });

  it("moves copies to a chosen folder and can request future sender rules", async () => {
    const props = renderDialog({ expanded: detail, expandedId: "group-1" });

    fireEvent.click(screen.getByRole("button", { name: "Move to folder" }));
    await waitFor(() => expect(props.onLoadFolders).toHaveBeenCalledWith("archive-1"));
    fireEvent.change(await screen.findByLabelText("Destination folder for Primary archive"), { target: { value: "folder-2" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Create future sender rules/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move copies" }));

    await waitFor(() => expect(props.onMoveCopies).toHaveBeenCalledWith(detail, {
      destination: "folder",
      createRules: true,
      targets: [{ archiveId: "archive-1", folderId: "folder-2", folderPath: "Receipts" }]
    }));
  });

  it("opens a member message", () => {
    const props = renderDialog({ expanded: detail, expandedId: "group-1" });
    fireEvent.click(screen.getAllByTitle("Open this copy")[0]!);
    expect(props.onOpenMessage).toHaveBeenCalledWith("message-1");
  });

  it("hides every mutating control for read-only viewers", () => {
    renderDialog({ expanded: detail, expandedId: "group-1", readOnly: true });
    expect(screen.queryByRole("button", { name: /Mark duplicate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Keep separate/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Scan now/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive copies" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Trash copies" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to folder" })).toBeNull();
    expect(screen.queryByLabelText("Prefer Re: Invoice 42")).toBeNull();
  });

  it("runs a scan on request", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /Scan now/ }));
    expect(props.onScan).toHaveBeenCalled();
  });

  it("switches between pending and confirmed", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("tab", { name: "Confirmed" }));
    expect(props.onChangeStatus).toHaveBeenCalledWith("confirmed");
  });

  it("shows an empty state when there is nothing to review", () => {
    renderDialog({ list: { groups: [], totalPending: 0, scan: null } });
    expect(screen.getByText("No duplicates to review")).toBeTruthy();
  });

  it("reports the running phase and lets the user leave while a scan runs", () => {
    const props = renderDialog({ scan: runningScan({ phase: "fingerprinting", processedItems: 250, totalItems: 1000 }) });
    expect(screen.getByText("Fingerprinting messages")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    // The whole point of the background job: closing is never blocked by a scan.
    fireEvent.click(screen.getByLabelText("Close"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("keeps the review tabs usable during a scan", () => {
    const props = renderDialog({ scan: runningScan({ phase: "matching" }) });
    fireEvent.click(screen.getByRole("tab", { name: "Confirmed" }));
    expect(props.onChangeStatus).toHaveBeenCalledWith("confirmed");
  });

  it("offers to stop a running scan instead of starting another", () => {
    const props = renderDialog({ scan: runningScan({}) });
    expect(screen.queryByRole("button", { name: /Scan now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Stop scan/ }));
    expect(props.onCancelScan).toHaveBeenCalled();
  });

  it("surfaces a failed scan", () => {
    renderDialog({ scan: runningScan({ status: "failed", message: "connection reset" }) });
    expect(screen.getByText(/connection reset/)).toBeTruthy();
  });

  it("says so when near-duplicate coverage was capped", () => {
    renderDialog({
      scan: runningScan({ status: "completed", phase: "done", scannedMessages: 50000, skippedMessages: 12000 })
    });
    expect(screen.getByText(/12,000 were past that limit/)).toBeTruthy();
  });
});

function runningScan(overrides: Partial<DuplicateScan>): DuplicateScan {
  return {
    id: "scan-1",
    status: "running",
    phase: "fingerprinting",
    processedItems: 0,
    totalItems: null,
    fingerprinted: 0,
    groupsCreated: 0,
    duplicateMessages: 0,
    scannedMessages: 0,
    skippedMessages: 0,
    message: "",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    finishedAt: null,
    ...overrides
  };
}
