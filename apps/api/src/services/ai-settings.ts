import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  AI_PROVIDER_IDS,
  type AdminSettings,
  type AiProviderId,
  type AiProviderSettings,
  type AiSettingsPatch,
  type AiUsageSummary
} from "@email-client/shared";

const SETTINGS_FILENAME = "ai-settings.json";

export const AI_PROVIDER_INFO: Record<AiProviderId, { label: string; defaultModel: string; envVar: string }> = {
  openai: { label: "OpenAI", defaultModel: "gpt-5.6-luna", envVar: "OPENAI_API_KEY" },
  // deepseek-chat/deepseek-reasoner retire 2026-07-24; deepseek-v4-flash is their replacement default.
  deepseek: { label: "DeepSeek", defaultModel: "deepseek-v4-flash", envVar: "DEEPSEEK_API_KEY" }
};

export const DEFAULT_AI_MODEL = AI_PROVIDER_INFO.openai.defaultModel;

export interface AiRuntimeSettings {
  provider: AiProviderId;
  apiKey: string | null;
  model: string;
  enabled: boolean;
  concurrency: number;
  dailyRequestLimit: number;
  monthlyRequestLimit: number;
}

type ByProvider<T> = Record<AiProviderId, T>;

interface PersistedAiSettings {
  provider: AiProviderId;
  apiKeys: ByProvider<string | null>;
  // Each provider remembers its own last-used model, so switching the active provider
  // and back doesn't lose a custom model id in favor of the other provider's default.
  models: ByProvider<string>;
  enabled: boolean;
  concurrency: number;
  dailyRequestLimit: number;
  monthlyRequestLimit: number;
}

const DEFAULT_SETTINGS: PersistedAiSettings = {
  provider: "openai",
  apiKeys: { openai: null, deepseek: null },
  models: { openai: AI_PROVIDER_INFO.openai.defaultModel, deepseek: AI_PROVIDER_INFO.deepseek.defaultModel },
  enabled: false,
  concurrency: 2,
  dailyRequestLimit: 100,
  monthlyRequestLimit: 2_000
};

export class AiSettingsManager {
  readonly settingsPath: string;
  private persisted: PersistedAiSettings = clone(DEFAULT_SETTINGS);
  private readError: string | null = null;

  constructor(
    dataDir: string,
    private readonly environmentApiKeys: Partial<Record<AiProviderId, string | null>> = {}
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  /** Resolved settings for the currently active provider — the one actually used to analyze messages. */
  current(): AiRuntimeSettings {
    return this.forProvider(this.persisted.provider);
  }

  /** Resolved settings for any provider, active or not — lets each provider's card be configured/tested independently. */
  forProvider(provider: AiProviderId): AiRuntimeSettings {
    return {
      provider,
      apiKey: this.persisted.apiKeys[provider] || this.environmentApiKeys[provider] || null,
      model: this.persisted.models[provider],
      enabled: this.persisted.enabled,
      concurrency: this.persisted.concurrency,
      dailyRequestLimit: this.persisted.dailyRequestLimit,
      monthlyRequestLimit: this.persisted.monthlyRequestLimit
    };
  }

  view(usage: AiUsageSummary): AdminSettings["ai"] {
    const providers = {} as Record<AiProviderId, AiProviderSettings>;
    for (const id of AI_PROVIDER_IDS) {
      const snapshot = this.forProvider(id);
      const source = this.persisted.apiKeys[id]
        ? "admin"
        : this.environmentApiKeys[id]
          ? "environment"
          : "none";
      providers[id] = {
        configured: Boolean(snapshot.apiKey),
        apiKeyConfigured: Boolean(snapshot.apiKey),
        savedApiKeyConfigured: Boolean(this.persisted.apiKeys[id]),
        environmentApiKeyConfigured: Boolean(this.environmentApiKeys[id]),
        source,
        model: snapshot.model
      };
    }
    return {
      activeProvider: this.persisted.provider,
      enabled: this.persisted.enabled,
      concurrency: this.persisted.concurrency,
      dailyRequestLimit: this.persisted.dailyRequestLimit,
      monthlyRequestLimit: this.persisted.monthlyRequestLimit,
      settingsPath: this.settingsPath,
      configurationError: this.readError,
      usage,
      providers
    };
  }

  /** Switches which provider is used to analyze messages, without touching either provider's saved key/model. */
  setActiveProvider(provider: AiProviderId): AiRuntimeSettings {
    this.write({ ...this.persisted, provider });
    return this.current();
  }

  /** Edits one provider's key/model (input.provider, defaulting to whichever is active) and/or the shared enable/limit settings. */
  update(input: AiSettingsPatch): AiRuntimeSettings {
    const target = input.provider ?? this.persisted.provider;
    const apiKeys = { ...this.persisted.apiKeys };
    if (input.clearApiKey) apiKeys[target] = null;
    else if (input.apiKey?.trim()) apiKeys[target] = input.apiKey.trim();

    const models = { ...this.persisted.models };
    if (input.model?.trim()) models[target] = input.model.trim();

    this.write({
      provider: this.persisted.provider,
      apiKeys,
      models,
      enabled: input.enabled ?? this.persisted.enabled,
      concurrency: input.concurrency ?? this.persisted.concurrency,
      dailyRequestLimit: input.dailyRequestLimit ?? this.persisted.dailyRequestLimit,
      monthlyRequestLimit: input.monthlyRequestLimit ?? this.persisted.monthlyRequestLimit
    });
    return this.forProvider(target);
  }

  clearApiKey(provider?: AiProviderId): AiRuntimeSettings {
    const target = provider ?? this.persisted.provider;
    this.write({
      ...this.persisted,
      apiKeys: { ...this.persisted.apiKeys, [target]: null },
      // Clearing a saved key restores its environment fallback when one exists.
      enabled: target === this.persisted.provider && !this.environmentApiKeys[target]
        ? false
        : this.persisted.enabled
    });
    return this.forProvider(target);
  }

  private write(settings: PersistedAiSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = settings;
    this.readError = null;
  }

  private read(): PersistedAiSettings {
    if (!existsSync(this.settingsPath)) return clone(DEFAULT_SETTINGS);
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      const settings = parseSettings(parsed);
      chmodSync(this.settingsPath, 0o600);
      return settings;
    } catch (error) {
      this.readError = `Saved AI settings could not be loaded: ${errorMessage(error)}`;
      return clone(DEFAULT_SETTINGS);
    }
  }
}

function clone(settings: PersistedAiSettings): PersistedAiSettings {
  return { ...settings, apiKeys: { ...settings.apiKeys }, models: { ...settings.models } };
}

function parseSettings(value: unknown): PersistedAiSettings {
  if (!value || typeof value !== "object") throw new Error("the file is not a JSON object");
  const root = value as Record<string, unknown>;
  const provider: AiProviderId = AI_PROVIDER_IDS.includes(root.provider as AiProviderId)
    ? root.provider as AiProviderId
    : DEFAULT_SETTINGS.provider;
  // Settings files written before multi-provider support only had flat `apiKey`/`model`
  // fields for whatever was then the sole provider (OpenAI); fold them into that slot.
  const legacyApiKey = optionalString(root.apiKey);
  const legacyModel = optionalString(root.model);
  const apiKeysRoot = root.apiKeys && typeof root.apiKeys === "object"
    ? root.apiKeys as Record<string, unknown>
    : null;
  const modelsRoot = root.models && typeof root.models === "object"
    ? root.models as Record<string, unknown>
    : null;
  const apiKeys = {} as ByProvider<string | null>;
  const models = {} as ByProvider<string>;
  for (const id of AI_PROVIDER_IDS) {
    apiKeys[id] = apiKeysRoot ? optionalString(apiKeysRoot[id]) : (id === "openai" ? legacyApiKey : null);
    models[id] = (modelsRoot ? optionalString(modelsRoot[id]) : null)
      ?? (id === provider ? legacyModel : null)
      ?? AI_PROVIDER_INFO[id].defaultModel;
  }
  return {
    provider,
    apiKeys,
    models,
    enabled: typeof root.enabled === "boolean" ? root.enabled : DEFAULT_SETTINGS.enabled,
    concurrency: boundedInteger(root.concurrency, DEFAULT_SETTINGS.concurrency, 1, 8),
    dailyRequestLimit: positiveInteger(root.dailyRequestLimit, DEFAULT_SETTINGS.dailyRequestLimit),
    monthlyRequestLimit: positiveInteger(root.monthlyRequestLimit, DEFAULT_SETTINGS.monthlyRequestLimit)
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
