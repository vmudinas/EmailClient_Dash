import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  DatabaseProvider,
  DatabaseProviderOption,
  DatabaseSettingsPatch
} from "@email-client/shared";
import { EmailDatabase, type EmailStore } from "./database.js";

const SETTINGS_FILENAME = "storage-settings.json";

export interface StorageBootstrapConfig {
  provider: DatabaseProvider;
  connectionString: string;
}

export interface CreatedEmailStore {
  provider: DatabaseProvider;
  connectionString: string;
  store: EmailStore;
}

export const DATABASE_PROVIDERS: DatabaseProviderOption[] = [
  {
    id: "sqlite",
    label: "SQLite",
    available: true,
    description: "Built-in local adapter with FTS5 search."
  },
  {
    id: "postgresql",
    label: "PostgreSQL",
    available: false,
    description: "Requires a PostgreSQL data and search adapter."
  },
  {
    id: "mysql",
    label: "MySQL",
    available: false,
    description: "Requires a MySQL data and full-text search adapter."
  },
  {
    id: "mssql",
    label: "Microsoft SQL Server",
    available: false,
    description: "Requires a SQL Server data and full-text search adapter."
  }
];

export class StorageSettingsManager {
  readonly settingsPath: string;
  private configured: StorageBootstrapConfig;

  constructor(readonly dataDir: string) {
    this.settingsPath = resolve(dataDir, SETTINGS_FILENAME);
    this.configured = this.read();
  }

  current(): StorageBootstrapConfig {
    return { ...this.configured };
  }

  update(input: DatabaseSettingsPatch): StorageBootstrapConfig {
    const provider = DATABASE_PROVIDERS.find((option) => option.id === input.provider);
    if (!provider?.available) {
      throw new UnsupportedDatabaseProviderError(
        `${provider?.label ?? input.provider} is not installed. Add its EmailStore adapter before selecting it.`
      );
    }
    if (input.provider === "sqlite") sqlitePath(input.connectionString, this.dataDir);
    const next = { provider: input.provider, connectionString: input.connectionString.trim() };
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    const temporaryPath = `${this.settingsPath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, this.settingsPath);
    this.configured = next;
    return this.current();
  }

  private read(): StorageBootstrapConfig {
    const fallback = defaultStorageConfig(this.dataDir);
    if (!existsSync(this.settingsPath)) return fallback;
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<StorageBootstrapConfig>;
      const provider = DATABASE_PROVIDERS.find((option) => option.id === parsed.provider);
      if (!provider?.available || typeof parsed.connectionString !== "string") return fallback;
      if (parsed.provider === "sqlite") sqlitePath(parsed.connectionString, this.dataDir);
      return {
        provider: provider.id,
        connectionString: parsed.connectionString
      };
    } catch {
      return fallback;
    }
  }
}

export class UnsupportedDatabaseProviderError extends Error {}

export function createEmailStore(
  dataDir: string,
  config: StorageBootstrapConfig
): CreatedEmailStore {
  if (config.provider === "sqlite") {
    const path = sqlitePath(config.connectionString, dataDir);
    return {
      provider: "sqlite",
      connectionString: sqliteConnectionString(path),
      store: new EmailDatabase(dirname(path), path)
    };
  }
  throw new UnsupportedDatabaseProviderError(
    `No ${config.provider} EmailStore adapter is installed`
  );
}

export function defaultStorageConfig(dataDir: string): StorageBootstrapConfig {
  return {
    provider: "sqlite",
    connectionString: sqliteConnectionString(resolve(dataDir, "archive-mail.sqlite"))
  };
}

export function sqliteConnectionString(path: string): string {
  return `sqlite://${encodeURI(resolve(path))}`;
}

export function sqlitePath(connectionString: string, dataDir: string): string {
  const value = connectionString.trim();
  if (!value.toLowerCase().startsWith("sqlite:")) {
    throw new Error("SQLite connection strings must start with sqlite:");
  }
  if (value.startsWith("sqlite://")) {
    const encodedPath = value.slice("sqlite://".length);
    if (!encodedPath.startsWith("/")) throw new Error("Use an absolute SQLite path");
    return resolve(decodeURI(encodedPath));
  }
  const relativePath = value.slice("sqlite:".length);
  if (!relativePath || relativePath === ":memory:") {
    throw new Error("Choose a persistent SQLite database file");
  }
  return resolve(dataDir, decodeURI(relativePath));
}
