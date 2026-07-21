import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  PropertyIntegrationSettings,
  PropertyIntegrationSettingsPatch
} from "@email-client/shared";

const SETTINGS_FILENAME = "property-integrations.json";

export interface PropertyIntegrationRuntimeSettings {
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
  gmailConnectionId: string | null;
}

type PersistedSettings = Omit<PropertyIntegrationRuntimeSettings, "paypalEnvironment" | "zelleNote"> & {
  paypalEnvironment: "sandbox" | "live" | null;
  zelleNote: string | null;
};

const DEFAULT_SETTINGS: PersistedSettings = {
  stripeSecretKey: null,
  stripeWebhookSecret: null,
  paypalClientId: null,
  paypalClientSecret: null,
  paypalWebhookId: null,
  paypalEnvironment: null,
  zelleRecipient: null,
  zelleNote: null,
  twilioAccountSid: null,
  twilioAuthToken: null,
  twilioMessagingServiceSid: null,
  gmailConnectionId: null
};

export class PropertyIntegrationSettingsManager {
  readonly settingsPath: string;
  private persisted: PersistedSettings = { ...DEFAULT_SETTINGS };

  constructor(
    dataDir: string,
    private readonly environment: Partial<PropertyIntegrationRuntimeSettings> = {}
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  current(): PropertyIntegrationRuntimeSettings {
    return {
      stripeSecretKey: this.persisted.stripeSecretKey || this.environment.stripeSecretKey || null,
      stripeWebhookSecret: this.persisted.stripeWebhookSecret || this.environment.stripeWebhookSecret || null,
      paypalClientId: this.persisted.paypalClientId || this.environment.paypalClientId || null,
      paypalClientSecret: this.persisted.paypalClientSecret || this.environment.paypalClientSecret || null,
      paypalWebhookId: this.persisted.paypalWebhookId || this.environment.paypalWebhookId || null,
      paypalEnvironment: this.persisted.paypalEnvironment ?? this.environment.paypalEnvironment ?? "sandbox",
      zelleRecipient: this.persisted.zelleRecipient || this.environment.zelleRecipient || null,
      zelleNote: this.persisted.zelleNote
        ?? this.environment.zelleNote
        ?? "Include the property address and payment reference in the memo.",
      twilioAccountSid: this.persisted.twilioAccountSid || this.environment.twilioAccountSid || null,
      twilioAuthToken: this.persisted.twilioAuthToken || this.environment.twilioAuthToken || null,
      twilioMessagingServiceSid: this.persisted.twilioMessagingServiceSid
        || this.environment.twilioMessagingServiceSid
        || null,
      gmailConnectionId: this.persisted.gmailConnectionId || this.environment.gmailConnectionId || null
    };
  }

  view(): PropertyIntegrationSettings {
    const current = this.current();
    return {
      stripeConfigured: Boolean(current.stripeSecretKey),
      stripeSource: source(this.persisted.stripeSecretKey, this.environment.stripeSecretKey),
      stripeWebhookConfigured: Boolean(current.stripeWebhookSecret),
      paypalConfigured: Boolean(current.paypalClientId && current.paypalClientSecret),
      paypalSource: source(
        this.persisted.paypalClientId && this.persisted.paypalClientSecret,
        this.environment.paypalClientId && this.environment.paypalClientSecret
      ),
      paypalEnvironment: current.paypalEnvironment,
      paypalWebhookConfigured: Boolean(current.paypalWebhookId),
      zelleRecipient: current.zelleRecipient,
      twilioConfigured: Boolean(
        current.twilioAccountSid && current.twilioAuthToken && current.twilioMessagingServiceSid
      ),
      twilioSource: source(
        this.persisted.twilioAccountSid && this.persisted.twilioAuthToken && this.persisted.twilioMessagingServiceSid,
        this.environment.twilioAccountSid
          && this.environment.twilioAuthToken
          && this.environment.twilioMessagingServiceSid
      ),
      gmailConnectionId: current.gmailConnectionId
    };
  }

  update(input: PropertyIntegrationSettingsPatch): PropertyIntegrationSettings {
    const next = { ...this.persisted };
    if (input.clearStripeSecretKey) next.stripeSecretKey = null;
    else if (input.stripeSecretKey) next.stripeSecretKey = input.stripeSecretKey;
    if (input.clearStripeWebhookSecret) next.stripeWebhookSecret = null;
    else if (input.stripeWebhookSecret) next.stripeWebhookSecret = input.stripeWebhookSecret;
    if (input.paypalClientId) next.paypalClientId = input.paypalClientId;
    if (input.clearPaypalClientSecret) next.paypalClientSecret = null;
    else if (input.paypalClientSecret) next.paypalClientSecret = input.paypalClientSecret;
    if (input.paypalWebhookId) next.paypalWebhookId = input.paypalWebhookId;
    if (input.paypalEnvironment) next.paypalEnvironment = input.paypalEnvironment;
    if (input.zelleRecipient !== undefined) next.zelleRecipient = input.zelleRecipient;
    if (input.zelleNote !== undefined) next.zelleNote = input.zelleNote;
    if (input.twilioAccountSid) next.twilioAccountSid = input.twilioAccountSid;
    if (input.clearTwilioAuthToken) next.twilioAuthToken = null;
    else if (input.twilioAuthToken) next.twilioAuthToken = input.twilioAuthToken;
    if (input.twilioMessagingServiceSid) next.twilioMessagingServiceSid = input.twilioMessagingServiceSid;
    if (input.gmailConnectionId !== undefined) next.gmailConnectionId = input.gmailConnectionId;
    this.write(next);
    return this.view();
  }

  private write(settings: PersistedSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = settings;
  }

  private read(): PersistedSettings {
    if (!existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
    try {
      const root = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Record<string, unknown>;
      chmodSync(this.settingsPath, 0o600);
      return {
        stripeSecretKey: optionalString(root.stripeSecretKey),
        stripeWebhookSecret: optionalString(root.stripeWebhookSecret),
        paypalClientId: optionalString(root.paypalClientId),
        paypalClientSecret: optionalString(root.paypalClientSecret),
        paypalWebhookId: optionalString(root.paypalWebhookId),
        paypalEnvironment: root.paypalEnvironment === "live"
          ? "live"
          : root.paypalEnvironment === "sandbox" ? "sandbox" : null,
        zelleRecipient: optionalString(root.zelleRecipient),
        zelleNote: optionalString(root.zelleNote),
        twilioAccountSid: optionalString(root.twilioAccountSid),
        twilioAuthToken: optionalString(root.twilioAuthToken),
        twilioMessagingServiceSid: optionalString(root.twilioMessagingServiceSid),
        gmailConnectionId: optionalString(root.gmailConnectionId)
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
}

function source(saved: unknown, environment: unknown): "admin" | "environment" | "none" {
  return saved ? "admin" : environment ? "environment" : "none";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
