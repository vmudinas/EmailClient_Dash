import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminSettings, AuthSessionInfo, UserSummary } from "@email-client/shared";
import type { ApiClient } from "../lib/api.js";
import { SettingsDialog } from "./SettingsDialog.js";

afterEach(cleanup);

describe("SettingsDialog", () => {
  it("shows database, Gmail, AI, users, security, and IP audit settings", async () => {
    const api = {
      adminSettings: vi.fn().mockResolvedValue(SETTINGS),
      listUsers: vi.fn().mockResolvedValue(USERS),
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
    expect(screen.getByText(/ChatGPT subscription does not provide API billing/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    expect(screen.getByText("Administrator")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText(/first-run administrator PIN is still active/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Audit" }));
    await waitFor(() => expect(screen.getByText("127.0.0.1")).toBeTruthy());
    expect(screen.getByText("GET /api/messages/:messageId")).toBeTruthy();
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
      listUsers: vi.fn().mockResolvedValue(USERS),
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
      clearClientSecret: false
    }));
    expect(screen.queryByDisplayValue("desktop-secret")).toBeNull();
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
    configurationError: null
  },
  ai: {
    configured: false,
    enabled: false,
    apiKeyConfigured: false,
    source: "none",
    model: "gpt-5.6-luna",
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
    }
  }
};
