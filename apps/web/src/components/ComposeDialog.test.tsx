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
        onLoadSendAsAliases={vi.fn().mockResolvedValue([])}
        onSave={vi.fn()}
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

  it("lets a verified send-as alias be chosen as the From address", async () => {
    const onSend = vi.fn();
    const onLoadSendAsAliases = vi.fn().mockResolvedValue([
      { email: "owner@example.test", displayName: "", isPrimary: true, isDefault: true },
      { email: "alias@example.test", displayName: "Code", isPrimary: false, isDefault: false }
    ]);
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={vi.fn()}
        onLoadSendAsAliases={onLoadSendAsAliases}
        onSave={vi.fn()}
        onSend={onSend}
      />
    );

    await screen.findByRole("combobox", { name: "Send as" });
    fireEvent.change(screen.getByRole("combobox", { name: "Send as" }), {
      target: { value: "alias@example.test" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "To" }), {
      target: { value: "recipient@example.test" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "From a custom domain" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith(CONNECTION.id, expect.objectContaining({
      fromAddress: "alias@example.test"
    }));
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
        onLoadSendAsAliases={vi.fn().mockResolvedValue([])}
        onSave={vi.fn()}
        onSend={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Gmail accounts" }));
    expect(onOpenGmail).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens an AI draft with its resume and saves edits without sending", () => {
    const onSave = vi.fn();
    const onSend = vi.fn();
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        initialDraft={{
          id: "draft-1",
          source: "ai",
          to: ["recruiter@example.test"],
          subject: "Re: Engineering role",
          bodyText: "Thank you for reaching out.",
          resumeId: "resume-1",
          resumeFilename: "engineering-resume.pdf"
        }}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={vi.fn()}
        onLoadSendAsAliases={vi.fn().mockResolvedValue([])}
        onSave={onSave}
        onSend={onSend}
      />
    );

    expect(screen.getByRole("heading", { name: "Review AI draft" })).toBeTruthy();
    expect(screen.getByText("engineering-resume.pdf")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Updated reply." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSave).toHaveBeenCalledWith(CONNECTION.id, expect.objectContaining({
      to: ["recruiter@example.test"],
      bodyText: "Updated reply."
    }));
    expect(onSend).not.toHaveBeenCalled();
  });
});
