import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient request headers", () => {
  it("deduplicates repeated GET requests within the client cache window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    const [first, second] = await Promise.all([client.listArchives(), client.listArchives()]);
    const third = await client.listArchives();

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached GET responses when data is mutated", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.listArchives();
    await client.listArchives();
    await client.removeArchive("archive-1");
    await client.listArchives();

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache active import status polling", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse([])));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.listImportJobs();
    await client.listImportJobs();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs in and uses the returned session token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        accessToken: "session-token",
        session: {
          id: "session-1",
          role: "admin",
          expiresAt: "2026-07-13T12:00:00.000Z",
          user: {
            id: "user-1",
            username: "admin",
            displayName: "Administrator",
            role: "admin",
            isActive: true,
            mustChangePin: true,
            lastLoginAt: null,
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:00:00.000Z"
          }
        }
      }))
      .mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "",
      platform: "mobile"
    });

    await client.login("admin", "2332");
    await client.listArchives();

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      username: "admin",
      pin: "2332"
    });
    expect(new Headers((fetchMock.mock.calls[1]![1] as RequestInit).headers).get("Authorization"))
      .toBe("Bearer session-token");
  });

  it("does not declare JSON for a bodyless POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(importJob()));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "",
      platform: "browser"
    });

    await client.cancelImport("job-1");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("Content-Type")).toBeNull();
  });

  it("still declares JSON when a JSON body is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "",
      platform: "browser"
    });

    await client.renameArchive("archive-1", "Renamed");

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("marks selected messages read with one bulk request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ updated: 2, alreadyRead: 0, failed: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.bulkMarkMessagesRead(["message-1", "message-2"]);

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/messages/bulk-read");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ messageIds: ["message-1", "message-2"] });
  });

  it("starts Gmail mailbox reconciliation without a request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "gmail-1", status: "syncing" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.reconcileGmailMailbox("gmail-1");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/gmail/connections/gmail-1/reconcile");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("reconnects an existing Apple Calendar account in place", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "apple-1", status: "connected" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.reconnectAppleCalendar("apple-1", {
      label: "iCloud",
      username: "owner@example.test",
      appSpecificPassword: "xxxx-xxxx-xxxx-xxxx",
      serverUrl: "https://caldav.icloud.com"
    });

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/admin/calendar/accounts/apple-1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("PUT");
  });

  it("starts and monitors a background smart-rule task", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({
      id: "task-1",
      status: "queued",
      scope: "all",
      ruleIds: ["rule-1", "rule-2"]
    })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.startSmartMailRuleRun("archive-1", ["rule-1", "rule-2"], "all");
    await client.mailboxTask("task-1");
    await client.cancelMailboxTask("task-1");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/admin/smart-mail-rules/run");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ archiveId: "archive-1", ruleIds: ["rule-1", "rule-2"], scope: "all" });
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:3001/api/admin/mailbox-tasks/task-1");
    expect(fetchMock.mock.calls[2]![0]).toBe("http://127.0.0.1:3001/api/admin/mailbox-tasks/task-1/cancel");
    expect((fetchMock.mock.calls[2]![1] as RequestInit).method).toBe("POST");
  });

  it("clears an import with a bodyless DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "",
      platform: "browser"
    });

    await client.clearImport("job-1");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/import-jobs/job-1");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("Content-Type")).toBeNull();
  });

  it("clears stale authorization and requests sign-in without reporting a client diagnostic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Authorization required" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "expired-token",
      platform: "browser"
    });
    const authorizationRequired = vi.fn();
    client.setAuthorizationRequiredHandler(authorizationRequired);

    await expect(client.listArchives()).rejects.toThrow("Authorization required");

    expect(client.getAccessToken()).toBe("");
    expect(authorizationRequired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes the C# mailTracking category count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      primary: 12,
      promotions: 8,
      social: 4,
      updates: 6,
      bills: 3,
      medical: 2,
      mailTracking: 5
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    const counts = await client.inboxCategoryCounts({ archiveId: "archive-1" });

    expect(counts.mail_tracking).toBe(5);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:3001/api/messages/category-counts?archiveId=archive-1"
    );
  });

  it("fills required archive and folder counters omitted by a legacy response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "archive-1", name: "Legacy" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "folder-1", archiveId: "archive-1", name: "Inbox" }]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    const [archive] = await client.listArchives();
    const [folder] = await client.listFolders("archive-1");

    expect(archive).toMatchObject({
      messageCount: 0,
      unreadCount: 0,
      folderCount: 0,
      attachmentCount: 0,
      errorCount: 0,
      sizeBytes: 0
    });
    expect(folder).toMatchObject({ path: "Inbox", messageCount: 0, unreadCount: 0 });
  });

  it("fills required Gmail and import progress fields omitted by a legacy response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: "gmail-1", email: "person@example.test" }]))
      .mockResolvedValueOnce(jsonResponse([{ id: "job-1", sourceName: "mail.pst" }]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    const [gmail] = await client.listGmailConnections();
    const [job] = await client.listImportJobs();

    expect(gmail).toMatchObject({
      processedItems: 0,
      importedItems: 0,
      totalItems: null,
      status: "error"
    });
    expect(job).toMatchObject({
      processedItems: 0,
      processedBytes: 0,
      totalBytes: 0,
      errorCount: 0,
      totalItems: null
    });
  });

  it("creates safe nested admin settings when counters are absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      database: {},
      security: {},
      gmail: {},
      drafts: {},
      stocks: {},
      news: {},
      ai: { usage: {} }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    const settings = await client.adminSettings();

    expect(settings.database.providers).toEqual([]);
    expect(settings.stocks.symbols).toEqual([]);
    expect(settings.news.enabledSources).toEqual([]);
    expect(settings.ai.usage).toEqual({
      todayRequests: 0,
      monthRequests: 0,
      todayInputTokens: 0,
      todayOutputTokens: 0,
      monthInputTokens: 0,
      monthOutputTokens: 0
    });
  });

  it("sends Gmail authorization, outgoing email, and combine requests to local-only routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authorizationUrl: "https://accounts.example/auth", expiresAt: "2026-07-13T01:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ id: "sent-1", threadId: "thread-1", localCopyImported: true }))
      .mockResolvedValueOnce(jsonResponse({ archive: {}, movedMessages: 0, movedFolders: 0, movedAttachments: 0 }))
      .mockResolvedValueOnce(jsonResponse({ mailbox: {}, movedMessages: 0, removedMailboxes: 0, movedAttachments: 0 }))
      .mockResolvedValueOnce(jsonResponse({ mailbox: {}, movedMailboxes: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "desktop"
    });

    await client.startGmailAuthorization({
      archiveId: null,
      folderId: null,
      archiveName: "Gmail",
      folderName: "Inbox",
      query: "newer_than:30d",
      ocrEnabled: false
    });
    await client.sendGmailMessage("gmail-connection", {
      to: ["recipient@example.test"],
      cc: [],
      bcc: [],
      subject: "Hello",
      bodyText: "Message body"
    });
    await client.combineArchives("source-id", "target-id");
    await client.combineMailboxes("source-folder", "target-folder");
    await client.moveMailbox("move-folder", "parent-folder");

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/gmail/oauth/start");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ archiveName: "Gmail", folderName: "Inbox" });
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:3001/api/gmail/connections/gmail-connection/send");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({ to: ["recipient@example.test"], subject: "Hello" });
    expect(fetchMock.mock.calls[2]![0]).toBe("http://127.0.0.1:3001/api/archives/source-id/combine");
    expect(fetchMock.mock.calls[3]![0]).toBe("http://127.0.0.1:3001/api/folders/source-folder/combine");
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({ targetFolderId: "target-folder" });
    expect(fetchMock.mock.calls[4]![0]).toBe("http://127.0.0.1:3001/api/folders/move-folder/move");
    expect(JSON.parse(String((fetchMock.mock.calls[4]![1] as RequestInit).body))).toEqual({ targetParentId: "parent-folder" });
  });

  it("surfaces RFC problem details returned while starting Google authorization", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        title: "Service Unavailable",
        detail: "Gmail is not configured. Load a Google OAuth JSON file."
      }), { status: 503, headers: { "Content-Type": "application/problem+json" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await expect(client.startGmailAuthorization({
      archiveId: null,
      folderId: null,
      archiveName: "Gmail",
      folderName: "Inbox",
      query: "",
      ocrEnabled: false
    })).rejects.toThrow("Gmail is not configured. Load a Google OAuth JSON file.");
  });

  it("sends mailbox and read-state filters for lists and search", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ApiClient({
      apiBaseUrl: "http://127.0.0.1:3001",
      accessToken: "local-token",
      platform: "browser"
    });

    await client.listMessages({ folderId: "folder-one", isRead: false, hasAttachment: true });
    await client.search("invoice", { folderId: "folder-two", isRead: false });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:3001/api/messages?folderId=folder-one&isRead=false&hasAttachment=true"
    );
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "http://127.0.0.1:3001/api/search?q=invoice&folderId=folder-two&isRead=false"
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function importJob() {
  return {
    id: "job-1",
    archiveId: "archive-1",
    sourceName: "Inbox.mbox",
    sourceType: "mbox",
    status: "cancelled",
    phase: "parsing",
    processedItems: 10,
    totalItems: 100,
    processedBytes: 1_000,
    totalBytes: 10_000,
    errorCount: 0,
    ocrEnabled: false,
    canResume: true,
    message: "Import cancelled",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z"
  };
}
