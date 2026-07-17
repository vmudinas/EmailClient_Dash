import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideDialog } from "./GuideDialog.js";

afterEach(cleanup);

describe("GuideDialog", () => {
  it("provides separate import, storage, Gmail, organization, and diagnostics tutorials", () => {
    render(<GuideDialog open onClose={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "How Archive Mail works" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Storage" }));
    expect(screen.getByRole("heading", { name: "Local storage" })).toBeTruthy();
    expect(screen.getByText(/byte-for-byte raw EML/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(screen.getByRole("heading", { name: "Why Gmail API instead of POP or IMAP?" })).toBeTruthy();
    expect(screen.getByText(/archive, move, Spam, Trash, read, and star actions run in Gmail first/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Diagnostics" }));
    expect(screen.getByRole("heading", { name: "Diagnostics and failures" })).toBeTruthy();
  });
});
