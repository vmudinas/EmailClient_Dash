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

export interface GmailOAuthCredentials {
  clientId: string | null;
  clientSecret: string | null;
}

export class GmailSettingsManager {
  readonly settingsPath: string;
  private persisted: GmailOAuthCredentials = { clientId: null, clientSecret: null };
  private readError: string | null = null;

  constructor(
    dataDir: string,
    private readonly environment: GmailOAuthCredentials
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    if (!environment.clientId) this.persisted = this.read();
  }

  credentials(): GmailOAuthCredentials {
    const source = this.environment.clientId ? this.environment : this.persisted;
    return { ...source };
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
      configurationError: this.readError
    };
  }

  update(input: GmailSettingsPatch): GmailOAuthCredentials {
    this.requireAdminManaged();
    const clientId = input.clientId.trim();
    const sameClient = clientId === this.persisted.clientId;
    const clientSecret = input.clearClientSecret
      ? null
      : input.clientSecret?.trim() || (sameClient ? this.persisted.clientSecret : null);
    const next = { clientId, clientSecret };

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
    this.persisted = { clientId: null, clientSecret: null };
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

  private read(): GmailOAuthCredentials {
    if (!existsSync(this.settingsPath)) return { clientId: null, clientSecret: null };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      const credentials = parseCredentials(parsed);
      chmodSync(this.settingsPath, 0o600);
      return credentials;
    } catch (error) {
      this.readError = `Saved Gmail OAuth settings could not be loaded: ${errorMessage(error)}`;
      return { clientId: null, clientSecret: null };
    }
  }
}

export class GmailSettingsManagedError extends Error {}

function parseCredentials(value: unknown): GmailOAuthCredentials {
  if (!value || typeof value !== "object") throw new Error("the file is not a JSON object");
  const root = value as Record<string, unknown>;
  const installed = root.installed && typeof root.installed === "object"
    ? root.installed as Record<string, unknown>
    : null;
  const clientId = stringValue(root.clientId)
    ?? stringValue(root.client_id)
    ?? stringValue(installed?.client_id);
  const clientSecret = stringValue(root.clientSecret)
    ?? stringValue(root.client_secret)
    ?? stringValue(installed?.client_secret);
  if (!clientId) throw new Error("client_id is missing");
  return { clientId, clientSecret };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
