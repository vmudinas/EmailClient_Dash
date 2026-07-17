import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  StorageSettingsManager,
  UnsupportedDatabaseProviderError,
  createEmailStore,
  sqliteConnectionString,
  sqlitePath
} from "./store-factory.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("EmailStore factory", () => {
  it("loads SQLite through a bootstrap connection string and persists changes atomically", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-store-"));
    directories.push(dataDir);
    const manager = new StorageSettingsManager(dataDir);
    const initial = manager.current();
    expect(initial).toMatchObject({ provider: "sqlite" });

    const created = createEmailStore(dataDir, initial);
    expect(created.provider).toBe("sqlite");
    expect(created.store.path).toBe(join(dataDir, "archive-mail.sqlite"));
    created.store.close();

    const alternate = sqliteConnectionString(join(dataDir, "alternate.sqlite"));
    expect(manager.update({ provider: "sqlite", connectionString: alternate })).toEqual({
      provider: "sqlite",
      connectionString: alternate
    });
    expect(JSON.parse(await readFile(manager.settingsPath, "utf8"))).toEqual({
      provider: "sqlite",
      connectionString: alternate
    });
  });

  it("round-trips an absolute path through sqliteConnectionString and sqlitePath", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-store-"));
    directories.push(dataDir);
    const target = join(dataDir, "nested", "archive-mail.sqlite");
    const connectionString = sqliteConnectionString(target);
    // Built via pathToFileURL/fileURLToPath rather than encodeURI/decodeURI so this
    // round-trips on Windows too, where resolve() joins with "\" and drive letters
    // (e.g. "C:\Users\...") would otherwise break the "starts with /" check below.
    expect(connectionString.startsWith("sqlite:///")).toBe(true);
    expect(sqlitePath(connectionString, dataDir)).toBe(target);
  });

  it("does not claim unsupported SQL adapters are available", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "archive-mail-store-"));
    directories.push(dataDir);
    const manager = new StorageSettingsManager(dataDir);
    expect(() => manager.update({
      provider: "postgresql",
      connectionString: "postgresql://localhost/archive_mail"
    })).toThrow(UnsupportedDatabaseProviderError);
  });
});
