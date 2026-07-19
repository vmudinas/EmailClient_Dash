import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { AdminSettings, GmailSettingsPatch } from "@email-client/shared";

const SETTINGS_FILENAME = "gmail-oauth-settings.json";
const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

export interface GmailOAuthCredentials {
  clientId: string | null;
  clientSecret: string | null;
}

export interface GmailSettingsEnvironment extends GmailOAuthCredentials {
  syncIntervalMinutes: number | null;
  syncMailboxActions?: boolean | null;
}

interface PersistedGmailSettings extends GmailOAuthCredentials {
  syncIntervalMinutes: number;
  syncMailboxActions: boolean;
}

export class GmailSettingsManager {
  readonly settingsPath: string;
  private persisted: PersistedGmailSettings = {
    clientId: null,
    clientSecret: null,
    syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
    syncMailboxActions: false
  };
  private readError: string | null = null;

  constructor(
    dataDir: string,
    private readonly environment: GmailSettingsEnvironment
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    if (!environment.clientId) this.persisted = this.read();
  }

  credentials(): GmailOAuthCredentials {
    const source = this.environment.clientId ? this.environment : this.persisted;
    return { clientId: source.clientId, clientSecret: source.clientSecret };
  }

  syncIntervalMinutes(): number {
    return this.environment.syncIntervalMinutes ?? this.persisted.syncIntervalMinutes;
  }

  syncMailboxActions(): boolean {
    return this.environment.syncMailboxActions ?? this.persisted.syncMailboxActions;
  }

  view(): AdminSettings["gmail"] {
    const credentials = this.credentials();
    const source = this.environment.clientId
      ? "environment"
      : credentials.clientId
        ? "admin"
        : "none";
    return {
      configured: Boolean(credentials.clientId),
      clientId: credentials.clientId ?? "",
      clientSecretConfigured: Boolean(credentials.clientSecret),
      source,
      settingsPath: this.settingsPath,
      configurationError: this.readError,
      syncIntervalMinutes: this.syncIntervalMinutes(),
      syncIntervalEnvManaged: this.environment.syncIntervalMinutes !== null,
      syncMailboxActions: this.syncMailboxActions(),
      syncMailboxActionsEnvManaged: this.environment.syncMailboxActions !== null
        && this.environment.syncMailboxActions !== undefined
    };
  }

  update(input: GmailSettingsPatch): GmailOAuthCredentials {
    this.requireAdminManaged();
    const clientId = input.clientId.trim();
    const sameClient = clientId === this.persisted.clientId;
    const clientSecret = input.clearClientSecret
      ? null
      : input.clientSecret?.trim() || (sameClient ? this.persisted.clientSecret : null);
    const syncIntervalMinutes = this.environment.syncIntervalMinutes
      ?? input.syncIntervalMinutes
      ?? this.persisted.syncIntervalMinutes;
    const syncMailboxActions = this.environment.syncMailboxActions
      ?? input.syncMailboxActions
      ?? this.persisted.syncMailboxActions;
    const next: PersistedGmailSettings = { clientId, clientSecret, syncIntervalMinutes, syncMailboxActions };

    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = next;
    this.readError = null;
    return this.credentials();
  }

  clear(): GmailOAuthCredentials {
    this.requireAdminManaged();
    rmSync(this.settingsPath, { force: true });
    this.persisted = {
      clientId: null,
      clientSecret: null,
      syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
      syncMailboxActions: false
    };
    this.readError = null;
    return this.credentials();
  }

  private requireAdminManaged(): void {
    if (this.environment.clientId) {
      throw new GmailSettingsManagedError(
        "Gmail OAuth is managed by GMAIL_CLIENT_ID environment settings. Remove those environment values and restart Archive Mail before editing it here."
      );
    }
  }

  private read(): PersistedGmailSettings {
    if (!existsSync(this.settingsPath)) {
      return {
        clientId: null,
        clientSecret: null,
        syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
        syncMailboxActions: false
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      const credentials = parseCredentials(parsed);
      chmodSync(this.settingsPath, 0o600);
      return credentials;
    } catch (error) {
      this.readError = `Saved Gmail OAuth settings could not be loaded: ${errorMessage(error)}`;
      return {
        clientId: null,
        clientSecret: null,
        syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
        syncMailboxActions: false
      };
    }
  }
}

export class GmailSettingsManagedError extends Error {}

function parseCredentials(value: unknown): PersistedGmailSettings {
  if (!value || typeof value !== "object") throw new Error("the file is not a JSON object");
  const root = value as Record<string, unknown>;
  const installed = root.installed && typeof root.installed === "object"
    ? root.installed as Record<string, unknown>
    : null;
  const web = root.web && typeof root.web === "object"
    ? root.web as Record<string, unknown>
    : null;
  const clientId = stringValue(root.clientId)
    ?? stringValue(root.client_id)
    ?? stringValue(installed?.client_id)
    ?? stringValue(web?.client_id);
  const clientSecret = stringValue(root.clientSecret)
    ?? stringValue(root.client_secret)
    ?? stringValue(installed?.client_secret)
    ?? stringValue(web?.client_secret);
  if (!clientId) throw new Error("client_id is missing");
  const syncIntervalMinutes = Number.isInteger(root.syncIntervalMinutes) && Number(root.syncIntervalMinutes) >= 0
    ? Number(root.syncIntervalMinutes)
    : DEFAULT_SYNC_INTERVAL_MINUTES;
  const syncMailboxActions = typeof root.syncMailboxActions === "boolean"
    ? root.syncMailboxActions
    : false;
  return { clientId, clientSecret, syncIntervalMinutes, syncMailboxActions };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
