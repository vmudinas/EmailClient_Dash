import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  it("opens Focus across categories, fills today and yesterday, and lazily requests earlier important mail", async () => {
    const requestedMessageUrls: URL[] = [];
    const requestedCountUrls: URL[] = [];
    const requestedSearchUrls: URL[] = [];
    const focusCutoff = startOfLocalDay(-1);
    const todayAtTen = localTime(0, 10);
    const todayAtNine = localTime(0, 9);
    const yesterdayAtTen = localTime(-1, 10);
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
      if (url.pathname === "/api/messages/category-counts") {
        requestedCountUrls.push(url);
        return jsonResponse({
          primary: 2,
          jobs: 2,
          promotions: 0,
          social: 0,
          updates: 1,
          bills: 0,
          medical: 0,
          mail_tracking: 0,
          focus: 6
        });
      }
      if (url.pathname === "/api/messages") {
        requestedMessageUrls.push(url);
        expect(url.searchParams.has("folderId")).toBe(false);
        expect(url.searchParams.get("inboxOnly")).toBe("true");
        if (url.searchParams.has("before")) {
          return jsonResponse({ items: [message("older", "Earlier important message", localTime(-3, 10))], nextCursor: null });
        }
        if (url.searchParams.get("cursor") === "recent-cursor") {
          return jsonResponse({
            items: [message("recent-3", "Today reply", todayAtNine, "updates", { hasReply: true })],
            nextCursor: null
          });
        }
        return jsonResponse({
          items: [
            message("recent-1", "Today from a person", todayAtTen),
            message("recent-2", "Yesterday career update", yesterdayAtTen, "jobs")
          ],
          nextCursor: "recent-cursor"
        });
      }
      if (url.pathname === "/api/search") {
        requestedSearchUrls.push(url);
        return jsonResponse({ items: [], nextCursor: null });
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

    expect(await screen.findByRole("heading", { name: "Focus" })).toBeTruthy();
    expect(document.querySelector(".app-shell")?.classList.contains("mobile-view-messages")).toBe(true);
    expect(await screen.findByText("Today from a person")).toBeTruthy();
    expect(await screen.findByText("Yesterday career update")).toBeTruthy();
    expect(await screen.findByText("Today reply")).toBeTruthy();
    const focusList = screen.getByRole("list", { name: "Focus" });
    expect(within(focusList).getByText("Today")).toBeTruthy();
    expect(within(focusList).getByText("Yesterday")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Today \+ yesterday/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Focus, important mail from today and yesterday" }).getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByRole("button", { name: "Career, 2 messages" })).toBeTruthy();
    expect(await screen.findByLabelText("6 messages to review")).toBeTruthy();

    expect(requestedMessageUrls).toHaveLength(2);
    expect(requestedMessageUrls[0]?.searchParams.get("limit")).toBe("50");
    expect(requestedMessageUrls[0]?.searchParams.get("focus")).toBe("true");
    expect(requestedMessageUrls[0]?.searchParams.has("inboxCategory")).toBe(false);
    expect(requestedMessageUrls[0]?.searchParams.has("isRead")).toBe(false);
    expect(requestedMessageUrls[0]?.searchParams.get("after")).toBe(focusCutoff);
    expect(requestedMessageUrls[1]?.searchParams.get("limit")).toBe("250");
    expect(requestedMessageUrls[1]?.searchParams.get("focus")).toBe("true");
    expect(requestedMessageUrls[1]?.searchParams.has("inboxCategory")).toBe(false);
    expect(requestedMessageUrls[1]?.searchParams.get("after")).toBe(focusCutoff);
    expect(requestedCountUrls).toHaveLength(1);
    expect(requestedCountUrls[0]?.searchParams.get("after")).toBe(focusCutoff);
    expect(requestedCountUrls[0]?.searchParams.get("inboxOnly")).toBe("true");
    expect(requestedCountUrls[0]?.searchParams.get("focus")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Show earlier important mail" }));
    expect(await screen.findByText("Earlier important message")).toBeTruthy();
    expect(requestedMessageUrls).toHaveLength(3);
    expect(requestedMessageUrls[2]?.searchParams.get("focus")).toBe("true");
    expect(requestedMessageUrls[2]?.searchParams.has("inboxCategory")).toBe(false);
    expect(requestedMessageUrls[2]?.searchParams.has("before")).toBe(true);
    expect(requestedMessageUrls[2]?.searchParams.has("after")).toBe(false);
    expect(screen.getByText(/Recent mail \+ older history/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search mail and attachments"), { target: { value: "contract" } });
    await waitFor(() => expect(requestedSearchUrls).toHaveLength(1));
    expect(requestedSearchUrls[0]?.searchParams.get("focus")).toBe("true");
    expect(requestedSearchUrls[0]?.searchParams.get("inboxOnly")).toBe("true");
    expect(requestedSearchUrls[0]?.searchParams.get("after")).toBe(focusCutoff);
  });

  it("caps automatic recent loading at 500 and finishes that window before older history", async () => {
    const requestedMessageUrls: URL[] = [];
    const focusCutoff = startOfLocalDay(-1);
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
      if (url.pathname === "/api/messages/category-counts") {
        return jsonResponse({
          primary: 501,
          jobs: 0,
          promotions: 0,
          social: 0,
          updates: 0,
          bills: 0,
          medical: 0,
          mail_tracking: 0
        });
      }
      if (url.pathname === "/api/messages") {
        requestedMessageUrls.push(url);
        expect(url.searchParams.has("folderId")).toBe(false);
        expect(url.searchParams.get("inboxOnly")).toBe("true");
        if (url.searchParams.has("before")) {
          return jsonResponse({
            items: [message("older-after-cap", "Older history after recent window", localTime(-3, 10))],
            nextCursor: null
          });
        }
        switch (url.searchParams.get("cursor")) {
          case "recent-50":
            return jsonResponse({ items: messageBatch(50, 250), nextCursor: "recent-300" });
          case "recent-300":
            return jsonResponse({ items: messageBatch(300, 200), nextCursor: "recent-500" });
          case "recent-500":
            return jsonResponse({
              items: [message("recent-over-cap", "Recent beyond automatic cap", localTime(-1, 8))],
              nextCursor: null
            });
          default:
            return jsonResponse({ items: messageBatch(0, 50), nextCursor: "recent-50" });
        }
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

    const continueRecent = await screen.findByRole("button", { name: "Load more recent important mail" });
    expect(screen.getByText(/Today \+ yesterday · more available/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show earlier important mail" })).toBeNull();

    expect(requestedMessageUrls).toHaveLength(3);
    expect(requestedMessageUrls.map((url) => url.searchParams.get("limit"))).toEqual(["50", "250", "200"]);
    expect(requestedMessageUrls.reduce((total, url) => total + Number(url.searchParams.get("limit")), 0)).toBe(500);
    expect(requestedMessageUrls.map((url) => url.searchParams.get("cursor"))).toEqual([null, "recent-50", "recent-300"]);
    expect(requestedMessageUrls.every((url) => url.searchParams.get("after") === focusCutoff)).toBe(true);
    expect(requestedMessageUrls.every((url) => !url.searchParams.has("before"))).toBe(true);

    fireEvent.click(continueRecent);
    expect(await screen.findByText("Recent beyond automatic cap")).toBeTruthy();
    await waitFor(() => expect(requestedMessageUrls).toHaveLength(4));
    expect(requestedMessageUrls[3]?.searchParams.get("cursor")).toBe("recent-500");
    expect(requestedMessageUrls[3]?.searchParams.get("limit")).toBe("100");
    expect(requestedMessageUrls[3]?.searchParams.get("after")).toBe(focusCutoff);
    expect(requestedMessageUrls[3]?.searchParams.has("before")).toBe(false);

    const showEarlier = await screen.findByRole("button", { name: "Show earlier important mail" });
    fireEvent.click(showEarlier);
    expect(await screen.findByText("Older history after recent window")).toBeTruthy();
    expect(requestedMessageUrls).toHaveLength(5);
    expect(requestedMessageUrls[4]?.searchParams.has("after")).toBe(false);
    expect(requestedMessageUrls[4]?.searchParams.get("before")).toBe(
      new Date(new Date(focusCutoff).getTime() - 1).toISOString()
    );
    expect(requestedMessageUrls[4]?.searchParams.has("cursor")).toBe(false);
    expect(screen.getByText(/Recent mail \+ older history/)).toBeTruthy();
  });

  it("restores unified Inbox scope when Career is chosen after a physical folder and Focus", async () => {
    const requestedMessageUrls: URL[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/auth/session") return jsonResponse(session());
      if (url.pathname === "/api/archives") return jsonResponse([{ ...archive(), folderCount: 2 }]);
      if (url.pathname === "/api/archives/archive-1/folders") return jsonResponse([inbox(), secondInbox(), receiptsFolder()]);
      if (url.pathname === "/api/inbox-tabs") return jsonResponse({
        archiveId: "archive-1",
        tabs: DEFAULT_INBOX_TABS,
        aiEnabled: false,
        aiConfidenceThreshold: 0.8,
        updatedAt: null
      });
      if (url.pathname === "/api/messages/category-counts") {
        return jsonResponse({
          primary: 1,
          jobs: 3,
          promotions: 0,
          social: 0,
          updates: 0,
          bills: 0,
          medical: 0,
          mail_tracking: 0
        });
      }
      if (url.pathname === "/api/messages") {
        requestedMessageUrls.push(url);
        if (url.searchParams.get("folderId") === "receipts-1") {
          return jsonResponse({
            items: [{
              ...message("receipt-message", "Physical folder message", localTime(0, 9), "bills"),
              folderId: "receipts-1",
              folderPath: "Receipts"
            }],
            nextCursor: null
          });
        }
        if (url.searchParams.get("inboxCategory") === "jobs") {
          return jsonResponse({
            items: [message("career-message", "Career scoped message", localTime(0, 11), "jobs")],
            nextCursor: null
          });
        }
        return jsonResponse({
          items: [message("focus-message", "Focus inbox message", localTime(0, 10))],
          nextCursor: null
        });
      }
      if (url.pathname === "/api/import-jobs" || url.pathname === "/api/gmail/connections") return jsonResponse([]);
      throw new Error(`Unexpected request: ${url.pathname}${url.search}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    expect(await screen.findByText("Focus inbox message")).toBeTruthy();
    const folderNavigation = screen.getByRole("navigation", { name: "Primary archive folders" });
    const receiptsButton = within(folderNavigation).getByRole("button", { name: /^Receipts/ });
    fireEvent.click(receiptsButton);
    expect(await screen.findByRole("heading", { name: "Receipts" })).toBeTruthy();
    expect(await screen.findByText("Physical folder message")).toBeTruthy();

    const physicalRequest = requestedMessageUrls.find((url) => url.searchParams.get("folderId") === "receipts-1");
    expect(physicalRequest).toBeTruthy();
    expect(physicalRequest?.searchParams.has("focus")).toBe(false);

    const dailyViews = screen.getByRole("navigation", { name: "Daily mail views" });
    fireEvent.click(within(dailyViews).getByRole("button", { name: /^Focus/ }));
    expect(await screen.findByRole("heading", { name: "Focus" })).toBeTruthy();

    const careerTab = await screen.findByRole("button", { name: "Career, 3 messages" });
    fireEvent.click(careerTab);
    expect(await screen.findByText("Career scoped message")).toBeTruthy();

    const careerRequest = [...requestedMessageUrls].reverse().find(
      (url) => url.searchParams.get("inboxCategory") === "jobs"
    );
    expect(careerRequest).toBeTruthy();
    expect(careerRequest?.searchParams.has("folderId")).toBe(false);
    expect(careerRequest?.searchParams.get("inboxOnly")).toBe("true");
    expect(careerRequest?.searchParams.get("inboxCategory")).toBe("jobs");
    expect(careerRequest?.searchParams.has("focus")).toBe(false);
    expect(within(folderNavigation).getAllByRole("button", { name: /^Inbox/ })
      .every((button) => !button.classList.contains("selected"))).toBe(true);
    expect(careerTab.getAttribute("aria-pressed")).toBe("true");
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

function secondInbox() {
  return {
    id: "inbox-2",
    archiveId: "archive-1",
    parentId: null,
    name: "Inbox",
    path: "Work account/Inbox",
    messageCount: 2,
    unreadCount: 1
  };
}

function receiptsFolder() {
  return {
    id: "receipts-1",
    archiveId: "archive-1",
    parentId: null,
    name: "Receipts",
    path: "Receipts",
    messageCount: 1,
    unreadCount: 1
  };
}

function message(
  id: string,
  subject: string,
  receivedAt: string,
  inboxCategory: MessageSummary["inboxCategory"] = "primary",
  indicators: Pick<MessageSummary, "hasReply" | "hasPendingFollowUp"> = {}
): MessageSummary {
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
    inboxCategory,
    ...indicators,
    state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
  };
}

function messageBatch(start: number, count: number): MessageSummary[] {
  return Array.from({ length: count }, (_, index) => {
    const position = start + index;
    return message(`recent-${position}`, `Recent important message ${position}`, localTime(position % 2 === 0 ? 0 : -1, 12));
  });
}

function startOfLocalDay(dayOffset: number): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.toISOString();
}

function localTime(dayOffset: number, hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.toISOString();
}
