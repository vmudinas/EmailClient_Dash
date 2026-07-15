import type { ImportJob } from "@email-client/shared";
import { describe, expect, it } from "vitest";
import {
  formatImportEta,
  importEmailCountLabel,
  importProgressPercent,
  updateImportEta
} from "./import-progress.js";

describe("import progress presentation", () => {
  it("keeps byte scanning and email progress in distinct phases", () => {
    expect(importProgressPercent(job({
      phase: "fingerprinting",
      processedBytes: 500,
      totalBytes: 1_000,
      totalItems: null
    }))).toBe(5);
    const parsing = job({
      phase: "parsing",
      processedItems: 25,
      totalItems: 100
    });
    expect(importProgressPercent(parsing)).toBe(32);
    expect(importEmailCountLabel(parsing)).toBe("25 of 100 emails");
    expect(importProgressPercent(job({
      phase: "parsing",
      sourceType: "mbox",
      processedBytes: 500,
      totalBytes: 1_000,
      totalItems: null
    }))).toBe(55);
    expect(importProgressPercent(job({ status: "completed" }))).toBe(100);
  });

  it("estimates completion from observed message throughput", () => {
    const first = job({
      processedItems: 10,
      totalItems: 100,
      updatedAt: "2026-07-13T00:00:00.000Z"
    });
    const initial = updateImportEta(undefined, first);
    expect(initial.secondsRemaining).toBeNull();

    const second = job({
      processedItems: 20,
      totalItems: 100,
      updatedAt: "2026-07-13T00:00:10.000Z"
    });
    const measured = updateImportEta(initial.sample, second);
    expect(measured.secondsRemaining).toBe(80);
    expect(formatImportEta(measured.secondsRemaining, Date.parse("2026-07-13T00:00:10.000Z")))
      .toContain("About 2 min left");
  });
});

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job-1",
    archiveId: "archive-1",
    sourceName: "Inbox.mbox",
    sourceType: "mbox",
    status: "running",
    phase: "parsing",
    processedItems: 0,
    totalItems: null,
    processedBytes: 0,
    totalBytes: 1_000,
    errorCount: 0,
    ocrEnabled: false,
    canResume: false,
    message: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides
  };
}
