import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { copyFile, cp, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { PropertyBackupSummary } from "@email-client/shared";

const SETTINGS_FILES = [
  "property-integrations.json",
  "gmail-oauth-settings.json",
  "gmail-settings.json",
  "draft-settings.json",
  "ai-settings.json"
];

export class PropertyBackupService {
  private readonly root: string;

  constructor(
    private readonly dataDir: string,
    private readonly databasePath: string,
    private readonly retention: number
  ) {
    this.root = resolve(dataDir, "property-backups");
    mkdirSync(this.root, { recursive: true });
  }

  list(): PropertyBackupSummary[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(entry.name))
      .map((entry) => summarize(join(this.root, entry.name), entry.name))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async create(): Promise<PropertyBackupSummary> {
    const createdAt = new Date().toISOString();
    const id = createdAt.replace(/[:.]/g, "-");
    const destination = join(this.root, id);
    mkdirSync(destination, { recursive: true });
    const databaseDestination = join(destination, basename(this.databasePath));
    const database = new BetterSqlite3(this.databasePath, { readonly: true, fileMustExist: true });
    try {
      await database.backup(databaseDestination);
    } finally {
      database.close();
    }
    for (const folder of ["property-files", "property-images"]) {
      const source = resolve(this.dataDir, folder);
      if (existsSync(source)) await cp(source, join(destination, folder), { recursive: true });
    }
    const settingsRoot = join(destination, "settings");
    for (const filename of SETTINGS_FILES) {
      const source = resolve(this.dataDir, filename);
      if (!existsSync(source)) continue;
      mkdirSync(settingsRoot, { recursive: true });
      await copyFile(source, join(settingsRoot, filename));
    }
    const summary = summarize(destination, id, createdAt);
    await writeFile(join(destination, "manifest.json"), `${JSON.stringify({
      ...summary,
      databaseFilename: basename(this.databasePath),
      restore: "Stop Archive Mail, replace the database and property file folders from this backup, then restart."
    }, null, 2)}\n`, { mode: 0o600 });
    this.prune();
    return summarize(destination, id, createdAt);
  }

  private prune(): void {
    const keep = Math.max(1, this.retention);
    for (const backup of this.list().slice(keep)) {
      rmSync(join(this.root, backup.id), { recursive: true, force: true });
    }
  }
}

function summarize(path: string, id: string, createdAt?: string): PropertyBackupSummary {
  const databaseFile = readdirSync(path, { withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name.endsWith(".sqlite"));
  const totals = treeSize(path);
  const timestamp = createdAt ?? id.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    "$1T$2:$3:$4.$5Z"
  );
  return {
    id,
    createdAt: Number.isNaN(Date.parse(timestamp)) ? statSync(path).birthtime.toISOString() : timestamp,
    sizeBytes: totals.bytes,
    databaseBytes: databaseFile ? statSync(join(path, databaseFile.name)).size : 0,
    fileCount: totals.files
  };
}

function treeSize(path: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      const nested = treeSize(child);
      bytes += nested.bytes;
      files += nested.files;
    } else if (entry.isFile()) {
      bytes += statSync(child).size;
      files += 1;
    }
  }
  return { bytes, files };
}
