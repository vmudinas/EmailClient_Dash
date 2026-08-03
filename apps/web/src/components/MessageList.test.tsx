import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboxCategoryCounts, MessageSummary } from "@email-client/shared";
import { DEFAULT_INBOX_TABS } from "@email-client/shared";
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
  onSelectFirst: vi.fn(),
  onSelectLoaded: vi.fn(),
  onSelectEntireView: vi.fn(),
  onClearSelection: vi.fn(),
  selectionBusy: false,
  bulkBusy: false,
  onBulkDelete: vi.fn(),
  onBulkArchive: vi.fn(),
  onBulkSpam: vi.fn(),
  onBulkMarkRead: vi.fn(),
  onBulkAiFile: vi.fn(),
  aiFilingBusy: false,
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
    expect(setData).toHaveBeenCalledWith("application/x-archive-mail-messages", JSON.stringify([MESSAGE.id]));
    expect(onDragStart).toHaveBeenCalledWith(MESSAGE, [MESSAGE.id]);
    fireEvent.dragEnd(row);
    expect(onDragEnd).toHaveBeenCalledOnce();
  });

  it("drags the full selection when a checked message row starts the drag", () => {
    const secondMessage = { ...MESSAGE, id: "message-2", subject: "Second selected message" };
    const onDragStart = vi.fn();
    const setData = vi.fn();
    const selectedIds = new Set([MESSAGE.id, secondMessage.id]);
    render(
      <MessageList
        items={[{ message: MESSAGE }, { message: secondMessage }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={false}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={onDragStart}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        selectedIds={selectedIds}
      />
    );

    fireEvent.dragStart(screen.getAllByRole("option")[0]!, { dataTransfer: { effectAllowed: "", setData } });

    expect(setData).toHaveBeenCalledWith("text/plain", `${MESSAGE.id}\n${secondMessage.id}`);
    expect(setData).toHaveBeenCalledWith("application/x-archive-mail-messages", JSON.stringify([...selectedIds]));
    expect(onDragStart).toHaveBeenCalledWith(MESSAGE, [...selectedIds]);
    expect(screen.getAllByRole("option").every((row) => row.classList.contains("dragging"))).toBe(true);
    expect(screen.getAllByTitle("Drag to move 2 selected messages")).toHaveLength(2);
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
          tabs: DEFAULT_INBOX_TABS.map((tab) => ({
            ...tab,
            label: tab.id === "social" ? "Community" : tab.label,
            enabled: tab.id === "promotions" ? false : tab.enabled,
            keywords: [],
            senderDomains: []
          })),
          counts: {
            primary: 12,
            promotions: 8,
            social: 4,
            updates: 6,
            bills: 3,
            medical: 2
          } as unknown as InboxCategoryCounts,
          onSelect: onSelectCategory
        }}
        {...BULK_SELECTION_PROPS}
      />
    );

    expect(screen.getByRole("button", { name: "Primary, 12 messages" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: "Promotions, 8 messages" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Community, 4 messages" }));
    expect(onSelectCategory).toHaveBeenCalledWith("social");
    fireEvent.click(screen.getByRole("button", { name: "Mail/Tracking, 0 messages" }));
    expect(onSelectCategory).toHaveBeenCalledWith("mail_tracking");
    expect(screen.getByText("No primary messages")).toBeTruthy();
  });

  it("shows upcoming package cards in Mail/Tracking and opens the carrier page", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const onSelect = vi.fn();
    const shipmentMessage: MessageSummary = {
      ...MESSAGE,
      id: "shipment-message",
      subject: "Your Amazon.com order has shipped",
      inboxCategory: "mail_tracking",
      shipment: {
        carrier: "fedex",
        merchant: "Amazon",
        trackingNumber: "123456789012",
        orderNumber: "113-1234567-1234567",
        status: "in_transit",
        estimatedDeliveryDate: "2099-01-02",
        trackingUrl: "https://www.fedex.com/fedextrack/?trknbr=123456789012"
      }
    };
    render(
      <MessageList
        items={[{ message: shipmentMessage }]}
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
        inboxCategories={{
          active: "mail_tracking",
          tabs: DEFAULT_INBOX_TABS.map((tab) => ({ ...tab, keywords: [], senderDomains: [] })),
          counts: { primary: 0, promotions: 0, social: 0, updates: 0, bills: 0, medical: 0, mail_tracking: 1 },
          onSelect: vi.fn()
        }}
        {...BULK_SELECTION_PROPS}
      />
    );

    expect(screen.getByRole("region", { name: "Arriving soon" })).toBeTruthy();
    expect(screen.getByText("Order from Amazon")).toBeTruthy();
    expect(screen.getByText(/FedEx/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View order" }));
    expect(open).toHaveBeenCalledWith(
      "https://www.fedex.com/fedextrack/?trknbr=123456789012",
      "_blank",
      "noopener,noreferrer"
    );
    expect(onSelect).not.toHaveBeenCalled();
    open.mockRestore();
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

  it("explains the five-day window and offers older history on demand", () => {
    const onLoadMore = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore
        rangeLabel="Last 5 days loaded"
        loadMoreLabel="Load messages older than 5 days"
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={onLoadMore}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
      />
    );

    expect(screen.getByText(/Last 5 days loaded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load messages older than 5 days" }));
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  it("uses stable skeleton rows while the first message page loads", () => {
    render(
      <MessageList
        items={[]}
        selectedMessageId={null}
        title="Inbox"
        loading
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

    expect(screen.getByRole("status", { name: "Loading messages" }).children).toHaveLength(6);
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

    const checkbox = screen.getByRole("checkbox", { name: "Select Drag this message" });
    expect(checkbox.closest("label")?.classList.contains("message-row-select-hit")).toBe(true);
    fireEvent.click(checkbox);
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

    const checkbox = screen.getByRole("checkbox", { name: "Select all loaded messages" });
    expect(checkbox.closest("label")?.classList.contains("message-select-hit")).toBe(true);
    fireEvent.click(checkbox);
    expect(onToggleSelectAll).toHaveBeenCalledOnce();
  });

  it("offers first 20, first 50, loaded, and entire-view selection presets", () => {
    const onSelectFirst = vi.fn();
    const onSelectLoaded = vi.fn();
    const onSelectEntireView = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }, { message: OTHER_MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={true}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        onSelectFirst={onSelectFirst}
        onSelectLoaded={onSelectLoaded}
        onSelectEntireView={onSelectEntireView}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose messages to select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Select first 20/ }));
    expect(onSelectFirst).toHaveBeenCalledWith(20);

    fireEvent.click(screen.getByRole("button", { name: "Choose messages to select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Select first 50/ }));
    expect(onSelectFirst).toHaveBeenCalledWith(50);

    fireEvent.click(screen.getByRole("button", { name: "Choose messages to select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Select all loaded/ }));
    expect(onSelectLoaded).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Choose messages to select" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Select entire view/ }));
    expect(onSelectEntireView).toHaveBeenCalledOnce();
  });

  it("shows the bulk action toolbar with a selection count once messages are selected", () => {
    const onBulkArchive = vi.fn();
    const onBulkSpam = vi.fn();
    const onBulkDelete = vi.fn();
    const onBulkMarkRead = vi.fn();
    const onBulkAiFile = vi.fn();
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
        onBulkMarkRead={onBulkMarkRead}
        onBulkAiFile={onBulkAiFile}
        onClearSelection={onClearSelection}
      />
    );

    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "AI file selected messages" }));
    expect(onBulkAiFile).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Mark selected as read" }));
    expect(onBulkMarkRead).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Move selected to Archive" }));
    expect(onBulkArchive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Move selected to Spam" }));
    expect(onBulkSpam).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(onBulkDelete).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalledOnce();
  });

  it("offers mailbox-wide selection after every loaded message is checked", () => {
    const onSelectEntireView = vi.fn();
    render(
      <MessageList
        items={[{ message: MESSAGE }, { message: OTHER_MESSAGE }]}
        selectedMessageId={null}
        title="Inbox"
        loading={false}
        searching={false}
        hasMore={true}
        readOnly={false}
        onSelect={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onLoadMore={vi.fn()}
        onMobileBack={vi.fn()}
        {...BULK_SELECTION_PROPS}
        selectedIds={new Set([MESSAGE.id, OTHER_MESSAGE.id])}
        onSelectEntireView={onSelectEntireView}
      />
    );

    expect(screen.getByText("All 2 loaded messages are selected.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all available in Inbox (up to 500)" }));
    expect(onSelectEntireView).toHaveBeenCalledOnce();
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
    expect(screen.getByRole("button", { name: "AI file selected messages" }).hasAttribute("disabled")).toBe(true);
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
