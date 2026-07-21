import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmailDatabase } from "../storage/database.js";
import { PropertyBackupService } from "./property-backup-service.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyBackupService", () => {
  it("creates an online database backup with property files and a manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archive-mail-property-backup-"));
    temporaryDirs.push(directory);
    const database = new EmailDatabase(directory);
    const fileRoot = join(directory, "property-files", "documents");
    mkdirSync(fileRoot, { recursive: true });
    writeFileSync(join(fileRoot, "lease.pdf"), Buffer.from("%PDF-1.7\nlease"));
    writeFileSync(join(directory, "property-integrations.json"), "{}\n");
    const service = new PropertyBackupService(directory, database.path, 2);

    const summary = await service.create();
    const root = join(directory, "property-backups", summary.id);

    expect(summary.databaseBytes).toBeGreaterThan(0);
    expect(summary.fileCount).toBeGreaterThanOrEqual(4);
    expect(existsSync(join(root, "archive-mail.sqlite"))).toBe(true);
    expect(readFileSync(join(root, "property-files", "documents", "lease.pdf"), "utf8"))
      .toContain("lease");
    expect(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))).toMatchObject({ id: summary.id });
    expect(service.list()[0]?.id).toBe(summary.id);
    database.close();
  });
});
