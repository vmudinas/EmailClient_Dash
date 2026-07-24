import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskAnswer, AskHistoryEntry, MessageDetail } from "@email-client/shared";
import { AskArchiveMailDialog } from "./AskArchiveMailDialog.js";

afterEach(cleanup);

const message = {
  id: "message-1",
  archiveId: "archive-1",
  folderId: "folder-1",
  subject: "Boiler repair",
  sender: { name: "Landlord", address: "owner@example.test" },
  to: [{ name: null, address: "me@example.test" }],
  sentAt: "2026-07-01T09:00:00.000Z",
  receivedAt: "2026-07-01T09:00:00.000Z",
  hasAttachments: false,
  attachmentCount: 0,
  sizeBytes: 1200,
  isRead: true,
  isFlagged: false,
  inboxCategory: "primary",
  cc: [],
  bcc: [],
  bodyText: "The boiler needs a plumber.",
  bodyHtml: null,
  headers: {}
} as unknown as MessageDetail;

const answer: AskAnswer = {
  answer: "The landlord mentioned the boiler on 1 July 2026.",
  citations: [{ messageId: "message-1", subject: "Boiler repair", message }],
  consulted: [
    { messageId: "message-1", subject: "Boiler repair", sender: "owner@example.test", receivedAt: "2026-07-01T09:00:00.000Z", rank: 0.9 },
    { messageId: "message-2", subject: "Rent reminder", sender: "owner@example.test", receivedAt: "2026-06-01T09:00:00.000Z", rank: 0.2 }
  ],
  retrievalMode: "fts",
  provider: "openai",
  model: "gpt-5-mini",
  excerptCount: 2
};

function renderDialog(overrides: Partial<Parameters<typeof AskArchiveMailDialog>[0]> = {}) {
  const props = {
    open: true,
    answer: null,
    history: [] as AskHistoryEntry[],
    asking: false,
    historyLoading: false,
    onClose: vi.fn(),
    onAsk: vi.fn(),
    onOpenMessage: vi.fn(),
    onRefreshHistory: vi.fn(),
    ...overrides
  };
  render(<AskArchiveMailDialog {...props} />);
  return props;
}

describe("AskArchiveMailDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <AskArchiveMailDialog
        open={false}
        answer={null}
        history={[]}
        asking={false}
        historyLoading={false}
        onClose={vi.fn()}
        onAsk={vi.fn()}
        onOpenMessage={vi.fn()}
        onRefreshHistory={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("asks the typed question", () => {
    const props = renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Ask about your archived mail/), {
      target: { value: "When did the landlord mention the boiler?" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(props.onAsk).toHaveBeenCalledWith("When did the landlord mention the boiler?", {});
  });

  it("does not ask when the question is blank", () => {
    const props = renderDialog();
    expect((screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement).disabled).toBe(true);
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  it("passes filters when they are filled in", () => {
    const props = renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Ask about your archived mail/), {
      target: { value: "boiler" }
    });
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.change(screen.getByPlaceholderText("owner@example.com"), {
      target: { value: "owner@example.test" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(props.onAsk).toHaveBeenCalledWith("boiler", { senderAddress: "owner@example.test" });
  });

  it("renders the answer and opens a cited message", () => {
    const props = renderDialog({ answer });
    expect(screen.getByText("The landlord mentioned the boiler on 1 July 2026.")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Open Boiler repair"));
    expect(props.onOpenMessage).toHaveBeenCalledWith("message-1");
  });

  it("reveals the consulted messages behind a toggle so the answer can be verified", () => {
    renderDialog({ answer });
    expect(screen.queryByText("Rent reminder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 messages consulted/ }));
    expect(screen.getByText("Rent reminder")).toBeTruthy();
  });

  it("warns when an answer cites nothing despite having excerpts", () => {
    renderDialog({ answer: { ...answer, citations: [] } });
    expect(screen.getByText(/did not cite a specific message/)).toBeTruthy();
  });

  it("states that only excerpts leave the server", () => {
    renderDialog();
    expect(screen.getByText(/Only the matching excerpts are sent to the AI provider/)).toBeTruthy();
  });

  it("reuses a question from history", () => {
    const history: AskHistoryEntry[] = [{
      id: "q1",
      question: "What did the plumber quote?",
      answer: "£320.",
      citations: ["message-9"],
      retrievalMode: "fts",
      provider: "openai",
      model: "gpt-5-mini",
      excerptCount: 3,
      createdAt: "2026-07-02T09:00:00.000Z"
    }];
    const props = renderDialog({ history });
    fireEvent.click(screen.getByLabelText("Recent questions"));
    expect(props.onRefreshHistory).toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Reuse this question"));
    expect((screen.getByPlaceholderText(/Ask about your archived mail/) as HTMLTextAreaElement).value)
      .toBe("What did the plumber quote?");
  });

  it("disables asking while a question is in flight", () => {
    renderDialog({ asking: true });
    expect(screen.getByText("Searching your mail")).toBeTruthy();
  });
});
