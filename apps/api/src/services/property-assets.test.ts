import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyAssetService } from "./property-assets.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyAssetService", () => {
  it("installs private photos while using a generic bundled fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archive-mail-property-assets-"));
    temporaryDirs.push(directory);
    const dataDir = join(directory, "data");
    const bundledDir = join(directory, "bundled");
    const privateImageDir = join(directory, "private");
    mkdirSync(bundledDir, { recursive: true });
    mkdirSync(privateImageDir, { recursive: true });
    writeFileSync(join(bundledDir, "generic-property.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    writeFileSync(join(privateImageDir, "home.jpg"), Buffer.from("private-photo"));
    const service = new PropertyAssetService(dataDir, bundledDir, privateImageDir);

    service.installSeedImages(["home.jpg"]);

    expect(existsSync(join(dataDir, "property-images", "home.jpg"))).toBe(true);
    expect(readFileSync(join(dataDir, "property-images", "home.jpg"), "utf8")).toBe("private-photo");
    expect(service.read("missing.jpg")).toMatchObject({ contentType: "image/svg+xml" });
    expect(service.read("missing.jpg")?.body.toString("utf8")).toContain("<svg");
  });
});
