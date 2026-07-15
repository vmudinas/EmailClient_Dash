import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GmailConnection } from "@email-client/shared";
import { ComposeDialog } from "./ComposeDialog.js";

afterEach(cleanup);

const CONNECTION: GmailConnection = {
  id: "gmail-1",
  email: "owner@example.test",
  archiveId: "archive-1",
  archiveName: "Gmail",
  folderId: "folder-1",
  folderPath: "Inbox",
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

describe("ComposeDialog", () => {
  it("sends a message through the selected authorized account", () => {
    const onSend = vi.fn();
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={vi.fn()}
        onSend={onSend}
      />
    );

    fireEvent.change(screen.getByRole("textbox", { name: "To" }), {
      target: { value: "one@example.test, two@example.test" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "Archive Mail test" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Sent from the local client." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith(CONNECTION.id, {
      to: ["one@example.test", "two@example.test"],
      cc: [],
      bcc: [],
      subject: "Archive Mail test",
      bodyText: "Sent from the local client."
    });
  });

  it("directs read-only OAuth connections back to Gmail authorization", () => {
    const onOpenGmail = vi.fn();
    render(
      <ComposeDialog
        open
        connections={[{ ...CONNECTION, canSend: false }]}
        initialConnectionId={null}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={onOpenGmail}
        onSend={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Gmail accounts" }));
    expect(onOpenGmail).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
