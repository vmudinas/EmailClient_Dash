import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyIntegrationSettingsManager } from "./property-integration-settings.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PropertyIntegrationSettingsManager", () => {
  it("uses payment environment values when no admin settings were saved", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "archive-mail-property-integrations-"));
    temporaryDirs.push(directory);
    const settings = new PropertyIntegrationSettingsManager(directory, {
      paypalEnvironment: "live",
      zelleNote: "Use the lease reference in the memo."
    });

    expect(settings.current()).toMatchObject({
      paypalEnvironment: "live",
      zelleNote: "Use the lease reference in the memo."
    });
    expect(settings.view()).toMatchObject({ paypalEnvironment: "live" });
  });
});
