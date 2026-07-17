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
  draftSettingsPatchSchema,
  type AdminSettings,
  type DraftIdentitySettings,
  type DraftSettingsPatch
} from "@email-client/shared";

const SETTINGS_FILENAME = "draft-settings.json";

export const DEFAULT_DRAFT_IDENTITY: DraftIdentitySettings = {
  defaultFromAddress: "ai@vitas.work",
  senderName: "Vitas"
};

export class DraftSettingsManager {
  readonly settingsPath: string;
  private persisted: DraftIdentitySettings = { ...DEFAULT_DRAFT_IDENTITY };
  private readError: string | null = null;

  constructor(dataDir: string) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.persisted = this.read();
  }

  current(): DraftIdentitySettings {
    return { ...this.persisted };
  }

  view(): AdminSettings["drafts"] {
    return {
      ...this.current(),
      settingsPath: this.settingsPath,
      configurationError: this.readError
    };
  }

  update(input: DraftSettingsPatch): DraftIdentitySettings {
    const parsed = draftSettingsPatchSchema.parse(input);
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    chmodSync(this.settingsPath, 0o600);
    this.persisted = parsed;
    this.readError = null;
    return this.current();
  }

  private read(): DraftIdentitySettings {
    if (!existsSync(this.settingsPath)) return { ...DEFAULT_DRAFT_IDENTITY };
    try {
      const parsed = draftSettingsPatchSchema.parse(JSON.parse(readFileSync(this.settingsPath, "utf8")));
      chmodSync(this.settingsPath, 0o600);
      return parsed;
    } catch (error) {
      this.readError = `Saved draft settings could not be loaded: ${errorMessage(error)}`;
      return { ...DEFAULT_DRAFT_IDENTITY };
    }
  }
}

export function applyDraftSenderName(value: string, senderName: string): string {
  return value.replace(/\[\s*name\s*\]/gi, senderName);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
