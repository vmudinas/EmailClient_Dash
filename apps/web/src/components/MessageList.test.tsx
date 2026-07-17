import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageSummary } from "@email-client/shared";
import { MessageList } from "./MessageList.js";

const MESSAGE: MessageSummary = {
  id: "message-1",
  archiveId: "archive-1",
  folderId: "folder-inbox",
  folderPath: "Inbox",
  subject: "Drag this message",
  sender: { name: "Sender", address: "sender@example.test" },
  recipients: [],
  sentAt: null,
  receivedAt: "2026-07-15T00:00:00.000Z",
  preview: "Message preview",
  hasAttachments: false,
  attachmentCount: 0,
  state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
};

const BULK_SELECTION_PROPS = {
  selectedIds: new Set<string>(),
  onToggleSelect: vi.fn(),
  onToggleSelectAll: vi.fn(),
  onClearSelection: vi.fn(),
  bulkBusy: false,
  onBulkDelete: vi.fn(),
  onBulkArchive: vi.fn(),
  onBulkSpam: vi.fn(),
  actionBusy: false,
  onArchive: vi.fn(),
  onSpam: vi.fn(),
  onToggleRead: vi.fn()
};

afterEach(cleanup);

describe("MessageList drag and drop", () => {
  it("makes writable message rows draggable and exposes their message id", () => {
    const onDragStart = vi.fn();
    const onDragEnd = vi.fn();
    const setData = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
      />
    );
    const row = screen.getByRole("option");

    fireEvent.dragStart(row, { dataTransfer: { effectAllowed: "", setData } });
    expect(setData).toHaveBeenCalledWith("text/plain", MESSAGE.id);
    expect(onDragStart).toHaveBeenCalledWith(MESSAGE);
    fireEvent.dragEnd(row);
    expect(onDragEnd).toHaveBeenCalledOnce();
  });

  it("prioritizes event-linked orange, analyzed purple, and read gray row states", () => {
    const readMessage: MessageSummary = {
      ...MESSAGE,
      id: "message-read",
      subject: "Read message",
      state: { ...MESSAGE.state, isRead: true }
    };
    const analyzedMessage: MessageSummary = {
      ...readMessage,
      id: "message-analyzed",
      subject: "Analyzed message",
      hasAiAnalysis: true,
      hasReply: true
    };
    const calendarMessage: MessageSummary = {
      ...analyzedMessage,
      id: "message-calendar",
      subject: "Calendar message",
      hasCalendarEvent: true
    };
    render(
      <MessageList
        items={[readMessage, analyzedMessage, calendarMessage].map((message) => ({ message }))}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
      />
    );

    const [readRow, analyzedRow, calendarRow] = screen.getAllByRole("option");
    expect(readRow?.classList.contains("read")).toBe(true);
    expect(readRow?.classList.contains("analyzed")).toBe(false);
    expect(analyzedRow?.classList.contains("analyzed")).toBe(true);
    expect(analyzedRow?.classList.contains("calendar-linked")).toBe(false);
    expect(calendarRow?.classList.contains("calendar-linked")).toBe(true);
    expect(calendarRow?.classList.contains("analyzed")).toBe(false);
    expect(screen.getByText("Analyzed")).toBeTruthy();
    expect(screen.getAllByText("Replied")).toHaveLength(2);
    expect(screen.getByText("Event")).toBeTruthy();
  });

  it("shows Gmail-style Inbox categories with counts and selection", () => {
    const onSelectCategory = vi.fn();
    render(
      <MessageList
        items={[]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        inboxCategories={{
          active: "primary",
          counts: {
            primary: 12,
            promotions: 8,
            social: 4,
            updates: 6,
            bills: 3,
            medical: 2,
            mail_tracking: 5
          },
          onSelect: onSelectCategory
        }}
        {...BULK_SELECTION_PROPS}
      />
    );

    expect(screen.getByRole("button", { name: "Primary, 12 messages" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Social, 4 messages" }));
    expect(onSelectCategory).toHaveBeenCalledWith("social");
    fireEvent.click(screen.getByRole("button", { name: "Mail/Tracking, 5 messages" }));
    expect(onSelectCategory).toHaveBeenCalledWith("mail_tracking");
    expect(screen.getByText("No primary messages")).toBeTruthy();
  });

  it("reveals touch actions and archives from the message row", () => {
    const onArchive = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        onArchive={onArchive}
      />
    );

    const row = screen.getByRole("option");
    fireEvent.touchStart(row, { touches: [{ clientX: 12, clientY: 20 }] });
    fireEvent.touchMove(row, { touches: [{ clientX: 100, clientY: 22 }] });
    fireEvent.touchEnd(row);
    expect(row.getAttribute("style")).toContain("translateX(120px)");

    fireEvent.click(screen.getByRole("button", { name: "Archive Drag this message" }));
    expect(onArchive).toHaveBeenCalledWith(MESSAGE);
  });
});

describe("MessageList bulk selection", () => {
  const OTHER_MESSAGE: MessageSummary = { ...MESSAGE, id: "message-2", subject: "Second message" };

  it("toggles an individual row's checkbox without opening the message", () => {
    const onSelect = vi.fn();
    const onToggleSelect = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={onSelect}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        onToggleSelect={onToggleSelect}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Drag this message" }));
    expect(onToggleSelect).toHaveBeenCalledWith(MESSAGE.id);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects and deselects all visible messages from the header checkbox", () => {
    const onToggleSelectAll = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }, { message: OTHER_MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        onToggleSelectAll={onToggleSelectAll}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown messages" }));
    expect(onToggleSelectAll).toHaveBeenCalledOnce();
  });

  it("shows the bulk action toolbar with a selection count once messages are selected", () => {
    const onBulkArchive = vi.fn();
    const onBulkSpam = vi.fn();
    const onBulkDelete = vi.fn();
    const onClearSelection = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }, { message: OTHER_MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        selectedIds={new Set([MESSAGE.id])}
        onBulkArchive={onBulkArchive}
        onBulkSpam={onBulkSpam}
        onBulkDelete={onBulkDelete}
        onClearSelection={onClearSelection}
      />
    );

    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move selected to Archive" }));
    expect(onBulkArchive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Move selected to Spam" }));
    expect(onBulkSpam).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(onBulkDelete).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("disables bulk actions while a bulk move is in progress", () => {
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        selectedIds={new Set([MESSAGE.id])}
        bulkBusy={true}
      />
    );

    expect(screen.getByRole("button", { name: "Delete selected" }).hasAttribute("disabled")).toBe(true);
  });

  it("hides selection checkboxes when the list is read-only", () => {
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={true}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
      />
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
