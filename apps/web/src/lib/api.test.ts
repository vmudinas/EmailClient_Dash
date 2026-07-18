import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ApiClient request headers", () => {
  it("logs in with the pairing token and uses the returned session token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        accessToken: "session-token",
        session: {
          id: "session-1",
          role: "viewer",
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
      pairingToken: "pairing-token-with-enough-characters",
      platform: "mobile"
    });

    await client.login("admin", "2332");
    await client.listArchives();

    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({
      username: "admin",
      pin: "2332",
      pairingToken: "pairing-token-with-enough-characters"
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

  it("sends Gmail authorization, outgoing email, and combine requests to local-only routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authorizationUrl: "https://accounts.example/auth", expiresAt: "2026-07-13T01:00:00.000Z" }))
      .mockResolvedValueOnce(jsonResponse({ id: "sent-1", threadId: "thread-1", localCopyImported: true }))
      .mockResolvedValueOnce(jsonResponse({ archive: {}, movedMessages: 0, movedFolders: 0, movedAttachments: 0 }))
      .mockResolvedValueOnce(jsonResponse({ mailbox: {}, movedMessages: 0, removedMailboxes: 0, movedAttachments: 0 }));
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

    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:3001/api/gmail/oauth/start");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toMatchObject({ archiveName: "Gmail", folderName: "Inbox" });
    expect(fetchMock.mock.calls[1]![0]).toBe("http://127.0.0.1:3001/api/gmail/connections/gmail-connection/send");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toMatchObject({ to: ["recipient@example.test"], subject: "Hello" });
    expect(fetchMock.mock.calls[2]![0]).toBe("http://127.0.0.1:3001/api/archives/source-id/combine");
    expect(fetchMock.mock.calls[3]![0]).toBe("http://127.0.0.1:3001/api/folders/source-folder/combine");
    expect(JSON.parse(String((fetchMock.mock.calls[3]![1] as RequestInit).body))).toEqual({ targetFolderId: "target-folder" });
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

    await client.listMessages({ folderId: "folder-one", isRead: false });
    await client.search("invoice", { folderId: "folder-two", isRead: false });

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:3001/api/messages?folderId=folder-one&isRead=false"
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
