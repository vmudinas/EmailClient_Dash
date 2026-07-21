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
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  paypalClientId: string | null;
  paypalClientSecret: string | null;
  paypalWebhookId: string | null;
  paypalEnvironment: "sandbox" | "live";
  zelleRecipient: string | null;
  zelleNote: string;
  twilioAccountSid: string | null;
  twilioAuthToken: string | null;
  twilioMessagingServiceSid: string | null;
  propertyGmailConnectionId: string | null;
  propertyAutomationIntervalMinutes: number;
  propertyBackupRetention: number;
  importConcurrency: number;
  importBatchSize: number;
  importThrottleMs: number;
  importLatencyThresholdMs: number;
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
      : process.env.DEEPSEEK_API_KEY ?? null,
    stripeSecretKey: overrides.stripeSecretKey !== undefined
      ? overrides.stripeSecretKey
      : process.env.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: overrides.stripeWebhookSecret !== undefined
      ? overrides.stripeWebhookSecret
      : process.env.STRIPE_WEBHOOK_SECRET ?? null,
    paypalClientId: overrides.paypalClientId !== undefined
      ? overrides.paypalClientId
      : process.env.PAYPAL_CLIENT_ID ?? null,
    paypalClientSecret: overrides.paypalClientSecret !== undefined
      ? overrides.paypalClientSecret
      : process.env.PAYPAL_CLIENT_SECRET ?? null,
    paypalWebhookId: overrides.paypalWebhookId !== undefined
      ? overrides.paypalWebhookId
      : process.env.PAYPAL_WEBHOOK_ID ?? null,
    paypalEnvironment: overrides.paypalEnvironment
      ?? (process.env.PAYPAL_ENVIRONMENT?.trim().toLowerCase() === "live" ? "live" : "sandbox"),
    zelleRecipient: overrides.zelleRecipient !== undefined
      ? overrides.zelleRecipient
      : process.env.ZELLE_RECIPIENT ?? null,
    zelleNote: overrides.zelleNote
      ?? process.env.ZELLE_PAYMENT_NOTE
      ?? "Include the property address and payment reference in the Zelle memo.",
    twilioAccountSid: overrides.twilioAccountSid !== undefined
      ? overrides.twilioAccountSid
      : process.env.TWILIO_ACCOUNT_SID ?? null,
    twilioAuthToken: overrides.twilioAuthToken !== undefined
      ? overrides.twilioAuthToken
      : process.env.TWILIO_AUTH_TOKEN ?? null,
    twilioMessagingServiceSid: overrides.twilioMessagingServiceSid !== undefined
      ? overrides.twilioMessagingServiceSid
      : process.env.TWILIO_MESSAGING_SERVICE_SID ?? null,
    propertyGmailConnectionId: overrides.propertyGmailConnectionId !== undefined
      ? overrides.propertyGmailConnectionId
      : process.env.PROPERTY_GMAIL_CONNECTION_ID ?? null,
    propertyAutomationIntervalMinutes: overrides.propertyAutomationIntervalMinutes
      ?? Math.max(1, Number(process.env.PROPERTY_AUTOMATION_INTERVAL_MINUTES ?? 5)),
    propertyBackupRetention: overrides.propertyBackupRetention
      ?? Math.max(1, Number(process.env.PROPERTY_BACKUP_RETENTION ?? 7)),
    importConcurrency: overrides.importConcurrency
      ?? boundedInteger(process.env.EMAIL_IMPORT_CONCURRENCY, 1, 1, 4),
    importBatchSize: overrides.importBatchSize
      ?? boundedInteger(process.env.EMAIL_IMPORT_BATCH_SIZE, 50, 10, 500),
    importThrottleMs: overrides.importThrottleMs
      ?? boundedInteger(process.env.EMAIL_IMPORT_THROTTLE_MS, 5, 0, 1_000),
    importLatencyThresholdMs: overrides.importLatencyThresholdMs
      ?? boundedInteger(process.env.EMAIL_IMPORT_LATENCY_THRESHOLD_MS, 250, 25, 10_000)
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

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}
