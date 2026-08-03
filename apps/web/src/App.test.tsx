import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_INBOX_TABS, type MessageSummary } from "@email-client/shared";
import { App } from "./App.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("App Inbox loading", () => {
  it("opens Inbox, fills the five-day window in the background, and lazily requests older mail", async () => {
    const requestedMessageUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/auth/session") return jsonResponse(session());
      if (url.pathname === "/api/archives") return jsonResponse([archive()]);
      if (url.pathname === "/api/archives/archive-1/folders") return jsonResponse([inbox()]);
      if (url.pathname === "/api/inbox-tabs") return jsonResponse({
        archiveId: "archive-1",
        tabs: DEFAULT_INBOX_TABS,
        aiEnabled: false,
        aiConfidenceThreshold: 0.8,
        updatedAt: null
      });
      if (url.pathname === "/api/messages/category-counts") return jsonResponse({
        primary: 4,
        promotions: 0,
        social: 0,
        updates: 0,
        bills: 0,
        medical: 0,
        mail_tracking: 0
      });
      if (url.pathname === "/api/messages") {
        requestedMessageUrls.push(url);
        expect(url.searchParams.get("folderId")).toBe("inbox-1");
        if (url.searchParams.has("before")) {
          return jsonResponse({ items: [message("older", "Older message", "2026-07-20T10:00:00.000Z")], nextCursor: null });
        }
        if (url.searchParams.get("cursor") === "recent-cursor") {
          return jsonResponse({ items: [message("recent-3", "Third recent message")], nextCursor: null });
        }
        return jsonResponse({
          items: [message("recent-1", "First recent message"), message("recent-2", "Second recent message")],
          nextCursor: "recent-cursor"
        });
      }
      if (url.pathname === "/api/stocks/quotes" || url.pathname === "/api/news/headlines"
        || url.pathname === "/api/import-jobs" || url.pathname === "/api/gmail/connections") {
        return jsonResponse([]);
      }
      if (url.pathname === "/api/stocks/display-settings") return jsonResponse({ secondsPerSymbol: 8 });
      if (url.pathname === "/api/news/display-settings") return jsonResponse({ secondsPerHeadline: 8 });
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeTruthy();
    expect(document.querySelector(".app-shell")?.classList.contains("mobile-view-messages")).toBe(true);
    expect(await screen.findByText("First recent message")).toBeTruthy();
    expect(await screen.findByText("Third recent message")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Last 5 days loaded/)).toBeTruthy());

    expect(requestedMessageUrls).toHaveLength(2);
    expect(requestedMessageUrls[0]?.searchParams.get("limit")).toBe("50");
    expect(requestedMessageUrls[0]?.searchParams.has("after")).toBe(true);
    expect(requestedMessageUrls[1]?.searchParams.get("limit")).toBe("250");

    fireEvent.click(screen.getByRole("button", { name: "Load messages older than 5 days" }));
    expect(await screen.findByText("Older message")).toBeTruthy();
    expect(requestedMessageUrls).toHaveLength(3);
    expect(requestedMessageUrls[2]?.searchParams.has("before")).toBe(true);
    expect(requestedMessageUrls[2]?.searchParams.has("after")).toBe(false);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function session() {
  const timestamp = "2026-08-03T00:00:00.000Z";
  return {
    id: "session-1",
    role: "admin",
    expiresAt: "2026-08-04T00:00:00.000Z",
    user: {
      id: "user-1",
      username: "admin",
      displayName: "Administrator",
      role: "admin",
      isActive: true,
      mustChangePin: false,
      allowedScreens: null,
      lastLoginAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp
    }
  };
}

function archive() {
  return {
    id: "archive-1",
    name: "Primary archive",
    sourceType: "gmail",
    status: "ready",
    sizeBytes: 1_000,
    messageCount: 4,
    unreadCount: 4,
    starredCount: 0,
    starredUnreadCount: 0,
    folderCount: 1,
    attachmentCount: 0,
    errorCount: 0,
    importedAt: "2026-08-03T00:00:00.000Z",
    createdAt: "2026-08-03T00:00:00.000Z"
  };
}

function inbox() {
  return {
    id: "inbox-1",
    archiveId: "archive-1",
    parentId: null,
    name: "Inbox",
    path: "Inbox",
    messageCount: 4,
    unreadCount: 4
  };
}

function message(id: string, subject: string, receivedAt = "2026-08-02T10:00:00.000Z"): MessageSummary {
  return {
    id,
    archiveId: "archive-1",
    folderId: "inbox-1",
    folderPath: "Inbox",
    subject,
    sender: { name: "Sender", address: "sender@example.test" },
    recipients: [],
    sentAt: null,
    receivedAt,
    preview: `${subject} preview`,
    hasAttachments: false,
    attachmentCount: 0,
    inboxCategory: "primary",
    state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
  };
}
