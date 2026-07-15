import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiSettingsManagedError, AiSettingsManager } from "./ai-settings.js";

const directories: string[] = [];
const EMPTY_USAGE = {
  todayRequests: 0,
  monthRequests: 0,
  todayInputTokens: 0,
  todayOutputTokens: 0,
  monthInputTokens: 0,
  monthOutputTokens: 0
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("AiSettingsManager", () => {
  it("persists an owner-only key while returning only redacted settings", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, null);
    expect(manager.view(EMPTY_USAGE)).toMatchObject({ configured: false, enabled: false, source: "none" });

    manager.update({
      apiKey: "sk-proj-local-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "analysis-model",
      dailyRequestLimit: 12,
      monthlyRequestLimit: 240
    });

    expect(manager.view(EMPTY_USAGE)).toMatchObject({
      configured: true,
      enabled: true,
      apiKeyConfigured: true,
      source: "admin",
      model: "analysis-model",
      dailyRequestLimit: 12,
      monthlyRequestLimit: 240
    });
    expect(manager.view(EMPTY_USAGE)).not.toHaveProperty("apiKey");
    expect((await stat(manager.settingsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(manager.settingsPath, "utf8"))).toMatchObject({
      apiKey: "sk-proj-local-secret-value",
      enabled: true
    });

    const reloaded = new AiSettingsManager(dataDir, null);
    expect(reloaded.current()).toMatchObject({ apiKey: "sk-proj-local-secret-value", model: "analysis-model" });
    reloaded.clearApiKey();
    expect(reloaded.view(EMPTY_USAGE)).toMatchObject({ configured: false, enabled: false });
  });

  it("reports malformed files and protects an environment-managed key", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(join(dataDir, "ai-settings.json"), "not-json");
    const malformed = new AiSettingsManager(dataDir, null);
    expect(malformed.view(EMPTY_USAGE).configurationError).toContain("could not be loaded");

    const managed = new AiSettingsManager(dataDir, "sk-proj-environment-secret");
    expect(managed.view(EMPTY_USAGE)).toMatchObject({ configured: true, source: "environment" });
    expect(() => managed.update({
      apiKey: "sk-proj-replacement-secret",
      clearApiKey: false
    })).toThrow(AiSettingsManagedError);
    expect(() => managed.clearApiKey()).toThrow(AiSettingsManagedError);
    expect(managed.update({
      clearApiKey: false,
      model: "environment-model",
      enabled: true
    })).toMatchObject({ apiKey: "sk-proj-environment-secret", model: "environment-model" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-ai-settings-"));
  directories.push(directory);
  return directory;
}
