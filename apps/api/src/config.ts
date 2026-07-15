import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ApiConfig {
  dataDir: string;
  host: string;
  port: number;
  staticDir?: string;
  devAuthBypass: boolean;
  sessionLifetimeMinutes: number;
  logger: boolean;
  gmailClientId: string | null;
  gmailClientSecret: string | null;
  openAiApiKey: string | null;
}

export function loadConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    dataDir: overrides.dataDir ?? process.env.EMAIL_CLIENT_DATA_DIR ?? resolve(homedir(), ".archive-mail"),
    host: overrides.host ?? process.env.EMAIL_CLIENT_HOST ?? "127.0.0.1",
    port: overrides.port ?? Number(process.env.EMAIL_CLIENT_PORT ?? 3001),
    staticDir: overrides.staticDir ?? process.env.EMAIL_CLIENT_WEB_DIR,
    devAuthBypass: overrides.devAuthBypass ?? process.env.EMAIL_CLIENT_DEV_AUTH_BYPASS === "1",
    sessionLifetimeMinutes: overrides.sessionLifetimeMinutes
      ?? Math.max(15, Number(process.env.EMAIL_CLIENT_SESSION_MINUTES ?? 720)),
    logger: overrides.logger ?? process.env.NODE_ENV !== "test",
    gmailClientId: overrides.gmailClientId !== undefined
      ? overrides.gmailClientId
      : process.env.GMAIL_CLIENT_ID ?? null,
    gmailClientSecret: overrides.gmailClientSecret !== undefined
      ? overrides.gmailClientSecret
      : process.env.GMAIL_CLIENT_SECRET ?? null,
    openAiApiKey: overrides.openAiApiKey !== undefined
      ? overrides.openAiApiKey
      : process.env.OPENAI_API_KEY ?? null
  };
}
