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
  AdminSettings,
  AiSettingsPatch,
  AiUsageSummary
} from "@email-client/shared";

const SETTINGS_FILENAME = "ai-settings.json";
export const DEFAULT_AI_MODEL = "gpt-5.6-luna";

export interface AiRuntimeSettings {
  apiKey: string | null;
  enabled: boolean;
  model: string;
  dailyRequestLimit: number;
  monthlyRequestLimit: number;
}

const DEFAULT_SETTINGS: AiRuntimeSettings = {
  apiKey: null,
  enabled: false,
  model: DEFAULT_AI_MODEL,
  dailyRequestLimit: 100,
  monthlyRequestLimit: 2_000
};

export class AiSettingsManager {
  readonly settingsPath: string;
  private persisted: AiRuntimeSettings = { ...DEFAULT_SETTINGS };
  private readError: string | null = null;

  constructor(
    dataDir: string,
    private readonly environmentApiKey: string | null
  ) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  current(): AiRuntimeSettings {
    return {
      ...this.persisted,
      apiKey: this.environmentApiKey || this.persisted.apiKey
    };
  }

  view(usage: AiUsageSummary): AdminSettings["ai"] {
    const current = this.current();
    const source = this.environmentApiKey
      ? "environment"
      : current.apiKey
        ? "admin"
        : "none";
    return {
      configured: Boolean(current.apiKey),
      enabled: current.enabled,
      apiKeyConfigured: Boolean(current.apiKey),
      source,
      model: current.model,
      dailyRequestLimit: current.dailyRequestLimit,
      monthlyRequestLimit: current.monthlyRequestLimit,
      settingsPath: this.settingsPath,
      configurationError: this.readError,
      usage
    };
  }

  update(input: AiSettingsPatch): AiRuntimeSettings {
    if (this.environmentApiKey && (input.apiKey || input.clearApiKey)) {
      throw new AiSettingsManagedError(
        "The OpenAI API key is managed by OPENAI_API_KEY. Remove that environment value and restart Archive Mail before changing the key here."
      );
    }
    const next: AiRuntimeSettings = {
      apiKey: input.clearApiKey
        ? null
        : input.apiKey?.trim() || this.persisted.apiKey,
      enabled: input.enabled ?? this.persisted.enabled,
      model: input.model?.trim() || this.persisted.model,
      dailyRequestLimit: input.dailyRequestLimit ?? this.persisted.dailyRequestLimit,
      monthlyRequestLimit: input.monthlyRequestLimit ?? this.persisted.monthlyRequestLimit
    };
    this.write(next);
    return this.current();
  }

  clearApiKey(): AiRuntimeSettings {
    if (this.environmentApiKey) {
      throw new AiSettingsManagedError(
        "The OpenAI API key is managed by OPENAI_API_KEY and cannot be cleared in the admin panel."
      );
    }
    const next = { ...this.persisted, apiKey: null, enabled: false };
    this.write(next);
    return this.current();
  }

  private write(settings: AiRuntimeSettings): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = settings;
    this.readError = null;
  }

  private read(): AiRuntimeSettings {
    if (!existsSync(this.settingsPath)) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      const settings = parseSettings(parsed);
      chmodSync(this.settingsPath, 0o600);
      return settings;
    } catch (error) {
      this.readError = `Saved AI settings could not be loaded: ${errorMessage(error)}`;
      return { ...DEFAULT_SETTINGS };
    }
  }
}

export class AiSettingsManagedError extends Error {}

function parseSettings(value: unknown): AiRuntimeSettings {
  if (!value || typeof value !== "object") throw new Error("the file is not a JSON object");
  const root = value as Record<string, unknown>;
  return {
    apiKey: optionalString(root.apiKey),
    enabled: typeof root.enabled === "boolean" ? root.enabled : DEFAULT_SETTINGS.enabled,
    model: optionalString(root.model) ?? DEFAULT_SETTINGS.model,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
