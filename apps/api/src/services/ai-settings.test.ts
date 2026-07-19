import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiSettingsManager } from "./ai-settings.js";

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
  it("persists an owner-only key while returning only redacted per-provider settings", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, {});
    expect(manager.view(EMPTY_USAGE)).toMatchObject({
      activeProvider: "openai",
      enabled: false,
      providers: { openai: { configured: false, source: "none" } }
    });

    manager.update({
      apiKey: "sk-proj-local-secret-value",
      clearApiKey: false,
      enabled: true,
      model: "analysis-model",
      concurrency: 3,
      dailyRequestLimit: 12,
      monthlyRequestLimit: 240
    });

    expect(manager.view(EMPTY_USAGE)).toMatchObject({
      activeProvider: "openai",
      enabled: true,
      concurrency: 3,
      dailyRequestLimit: 12,
      monthlyRequestLimit: 240,
      providers: {
        openai: { configured: true, apiKeyConfigured: true, source: "admin", model: "analysis-model" }
      }
    });
    expect(manager.view(EMPTY_USAGE).providers.openai).not.toHaveProperty("apiKey");
    expect((await stat(manager.settingsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(manager.settingsPath, "utf8"))).toMatchObject({
      apiKeys: { openai: "sk-proj-local-secret-value" },
      enabled: true
    });

    const reloaded = new AiSettingsManager(dataDir, {});
    expect(reloaded.current()).toMatchObject({ apiKey: "sk-proj-local-secret-value", model: "analysis-model", concurrency: 3 });
    reloaded.clearApiKey();
    expect(reloaded.view(EMPTY_USAGE)).toMatchObject({ enabled: false, providers: { openai: { configured: false } } });
  });

  it("reports malformed files and lets a saved key override an environment fallback", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(join(dataDir, "ai-settings.json"), "not-json");
    const malformed = new AiSettingsManager(dataDir, {});
    expect(malformed.view(EMPTY_USAGE).configurationError).toContain("could not be loaded");

    const managed = new AiSettingsManager(dataDir, { openai: "sk-proj-environment-secret" });
    expect(managed.view(EMPTY_USAGE).providers.openai).toMatchObject({ configured: true, source: "environment" });
    expect(managed.update({
      apiKey: "sk-proj-replacement-secret",
      clearApiKey: false
    })).toMatchObject({ apiKey: "sk-proj-replacement-secret" });
    expect(managed.view(EMPTY_USAGE).providers.openai).toMatchObject({
      source: "admin",
      savedApiKeyConfigured: true,
      environmentApiKeyConfigured: true
    });
    expect(managed.clearApiKey()).toMatchObject({ apiKey: "sk-proj-environment-secret" });
    expect(managed.view(EMPTY_USAGE).providers.openai).toMatchObject({
      source: "environment",
      savedApiKeyConfigured: false,
      environmentApiKeyConfigured: true
    });
    expect(managed.update({
      clearApiKey: false,
      model: "environment-model",
      enabled: true
    })).toMatchObject({ apiKey: "sk-proj-environment-secret", model: "environment-model" });
  });

  it("edits a specific provider's key/model without changing which provider is active", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, {});

    manager.update({ apiKey: "sk-openai-secret", clearApiKey: false, model: "openai-model" });
    expect(manager.current()).toMatchObject({ provider: "openai", apiKey: "sk-openai-secret", model: "openai-model" });

    const deepseekEdit = manager.update({ provider: "deepseek", apiKey: "sk-deepseek-secret-value", clearApiKey: false });
    expect(deepseekEdit).toMatchObject({ provider: "deepseek", apiKey: "sk-deepseek-secret-value", model: "deepseek-v4-flash" });
    // Editing DeepSeek's key must not switch the active provider away from OpenAI.
    expect(manager.current()).toMatchObject({ provider: "openai", apiKey: "sk-openai-secret", model: "openai-model" });

    manager.setActiveProvider("deepseek");
    expect(manager.current()).toMatchObject({ provider: "deepseek", apiKey: "sk-deepseek-secret-value", model: "deepseek-v4-flash" });

    manager.setActiveProvider("openai");
    expect(manager.current()).toMatchObject({ provider: "openai", apiKey: "sk-openai-secret", model: "openai-model" });
  });

  it("keeps both providers connected simultaneously in the settings view", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, {});

    manager.update({ apiKey: "sk-openai-secret", clearApiKey: false });
    manager.update({ provider: "deepseek", apiKey: "sk-deepseek-secret", clearApiKey: false });

    expect(manager.view(EMPTY_USAGE).providers).toMatchObject({
      openai: { configured: true, source: "admin" },
      deepseek: { configured: true, source: "admin" }
    });
  });

  it("allows provider-specific saved overrides without losing environment fallbacks", async () => {
    const dataDir = await temporaryDirectory();
    const managed = new AiSettingsManager(dataDir, { openai: "sk-openai-env-secret" });

    expect(managed.update({ apiKey: "sk-openai-replacement", clearApiKey: false }))
      .toMatchObject({ provider: "openai", apiKey: "sk-openai-replacement" });

    const deepseekEdit = managed.update({ provider: "deepseek", apiKey: "sk-deepseek-admin-secret", clearApiKey: false });
    expect(deepseekEdit).toMatchObject({ provider: "deepseek", apiKey: "sk-deepseek-admin-secret" });
    expect(() => managed.clearApiKey("deepseek")).not.toThrow();
    expect(managed.clearApiKey("openai")).toMatchObject({ apiKey: "sk-openai-env-secret" });
  });

  it("only disables analysis when the active provider's key is cleared, not a non-active one", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, {});
    manager.update({ apiKey: "sk-openai-secret", clearApiKey: false, enabled: true });
    manager.update({ provider: "deepseek", apiKey: "sk-deepseek-secret", clearApiKey: false });

    manager.clearApiKey("deepseek");
    expect(manager.current()).toMatchObject({ provider: "openai", enabled: true, apiKey: "sk-openai-secret" });

    manager.clearApiKey();
    expect(manager.current()).toMatchObject({ provider: "openai", enabled: false, apiKey: null });
  });

  it("keeps analysis enabled when clearing an active saved key reveals an environment fallback", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new AiSettingsManager(dataDir, { openai: "sk-openai-env-secret" });
    manager.update({ apiKey: "sk-openai-admin-secret", clearApiKey: false, enabled: true });

    manager.clearApiKey();

    expect(manager.current()).toMatchObject({ enabled: true, apiKey: "sk-openai-env-secret" });
  });

  it("migrates a pre-multi-provider settings file's flat apiKey into the openai slot", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(join(dataDir, "ai-settings.json"), JSON.stringify({
      apiKey: "sk-legacy-secret",
      enabled: true,
      model: "legacy-model",
      dailyRequestLimit: 50,
      monthlyRequestLimit: 500
    }));
    const manager = new AiSettingsManager(dataDir, {});
    expect(manager.current()).toMatchObject({ provider: "openai", apiKey: "sk-legacy-secret", model: "legacy-model" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-ai-settings-"));
  directories.push(directory);
  return directory;
}
