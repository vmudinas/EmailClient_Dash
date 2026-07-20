import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ApiConfig {
  dataDir: string;
  host: string;
  port: number;
  publicUrl: string | null;
  trustProxy: boolean;
  staticDir?: string;
  devAuthBypass: boolean;
  allowRemoteLogin: boolean;
  sessionLifetimeMinutes: number;
  logger: boolean;
  gmailClientId: string | null;
  gmailClientSecret: string | null;
  gmailSyncIntervalMinutes: number | null;
  gmailSyncMailboxActions: boolean | null;
  openAiApiKey: string | null;
  deepSeekApiKey: string | null;
}

export function loadConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    dataDir: overrides.dataDir ?? process.env.EMAIL_CLIENT_DATA_DIR ?? resolve(homedir(), ".archive-mail"),
    host: overrides.host ?? process.env.EMAIL_CLIENT_HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.EMAIL_CLIENT_PORT ?? 3001),
    publicUrl: normalizePublicUrl(overrides.publicUrl !== undefined
      ? overrides.publicUrl
      : process.env.EMAIL_CLIENT_PUBLIC_URL),
    trustProxy: overrides.trustProxy
      ?? parseOptionalBoolean(process.env.EMAIL_CLIENT_TRUST_PROXY)
      ?? false,
    staticDir: overrides.staticDir ?? process.env.EMAIL_CLIENT_WEB_DIR,
    devAuthBypass: overrides.devAuthBypass ?? process.env.EMAIL_CLIENT_DEV_AUTH_BYPASS === "1",
    allowRemoteLogin: overrides.allowRemoteLogin
      ?? parseOptionalBoolean(process.env.EMAIL_CLIENT_ALLOW_REMOTE_LOGIN)
      ?? false,
    sessionLifetimeMinutes: overrides.sessionLifetimeMinutes
      ?? Math.max(15, Number(process.env.EMAIL_CLIENT_SESSION_MINUTES ?? 720)),
    logger: overrides.logger ?? process.env.NODE_ENV !== "test",
    gmailClientId: overrides.gmailClientId !== undefined
      ? overrides.gmailClientId
      : process.env.GMAIL_CLIENT_ID ?? null,
    gmailClientSecret: overrides.gmailClientSecret !== undefined
      ? overrides.gmailClientSecret
      : process.env.GMAIL_CLIENT_SECRET ?? null,
    gmailSyncIntervalMinutes: overrides.gmailSyncIntervalMinutes !== undefined
      ? overrides.gmailSyncIntervalMinutes
      : parseOptionalInt(process.env.GMAIL_SYNC_INTERVAL_MINUTES),
    gmailSyncMailboxActions: overrides.gmailSyncMailboxActions !== undefined
      ? overrides.gmailSyncMailboxActions
      : parseOptionalBoolean(process.env.GMAIL_SYNC_MAILBOX_ACTIONS),
    openAiApiKey: overrides.openAiApiKey !== undefined
      ? overrides.openAiApiKey
      : process.env.OPENAI_API_KEY ?? null,
    deepSeekApiKey: overrides.deepSeekApiKey !== undefined
      ? overrides.deepSeekApiKey
      : process.env.DEEPSEEK_API_KEY ?? null
  };
}

function normalizePublicUrl(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("EMAIL_CLIENT_PUBLIC_URL must use http:// or https://");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("EMAIL_CLIENT_PUBLIC_URL must be an origin without credentials, a path, query, or hash");
  }
  return url.origin;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function parseOptionalBoolean(value: string | undefined): boolean | null {
  if (value === undefined || value.trim() === "") return null;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
