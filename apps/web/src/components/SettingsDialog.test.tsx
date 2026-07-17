import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AdminInsights,
  AdminSettings,
  AiSchedule,
  Archive,
  AuthSessionInfo,
  Folder,
  GmailConnection,
  SenderFilingStatus,
  UserSummary
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { SettingsDialog } from "./SettingsDialog.js";

afterEach(cleanup);

describe("SettingsDialog", () => {
  it("configures the default draft sender and placeholder name", async () => {
    const updatedSettings: AdminSettings = {
      ...SETTINGS,
      drafts: {
        ...SETTINGS.drafts,
        defaultFromAddress: "automation@vitas.work",
        senderName: "Vitas Mudinas"
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      updateDraftSettings: vi.fn().mockResolvedValue(updatedSettings)
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Drafts" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Drafts" }));

    fireEvent.change(screen.getByRole("textbox", { name: /Default draft send-as address/ }), {
      target: { value: "automation@vitas.work" }
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Sender name/ }), {
      target: { value: "Vitas Mudinas" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft identity" }));

    await waitFor(() => expect(api.updateDraftSettings).toHaveBeenCalledWith({
      defaultFromAddress: "automation@vitas.work",
      senderName: "Vitas Mudinas"
    }));
    expect(await screen.findByText("Draft identity saved.")).toBeTruthy();
  });

  it("adds and removes symbols from the footer stock ticker", async () => {
    const updatedSettings: AdminSettings = {
      ...SETTINGS,
      stocks: { ...SETTINGS.stocks, symbols: ["SPY", "AAPL", "MSFT"] }
    };
    const onStockSettingsChanged = vi.fn();
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      updateStockSettings: vi.fn().mockResolvedValue(updatedSettings)
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
        onStockSettingsChanged={onStockSettingsChanged}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Stocks" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Stocks" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove QQQ" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Add ticker symbol/ }), { target: { value: "msft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save ticker list" }));

    await waitFor(() => expect(api.updateStockSettings).toHaveBeenCalledWith({
      symbols: ["SPY", "AAPL", "MSFT"],
      secondsPerSymbol: 8
    }));
    expect(onStockSettingsChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("Stock ticker list saved.")).toBeTruthy();
  });

  it("toggles news sources for the breaking-news ticker", async () => {
    const updatedSettings: AdminSettings = {
      ...SETTINGS,
      news: { ...SETTINGS.news, enabledSources: ["bbc", "aljazeera", "foxnews"] }
    };
    const onNewsSettingsChanged = vi.fn();
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      updateNewsSettings: vi.fn().mockResolvedValue(updatedSettings)
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
        onNewsSettingsChanged={onNewsSettingsChanged}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "News" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "News" }));

    const cnnCheckbox = screen.getByRole("checkbox", { name: "CNN" });
    expect((cnnCheckbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(cnnCheckbox);
    fireEvent.click(screen.getByRole("button", { name: "Save news sources" }));

    await waitFor(() => expect(api.updateNewsSettings).toHaveBeenCalledWith({
      enabledSources: ["bbc", "aljazeera", "foxnews"],
      secondsPerHeadline: 8
    }));
    expect(onNewsSettingsChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("News ticker sources saved.")).toBeTruthy();
  });

  it("shows database, Gmail, AI, users, security, and IP audit settings", async () => {
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      audit: vi.fn().mockResolvedValue({
        items: [{
          id: "audit-1",
          sessionId: "session-1",
          userId: "user-1",
          username: "admin",
          displayName: "Administrator",
          role: "admin",
          action: "GET /api/messages/:messageId",
          method: "GET",
          path: "/api/messages/message-1",
          statusCode: 200,
          success: true,
          ipAddress: "127.0.0.1",
          userAgent: "Test browser",
          details: {},
          createdAt: "2026-07-13T00:00:00.000Z"
        }],
        nextCursor: null
      }),
      downloadAudit: vi.fn()
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    expect((screen.getByRole("option", { name: /PostgreSQL.*adapter not installed/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText(/content-addressed blob directory/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(screen.getByText(/Gmail authorization cannot start/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    expect(screen.getByText(/does not provide API billing/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(screen.getByText("Administrator")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText(/first-run administrator PIN is still active/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    await waitFor(() => expect(screen.getByText("127.0.0.1")).toBeTruthy());
    expect(screen.getByText("GET /api/messages/:messageId")).toBeTruthy();
  });

  it("makes DeepSeek the active provider without touching OpenAI's saved configuration", async () => {
    const switchedSettings: AdminSettings = {
      ...SETTINGS,
      ai: { ...SETTINGS.ai, activeProvider: "deepseek" }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      setActiveAiProvider: vi.fn().mockResolvedValue(switchedSettings),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      audit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      downloadAudit: vi.fn()
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    fireEvent.click(screen.getByRole("button", { name: "Make active" }));
    expect(api.setActiveAiProvider).toHaveBeenCalledWith("deepseek");
    await waitFor(() => expect(screen.getAllByText("Active")).toHaveLength(1));
  });

  it("allows an Admin key to override an environment key from the UI", async () => {
    const environmentSettings: AdminSettings = {
      ...SETTINGS,
      ai: {
        ...SETTINGS.ai,
        providers: {
          ...SETTINGS.ai.providers,
          openai: {
            ...SETTINGS.ai.providers.openai,
            configured: true,
            apiKeyConfigured: true,
            environmentApiKeyConfigured: true,
            source: "environment"
          }
        }
      }
    };
    const overriddenSettings: AdminSettings = {
      ...environmentSettings,
      ai: {
        ...environmentSettings.ai,
        providers: {
          ...environmentSettings.ai.providers,
          openai: {
            ...environmentSettings.ai.providers.openai,
            savedApiKeyConfigured: true,
            source: "admin"
          }
        }
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(environmentSettings),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      updateAiSettings: vi.fn().mockResolvedValue(overriddenSettings)
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "AI" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    const keyInput = screen.getByLabelText(/OpenAI API key/) as HTMLInputElement;
    expect(keyInput.disabled).toBe(false);
    fireEvent.change(keyInput, { target: { value: "sk-proj-admin-override-secret" } });
    fireEvent.submit(keyInput.closest("form")!);

    await waitFor(() => expect(api.updateAiSettings).toHaveBeenCalledWith({
      provider: "openai",
      clearApiKey: false,
      model: "gpt-5.6-luna",
      apiKey: "sk-proj-admin-override-secret"
    }));
  });

  it("loads live DeepSeek models into the picker and shows pricing for the selected one", async () => {
    const settingsWithDeepSeekKey: AdminSettings = {
      ...SETTINGS,
      ai: {
        ...SETTINGS.ai,
        providers: {
          ...SETTINGS.ai.providers,
          deepseek: {
            configured: true,
            apiKeyConfigured: true,
            savedApiKeyConfigured: true,
            environmentApiKeyConfigured: false,
            source: "admin",
            model: "deepseek-v4-flash"
          }
        }
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(settingsWithDeepSeekKey),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listAiModels: vi.fn().mockResolvedValue([
        { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "Fast general-purpose model.", pricing: "$0.14 per 1M input tokens" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", description: "Stronger reasoning model.", pricing: "$0.435 per 1M input tokens" }
      ]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      audit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      downloadAudit: vi.fn()
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    fireEvent.click(screen.getByRole("button", { name: "Load DeepSeek models" }));
    expect(api.listAiModels).toHaveBeenCalledWith("deepseek");
    await waitFor(() => expect(screen.getByRole("option", { name: "DeepSeek V4 Pro" })).toBeTruthy());
    expect(screen.getByText(/\$0\.14 per 1M input tokens/)).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("DeepSeek V4 Flash"), { target: { value: "deepseek-v4-pro" } });
    expect(screen.getByText(/\$0\.435 per 1M input tokens/)).toBeTruthy();
  });

  it("loads a Google Desktop OAuth JSON file and saves redacted admin settings", async () => {
    const configuredSettings: AdminSettings = {
      ...SETTINGS,
      gmail: {
        ...SETTINGS.gmail,
        configured: true,
        clientId: "desktop.apps.googleusercontent.com",
        clientSecretConfigured: true,
        source: "admin"
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      updateGmailSettings: vi.fn().mockResolvedValue(configuredSettings)
    } as unknown as ApiClient;
    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Gmail" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    const file = new File(["{}"], "desktop-oauth.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue(JSON.stringify({
        installed: {
          client_id: "desktop.apps.googleusercontent.com",
          client_secret: "desktop-secret"
        }
      }))
    });
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByDisplayValue("desktop.apps.googleusercontent.com")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Save Gmail configuration/ }));
    await waitFor(() => expect(api.updateGmailSettings).toHaveBeenCalledWith({
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "desktop-secret",
      clearClientSecret: false,
      syncIntervalMinutes: 5,
      syncMailboxActions: false
    }));
    expect(screen.queryByDisplayValue("desktop-secret")).toBeNull();
  });

  it("enables Gmail mailbox action sync and offers reauthorization for older connections", async () => {
    const currentSettings: AdminSettings = {
      ...SETTINGS,
      gmail: {
        ...SETTINGS.gmail,
        configured: true,
        clientId: "desktop.apps.googleusercontent.com",
        source: "admin"
      }
    };
    const updatedSettings: AdminSettings = {
      ...currentSettings,
      gmail: { ...currentSettings.gmail, syncMailboxActions: true }
    };
    const connection: GmailConnection = {
      id: "gmail-readonly",
      email: "owner@example.test",
      archiveId: "archive-1",
      archiveName: "Gmail",
      folderId: "folder-1",
      folderPath: "Gmail",
      query: "",
      ocrEnabled: false,
      canSend: true,
      canModifyMailbox: false,
      canManageCalendar: true,
      status: "connected",
      processedItems: 0,
      totalItems: null,
      importedItems: 0,
      lastSyncedAt: null,
      lastError: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const onReauthorize = vi.fn();
    const api = {
      adminSettings: vi.fn().mockResolvedValue(currentSettings),
      listGmailConnections: vi.fn().mockResolvedValue([connection]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      updateGmailSettings: vi.fn().mockResolvedValue(updatedSettings)
    } as unknown as ApiClient;
    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
        onReauthorizeGoogleCalendar={onReauthorize}
      />
    );

    await waitFor(() => expect(screen.getByRole("button", { name: "Gmail" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    const toggle = await screen.findByRole("checkbox", { name: /Mirror mailbox actions to Gmail/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Save Gmail configuration/ }));
    await waitFor(() => expect(api.updateGmailSettings).toHaveBeenCalledWith({
      clientId: "desktop.apps.googleusercontent.com",
      clearClientSecret: false,
      syncIntervalMinutes: 5,
      syncMailboxActions: true
    }));
    const reauthorize = await screen.findByRole("button", { name: "Reauthorize" });
    fireEvent.click(reauthorize);
    expect(onReauthorize).toHaveBeenCalledWith(connection);
  });

  it("starts a full-history Gmail pull from the admin panel and shows progress", async () => {
    const connection = {
      id: "gmail-1",
      email: "owner@example.test",
      archiveId: "archive-1",
      archiveName: "Gmail",
      folderId: "folder-1",
      folderPath: "Gmail",
      query: "newer_than:30d",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: true,
      status: "connected" as const,
      processedItems: 0,
      totalItems: null,
      importedItems: 0,
      lastSyncedAt: null,
      lastError: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const syncing = {
      ...connection,
      status: "syncing" as const,
      processedItems: 25,
      totalItems: 100,
      importedItems: 10
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([connection]),
      syncGmail: vi.fn().mockResolvedValue(syncing),
      listUsers: vi.fn().mockResolvedValue(USERS)
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Gmail" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Gmail" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Pull all email" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pull all email" }));

    await waitFor(() => expect(api.syncGmail).toHaveBeenCalledWith("gmail-1", { full: true }));
    expect(screen.getByText(/25 of 100 checked · 10 new · 25%/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("creates a scheduled AI sweep for a chosen mailbox", async () => {
    const archive: Archive = {
      id: "archive-1",
      name: "Combined mail",
      sourceType: "mbox",
      status: "ready",
      sizeBytes: 100,
      messageCount: 10,
      unreadCount: 2,
      folderCount: 1,
      attachmentCount: 0,
      errorCount: 0,
      importedAt: "2026-07-13T00:00:00.000Z",
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const folder: Folder = { id: "folder-1", archiveId: "archive-1", parentId: null, name: "Inbox", path: "Inbox", messageCount: 10, unreadCount: 2 };
    const createdSchedule: AiSchedule = {
      id: "schedule-1",
      name: "Inbox sweep",
      task: "analyze",
      folderId: folder.id,
      folderPath: "Inbox",
      archiveId: archive.id,
      archiveName: "Combined mail",
      messageId: null,
      messageSubject: null,
      gmailConnectionId: null,
      gmailConnectionEmail: null,
      resumeId: null,
      resumeName: null,
      mode: "unread",
      intervalMinutes: 60,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      skills: ["summarize", "categorize", "prioritize", "extract-actions", "detect-spam", "detect-phishing", "recommend-draft"],
      prompt: "Focus on customer escalations and due dates.",
      enabled: true,
      lastRunAt: null,
      lastRunSummary: null,
      progress: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue([folder]),
      listMessages: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      createAiSchedule: vi.fn().mockResolvedValue(createdSchedule),
      audit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      downloadAudit: vi.fn()
    } as unknown as ApiClient;

    render(
      <SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    await waitFor(() => expect(screen.getByText("No scheduled AI agents yet.")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Inbox" })).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("e.g. Inbox unread sweep"), { target: { value: "Inbox sweep" } });
    fireEvent.change(screen.getByLabelText("Mailbox"), { target: { value: folder.id } });
    fireEvent.change(screen.getByLabelText("Agent provider"), { target: { value: "deepseek" } });
    fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Focus on customer escalations and due dates." } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(api.createAiSchedule).toHaveBeenCalledWith({
      name: "Inbox sweep",
      task: "analyze",
      folderId: folder.id,
      messageId: null,
      gmailConnectionId: null,
      resumeId: null,
      replyStyleId: null,
      mode: "unread",
      intervalMinutes: 60,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      skills: ["summarize", "categorize", "prioritize", "extract-actions", "detect-spam", "detect-phishing", "recommend-draft"],
      prompt: "Focus on customer escalations and due dates.",
      enabled: true
    }));
    await waitFor(() => expect(screen.getByText("Inbox sweep")).toBeTruthy());
  });

  it("shows live queued, running, completed, skipped, and percent status for an AI schedule", async () => {
    const schedule: AiSchedule = {
      id: "schedule-progress",
      name: "Inbox Sweep",
      task: "analyze",
      folderId: "folder-progress",
      folderPath: "Gmail-Archive/Inbox",
      archiveId: "archive-progress",
      archiveName: "Inbox-1.mbox",
      messageId: null,
      messageSubject: null,
      gmailConnectionId: null,
      gmailConnectionEmail: null,
      resumeId: null,
      resumeName: null,
      mode: "all",
      intervalMinutes: 60,
      provider: "deepseek",
      model: "deepseek-chat",
      skills: ["summarize", "categorize", "prioritize"],
      prompt: "Process the inbox.",
      enabled: true,
      lastRunAt: "2026-07-15T23:37:00.000Z",
      lastRunSummary: "Processed 10 of 100 jobs",
      progress: {
        runId: "run-progress",
        status: "processing",
        totalMessages: 101,
        queuedJobs: 100,
        skippedMessages: 1,
        enqueueErrors: 0,
        queued: 89,
        running: 1,
        completed: 10,
        failed: 0,
        cancelled: 0,
        processedJobs: 10,
        percent: 10,
        draftsCreated: 0,
        startedAt: "2026-07-15T23:37:00.000Z",
        enqueueCompletedAt: "2026-07-15T23:37:01.000Z",
        completedAt: null,
        error: null
      },
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T23:38:00.000Z"
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([schedule]),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));

    expect(await screen.findByText("Inbox Sweep")).toBeTruthy();
    expect(screen.getByText("10 of 100 jobs processed")).toBeTruthy();
    expect(screen.getByText("89 queued")).toBeTruthy();
    expect(screen.getByText("1 running")).toBeTruthy();
    expect(screen.getByText("10 completed")).toBeTruthy();
    expect(screen.getByText("1 skipped (already handled or up to date)")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "AI schedule progress" }).getAttribute("aria-valuenow")).toBe("10");
    expect((screen.getByRole("button", { name: "Run Inbox Sweep now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("configures a specific-email draft task with a Gmail account, resume, skills, and prompt", async () => {
    const archive: Archive = {
      id: "archive-draft",
      name: "Gmail mail",
      sourceType: "gmail",
      status: "ready",
      sizeBytes: 10,
      messageCount: 1,
      unreadCount: 1,
      folderCount: 1,
      attachmentCount: 0,
      errorCount: 0,
      importedAt: "2026-07-15T00:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const folder: Folder = { id: "folder-draft", archiveId: archive.id, parentId: null, name: "Inbox", path: "Inbox", messageCount: 1, unreadCount: 1 };
    const connection = {
      id: "connection-draft",
      email: "owner@example.test",
      archiveId: archive.id,
      archiveName: archive.name,
      folderId: folder.id,
      folderPath: folder.path,
      query: "",
      ocrEnabled: false,
      canSend: true,
      canManageCalendar: false,
      status: "connected" as const,
      processedItems: 0,
      totalItems: null,
      importedItems: 0,
      lastSyncedAt: null,
      lastError: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const resume = {
      id: "resume-draft",
      name: "Engineering resume",
      filename: "resume.pdf",
      contentType: "application/pdf",
      sizeBytes: 100,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const createdSchedule: AiSchedule = {
      id: "schedule-draft",
      name: "Development replies",
      task: "draft_reply",
      folderId: folder.id,
      folderPath: folder.path,
      archiveId: archive.id,
      archiveName: archive.name,
      messageId: "message-draft",
      messageSubject: "TypeScript role",
      gmailConnectionId: connection.id,
      gmailConnectionEmail: connection.email,
      resumeId: resume.id,
      resumeName: resume.name,
      mode: "all",
      intervalMinutes: 30,
      provider: "openai",
      model: "gpt-5.6-luna",
      skills: ["recommend-draft"],
      prompt: "Reply professionally and avoid salary commitments.",
      enabled: true,
      lastRunAt: null,
      lastRunSummary: null,
      progress: null,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listGmailConnections: vi.fn().mockResolvedValue([connection]),
      listResumes: vi.fn().mockResolvedValue([resume]),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue([folder]),
      listMessages: vi.fn().mockResolvedValue({
        items: [{
          id: "message-draft",
          archiveId: archive.id,
          folderId: folder.id,
          folderPath: folder.path,
          subject: "TypeScript role",
          sender: { name: "Recruiter", address: "recruiter@example.test" },
          recipients: [],
          sentAt: "2026-07-15T00:00:00.000Z",
          receivedAt: "2026-07-15T00:00:00.000Z",
          preview: "Opportunity",
          hasAttachments: false,
          attachmentCount: 0,
          state: { isRead: false, isStarred: false, tags: [], note: "", updatedAt: null }
        }],
        nextCursor: null
      }),
      createAiSchedule: vi.fn().mockResolvedValue(createdSchedule)
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "AI" }));
    await waitFor(() => expect(screen.getByText("No scheduled AI agents yet.")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Inbox" })).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("e.g. Inbox unread sweep"), { target: { value: "Development replies" } });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "draft_reply" } });
    fireEvent.change(screen.getByLabelText("Mailbox"), { target: { value: folder.id } });
    await waitFor(() => expect(screen.getByRole("option", { name: /TypeScript role/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/^Target/), { target: { value: "message-draft" } });
    fireEvent.change(screen.getByLabelText(/^Development resume/), { target: { value: resume.id } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Summarize/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Categorize/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Prioritize/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Extract actions/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Detect spam/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Detect phishing/ }));
    fireEvent.change(screen.getByLabelText("Agent prompt"), { target: { value: "Reply professionally and avoid salary commitments." } });
    fireEvent.click(screen.getByRole("button", { name: "Create schedule" }));

    await waitFor(() => expect(api.createAiSchedule).toHaveBeenCalledWith({
      name: "Development replies",
      task: "draft_reply",
      folderId: folder.id,
      messageId: "message-draft",
      gmailConnectionId: connection.id,
      resumeId: resume.id,
      replyStyleId: null,
      mode: "unread",
      intervalMinutes: 60,
      provider: "openai",
      model: "gpt-5.6-luna",
      skills: ["recommend-draft"],
      prompt: "Reply professionally and avoid salary commitments.",
      enabled: true
    }));
  });

  it("uploads a resume from the admin resume panel", async () => {
    const uploaded = {
      id: "resume-uploaded",
      name: "Engineering resume",
      filename: "resume.pdf",
      contentType: "application/pdf",
      sizeBytes: 12,
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z"
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listResumes: vi.fn().mockResolvedValue([]),
      uploadResume: vi.fn().mockResolvedValue(uploaded)
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Resumes" }));
    await waitFor(() => expect(screen.getByText("No resumes uploaded yet.")).toBeTruthy());
    const file = new File(["%PDF-resume"], "resume.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/^Display name/), { target: { value: "Engineering resume" } });
    fireEvent.change(screen.getByLabelText(/^Resume file/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Upload resume" }));

    await waitFor(() => expect(api.uploadResume).toHaveBeenCalledWith(file, "Engineering resume"));
    expect(await screen.findByText("resume.pdf · 12 B")).toBeTruthy();
  });

  it("organizes top Inbox senders and displays automatic filing status", async () => {
    const archive: Archive = {
      id: "b8f3f5a5-bc88-4ac9-97e6-e1bd4c2db702",
      name: "Primary Gmail",
      sourceType: "gmail",
      status: "ready",
      sizeBytes: 0,
      messageCount: 120,
      unreadCount: 4,
      folderCount: 8,
      attachmentCount: 0,
      errorCount: 0,
      importedAt: "2026-07-15T00:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const initialStatus: SenderFilingStatus = {
      archiveId: archive.id,
      archiveName: archive.name,
      enabled: false,
      rules: [],
      lastRunAt: null,
      lastRunMovedMessages: 0,
      lastRunCreatedFolders: 0
    };
    const organizedStatus: SenderFilingStatus = {
      ...initialStatus,
      enabled: true,
      lastRunAt: "2026-07-15T12:00:00.000Z",
      lastRunMovedMessages: 42,
      lastRunCreatedFolders: 2,
      rules: [{
        id: "rule-1",
        archiveId: archive.id,
        senderAddress: "vendor@example.test",
        senderName: "Vendor Co",
        ruleType: "folder",
        folderId: "folder-1",
        folderPath: "Top Senders/Vendor Co",
        messageCount: 42,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z"
      }]
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listArchives: vi.fn().mockResolvedValue([archive]),
      senderFilingStatus: vi.fn().mockResolvedValue(initialStatus),
      organizeTopSenders: vi.fn().mockResolvedValue(organizedStatus)
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sender rules" }));
    await waitFor(() => expect(api.senderFilingStatus).toHaveBeenCalledWith(archive.id));
    expect(screen.getByText(/Spam and every non-Inbox mailbox are untouched/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Organize top 20" }));

    await waitFor(() => expect(api.organizeTopSenders).toHaveBeenCalledWith(archive.id));
    expect(await screen.findByText("Vendor Co")).toBeTruthy();
    expect(screen.getByText("Top Senders/Vendor Co")).toBeTruthy();
    expect(screen.getByText(/Moved 42 messages/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("shows mailbox insights: totals, oldest/newest mail, top contacts, and AI analysis breakdown", async () => {
    const insights: AdminInsights = {
      generatedAt: "2026-07-15T12:00:00.000Z",
      totalMessages: 120,
      totalAttachments: 8,
      endpoints: {
        oldest: { id: "m1", subject: "Welcome aboard", senderName: "HR Team", senderAddress: "hr@example.test", date: "2020-01-01T00:00:00.000Z" },
        newest: { id: "m2", subject: "Q3 numbers", senderName: null, senderAddress: "finance@example.test", date: "2026-07-14T00:00:00.000Z" }
      },
      topSenders: [{ address: "vendor@example.test", name: "Vendor Co", count: 42 }],
      topRecipients: [{ address: "owner@example.test", name: "Owner", count: 95 }],
      analysis: {
        analyzedCount: 30,
        priorityBreakdown: { low: 5, normal: 20, high: 4, urgent: 1 },
        topCategories: [{ category: "Finance", count: 12 }],
        actionRequiredCount: 6,
        draftRecommendedCount: 3,
        flaggedSpamCount: 2,
        flaggedPhishingCount: 1,
        averageSpamProbability: 0.12,
        averagePhishingProbability: 0.05
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([]),
      adminInsights: vi.fn().mockResolvedValue(insights),
      audit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      downloadAudit: vi.fn()
    } as unknown as ApiClient;

    render(
      <SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));

    await waitFor(() => expect(screen.getByText("120")).toBeTruthy());
    expect(screen.getByText(/Welcome aboard/)).toBeTruthy();
    expect(screen.getByText(/Q3 numbers/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Top 10 senders (excluding Spam)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Top 10 recipients (excluding Spam)" })).toBeTruthy();
    expect(screen.getByText("Vendor Co")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText(/urgent: 1/)).toBeTruthy();
    expect(screen.getByText("Finance")).toBeTruthy();
  });
});

const USERS: UserSummary[] = [{
  id: "user-1",
  username: "admin",
  displayName: "Administrator",
  role: "admin",
  isActive: true,
  mustChangePin: true,
  lastLoginAt: null,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z"
}];

const SESSION: AuthSessionInfo = {
  id: "session-1",
  user: USERS[0]!,
  role: "admin",
  expiresAt: "2026-07-13T12:00:00.000Z"
};

const SETTINGS: AdminSettings = {
  database: {
    activeProvider: "sqlite",
    activeConnectionString: "sqlite:///tmp/archive-mail.sqlite",
    configuredProvider: "sqlite",
    configuredConnectionString: "sqlite:///tmp/archive-mail.sqlite",
    restartRequired: false,
    providers: [
      { id: "sqlite", label: "SQLite", available: true, description: "Built-in local adapter with FTS5 search." },
      { id: "postgresql", label: "PostgreSQL", available: false, description: "Requires a PostgreSQL data and search adapter." },
      { id: "mysql", label: "MySQL", available: false, description: "Requires a MySQL data and full-text search adapter." },
      { id: "mssql", label: "Microsoft SQL Server", available: false, description: "Requires a SQL Server data and full-text search adapter." }
    ],
    structuredDataPath: "/tmp/archive-mail.sqlite",
    attachmentBlobPath: "/tmp/blobs"
  },
  security: { sessionLifetimeMinutes: 720, defaultPinWarning: true },
  gmail: {
    configured: false,
    clientId: "",
    clientSecretConfigured: false,
    source: "none",
    settingsPath: "/tmp/gmail-oauth-settings.json",
    configurationError: null,
    syncIntervalMinutes: 5,
    syncIntervalEnvManaged: false,
    syncMailboxActions: false,
    syncMailboxActionsEnvManaged: false
  },
  drafts: {
    defaultFromAddress: "ai@vitas.work",
    senderName: "Vitas",
    settingsPath: "/tmp/draft-settings.json",
    configurationError: null
  },
  stocks: {
    symbols: ["SPY", "QQQ", "AAPL"],
    secondsPerSymbol: 8,
    settingsPath: "/tmp/stock-settings.json",
    configurationError: null
  },
  news: {
    enabledSources: ["cnn", "bbc", "aljazeera", "foxnews"],
    secondsPerHeadline: 8,
    settingsPath: "/tmp/news-settings.json",
    configurationError: null
  },
  ai: {
    activeProvider: "openai",
    enabled: false,
    dailyRequestLimit: 100,
    monthlyRequestLimit: 2000,
    settingsPath: "/tmp/ai-settings.json",
    configurationError: null,
    usage: {
      todayRequests: 0,
      monthRequests: 0,
      todayInputTokens: 0,
      todayOutputTokens: 0,
      monthInputTokens: 0,
      monthOutputTokens: 0
    },
    providers: {
      openai: {
        configured: false,
        apiKeyConfigured: false,
        savedApiKeyConfigured: false,
        environmentApiKeyConfigured: false,
        source: "none",
        model: "gpt-5.6-luna"
      },
      deepseek: {
        configured: false,
        apiKeyConfigured: false,
        savedApiKeyConfigured: false,
        environmentApiKeyConfigured: false,
        source: "none",
        model: "deepseek-v4-flash"
      }
    }
  }
};
