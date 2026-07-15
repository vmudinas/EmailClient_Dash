import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GmailSettingsManagedError,
  GmailSettingsManager
} from "./gmail-settings.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("GmailSettingsManager", () => {
  it("persists owner-only credentials without exposing the client secret in its view", async () => {
    const dataDir = await temporaryDirectory();
    const manager = new GmailSettingsManager(dataDir, { clientId: null, clientSecret: null });

    expect(manager.view()).toMatchObject({ configured: false, source: "none" });
    manager.update({
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "local-client-secret",
      clearClientSecret: false
    });

    expect(manager.view()).toMatchObject({
      configured: true,
      clientId: "desktop.apps.googleusercontent.com",
      clientSecretConfigured: true,
      source: "admin"
    });
    expect(manager.view()).not.toHaveProperty("clientSecret");
    expect((await stat(manager.settingsPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(manager.settingsPath, "utf8"))).toEqual({
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "local-client-secret"
    });

    const reloaded = new GmailSettingsManager(dataDir, { clientId: null, clientSecret: null });
    expect(reloaded.credentials()).toEqual({
      clientId: "desktop.apps.googleusercontent.com",
      clientSecret: "local-client-secret"
    });
    reloaded.update({
      clientId: "desktop.apps.googleusercontent.com",
      clearClientSecret: false
    });
    expect(reloaded.credentials().clientSecret).toBe("local-client-secret");
    reloaded.clear();
    expect(reloaded.view()).toMatchObject({ configured: false, source: "none" });
  });

  it("loads a downloaded Google Desktop OAuth JSON placed at the settings path", async () => {
    const dataDir = await temporaryDirectory();
    const settingsPath = join(dataDir, "gmail-oauth-settings.json");
    await writeFile(settingsPath, JSON.stringify({
      installed: {
        client_id: "downloaded.apps.googleusercontent.com",
        client_secret: "downloaded-secret"
      }
    }));

    const manager = new GmailSettingsManager(dataDir, { clientId: null, clientSecret: null });
    expect(manager.credentials()).toEqual({
      clientId: "downloaded.apps.googleusercontent.com",
      clientSecret: "downloaded-secret"
    });
  });

  it("reports malformed saved settings and protects environment-managed credentials", async () => {
    const dataDir = await temporaryDirectory();
    await writeFile(join(dataDir, "gmail-oauth-settings.json"), "not-json");
    const malformed = new GmailSettingsManager(dataDir, { clientId: null, clientSecret: null });
    expect(malformed.view()).toMatchObject({
      configured: false,
      configurationError: expect.stringContaining("could not be loaded")
    });

    const managed = new GmailSettingsManager(dataDir, {
      clientId: "environment-client",
      clientSecret: "environment-secret"
    });
    expect(managed.view()).toMatchObject({ configured: true, source: "environment" });
    expect(() => managed.update({
      clientId: "replacement",
      clearClientSecret: false
    })).toThrow(GmailSettingsManagedError);
    expect(() => managed.clear()).toThrow(GmailSettingsManagedError);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "archive-mail-gmail-settings-"));
  directories.push(directory);
  return directory;
}
