import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
