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
  SmartMailRule,
  SmartMailRuleRunTask,
  UserSummary
} from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { SettingsDialog } from "./SettingsDialog.js";

afterEach(cleanup);

describe("SettingsDialog", () => {
  it("shows private account settings without loading administrator configuration", async () => {
    const adminSettings = vi.fn().mockResolvedValue(SETTINGS);
    const listUsers = vi.fn().mockResolvedValue(USERS);
    const api = {
      adminSettings,
      listUsers,
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listCalendarAccounts: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={USER_SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Personal settings" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Calendars" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Smart rules" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Database" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Users" })).toBeNull();
    await waitFor(() => expect(screen.getByText(/No Google accounts connected/)).toBeTruthy());
    expect(adminSettings).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("gives renters only personal PIN settings", async () => {
    const changePin = vi.fn().mockResolvedValue(undefined);
    const onSignedOut = vi.fn();
    const api = { changePin } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={RENTER_SESSION}
        onClose={vi.fn()}
        onSignedOut={onSignedOut}
      />
    );

    expect(screen.getByRole("dialog", { name: "Personal settings" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Security" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Calendars" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Users" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Current PIN"), { target: { value: "4826" } });
    fireEvent.change(screen.getByLabelText("New PIN"), { target: { value: "7319" } });
    fireEvent.change(screen.getByLabelText("Confirm new PIN"), { target: { value: "7319" } });
    fireEvent.click(screen.getByRole("button", { name: "Change PIN and sign out" }));

    await waitFor(() => expect(changePin).toHaveBeenCalledWith("4826", "7319"));
    expect(onSignedOut).toHaveBeenCalledOnce();
  });

  it("opens the guide and diagnostics from Admin tools", async () => {
    const onOpenGuide = vi.fn();
    const onOpenDiagnostics = vi.fn();
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS)
    } as unknown as ApiClient;

    render(
      <SettingsDialog
        open
        api={api}
        session={SESSION}
        onClose={vi.fn()}
        onSignedOut={vi.fn()}
        onOpenGuide={onOpenGuide}
        onOpenDiagnostics={onOpenDiagnostics}
        pendingDiagnosticCount={7}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    expect(screen.getByRole("heading", { name: "Tools" })).toBeTruthy();
    const guideButton = screen.getByRole("button", { name: /^Guide/ });
    const diagnosticsButton = screen.getByRole("button", { name: /^Diagnostics/ });
    expect(screen.getByText("7")).toBeTruthy();

    fireEvent.click(guideButton);
    fireEvent.click(diagnosticsButton);
    expect(onOpenGuide).toHaveBeenCalledOnce();
    expect(onOpenDiagnostics).toHaveBeenCalledOnce();
  });

  it("lets an administrator delete a renter account", async () => {
    const renter: UserSummary = {
      ...RENTER_SESSION.user,
      id: "renter-delete",
      username: "renter-delete"
    };
    const deleteUser = vi.fn().mockResolvedValue(undefined);
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue([...USERS, renter]),
      deleteUser
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Users" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete renter-delete" }));

    await waitFor(() => expect(deleteUser).toHaveBeenCalledWith(renter.id));
    expect(screen.getByText("Account renter-delete deleted.")).toBeTruthy();
    expect(screen.queryByText("renter-delete")).toBeNull();
    confirm.mockRestore();
  });

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

  it("edits and reruns an existing smart rule against current Inbox mail", async () => {
    const archive: Archive = {
      id: "archive-smart-rules",
      name: "Gmail",
      sourceType: "gmail",
      status: "ready",
      sizeBytes: 100,
      messageCount: 10,
      unreadCount: 2,
      folderCount: 2,
      attachmentCount: 0,
      errorCount: 0,
      importedAt: "2026-07-13T00:00:00.000Z",
      createdAt: "2026-07-13T00:00:00.000Z"
    };
    const folders: Folder[] = [
      { id: "folder-inbox", archiveId: archive.id, parentId: null, name: "Inbox", path: "Inbox", messageCount: 10, unreadCount: 2 },
      { id: "folder-finance", archiveId: archive.id, parentId: null, name: "Finance", path: "Finance", messageCount: 0, unreadCount: 0 }
    ];
    const rule: SmartMailRule = {
      id: "rule-invoices",
      archiveId: archive.id,
      archiveName: archive.name,
      name: "Invoice filing",
      instruction: "Move invoice email to Finance.",
      conditions: {
        match: "any",
        senderContains: [],
        subjectContains: ["invoice"],
        bodyContains: [],
        hasAttachments: null
      },
      targetFolderId: folders[1]!.id,
      targetFolderPath: folders[1]!.path,
      markRead: false,
      star: false,
      enabled: true,
      matchedMessages: 4,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
    const updatedRule: SmartMailRule = {
      ...rule,
      name: "Receipt filing",
      instruction: "Move receipt email to Finance.",
      conditions: { ...rule.conditions, subjectContains: ["receipt"] },
      updatedAt: "2026-07-18T00:00:00.000Z"
    };
    const rerunRule = { ...updatedRule, matchedMessages: 7 };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue(folders),
      listSmartMailRules: vi.fn().mockResolvedValueOnce([rule]).mockResolvedValue([rerunRule]),
      updateSmartMailRule: vi.fn().mockResolvedValue(updatedRule),
      startSmartMailRuleRun: vi.fn().mockResolvedValue(smartRuleTask({
        archiveId: archive.id,
        ruleIds: [rule.id],
        totalRules: 1,
        totalMessages: 12,
        scope: "all"
      })),
      mailboxTask: vi.fn().mockResolvedValue(smartRuleTask({
        archiveId: archive.id,
        ruleIds: [rule.id],
        status: "completed",
        totalRules: 1,
        completedRules: 1,
        totalMessages: 12,
        processedMessages: 12,
        matchedMessages: 3,
        movedMessages: 2,
        markedReadMessages: 1,
        scope: "all"
      }))
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Smart rules" }));
    await waitFor(() => expect(screen.getByText("Invoice filing")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Rule name" }), { target: { value: "Receipt filing" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Instruction" }), { target: { value: "Move receipt email to Finance." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Subject contains" }), { target: { value: "receipt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.updateSmartMailRule).toHaveBeenNthCalledWith(1, rule.id, {
      name: "Receipt filing",
      instruction: "Move receipt email to Finance.",
      conditions: { ...rule.conditions, subjectContains: ["receipt"] },
      targetFolderId: folders[1]!.id,
      markRead: false,
      star: false,
      enabled: true
    }));
    expect(await screen.findByText('Smart rule "Receipt filing" updated.')).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run all folders" }));
    await waitFor(() => expect(api.startSmartMailRuleRun).toHaveBeenCalledWith(archive.id, [rule.id], "all"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("including Sent, Spam, Trash"));
    expect(await screen.findByText(/3 matched and 2 moved/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("shows cumulative progress while running all enabled smart rules", async () => {
    const archive: Archive = {
      id: "archive-bulk-rules",
      name: "Gmail",
      sourceType: "gmail",
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
    const inbox: Folder = { id: "folder-bulk-inbox", archiveId: archive.id, parentId: null, name: "Inbox", path: "Inbox", messageCount: 10, unreadCount: 2 };
    const baseRule: SmartMailRule = {
      id: "rule-one",
      archiveId: archive.id,
      archiveName: archive.name,
      name: "First rule",
      instruction: "Move matching messages.",
      conditions: { match: "any", senderContains: ["first.test"], subjectContains: [], bodyContains: [], hasAttachments: null },
      targetFolderId: inbox.id,
      targetFolderPath: inbox.path,
      markRead: false,
      star: false,
      enabled: true,
      matchedMessages: 0,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z"
    };
    const secondRule: SmartMailRule = { ...baseRule, id: "rule-two", name: "Second rule", conditions: { ...baseRule.conditions, senderContains: ["second.test"] } };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue([inbox]),
      listSmartMailRules: vi.fn().mockResolvedValue([baseRule, secondRule]),
      startSmartMailRuleRun: vi.fn().mockResolvedValue(smartRuleTask({
        archiveId: archive.id,
        ruleIds: [baseRule.id, secondRule.id],
        totalRules: 2,
        totalMessages: 18,
        scope: "all"
      })),
      mailboxTask: vi.fn().mockResolvedValue(smartRuleTask({
        archiveId: archive.id,
        ruleIds: [baseRule.id, secondRule.id],
        status: "completed",
        totalRules: 2,
        completedRules: 2,
        totalMessages: 18,
        processedMessages: 18,
        matchedMessages: 3,
        movedMessages: 3,
        scope: "all"
      }))
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Smart rules" }));
    await waitFor(() => expect(screen.getByText("First rule")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Run all rules in all folders" }));

    await waitFor(() => expect(api.startSmartMailRuleRun).toHaveBeenCalledWith(archive.id, [baseRule.id, secondRule.id], "all"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Run all 2 enabled smart rules"));
    const progress = screen.getByLabelText("Smart rule run progress");
    expect(progress.textContent).toContain("Completed 2 rules");
    expect(progress.textContent).toContain("18 of 18 checked");
    expect(progress.textContent).toContain("3 matched");
    expect(progress.textContent).toContain("3 moved");
    confirm.mockRestore();
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
    const settingsWithInsecureGoogleCallback: AdminSettings = {
      ...SETTINGS,
      gmail: {
        ...SETTINGS.gmail,
        oauthCallbackUrl: "http://synology.local:3001/api/gmail/oauth/callback"
      }
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(settingsWithInsecureGoogleCallback),
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
    expect((screen.getByRole("option", { name: /Microsoft SQL Server.*adapter not installed/ }) as HTMLOptionElement).disabled).toBe(true);
    expect(screen.getByText(/content-addressed blob directory/)).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
    expect(screen.getByText(/Gmail authorization cannot start/)).toBeTruthy();
    expect(screen.getByText((_, element) =>
      element?.classList.contains("settings-warning") === true
      && element.textContent?.includes("Google will reject") === true
      && element.textContent.includes("http://synology.local:3001/api/gmail/oauth/callback")
    )).toBeTruthy();

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

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Gmail" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
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

  it("loads Google Web OAuth credentials for a server deployment", async () => {
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listGmailConnections: vi.fn().mockResolvedValue([]),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listAiSchedules: vi.fn().mockResolvedValue([]),
      listResumes: vi.fn().mockResolvedValue([])
    } as unknown as ApiClient;
    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Gmail" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
    const file = new File(["{}"], "web-oauth.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: vi.fn().mockResolvedValue(JSON.stringify({
        web: {
          client_id: "web.apps.googleusercontent.com",
          client_secret: "web-secret"
        }
      }))
    });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByDisplayValue("web.apps.googleusercontent.com")).toBeTruthy());
    expect(screen.getByDisplayValue("web-secret")).toBeTruthy();
  });

  it("offers Google authorization controls and enables Gmail mailbox action sync", async () => {
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
    const onAddGoogle = vi.fn();
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
        onAddGoogleCalendar={onAddGoogle}
        onReauthorizeGoogleCalendar={onReauthorize}
      />
    );

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Gmail" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Authorize new Google account" }));
    expect(onAddGoogle).toHaveBeenCalledOnce();
    const reauthorize = await screen.findByRole("button", { name: "Reauthorize" });
    fireEvent.click(reauthorize);
    expect(onReauthorize).toHaveBeenCalledWith(connection);
    const toggle = await screen.findByRole("checkbox", { name: /Mirror mailbox actions to Gmail/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Save Gmail configuration/ }));
    await waitFor(() => expect(api.updateGmailSettings).toHaveBeenCalledWith({
      clientId: "desktop.apps.googleusercontent.com",
      clearClientSecret: false,
      syncIntervalMinutes: 5,
      syncMailboxActions: true
    }));
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

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Gmail" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pull all email" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Pull all email" }));

    await waitFor(() => expect(api.syncGmail).toHaveBeenCalledWith("gmail-1", { full: true }));
    expect(screen.getByText(/25 of 100 checked · 10 new · 25%/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("starts a safe Gmail mailbox reconciliation from the admin panel", async () => {
    const settings: AdminSettings = {
      ...SETTINGS,
      gmail: { ...SETTINGS.gmail, syncMailboxActions: true }
    };
    const connection: GmailConnection = {
      id: "gmail-reconcile",
      email: "owner@example.test",
      archiveId: "archive-1",
      archiveName: "Gmail",
      folderId: "folder-1",
      folderPath: "Gmail",
      query: "",
      ocrEnabled: false,
      canSend: true,
      canModifyMailbox: true,
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
    const syncing = { ...connection, status: "syncing" as const };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(settings),
      listGmailConnections: vi.fn().mockResolvedValue([connection]),
      reconcileGmailMailbox: vi.fn().mockResolvedValue(syncing),
      listUsers: vi.fn().mockResolvedValue(USERS)
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Gmail" })[0]).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "Gmail" })[0]!);
    const reconcile = await screen.findByRole("button", { name: "Reconcile Gmail" });
    fireEvent.click(reconcile);

    await waitFor(() => expect(api.reconcileGmailMailbox).toHaveBeenCalledWith("gmail-reconcile"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("nothing is permanently deleted"));
    expect(screen.getByText(/mailbox state · 0%/)).toBeTruthy();
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
        matchField: "from",
        matchAddress: "vendor@example.test",
        senderAddress: "vendor@example.test",
        senderName: "Vendor Co",
        ruleType: "folder",
        sourceScope: "inbox",
        sourceFolderId: null,
        sourceFolderPath: null,
        folderId: "folder-1",
        folderPath: "Top Senders/Vendor Co",
        messageCount: 42,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z"
      }]
    };
    const folders: Folder[] = [{
      id: "folder-1",
      archiveId: archive.id,
      parentId: null,
      name: "Vendor Co",
      path: "Top Senders/Vendor Co",
      messageCount: 42,
      unreadCount: 0
    }, {
      id: "folder-2",
      archiveId: archive.id,
      parentId: null,
      name: "Vendors",
      path: "Vendors",
      messageCount: 0,
      unreadCount: 0
    }];
    const updatedStatus: SenderFilingStatus = {
      ...organizedStatus,
      rules: [{
        ...organizedStatus.rules[0]!,
        folderId: "folder-2",
        folderPath: "Vendors"
      }]
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue(folders),
      senderFilingStatus: vi.fn().mockResolvedValue(initialStatus),
      organizeTopSenders: vi.fn().mockResolvedValue(organizedStatus),
      updateSenderFilingRuleFolder: vi.fn().mockResolvedValue(updatedStatus)
    } as unknown as ApiClient;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sender rules" }));
    await waitFor(() => expect(api.senderFilingStatus).toHaveBeenCalledWith(archive.id));
    expect(screen.getByText(/do not change Gmail labels/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Organize top 20" }));

    await waitFor(() => expect(api.organizeTopSenders).toHaveBeenCalledWith(archive.id));
    expect(await screen.findByText(/From: Vendor Co/)).toBeTruthy();
    const folderSelect = screen.getByRole("combobox", { name: "Folder for Vendor Co" });
    expect((folderSelect as HTMLSelectElement).value).toBe("folder-1");
    expect(screen.getByText(/Moved 42 messages/)).toBeTruthy();

    fireEvent.change(folderSelect, { target: { value: "folder-2" } });
    await waitFor(() => expect(api.updateSenderFilingRuleFolder).toHaveBeenCalledWith("rule-1", "folder-2"));
    expect((screen.getByRole("combobox", { name: "Folder for Vendor Co" }) as HTMLSelectElement).value).toBe("folder-2");
    expect(await screen.findByText(/Sender rule updated/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("creates consecutive scoped sender rules without reloading the panel", async () => {
    const archive: Archive = {
      id: "b8f3f5a5-bc88-4ac9-97e6-e1bd4c2db702",
      name: "Primary Gmail",
      sourceType: "gmail",
      status: "ready",
      sizeBytes: 0,
      messageCount: 120,
      unreadCount: 4,
      folderCount: 2,
      attachmentCount: 0,
      errorCount: 0,
      importedAt: "2026-07-15T00:00:00.000Z",
      createdAt: "2026-07-15T00:00:00.000Z"
    };
    const inbox: Folder = {
      id: "folder-inbox",
      archiveId: archive.id,
      parentId: null,
      name: "Inbox",
      path: "Inbox",
      messageCount: 120,
      unreadCount: 4
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
    const createdStatus: SenderFilingStatus = {
      ...initialStatus,
      enabled: true,
      rules: [{
        id: "rule-to-owner",
        archiveId: archive.id,
        matchField: "to",
        matchAddress: "owner@example.test",
        senderAddress: "owner@example.test",
        senderName: null,
        ruleType: "folder",
        sourceScope: "all",
        sourceFolderId: null,
        sourceFolderPath: null,
        folderId: "folder-owner",
        folderPath: "For Owner",
        messageCount: 17,
        createdAt: "2026-07-15T12:00:00.000Z",
        updatedAt: "2026-07-15T12:00:00.000Z"
      }],
      lastRunAt: "2026-07-15T12:00:00.000Z",
      lastRunMovedMessages: 17,
      lastRunCreatedFolders: 1
    };
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
      listArchives: vi.fn().mockResolvedValue([archive]),
      listFolders: vi.fn().mockResolvedValue([inbox]),
      senderFilingStatus: vi.fn().mockResolvedValue(initialStatus),
      createSenderFilingRule: vi.fn().mockResolvedValue({
        statuses: [createdStatus],
        createdRules: 1,
        createdFolders: 1,
        movedMessages: 17
      })
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sender rules" }));
    await waitFor(() => expect(api.senderFilingStatus).toHaveBeenCalledWith(archive.id));

    fireEvent.change(screen.getByLabelText("Archives to apply"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Match field"), { target: { value: "to" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "OWNER@example.test" } });
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "For Owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and add another" }));

    await waitFor(() => expect(api.createSenderFilingRule).toHaveBeenCalledWith({
      archiveId: archive.id,
      archiveScope: "all",
      matchField: "to",
      matchAddress: "owner@example.test",
      sourceScope: "all",
      sourceFolderId: null,
      destinationFolderId: null,
      destinationFolderName: "For Owner",
      applyExisting: true
    }));
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "Save and add another" })).toBeTruthy();
    expect(await screen.findByText(/To: owner@example.test/)).toBeTruthy();
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

  it("uses screen-level section navigation for mobile settings", async () => {
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS)
    } as unknown as ApiClient;

    render(<SettingsDialog open api={api} session={SESSION} onClose={vi.fn()} onSignedOut={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Database" })).toBeTruthy());

    const dialog = screen.getByRole("dialog", { name: "Admin settings" });
    expect(dialog.className).toContain("mobile-settings-menu-open");
    fireEvent.click(screen.getByRole("button", { name: "Drafts" }));
    expect(dialog.className).not.toContain("mobile-settings-menu-open");
    expect(screen.getByRole("heading", { name: "Drafts" })).toBeTruthy();

    fireEvent.click(dialog.querySelector(".settings-mobile-section-trigger")!);
    expect(dialog.className).toContain("mobile-settings-menu-open");
  });
});

function smartRuleTask(overrides: Partial<SmartMailRuleRunTask> = {}): SmartMailRuleRunTask {
  return {
    id: "smart-rule-task-1",
    type: "smart_rule_run",
    status: "queued",
    archiveId: "archive-1",
    scope: "inbox",
    ruleIds: [],
    totalRules: 0,
    completedRules: 0,
    currentRuleId: null,
    currentRuleName: null,
    totalMessages: 0,
    processedMessages: 0,
    matchedMessages: 0,
    movedMessages: 0,
    markedReadMessages: 0,
    starredMessages: 0,
    cancelRequested: false,
    error: null,
    createdAt: "2026-07-18T12:00:00.000Z",
    startedAt: null,
    completedAt: null,
    ...overrides
  };
}

const USERS: UserSummary[] = [{
  id: "user-1",
  username: "admin",
  displayName: "Administrator",
  role: "admin",
  isActive: true,
  mustChangePin: true,
  allowedScreens: null,
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

const USER_SESSION: AuthSessionInfo = {
  id: "session-user",
  user: {
    id: "user-private",
    username: "casey",
    displayName: "Casey",
    role: "user",
    isActive: true,
    mustChangePin: false,
    allowedScreens: null,
    lastLoginAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  },
  role: "user",
  expiresAt: "2026-07-13T12:00:00.000Z"
};

const RENTER_SESSION: AuthSessionInfo = {
  id: "session-renter",
  user: {
    id: "renter-private",
    username: "taylor",
    displayName: "Taylor Tenant",
    role: "renter",
    isActive: true,
    mustChangePin: false,
    allowedScreens: ["properties"],
    lastLoginAt: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z"
  },
  role: "renter",
  expiresAt: "2026-07-13T12:00:00.000Z"
};

const SETTINGS: AdminSettings = {
  database: {
    activeProvider: "postgresql",
    activeConnectionString: "Host=postgres;Database=archive_mail;Username=archive_mail;Password=********",
    configuredProvider: "postgresql",
    configuredConnectionString: "Host=postgres;Database=archive_mail;Username=archive_mail;Password=********",
    restartRequired: false,
    providers: [
      { id: "postgresql", label: "PostgreSQL", available: true, description: "PostgreSQL runtime adapter." },
      { id: "mssql", label: "Microsoft SQL Server", available: false, description: "Requires a SQL Server data and full-text search adapter." }
    ],
    structuredDataPath: "PostgreSQL",
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
    concurrency: 2,
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
