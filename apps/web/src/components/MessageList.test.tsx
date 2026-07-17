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
      hasAiAnalysis: true
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
          counts: { primary: 12, promotions: 8, social: 4, updates: 6 },
          onSelect: onSelectCategory
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Primary, 12 messages" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Social, 4 messages" }));
    expect(onSelectCategory).toHaveBeenCalledWith("social");
    expect(screen.getByText("No primary messages")).toBeTruthy();
  });
});
