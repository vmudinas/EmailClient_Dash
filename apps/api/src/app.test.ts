import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailApiRuntime } from "./app.js";
import { loadConfig } from "./config.js";

const runtimes: EmailApiRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Email API AI provider routes", () => {
  it("switches the active AI provider and refuses live model listing for OpenAI", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const login = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { username: "admin", pin: "2332" }
    });
    const headers = { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` };

    const active = await runtime.app.inject({
      method: "POST",
      url: "/api/admin/settings/ai/active",
      headers,
      remoteAddress: "127.0.0.1",
      payload: { provider: "deepseek" }
    });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({ ai: { activeProvider: "deepseek" } });

    const invalidActive = await runtime.app.inject({
      method: "POST",
      url: "/api/admin/settings/ai/active",
      headers,
      remoteAddress: "127.0.0.1",
      payload: { provider: "not-a-real-provider" }
    });
    expect(invalidActive.statusCode).toBe(400);

    const missingProviderQuery = await runtime.app.inject({
      method: "GET",
      url: "/api/admin/settings/ai/models",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(missingProviderQuery.statusCode).toBe(400);

    const openAiModels = await runtime.app.inject({
      method: "GET",
      url: "/api/admin/settings/ai/models?provider=openai",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(openAiModels.statusCode).toBe(503);
    expect(openAiModels.json()).toMatchObject({ error: expect.stringContaining("only available for DeepSeek") });
  });
});

describe("Email API sender filing routes", () => {
  it("organizes and disables top-sender Inbox rules from the admin API", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const archive = runtime.database.createArchive({
      name: "Sender route mail",
      sourceType: "gmail",
      fingerprint: "sender-route",
      sizeBytes: 10
    });
    const inbox = runtime.database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    runtime.database.insertMessage({
      archiveId: archive.id,
      folderId: inbox.id,
      sourceKey: "sender-route-message",
      internetMessageId: null,
      subject: "Top sender",
      sender: { name: "Vendor Co", address: "vendor@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: "2026-07-15T12:00:00.000Z",
      receivedAt: "2026-07-15T12:00:00.000Z",
      bodyText: "Route this message",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });
    runtime.database.completeArchive(archive.id, 0);

    const login = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { username: "admin", pin: "2332" }
    });
    const headers = { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` };

    const initial = await runtime.app.inject({
      method: "GET",
      url: `/api/admin/sender-filing?archiveId=${archive.id}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: false, rules: [] });

    const organized = await runtime.app.inject({
      method: "POST",
      url: "/api/admin/sender-filing/organize",
      headers,
      remoteAddress: "127.0.0.1",
      payload: { archiveId: archive.id }
    });
    expect(organized.statusCode).toBe(200);
    expect(organized.json()).toMatchObject({
      enabled: true,
      lastRunMovedMessages: 1,
      rules: [{ senderAddress: "vendor@example.test", folderPath: "Top Senders/Vendor Co" }]
    });

    const disabled = await runtime.app.inject({
      method: "DELETE",
      url: `/api/admin/sender-filing?archiveId=${archive.id}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, rules: [] });
  });
});

describe("Email API AI schedule and insights routes", () => {
  it("creates, runs, updates, and deletes a scheduled AI sweep, and reports mailbox insights", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const archive = runtime.database.createArchive({
      name: "Schedule route mail",
      sourceType: "mbox",
      fingerprint: "schedule-route",
      sizeBytes: 10
    });
    const folder = runtime.database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    runtime.database.completeArchive(archive.id, 0);

    const login = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { username: "admin", pin: "2332" }
    });
    const headers = { authorization: `Bearer ${(login.json() as { accessToken: string }).accessToken}` };

    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/admin/ai-schedules",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        name: "Inbox sweep",
        folderId: folder.id,
        mode: "unread",
        intervalMinutes: 30,
        provider: "deepseek",
        model: "deepseek-v4-flash",
        skills: ["summarize", "extract-actions"],
        prompt: "Focus on commitments and due dates.",
        enabled: true
      }
    });
    expect(created.statusCode).toBe(200);
    const scheduleId = (created.json() as { id: string }).id;
    expect(created.json()).toMatchObject({
      name: "Inbox sweep",
      folderPath: "Inbox",
      mode: "unread",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      skills: ["summarize", "extract-actions"],
      prompt: "Focus on commitments and due dates."
    });

    const listed = await runtime.app.inject({ method: "GET", url: "/api/admin/ai-schedules", headers, remoteAddress: "127.0.0.1" });
    expect(listed.json()).toHaveLength(1);

    const runNow = await runtime.app.inject({
      method: "POST",
      url: `/api/admin/ai-schedules/${scheduleId}/run`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(runNow.statusCode).toBe(200);
    expect(runNow.json()).toMatchObject({
      lastRunSummary: "Completed 0 of 0 jobs",
      progress: { status: "completed", totalMessages: 0, queuedJobs: 0, percent: 100 }
    });

    const updated = await runtime.app.inject({
      method: "PATCH",
      url: `/api/admin/ai-schedules/${scheduleId}`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { enabled: false }
    });
    expect(updated.json()).toMatchObject({ enabled: false });

    const deleted = await runtime.app.inject({
      method: "DELETE",
      url: `/api/admin/ai-schedules/${scheduleId}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(deleted.statusCode).toBe(204);
    const listedAfterDelete = await runtime.app.inject({ method: "GET", url: "/api/admin/ai-schedules", headers, remoteAddress: "127.0.0.1" });
    expect(listedAfterDelete.json()).toEqual([]);

    const insights = await runtime.app.inject({ method: "GET", url: "/api/admin/insights", headers, remoteAddress: "127.0.0.1" });
    expect(insights.statusCode).toBe(200);
    expect(insights.json()).toMatchObject({ totalMessages: 0, analysis: null });

    const unauthorizedInsights = await runtime.app.inject({ method: "GET", url: "/api/admin/insights", remoteAddress: "127.0.0.1" });
    expect(unauthorizedInsights.statusCode).toBe(401);
  });
});

describe("Email API authorization", () => {
  it("requires named login and attributes administrator actions to an IP address", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const unauthorized = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      remoteAddress: "127.0.0.1"
    });
    expect(unauthorized.statusCode).toBe(401);

    const rejected = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { username: "admin", pin: "0000" }
    });
    expect(rejected.statusCode).toBe(401);

    const login = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { "user-agent": "Archive Mail test browser" },
      payload: { username: "admin", pin: "2332" }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({
      session: { role: "admin", user: { username: "admin", mustChangePin: true } }
    });
    const accessToken = (login.json() as { accessToken: string }).accessToken;
    const headers = { authorization: `Bearer ${accessToken}` };

    const settings = await runtime.app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      database: { activeProvider: "sqlite" },
      security: { defaultPinWarning: true },
      gmail: { configured: false, source: "none", clientSecretConfigured: false },
      ai: { activeProvider: "openai", enabled: false, providers: { openai: { configured: false, source: "none", apiKeyConfigured: false } } }
    });

    const savedAi = await runtime.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/ai",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        apiKey: "sk-proj-route-test-secret-value",
        clearApiKey: false,
        enabled: true,
        model: "route-test-model",
        dailyRequestLimit: 5,
        monthlyRequestLimit: 50
      }
    });
    expect(savedAi.statusCode).toBe(200);
    expect(savedAi.json()).toMatchObject({
      ai: {
        enabled: true,
        dailyRequestLimit: 5,
        monthlyRequestLimit: 50,
        providers: { openai: { configured: true, source: "admin", model: "route-test-model" } }
      }
    });
    expect(savedAi.body).not.toContain("sk-proj-route-test-secret-value");

    const clearedAi = await runtime.app.inject({
      method: "DELETE",
      url: "/api/admin/settings/ai/key",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(clearedAi.statusCode).toBe(200);
    expect(clearedAi.json()).toMatchObject({ ai: { enabled: false, providers: { openai: { configured: false } } } });

    const savedGmail = await runtime.app.inject({
      method: "PATCH",
      url: "/api/admin/settings/gmail",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        clientId: "route-test.apps.googleusercontent.com",
        clientSecret: "route-test-secret",
        clearClientSecret: false
      }
    });
    expect(savedGmail.statusCode).toBe(200);
    expect(savedGmail.json()).toMatchObject({
      gmail: {
        configured: true,
        clientId: "route-test.apps.googleusercontent.com",
        clientSecretConfigured: true,
        source: "admin"
      }
    });
    expect(savedGmail.body).not.toContain("route-test-secret");

    const gmailAuthorization = await runtime.app.inject({
      method: "POST",
      url: "/api/gmail/oauth/start",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        archiveName: "Gmail test",
        folderName: "Inbox",
        query: "newer_than:1d",
        ocrEnabled: false
      }
    });
    expect(gmailAuthorization.statusCode).toBe(200);
    const authorizationUrl = new URL((gmailAuthorization.json() as { authorizationUrl: string }).authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("route-test.apps.googleusercontent.com");

    const clearedGmail = await runtime.app.inject({
      method: "DELETE",
      url: "/api/admin/settings/gmail",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(clearedGmail.statusCode).toBe(200);
    expect(clearedGmail.json()).toMatchObject({ gmail: { configured: false, source: "none" } });

    const createdUser = await runtime.app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        username: "casey",
        displayName: "Casey Morgan",
        role: "user",
        pin: "4521"
      }
    });
    expect(createdUser.statusCode).toBe(200);

    const audit = await runtime.app.inject({
      method: "GET",
      url: "/api/admin/audit?username=admin&limit=50",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          username: "admin",
          ipAddress: "127.0.0.1",
          action: "GET /api/admin/settings",
          success: true
        })
      ])
    });

    const userLogin = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "127.0.0.1",
      payload: { username: "casey", pin: "4521" }
    });
    const userHeaders = {
      authorization: `Bearer ${(userLogin.json() as { accessToken: string }).accessToken}`
    };
    const forbiddenSettings = await runtime.app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: userHeaders,
      remoteAddress: "127.0.0.1"
    });
    expect(forbiddenSettings.statusCode).toBe(403);

    const wrongIp = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      headers,
      remoteAddress: "127.0.0.2"
    });
    expect(wrongIp.statusCode).toBe(401);

    const logout = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(logout.statusCode).toBe(204);
    const afterLogout = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("allows paired viewers to read but not mutate", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const archive = runtime.database.createArchive({
      name: "fixture.mbox",
      sourceType: "mbox",
      fingerprint: "api-fixture",
      sizeBytes: 100
    });
    const folder = runtime.database.ensureFolder(archive.id, "Inbox", "Inbox", null);
    const messageId = runtime.database.insertMessage({
      archiveId: archive.id,
      folderId: folder.id,
      sourceKey: "one",
      internetMessageId: null,
      subject: "Authorization test",
      sender: { name: "Maya", address: "maya@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      receivedAt: null,
      bodyText: "Local state is private.",
      bodyHtml: null,
      headers: {},
      sizeBytes: 40,
      attachments: []
    });
    runtime.database.completeArchive(archive.id, 0);

    const unauthorized = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      remoteAddress: "192.168.1.8"
    });
    expect(unauthorized.statusCode).toBe(401);

    const sharing = runtime.setSharingEnabled(true);
    const viewerToken = new URL(sharing.url!).searchParams.get("share")!;
    const viewerLogin = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "192.168.1.8",
      payload: { username: "admin", pin: "2332", pairingToken: viewerToken }
    });
    expect(viewerLogin.statusCode).toBe(200);
    expect(viewerLogin.json()).toMatchObject({ session: { role: "viewer" } });
    const viewerHeaders = {
      authorization: `Bearer ${(viewerLogin.json() as { accessToken: string }).accessToken}`
    };
    const readable = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8"
    });
    expect(readable.statusCode).toBe(200);
    expect(readable.json()).toHaveLength(1);

    const forbidden = await runtime.app.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}/state`,
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8",
      payload: { isStarred: true }
    });
    expect(forbidden.statusCode).toBe(403);

    const deleteForbidden = await runtime.app.inject({
      method: "DELETE",
      url: `/api/folders/${folder.id}`,
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8"
    });
    expect(deleteForbidden.statusCode).toBe(403);

    const diagnosticsForbidden = await runtime.app.inject({
      method: "GET",
      url: "/api/diagnostics",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8"
    });
    expect(diagnosticsForbidden.statusCode).toBe(403);
    const diagnosticsDeleteForbidden = await runtime.app.inject({
      method: "DELETE",
      url: "/api/diagnostics",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8"
    });
    expect(diagnosticsDeleteForbidden.statusCode).toBe(403);

    const sendSpy = vi.spyOn(runtime.gmail, "sendMessage").mockResolvedValue({
      id: "gmail-sent-route",
      threadId: "gmail-thread-route",
      localCopyImported: true
    });
    const sendForbidden = await runtime.app.inject({
      method: "POST",
      url: "/api/gmail/connections/connection-route/send",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.8",
      payload: {
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "Viewer cannot send",
        bodyText: "This request must be rejected."
      }
    });
    expect(sendForbidden.statusCode).toBe(403);
    expect(sendSpy).not.toHaveBeenCalled();

    const localHeaders = { authorization: `Bearer ${runtime.localToken}` };
    const local = await runtime.app.inject({
      method: "PATCH",
      url: `/api/messages/${messageId}/state`,
      headers: localHeaders,
      remoteAddress: "127.0.0.1",
      payload: { isStarred: true }
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({ isStarred: true });

    const sent = await runtime.app.inject({
      method: "POST",
      url: "/api/gmail/connections/connection-route/send",
      headers: localHeaders,
      remoteAddress: "127.0.0.1",
      payload: {
        to: ["recipient@example.test"],
        cc: [],
        bcc: [],
        subject: "Route send",
        bodyText: "Sent through the local-only route."
      }
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ id: "gmail-sent-route", localCopyImported: true });
    expect(sendSpy).toHaveBeenCalledWith("connection-route", expect.objectContaining({
      to: ["recipient@example.test"],
      subject: "Route send"
    }));

    const renamedArchive = await runtime.app.inject({
      method: "PATCH",
      url: `/api/archives/${archive.id}`,
      headers: localHeaders,
      remoteAddress: "127.0.0.1",
      payload: { name: "Renamed archive" }
    });
    expect(renamedArchive.statusCode).toBe(200);
    expect(renamedArchive.json()).toMatchObject({ name: "Renamed archive" });

    const renamedFolder = await runtime.app.inject({
      method: "PATCH",
      url: `/api/folders/${folder.id}`,
      headers: localHeaders,
      remoteAddress: "127.0.0.1",
      payload: { name: "Primary" }
    });
    expect(renamedFolder.statusCode).toBe(200);
    expect(renamedFolder.json()).toMatchObject({ name: "Primary", path: "Primary" });

    const deletedFolder = await runtime.app.inject({
      method: "DELETE",
      url: `/api/folders/${folder.id}`,
      headers: localHeaders,
      remoteAddress: "127.0.0.1"
    });
    expect(deletedFolder.statusCode).toBe(204);
    expect(runtime.database.getMessage(messageId)).toBeNull();
    expect(runtime.database.getArchive(archive.id)?.messageCount).toBe(0);

    const deletedArchive = await runtime.app.inject({
      method: "DELETE",
      url: `/api/archives/${archive.id}`,
      headers: localHeaders,
      remoteAddress: "127.0.0.1"
    });
    expect(deletedArchive.statusCode).toBe(204);
    expect(runtime.database.getArchive(archive.id)).toBeNull();
    expect(runtime.database.listDiagnostics().map((event) => event.message)).toEqual(
      expect.arrayContaining(["Mailbox removed: Primary", "Archive removed: Renamed archive"])
    );
    const clearedDiagnostics = await runtime.app.inject({
      method: "DELETE",
      url: "/api/diagnostics",
      headers: localHeaders,
      remoteAddress: "127.0.0.1"
    });
    expect(clearedDiagnostics.statusCode).toBe(204);
    expect(runtime.database.listDiagnostics()).toEqual([]);
  });

  it("revokes issued viewer sessions when sharing is turned off", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const sharing = runtime.setSharingEnabled(true);
    const viewerToken = new URL(sharing.url!).searchParams.get("share")!;
    const viewerLogin = await runtime.app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "192.168.1.9",
      payload: { username: "admin", pin: "2332", pairingToken: viewerToken }
    });
    const viewerHeaders = {
      authorization: `Bearer ${(viewerLogin.json() as { accessToken: string }).accessToken}`
    };
    const beforeStop = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.9"
    });
    expect(beforeStop.statusCode).toBe(200);

    runtime.setSharingEnabled(false);

    const afterStop = await runtime.app.inject({
      method: "GET",
      url: "/api/archives",
      headers: viewerHeaders,
      remoteAddress: "192.168.1.9"
    });
    expect(afterStop.statusCode).toBe(401);
  });

  it("only allows the Electron dev-server origin for cross-origin API access", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();

    const allowed = await runtime.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://127.0.0.1:5173" },
      remoteAddress: "127.0.0.1"
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");

    const blocked = await runtime.app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://malicious.example" },
      remoteAddress: "127.0.0.1"
    });
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("resumes chunked extensionless MBOX uploads and exposes their diagnostics", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();
    const headers = { authorization: `Bearer ${runtime.localToken}` };
    const content = Buffer.from(extensionlessMbox(), "utf8");

    const createdResponse = await runtime.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        filename: "Inbox",
        sizeBytes: content.byteLength,
        lastModified: 1_700_000_000_000,
        ocrEnabled: false
      }
    });
    expect(createdResponse.statusCode).toBe(200);
    const created = createdResponse.json() as { id: string };
    const firstChunk = content.subarray(0, 48);
    const secondChunk = content.subarray(48);

    const firstResponse = await runtime.app.inject({
      method: "PUT",
      url: `/api/uploads/${created.id}/chunk`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-upload-offset": "0"
      },
      remoteAddress: "127.0.0.1",
      payload: firstChunk
    });
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json()).toMatchObject({ receivedBytes: firstChunk.byteLength });

    const wrongOffset = await runtime.app.inject({
      method: "PUT",
      url: `/api/uploads/${created.id}/chunk`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-upload-offset": "0"
      },
      remoteAddress: "127.0.0.1",
      payload: secondChunk
    });
    expect(wrongOffset.statusCode).toBe(409);

    const resumedResponse = await runtime.app.inject({
      method: "POST",
      url: "/api/uploads",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        filename: "Inbox",
        sizeBytes: content.byteLength,
        lastModified: 1_700_000_000_000,
        ocrEnabled: false
      }
    });
    expect(resumedResponse.json()).toMatchObject({ id: created.id, receivedBytes: firstChunk.byteLength });

    const secondResponse = await runtime.app.inject({
      method: "PUT",
      url: `/api/uploads/${created.id}/chunk`,
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-upload-offset": String(firstChunk.byteLength)
      },
      remoteAddress: "127.0.0.1",
      payload: secondChunk
    });
    expect(secondResponse.statusCode).toBe(200);

    const completeResponse = await runtime.app.inject({
      method: "POST",
      url: `/api/uploads/${created.id}/complete`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(completeResponse.statusCode).toBe(200);
    const upload = completeResponse.json() as { jobId: string };
    const job = await waitForJob(runtime, upload.jobId);
    expect(job.status).toBe("completed");
    expect(runtime.database.listArchives()[0]?.name).toBe("Inbox");
    expect(runtime.database.listFolders(job.archiveId!)[0]?.name).toBe("Inbox");

    const archiveRename = await runtime.app.inject({
      method: "PATCH",
      url: `/api/archives/${job.archiveId}`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { name: "Gmail history" }
    });
    expect(archiveRename.json()).toMatchObject({ name: "Gmail history" });

    const diagnosticsResponse = await runtime.app.inject({
      method: "GET",
      url: "/api/diagnostics",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      uploads: [{ id: created.id, status: "completed", jobId: upload.jobId }]
    });
    expect((diagnosticsResponse.json() as { events: Array<{ category: string }> }).events.some((event) => event.category === "upload")).toBe(true);
  });

  it("clears completed import history without deleting the imported archive", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();
    const headers = { authorization: `Bearer ${runtime.localToken}` };
    const archive = runtime.database.createArchive({
      name: "Imported archive",
      sourceType: "mbox",
      fingerprint: "api-clear-complete",
      sizeBytes: 20
    });
    runtime.database.completeArchive(archive.id, 0);
    const job = runtime.database.createImportJob({
      archiveId: archive.id,
      sourcePath: join(dataDir, "imported.mbox"),
      sourceName: "imported.mbox",
      sourceType: "mbox",
      sizeBytes: 20,
      ocrEnabled: false,
      temporarySource: true
    });
    runtime.database.updateImportJob(job.id, { status: "completed", canResume: false });

    const cleared = await runtime.app.inject({
      method: "DELETE",
      url: `/api/import-jobs/${job.id}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(cleared.statusCode).toBe(204);
    expect(runtime.database.getImportJob(job.id)).toBeNull();
    expect(runtime.database.getArchive(archive.id)).toMatchObject({
      id: archive.id,
      name: "Imported archive",
      status: "ready"
    });
    expect(runtime.database.listDiagnostics().map((event) => event.message)).toContain(
      "Import cleared: imported.mbox"
    );

    const missing = await runtime.app.inject({
      method: "DELETE",
      url: `/api/import-jobs/${job.id}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates and combines mailboxes and archives, then reports missing Gmail configuration", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      gmailClientId: null,
      gmailClientSecret: null,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();
    const headers = { authorization: `Bearer ${runtime.localToken}` };
    const target = runtime.database.createArchive({
      name: "Destination",
      sourceType: "mbox",
      fingerprint: "api-merge-target",
      sizeBytes: 10
    });
    const source = runtime.database.createArchive({
      name: "Source",
      sourceType: "mbox",
      fingerprint: "api-merge-source",
      sizeBytes: 20
    });
    runtime.database.completeArchive(target.id, 0);
    runtime.database.completeArchive(source.id, 0);

    const targetFolderResponse = await runtime.app.inject({
      method: "POST",
      url: `/api/archives/${target.id}/folders`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { name: "Inbox" }
    });
    const sourceFolderResponse = await runtime.app.inject({
      method: "POST",
      url: `/api/archives/${source.id}/folders`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { name: "Inbox" }
    });
    const stagingFolderResponse = await runtime.app.inject({
      method: "POST",
      url: `/api/archives/${target.id}/folders`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { name: "Staging" }
    });
    expect(targetFolderResponse.statusCode).toBe(201);
    expect(sourceFolderResponse.statusCode).toBe(201);
    expect(stagingFolderResponse.statusCode).toBe(201);
    const targetFolder = targetFolderResponse.json() as { id: string };
    const stagingFolder = stagingFolderResponse.json() as { id: string };
    const sourceFolder = sourceFolderResponse.json() as { id: string };
    runtime.database.insertMessage({
      archiveId: source.id,
      folderId: sourceFolder.id,
      sourceKey: "api-combine-message",
      internetMessageId: null,
      subject: "Combined through API",
      sender: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      receivedAt: null,
      bodyText: "Route merge body",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });
    runtime.database.insertMessage({
      archiveId: target.id,
      folderId: stagingFolder.id,
      sourceKey: "api-mailbox-combine-message",
      internetMessageId: null,
      subject: "Mailbox combined through API",
      sender: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      bcc: [],
      sentAt: null,
      receivedAt: null,
      bodyText: "Mailbox route merge body",
      bodyHtml: null,
      headers: {},
      sizeBytes: 10,
      attachments: []
    });
    runtime.database.refreshArchiveStatistics(source.id);

    const mailboxCombined = await runtime.app.inject({
      method: "POST",
      url: `/api/folders/${stagingFolder.id}/combine`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { targetFolderId: targetFolder.id }
    });
    expect(mailboxCombined.statusCode).toBe(200);
    expect(mailboxCombined.json()).toMatchObject({
      movedMessages: 1,
      removedMailboxes: 1,
      mailbox: { id: targetFolder.id, path: "Inbox", messageCount: 1 }
    });
    expect(runtime.database.getFolder(stagingFolder.id)).toBeNull();

    const combined = await runtime.app.inject({
      method: "POST",
      url: `/api/archives/${source.id}/combine`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { targetArchiveId: target.id }
    });
    expect(combined.statusCode).toBe(200);
    expect(combined.json()).toMatchObject({
      movedMessages: 1,
      archive: { id: target.id, messageCount: 2, folderCount: 1 }
    });
    expect(runtime.database.getArchive(source.id)).toBeNull();

    const gmailStart = await runtime.app.inject({
      method: "POST",
      url: "/api/gmail/oauth/start",
      headers,
      remoteAddress: "127.0.0.1",
      payload: {
        archiveId: target.id,
        folderId: targetFolder.id,
        archiveName: "Gmail",
        folderName: "Inbox",
        query: "newer_than:30d",
        ocrEnabled: false
      }
    });
    expect(gmailStart.statusCode).toBe(503);
    expect(gmailStart.json()).toMatchObject({ error: expect.stringContaining("Admin settings") });
    const diagnostics = await runtime.app.inject({
      method: "GET",
      url: "/api/diagnostics",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(diagnostics.json()).toMatchObject({ gmailConnections: [] });
    expect((diagnostics.json() as { events: Array<{ category: string }> }).events.some((event) => event.category === "gmail")).toBe(true);
  });

  it("creates, updates, and deletes per-day to-do items through the API", async () => {
    const dataDir = await temporaryDirectory();
    const runtime = new EmailApiRuntime(loadConfig({
      dataDir,
      port: 0,
      devAuthBypass: false,
      logger: false,
      openAiApiKey: ""
    }));
    runtimes.push(runtime);
    await runtime.initialize();
    const headers = { authorization: `Bearer ${runtime.localToken}` };

    const created = await runtime.app.inject({
      method: "POST",
      url: "/api/todos",
      headers,
      remoteAddress: "127.0.0.1",
      payload: { date: "2026-07-15", text: "Draft the release notes" }
    });
    expect(created.statusCode).toBe(201);
    const todo = created.json() as { id: string; completed: boolean };
    expect(todo.completed).toBe(false);

    const listed = await runtime.app.inject({
      method: "GET",
      url: "/api/todos?start=2026-07-15&end=2026-07-15",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(listed.json()).toMatchObject([{ id: todo.id, text: "Draft the release notes" }]);

    const updated = await runtime.app.inject({
      method: "PATCH",
      url: `/api/todos/${todo.id}`,
      headers,
      remoteAddress: "127.0.0.1",
      payload: { completed: true }
    });
    expect(updated.json()).toMatchObject({ id: todo.id, completed: true });

    const deleted = await runtime.app.inject({
      method: "DELETE",
      url: `/api/todos/${todo.id}`,
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(deleted.statusCode).toBe(204);

    const emptied = await runtime.app.inject({
      method: "GET",
      url: "/api/todos?start=2026-07-15&end=2026-07-15",
      headers,
      remoteAddress: "127.0.0.1"
    });
    expect(emptied.json()).toEqual([]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-api-"));
  directories.push(directory);
  return directory;
}

async function waitForJob(runtime: EmailApiRuntime, jobId: string): Promise<NonNullable<ReturnType<EmailApiRuntime["database"]["getImportJob"]>>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = runtime.database.getImportJob(jobId);
    if (job && ["completed", "completed_with_errors", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for import");
}

function extensionlessMbox(): string {
  return [
    "From sender@example.test Wed Jul 01 12:00:00 2026",
    "From: Maya Chen <maya@example.test>",
    "To: Product <product@example.test>",
    "Date: Wed, 01 Jul 2026 12:00:00 +0000",
    "Subject: Extensionless archive",
    "Message-ID: <extensionless@example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This mailbox has no filename extension.",
    ""
  ].join("\n");
}
