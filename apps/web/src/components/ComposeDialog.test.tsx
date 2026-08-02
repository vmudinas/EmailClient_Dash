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
      bodyText: "Sent from the local client.",
      // Always sent, and defaulting to the automated address rather than the connected account.
      fromAddress: "ai@vitas.work"
    }, null);
  });

  it("offers only the configured sending addresses, not the account's own aliases", async () => {
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

    const sendAs = await screen.findByRole("combobox", { name: "Send as" });
    const offered = [...sendAs.querySelectorAll("option")].map((option) => option.value);
    expect(offered).toEqual([
      "ai@vitas.work",
      "code@vitas.work",
      "me@vitas.work",
      "gliukaz@gmail.com"
    ]);
    // Gmail's own aliases are not choices: the server refuses anything outside the list above.
    expect(offered).not.toContain("alias@example.test");
    expect(offered).not.toContain("owner@example.test");

    fireEvent.change(sendAs, { target: { value: "code@vitas.work" } });
    fireEvent.change(screen.getByRole("textbox", { name: "To" }), {
      target: { value: "recipient@example.test" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), {
      target: { value: "From a custom domain" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith(CONNECTION.id, expect.objectContaining({
      fromAddress: "code@vitas.work"
    }), null);
  });

  it("warns when Gmail has not verified the chosen address on that account", async () => {
    const onLoadSendAsAliases = vi.fn().mockResolvedValue([
      { email: "owner@example.test", displayName: "", isPrimary: true, isDefault: true }
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
        onSend={vi.fn()}
      />
    );

    // Google rejects an unverified From at send time, so the dialog says so before the attempt.
    expect(await screen.findByText(/has not verified ai@vitas.work/i)).toBeTruthy();
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
    const onDelete = vi.fn();
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        initialDraft={{
          id: "draft-1",
          source: "ai",
          sourceMessageId: "11111111-1111-4111-8111-111111111111",
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
        onDelete={onDelete}
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
      bodyText: "Updated reply.",
      sourceMessageId: "11111111-1111-4111-8111-111111111111"
    }), "resume-1");
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  const RESUMES = [
    { id: "resume-1", name: "Engineering", filename: "engineering-resume.pdf", contentType: "application/pdf", sizeBytes: 1, createdAt: "", updatedAt: "" },
    { id: "resume-2", name: "Platform", filename: "platform-resume.pdf", contentType: "application/pdf", sizeBytes: 1, createdAt: "", updatedAt: "" }
  ];

  it("lets a resume be attached to a manually composed draft", async () => {
    const onSave = vi.fn();
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
        onLoadResumes={vi.fn().mockResolvedValue(RESUMES)}
        onSave={onSave}
        onSend={vi.fn()}
      />
    );

    // Before this existed a manual draft could never carry a resume, which also meant it could
    // never reach the code@ default.
    const picker = await screen.findByRole("combobox", { name: "Résumé" });
    fireEvent.change(picker, { target: { value: "resume-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect(onSave).toHaveBeenCalledWith(CONNECTION.id, expect.anything(), "resume-2");
  });

  it("preselects the resume a draft already carries and can detach it", async () => {
    const onSave = vi.fn();
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        initialDraft={{ id: "draft-1", source: "ai", resumeId: "resume-1", resumeFilename: "engineering-resume.pdf" }}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={vi.fn()}
        onLoadSendAsAliases={vi.fn().mockResolvedValue([])}
        onLoadResumes={vi.fn().mockResolvedValue(RESUMES)}
        onSave={onSave}
        onSend={vi.fn()}
      />
    );

    const picker = await screen.findByRole("combobox", { name: "Résumé" }) as HTMLSelectElement;
    expect(picker.value).toBe("resume-1");

    fireEvent.change(picker, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    // Detaching has to reach the server as null, not as the value the draft opened with.
    expect(onSave).toHaveBeenCalledWith(CONNECTION.id, expect.anything(), null);
  });

  it("still shows an attached resume when the list cannot be loaded", async () => {
    render(
      <ComposeDialog
        open
        connections={[CONNECTION]}
        initialConnectionId={CONNECTION.id}
        initialDraft={{ id: "draft-1", source: "ai", resumeId: "resume-1", resumeFilename: "engineering-resume.pdf" }}
        busy={false}
        error=""
        onClose={vi.fn()}
        onOpenGmail={vi.fn()}
        onLoadSendAsAliases={vi.fn().mockResolvedValue([])}
        onLoadResumes={vi.fn().mockRejectedValue(new Error("offline"))}
        onSave={vi.fn()}
        onSend={vi.fn()}
      />
    );

    // A failed load must not imply the draft has no resume attached.
    expect(await screen.findByText("engineering-resume.pdf")).toBeTruthy();
  });
});
